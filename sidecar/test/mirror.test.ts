// End to end inside one process: a Harness on the faux model, the mirror writing to Postgres, and the NOTIFY
// a Rails relay would receive.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pg from "pg";
import type { ConversationRecord } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { PostgresCredentialStore } from "../src/credentials.ts";
import { createProcessModels, type OpenedHarness, openHarness } from "../src/harness.ts";
import { Mirror, MIRROR_CHANNEL } from "../src/mirror.ts";
import { assertKnownModel, UnknownModel } from "../src/models-check.ts";
import { bootTestSidecar, faultyPool, type TestSidecar, testConfig, testPool, truncateMirror, until } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
let pool: pg.Pool;
let listener: pg.Client;
let opened: OpenedHarness;
let mirror: Mirror;
let sidecar: TestSidecar;
const notifications: { conversationId: number; entries?: number[]; docs?: string[]; submission?: { status: string } }[] = [];

before(async () => {
	pool = await testPool();
	listener = new pg.Client({ connectionString: pool.options.connectionString });
	await listener.connect();
	listener.on("notification", (message) => notifications.push(JSON.parse(message.payload ?? "{}")));
	await listener.query(`LISTEN ${MIRROR_CHANNEL}`);

	sidecar = await bootTestSidecar(pool, await testConfig());
	({ opened, mirror } = sidecar);
});

after(async () => {
	await sidecar.close();
	await listener.end();
	await pool.end();
});

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
		const rows = await pool.query("SELECT 1 FROM durable_agent_entries WHERE conversation_id = $1 AND kind = 'pi.assistant'", [conversation.id]);
		return (rows.rowCount ?? 0) > 0;
	});
	await until("submission done", async () => {
		const rows = await pool.query("SELECT status FROM durable_agent_submissions WHERE id = $1", [submission.id]);
		return rows.rows[0]?.status === "done";
	});

	const entries = await pool.query<{ kind: string }>("SELECT kind FROM durable_agent_entries WHERE conversation_id = $1 ORDER BY id", [conversation.id]);
	assert.deepEqual(entries.rows.map((row) => row.kind), ["pi.user", "pi.system", "pi.assistant"]);
	const docs = await pool.query<{ kind: string }>("SELECT kind FROM durable_agent_documents WHERE conversation_id = $1 ORDER BY kind", [conversation.id]);
	assert.deepEqual(docs.rows.map((row) => row.kind), ["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"]);

	await until("notifications", () => notifications.some((n) => n.conversationId === conversation.id && n.submission?.status === "done"));
	const entryNotes = notifications.filter((n) => n.conversationId === conversation.id && (n.entries?.length ?? 0) > 0);
	assert.ok(entryNotes.length > 0, "entry notifications were sent");

	// Same request id: the same submission, no duplicate row.
	const again = await conversation.submit({ type: "input", content: "Hello", requestId: "t-1" }, context);
	assert.equal(again.id, submission.id);
	const count = await pool.query("SELECT count(*)::int AS n FROM durable_agent_submissions WHERE conversation_id = $1", [conversation.id]);
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

// The tests below each run their own Harness, whose ids start at 1 again, so each starts from empty tables.

/** A Harness whose creation hook does nothing, and a mirror over `mirrorPool` that only attaches when told. */
async function unhookedMirror(config: Config, mirrorPool: pg.Pool) {
	const own = await openHarness(
		config,
		createProcessModels(config, new PostgresCredentialStore(pool, config.token)),
		{ onConversationCreated: () => undefined, onReport: () => undefined },
		context,
	);
	const ownMirror = new Mirror(mirrorPool, own.harness, config, context);
	await ownMirror.start();
	own.harness.resume();
	return {
		opened: own,
		mirror: ownMirror,
		close: async () => {
			await ownMirror.stop();
			await own.close(context);
		},
	};
}

const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await pool.query(sql, params)).rowCount ?? 0;
const assistantMirrored = (conversationId: number) => async () =>
	(await rowCount("SELECT 1 FROM durable_agent_entries WHERE conversation_id = $1 AND kind = 'pi.assistant'", [conversationId])) > 0;
const submissionStatus = async (id: number): Promise<string | undefined> =>
	(await pool.query("SELECT status FROM durable_agent_submissions WHERE id = $1", [id])).rows[0]?.status;

