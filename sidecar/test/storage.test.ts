import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { type Db, openDatabase } from "../src/db/index.ts";
import { readHarnessSchemaVersion } from "../src/settings.ts";
import { MissingSchema, openHarnessStorage } from "../src/storage.ts";
import { emptyDatabaseUrl, openTestDatabase, TEST_DIALECT, tempDir, testDatabaseUrl } from "./helpers.ts";

const singletons = async (db: Db) => ({
	schema: { ...(await db.get("SELECT singleton, version FROM durable_agent_durable_schema")) },
	metadata: { ...(await db.get("SELECT singleton, next_id, next_seq FROM durable_agent_durable_metadata")) },
	count:
		Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM durable_agent_durable_schema"))?.n) +
		Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM durable_agent_durable_metadata"))?.n),
});

test(`[${TEST_DIALECT}] a database without the tables is refused with MissingSchema`, async () => {
	const empty = await emptyDatabaseUrl();
	const db = await openDatabase(empty.url);
	try {
		await assert.rejects(openHarnessStorage(db), (error: Error) => {
			assert.ok(error instanceof MissingSchema);
			assert.match(error.message, /run bin\/rails db:migrate/);
			return true;
		});
	} finally {
		await db.close();
		await empty.dispose();
	}
});

test(`[${TEST_DIALECT}] opening seeds the singleton rows once, and opens again over them`, async () => {
	const url = await testDatabaseUrl();
	const db = await openTestDatabase({ url });
	assert.equal((await singletons(db)).count, 0);

	const first = await openHarnessStorage(db);
	const seeded = await singletons(db);
	assert.deepEqual(seeded, {
		schema: { singleton: 1, version: CURRENT_SQLITE_SCHEMA_VERSION },
		metadata: { singleton: 1, next_id: "2", next_seq: 1 },
		count: 2,
	});
	assert.equal(await readHarnessSchemaVersion(db), CURRENT_SQLITE_SCHEMA_VERSION);
	const id = await first.mintId();
	assert.equal(id, 2);
	await first.commit([], BACKGROUND_CONTEXT);
	await first.close(BACKGROUND_CONTEXT);

	// The storage closed the database; a second process (or boot) opens its own.
	const again = await openTestDatabase({ url, reset: false });
	const second = await openHarnessStorage(again);
	assert.equal((await singletons(again)).count, 2);
	assert.equal(Number((await again.get<{ next_seq: number }>("SELECT next_seq FROM durable_agent_durable_metadata"))?.next_seq), 2);
	await second.close(BACKGROUND_CONTEXT);
});

test(`[${TEST_DIALECT}] a stored harness schema older than this pi-durable is refused, not migrated`, async () => {
	const db = await openTestDatabase();
	await db.run("INSERT INTO durable_agent_durable_schema (singleton, version) VALUES (1, 0)");
	await assert.rejects(openHarnessStorage(db), /harness schema is version 0.*bin\/rails db:migrate/);
	assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM durable_agent_durable_metadata"))?.n), 1);
	await db.close();
});

test(`[${TEST_DIALECT}] a real Harness on faux answers a submission through openHarnessStorage`, async () => {
	const db = await openTestDatabase();
	const storage = await openHarnessStorage(db);
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 10_000 });
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("hello from the database")]);
	const cwd = await tempDir();
	const harness = await Harness.open(
		storage,
		{ models, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd }) },
		BACKGROUND_CONTEXT,
	);
	try {
		harness.resume();
		const conversation = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
			BACKGROUND_CONTEXT,
		);
		const submission = await conversation.submit({ type: "input", requestId: "r1", content: "hi" }, BACKGROUND_CONTEXT);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");

		const rows = await db.all<{ record: string }>(
			"SELECT record FROM durable_agent_entries WHERE conversation_id = ? ORDER BY id",
			conversation.id,
		);
		const kinds = rows.map((row) => (JSON.parse(row.record) as { kind: string }).kind);
		assert.ok(kinds.includes("pi.assistant"), `entry kinds: ${kinds.join(", ")}`);
		assert.match(rows.map((row) => row.record).join("\n"), /hello from the database/);
		const stored = await db.get<{ status: string; request_id: string }>(
			"SELECT status, request_id FROM durable_agent_submissions WHERE id = ?",
			submission.id,
		);
		assert.deepEqual({ ...stored }, { status: "done", request_id: '"r1"' });
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});
