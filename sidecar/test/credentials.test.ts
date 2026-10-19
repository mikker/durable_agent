import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DbCredentialStore } from "../src/credentials.ts";
import type { Db } from "../src/db/index.ts";
import { createReporter } from "../src/reports.ts";
import { installationDeviceId, readSchemaVersion, recordSchemaVersion, SCHEMA_VERSION } from "../src/settings.ts";
import { openTestDatabase, TEST_DIALECT, until } from "./helpers.ts";

let db: Db;
before(async () => {
	db = await openTestDatabase();
});
after(() => db.close());

test(`[${TEST_DIALECT}] credentials round-trip through the database and modifications serialize per provider`, async () => {
	const store = new DbCredentialStore(db, "token-a");
	assert.equal(await store.read("openai"), undefined);

	await store.modify("openai", async () => ({ type: "oauth", access: "a1", refresh: "r1", expires: 1 }));
	assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);

	// Two concurrent refreshes: the second must see the first's result.
	const seen: string[] = [];
	await Promise.all([
		store.modify("openai", async (current) => {
			seen.push(current?.type === "oauth" ? current.access : "none");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { type: "oauth", access: "a2", refresh: "r1", expires: 2 };
		}),
		store.modify("openai", async (current) => {
			seen.push(current?.type === "oauth" ? current.access : "none");
			return undefined; // keep
		}),
	]);
	assert.deepEqual(seen, ["a1", "a2"]);

	await store.delete("openai");
	assert.equal(await store.read("openai"), undefined);
});

const storedRow = async (providerId: string): Promise<Record<string, unknown>> => {
	const row = await db.get<{ credential: string }>("SELECT credential FROM durable_agent_credentials WHERE provider_id = ?", providerId);
	assert.ok(row, `no row for ${providerId}`);
	assert.equal(typeof row.credential, "string", "credential is JSON text");
	return JSON.parse(row.credential) as Record<string, unknown>;
};

test("credentials are stored as an encrypted envelope and read back intact", async () => {
	const store = new DbCredentialStore(db, "token-a");
	const credential = { type: "oauth", access: "access-secret", refresh: "refresh-secret-xyz", expires: 42 } as const;
	await store.modify("enc-provider", async () => credential);

	assert.deepEqual(await store.read("enc-provider"), credential);
	const stored = await storedRow("enc-provider");
	assert.equal(stored.enc, 1);
	assert.equal(stored.type, "oauth");
	assert.deepEqual(Object.keys(stored).sort(), ["data", "enc", "iv", "tag", "type"]);
	const raw = JSON.stringify(stored);
	assert.doesNotMatch(raw, /refresh-secret-xyz/);
	assert.doesNotMatch(raw, /access-secret/);
	assert.ok((await store.list()).some((info) => info.providerId === "enc-provider" && info.type === "oauth"));
	await store.delete("enc-provider");
});

test("a legacy plaintext row reads back and is re-encrypted on the next modify", async () => {
	const legacy = { type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: 7 };
	await db.run(
		"INSERT INTO durable_agent_credentials (provider_id, credential, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
		"legacy-provider",
		JSON.stringify(legacy),
	);
	const store = new DbCredentialStore(db, "token-a");
	assert.deepEqual(await store.read("legacy-provider"), legacy);
	assert.deepEqual(await store.list(), [{ providerId: "legacy-provider", type: "oauth" }]);

	await store.modify("legacy-provider", async () => undefined); // keep
	const stored = await storedRow("legacy-provider");
	assert.equal(stored.enc, 1);
	assert.doesNotMatch(JSON.stringify(stored), /legacy-refresh/);
	assert.deepEqual(await store.read("legacy-provider"), legacy);
	await store.delete("legacy-provider");
});

test("a store with a different token treats the credential as absent and logs a warning", async (t) => {
	await new DbCredentialStore(db, "token-a").modify("rotated-provider", async () => ({
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: 1,
	}));
	const lines: string[] = [];
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		lines.push(String(chunk));
		return true;
	});
	const rotated = new DbCredentialStore(db, "token-b");
	const read = await rotated.read("rotated-provider");
	t.mock.restoreAll();

	assert.equal(read, undefined);
	const warning = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.level === "warn");
	assert.ok(warning, "expected a warning");
	assert.equal(warning.provider, "rotated-provider");
	assert.match(String(warning.message), /decrypt/);
	await rotated.delete("rotated-provider");
});

test("the installation device id is created once and then stable", async () => {
	const first = await installationDeviceId(db);
	const second = await installationDeviceId(db);
	assert.match(first, /^[0-9a-f-]{36}$/);
	assert.equal(first, second);
});

test("the schema version row is written once and never overwritten", async () => {
	assert.equal(SCHEMA_VERSION, 2);
	await recordSchemaVersion(db);
	assert.equal(await readSchemaVersion(db), 2);
	await db.run("UPDATE durable_agent_settings SET value = '7' WHERE key = 'schema_version'");
	await recordSchemaVersion(db);
	assert.equal(await readSchemaVersion(db), 7);
	await db.run("UPDATE durable_agent_settings SET value = '2' WHERE key = 'schema_version'");
});

test("a harness report is stored with its fields and its id handed to the events", async (t) => {
	t.mock.method(process.stderr, "write", () => true);
	const reported: number[] = [];
	const report = createReporter(db, { report: (id) => reported.push(id) });
	report(new Error("task blew up"), { type: "task_faulted", extension: "pi.tools", task: { id: 12, kind: "pi.run", conversationId: 7 } });
	await until("the report row", () => reported.length === 1);
	t.mock.restoreAll();

	const row = await db.get<Record<string, unknown>>("SELECT * FROM durable_agent_reports WHERE id = ?", reported[0] as number);
	assert.ok(row);
	assert.equal(typeof reported[0], "number");
	assert.deepEqual(
		{ type: row.type, conversation_id: row.conversation_id, task_id: row.task_id, task_kind: row.task_kind, extension: row.extension, message: row.message },
		{ type: "task_faulted", conversation_id: 7, task_id: 12, task_kind: "pi.run", extension: "pi.tools", message: "task blew up" },
	);
	assert.equal((JSON.parse(String(row.info)) as { type: string }).type, "task_faulted");
	assert.ok(row.created_at, "created_at is set");
});
