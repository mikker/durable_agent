// End to end inside one process: a Harness on the faux model, the mirror writing to Postgres, and the NOTIFY
// a Rails relay would receive.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pg from "pg";
import type { Config } from "../src/config.ts";
import { PostgresCredentialStore } from "../src/credentials.ts";
import { createProcessModels, type OpenedHarness, openHarness } from "../src/harness.ts";
import { Mirror, MIRROR_CHANNEL } from "../src/mirror.ts";
import { assertKnownModel, UnknownModel } from "../src/models-check.ts";
import { testPool } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
let pool: pg.Pool;
let listener: pg.Client;
let opened: OpenedHarness;
let mirror: Mirror;
const notifications: { conversationId: number; entries?: number[]; docs?: string[]; submission?: { status: string } }[] = [];

const config = async (): Promise<Config> => {
	const dir = await mkdtemp(join(tmpdir(), "sidecar-test-"));
	return {
		port: 0,
		host: "127.0.0.1",
		token: "t",
		databaseUrl: "",
		storagePath: join(dir, "harness.sqlite"),
		workspaceRoot: dir,
		model: { provider: "faux", modelId: "faux-1" },
		agentName: "test",
		enableCodingTools: false,
		railsUrl: undefined,
		railsWebhookPath: "/x",
		mirrorDocs: undefined,
	};
};

before(async () => {
	pool = await testPool();
	listener = new pg.Client({ connectionString: pool.options.connectionString });
	await listener.connect();
	listener.on("notification", (message) => notifications.push(JSON.parse(message.payload ?? "{}")));
	await listener.query(`LISTEN ${MIRROR_CHANNEL}`);

	const cfg = await config();
	const models = createProcessModels(cfg, new PostgresCredentialStore(pool));
	mirror = undefined as unknown as Mirror;
	opened = await openHarness(cfg, models, { onConversationCreated: (record) => mirror?.enqueue(record), onReport: () => undefined }, context);
	mirror = new Mirror(pool, opened.harness, cfg, context);
	await mirror.start();
	opened.harness.resume();
});

after(async () => {
	await mirror.stop();
	await opened.close(context);
	await listener.end();
	await pool.end();
});

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

test("a submitted input is answered and every piece lands in Postgres with a notification", async () => {
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.model } },
		context,
	);
	await mirror.attach(conversation.id);
	const submission = await conversation.submit({ type: "input", content: "Hello", requestId: "t-1" }, context);
	mirror.track(submission, conversation, { type: "input", content: "Hello", requestId: "t-1" });
	await submission.wait(context);

	await until("assistant entry mirrored", async () => {
		const rows = await pool.query("SELECT 1 FROM agent_entries WHERE conversation_id = $1 AND kind = 'pi.assistant'", [conversation.id]);
		return (rows.rowCount ?? 0) > 0;
	});
	await until("submission done", async () => {
		const rows = await pool.query("SELECT status FROM agent_submissions WHERE id = $1", [submission.id]);
		return rows.rows[0]?.status === "done";
	});

	const entries = await pool.query<{ kind: string }>("SELECT kind FROM agent_entries WHERE conversation_id = $1 ORDER BY id", [conversation.id]);
	assert.deepEqual(entries.rows.map((row) => row.kind), ["pi.user", "pi.system", "pi.assistant"]);
	const docs = await pool.query<{ kind: string }>("SELECT kind FROM agent_documents WHERE conversation_id = $1 ORDER BY kind", [conversation.id]);
	assert.deepEqual(docs.rows.map((row) => row.kind), ["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"]);

	await until("notifications", () => notifications.some((n) => n.conversationId === conversation.id && n.submission?.status === "done"));
	const entryNotes = notifications.filter((n) => n.conversationId === conversation.id && (n.entries?.length ?? 0) > 0);
	assert.ok(entryNotes.length > 0, "entry notifications were sent");

	// Same request id: the same submission, no duplicate row.
	const again = await conversation.submit({ type: "input", content: "Hello", requestId: "t-1" }, context);
	assert.equal(again.id, submission.id);
	const count = await pool.query("SELECT count(*)::int AS n FROM agent_submissions WHERE conversation_id = $1", [conversation.id]);
	assert.equal(count.rows[0].n, 1);
});

test("unknown model ids are rejected with suggestions", () => {
	assert.throws(() => assertKnownModel(opened.models, { provider: "openai", modelId: "gpt-6.0-sol" }), (error: unknown) => {
		assert.ok(error instanceof UnknownModel);
		assert.ok(error.suggestions.includes("gpt-6-sol"), `suggestions: ${error.suggestions.join(", ")}`);
		return true;
	});
	assert.doesNotThrow(() => assertKnownModel(opened.models, { provider: "openai", modelId: "gpt-6-sol" }));
	assert.doesNotThrow(() => assertKnownModel(opened.models, { provider: "faux", modelId: "anything" }));
});