test("a settlement missed while Postgres failed is written by the next boot", async () => {
	await truncateMirror(pool);
	const config = await testConfig();
	let failed = 0;
	const flaky = faultyPool(pool, (sql) => {
		const settlement = sql.includes("INSERT INTO durable_agent_submissions") && sql.includes("DO UPDATE");
		if (settlement) failed++;
		return settlement;
	});
	const first = await bootTestSidecar(flaky, config, undefined, { reconcileMs: 60_000 });
	const conversation = await first.opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: first.opened.model } },
		context,
	);
	await first.mirror.attach(conversation.id);
	const draft = { type: "input", content: "Hello" } as const;
	const submission = await conversation.submit(draft, context);
	first.mirror.track(submission, conversation, draft);
	assert.equal((await submission.wait(context)).status, "done");
	await until("settlement write attempted", () => failed > 0);
	assert.equal(await submissionStatus(submission.id), "queued");
	await first.close();

	const second = await bootTestSidecar(pool, config);
	try {
		await until("row settled by the second boot", async () => (await submissionStatus(submission.id)) === "done");
		await until("assistant entry mirrored", assistantMirrored(conversation.id));
	} finally {
		await second.close();
	}
});

test("a failed attach registers nothing and the next attach mirrors the conversation", async () => {
	await truncateMirror(pool);
	let failures = 1;
	const flaky = faultyPool(pool, (sql) => sql.includes("INSERT INTO durable_agent_conversations") && failures-- > 0);
	const own = await unhookedMirror(await testConfig(), flaky);
	try {
		const conversation = await own.opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: own.opened.model } },
			context,
		);
		await assert.rejects(own.mirror.attach(conversation.id), /injected failure/);
		assert.equal(await rowCount("SELECT 1 FROM durable_agent_conversations WHERE id = $1", [conversation.id]), 0);

		await own.mirror.attach(conversation.id);
		// Resolved attach means the row and the first frame are already there.
		assert.equal(await rowCount("SELECT 1 FROM durable_agent_conversations WHERE id = $1", [conversation.id]), 1);
		const submission = await conversation.submit({ type: "input", content: "Hello" }, context);
		await submission.wait(context);
		await until("assistant entry mirrored", assistantMirrored(conversation.id));
	} finally {
		await own.close();
	}
});

test("the reconcile pass heals a failed final frame without further agent activity", async () => {
	await truncateMirror(pool);
	let down = false;
	let failed = 0;
	const flaky = faultyPool(pool, (sql) => {
		const frame = down && sql.startsWith("UPDATE durable_agent_conversations SET updated_at");
		if (frame) failed++;
		return frame;
	});
	const own = await bootTestSidecar(flaky, await testConfig(), undefined, { reconcileMs: 100 });
	try {
		const conversation = await own.opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: own.opened.model } },
			context,
		);
		await own.mirror.attach(conversation.id);
		down = true;
		const submission = await conversation.submit({ type: "input", content: "Hello" }, context);
		await submission.wait(context);
		await conversation.waitForIdle(context);
		await until("frame writes failed", () => failed > 0);
		assert.equal(await assistantMirrored(conversation.id)(), false);

		down = false;
		const watch = await conversation.watch(context);
		const live = watch.value.docs["pi.live"];
		await watch.stop();
		await until("assistant entry mirrored", assistantMirrored(conversation.id));
		await until("pi.live matches the harness", async () => {
			const rows = await pool.query("SELECT body FROM durable_agent_documents WHERE conversation_id = $1 AND kind = 'pi.live'", [
				conversation.id,
			]);
			return JSON.stringify(rows.rows[0]?.body) === JSON.stringify(live);
		});
	} finally {
		await own.close();
	}
});

test("a failing hook-driven attach is retried and never an unhandled rejection", async () => {
	await truncateMirror(pool);
	let failures = 2;
	const flaky = faultyPool(pool, (sql) => sql.includes("INSERT INTO durable_agent_conversations") && failures-- > 0);
	const own = await unhookedMirror(await testConfig(), flaky);
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		const conversation = await own.opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: own.opened.model } },
			context,
		);
		own.mirror.enqueue({ id: conversation.id } as ConversationRecord);
		await until("conversation mirrored after retries", async () =>
			(await rowCount("SELECT 1 FROM durable_agent_conversations WHERE id = $1", [conversation.id])) === 1,
		);
		assert.ok(failures < 0, "both injected failures were hit");
		assert.deepEqual(rejections, []);
	} finally {
		process.off("unhandledRejection", onRejection);
		await own.close();
	}
});
