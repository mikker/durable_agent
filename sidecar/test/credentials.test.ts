import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type pg from "pg";
import { installationDeviceId, PostgresCredentialStore, recordSchemaVersion } from "../src/credentials.ts";
import { testPool } from "./helpers.ts";

let pool: pg.Pool;
before(async () => {
	pool = await testPool();
});
after(() => pool.end());

test("credentials round-trip through Postgres and modifications serialize per provider", async () => {
	const store = new PostgresCredentialStore(pool, "token-a");
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
	const result = await pool.query<{ credential: Record<string, unknown> }>(
		"SELECT credential FROM durable_agent_credentials WHERE provider_id = $1",
		[providerId],
	);
	const row = result.rows[0];
	assert.ok(row, `no row for ${providerId}`);
	return row.credential;
};

test("credentials are stored as an encrypted envelope and read back intact", async () => {
	const store = new PostgresCredentialStore(pool, "token-a");
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
	await pool.query("INSERT INTO durable_agent_credentials (provider_id, credential) VALUES ($1, $2)", [
		"legacy-provider",
		JSON.stringify(legacy),
	]);
	const store = new PostgresCredentialStore(pool, "token-a");
	assert.deepEqual(await store.read("legacy-provider"), legacy);

	await store.modify("legacy-provider", async () => undefined); // keep
	const stored = await storedRow("legacy-provider");
	assert.equal(stored.enc, 1);
	assert.doesNotMatch(JSON.stringify(stored), /legacy-refresh/);
	assert.deepEqual(await store.read("legacy-provider"), legacy);
	await store.delete("legacy-provider");
});

test("a store with a different token treats the credential as absent and logs a warning", async (t) => {
	await new PostgresCredentialStore(pool, "token-a").modify("rotated-provider", async () => ({
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
	const rotated = new PostgresCredentialStore(pool, "token-b");
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
	const first = await installationDeviceId(pool);
	const second = await installationDeviceId(pool);
	assert.match(first, /^[0-9a-f-]{36}$/);
	assert.equal(first, second);
});

test("the schema version row is written once and never overwritten", async () => {
	await recordSchemaVersion(pool);
	await pool.query("UPDATE durable_agent_settings SET value = '7' WHERE key = 'schema_version'");
	await recordSchemaVersion(pool);
	const result = await pool.query<{ value: string }>("SELECT value FROM durable_agent_settings WHERE key = 'schema_version'");
	assert.equal(result.rows[0]?.value, "7");
	await pool.query("UPDATE durable_agent_settings SET value = '1' WHERE key = 'schema_version'");
});
