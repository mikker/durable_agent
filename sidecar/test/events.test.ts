// Change events: the tracker names the conversations a commit touched, and `Events` posts them, batched, to a fake
// Rails that records every request body.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ConversationId,
	DocumentId,
	EntryId,
	Seq,
	StorageWrite,
	SubmissionId,
	SubmissionRecord,
	TaskRecord,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { Models } from "@earendil-works/pi-ai";
import { Logins } from "../src/auth.ts";
import { type BaseDocumentStorage, delegateStorage, withBaseDocuments } from "../src/documents.ts";
import { ChangeTracker, DEBOUNCE_MS, Events } from "../src/events.ts";
import { until } from "./helpers.ts";
import { bootTestSidecar } from "./sidecar.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "events-test-token";

type Received = { readonly at: number; readonly authorization: string | undefined; readonly body: unknown };
const received: Received[] = [];
/** Statuses for the next requests, in order; 204 once empty. */
let statuses: number[] = [];
let rails: Server;
let railsUrl: string;

before(async () => {
	rails = createServer(async (request, response) => {
		let text = "";
		for await (const chunk of request) text += String(chunk);
		if (request.method === "POST" && request.url === "/durable_agent/events") {
			received.push({ at: Date.now(), authorization: request.headers.authorization, body: JSON.parse(text) });
			response.writeHead(statuses.shift() ?? 204).end();
			return;
		}
		if (request.method === "GET" && request.url === "/durable_agent/tools") {
			response.writeHead(200, { "content-type": "application/json" }).end("[]");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
	railsUrl = `http://127.0.0.1:${(rails.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((resolve) => rails.close(resolve));
});

beforeEach(() => {
	received.length = 0;
	statuses = [];
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("changes and reports within the debounce window coalesce into one POST", async () => {
	const events = new Events({ railsUrl, token: TOKEN });
	events.changed(7);
	events.changed(9);
	events.report(3);
	events.changed(7);
	await sleep(DEBOUNCE_MS * 3);
	await events.flush();
	assert.equal(received.length, 1);
	assert.equal(received[0]?.authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(received[0]?.body, { conversations: [7, 9], reports: [3] });
});

test("a steady stream of changes still posts every debounce interval", async () => {
	const events = new Events({ railsUrl, token: TOKEN });
	const started = Date.now();
	while (Date.now() - started < DEBOUNCE_MS * 4) {
		events.changed(1);
		await sleep(10);
	}
	await events.flush();
	assert.ok(received.length >= 3, `posted ${received.length} times`);
	assert.ok(received.length <= 6, `posted ${received.length} times`);
});

test("a failed POST is retried once after a second", async () => {
	statuses = [500, 204];
	const events = new Events({ railsUrl, token: TOKEN });
	events.changed(4);
	await events.flush();
	assert.equal(received.length, 2);
	assert.deepEqual(received[0]?.body, { conversations: [4], reports: [] });
	assert.deepEqual(received[1]?.body, received[0]?.body);
	const gap = (received[1]?.at ?? 0) - (received[0]?.at ?? 0);
	assert.ok(gap >= 950, `retried after ${gap} ms`);
});

test("a persistent failure is dropped after the one retry", async () => {
	statuses = [500, 503];
	const events = new Events({ railsUrl, token: TOKEN });
	events.changed(5);
	await events.flush();
	assert.equal(received.length, 2);

	events.changed(6);
	await events.flush();
	assert.equal(received.length, 3);
	assert.deepEqual(received[2]?.body, { conversations: [6], reports: [] });
});

test("a network error is retried once and then dropped", async () => {
	let calls = 0;
	const timers = { setTimeout: (callback: () => void) => setTimeout(callback, 0), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
	const events = new Events({
		railsUrl,
		token: TOKEN,
		timers,
		fetch: async () => {
			calls += 1;
			throw new TypeError("fetch failed");
		},
	});
	events.report(1);
	await events.flush();
	assert.equal(calls, 2);
});

test("without a Rails URL nothing is ever fetched", async () => {
	let calls = 0;
	const events = new Events({
		railsUrl: undefined,
		token: TOKEN,
		fetch: async () => {
			calls += 1;
			return new Response(null, { status: 204 });
		},
	});
	events.changed(1);
	events.report(2);
	await sleep(DEBOUNCE_MS * 2);
	await events.flush();
	assert.equal(calls, 0);
});

// ChangeTracker ----------------------------------------------------------------------------------------------------

/** Records what the tracker announces. */
const sink = () => {
	const changed: number[] = [];
	return { changed, events: { changed: (id: number) => void changed.push(id) } };
};

/** An inner storage that accepts every batch and knows the owners of the documents in `owners`. */
const fakeInner = (owners: Map<number, number>, fail = false): BaseDocumentStorage => {
	const commitWithOwners = async (writes: readonly StorageWrite[]) => {
		if (fail) throw new Error("commit failed");
		const named = writes.flatMap((write) =>
			write.type === "document.change" || write.type === "document.retire" ? [owners.get(write.id) as ConversationId] : [],
		);
		return { seq: 1 as Seq, owners: named.filter((owner) => owner !== undefined) };
	};
	return {
		...delegateStorage(new MemoryStorage()),
		commit: async (writes) => (await commitWithOwners(writes)).seq,
		commitWithOwners,
	};
};

const id = <T>(value: number) => value as T;

test("the tracker maps each kind of write to its conversation and ignores tasks", async () => {
	const { changed, events } = sink();
	const tracker = new ChangeTracker(fakeInner(new Map([[50, 11], [51, 12]])), events);
	const writes: StorageWrite[] = [
		{ type: "conversation", value: { id: id<ConversationId>(10) } },
		{ type: "entry", value: { id: id<EntryId>(100), conversationId: id<ConversationId>(13), kind: "pi.user" } },
		{
			type: "submission",
			value: { id: id<SubmissionId>(101), conversationId: id<ConversationId>(14), type: "input", status: "queued" } as unknown as SubmissionRecord,
		},
		{ type: "task", value: { id: 102, conversationId: 99 } as unknown as TaskRecord<never, never, never> },
		{
			type: "document.create",
			record: { id: id<DocumentId>(52), kind: "pi.live", scope: { kind: "conversation", conversationId: id<ConversationId>(15) }, history: "latest", fork: "current" },
			content: { kind: "base", version: 1, value: {} },
		},
		{
			type: "document.create",
			record: { id: id<DocumentId>(53), kind: "x", scope: { kind: "session" } },
			content: { kind: "base", version: 1, value: {} },
		},
		{ type: "document.change", id: id<DocumentId>(50), content: { kind: "delta", version: 1, ops: [] } },
		{ type: "document.retire", id: id<DocumentId>(51) },
	];
	await tracker.commit(writes, context);
	assert.deepEqual([...changed].sort((a, b) => a - b), [10, 11, 12, 13, 14, 15]);
});

test("a failed commit announces nothing", async () => {
	const { changed, events } = sink();
	const tracker = new ChangeTracker(fakeInner(new Map(), true), events);
	await assert.rejects(tracker.commit([{ type: "conversation", value: { id: id<ConversationId>(1) } }], context));
	assert.deepEqual(changed, []);
});

test("over real storage, document changes and retirements resolve through the cache and storage", async () => {
	const memory = new MemoryStorage();
	const { changed, events } = sink();
	const tracker = new ChangeTracker(withBaseDocuments(memory), events);
	const conversationId = await tracker.mintId<ConversationId>();
	await tracker.commit([{ type: "conversation", value: { id: conversationId } }], context);
	const documentId = await tracker.mintId<DocumentId>();
	await tracker.commit(
		[
			{
				type: "document.create",
				record: { id: documentId, kind: "pi.live", scope: { kind: "conversation", conversationId }, history: "latest", fork: "current" },
				content: { kind: "base", version: 1, value: { text: "" } },
			},
		],
		context,
	);
	changed.length = 0;

	// A fresh tracker over the same storage has an empty cache and reads the owner from storage.
	const cold = sink();
	const fresh = new ChangeTracker(withBaseDocuments(memory), cold.events);
	await fresh.commit([{ type: "document.change", id: documentId, content: { kind: "delta", version: 1, ops: [["a", ["text"], "hi"]] } }], context);
	assert.deepEqual(cold.changed, [conversationId]);

	await tracker.commit([{ type: "document.retire", id: documentId }], context);
	assert.deepEqual(changed, [conversationId]);
});

/** A conversation with one latest document, written through a tracker, and a memory storage whose reads can fail. */
const documentFixture = async () => {
	const memory = new MemoryStorage();
	const read = memory.document.bind(memory);
	const failing = { reads: false };
	memory.document = (...args) => {
		if (failing.reads) return Promise.reject(new Error("read failed"));
		return read(...args);
	};
	const setup = new ChangeTracker(withBaseDocuments(memory), sink().events);
	const conversationId = await setup.mintId<ConversationId>();
	const otherId = await setup.mintId<ConversationId>();
	const documentId = await setup.mintId<DocumentId>();
	await setup.commit(
		[
			{ type: "conversation", value: { id: conversationId } },
			{ type: "conversation", value: { id: otherId } },
			{
				type: "document.create",
				record: { id: documentId, kind: "pi.live", scope: { kind: "conversation", conversationId }, history: "latest", fork: "current" },
				content: { kind: "base", version: 1, value: { text: "" } },
			},
		],
		context,
	);
	const entryId = await setup.mintId<EntryId>();
	const batch: StorageWrite[] = [
		{ type: "entry", value: { id: entryId, conversationId: otherId, kind: "test.entry" } },
		{ type: "document.change", id: documentId, content: { kind: "base", version: 1, value: { text: "checkpoint" } } },
	];
	return { memory, failing, conversationId, otherId, documentId, batch };
};

test("a read that fails after the commit cannot fail it: owners are resolved before", async (t) => {
	t.mock.method(process.stdout, "write", () => true);
	const { memory, failing, conversationId, otherId, documentId, batch } = await documentFixture();
	const commit = memory.commit.bind(memory);
	memory.commit = async (writes, ctx) => {
		const seq = await commit(writes, ctx);
		failing.reads = true;
		return seq;
	};
	// A fresh tracker has an empty cache, as after a restart.
	const { changed, events } = sink();
	await new ChangeTracker(withBaseDocuments(memory), events).commit(batch, context);
	failing.reads = false;
	assert.deepEqual([...changed].sort((a, b) => a - b), [conversationId, otherId]);
	assert.deepEqual((await memory.document(documentId, "current", context))?.value, { text: "checkpoint" });
});

test("a failed pre-commit owner read still commits and announces nothing for that document", async (t) => {
	const lines: string[] = [];
	t.mock.method(process.stdout, "write", (line: unknown) => void lines.push(String(line)));
	const { memory, failing, otherId, documentId, batch } = await documentFixture();
	failing.reads = true;
	const { changed, events } = sink();
	await new ChangeTracker(withBaseDocuments(memory), events).commit(batch, context);
	failing.reads = false;
	t.mock.restoreAll();
	assert.deepEqual(changed, [otherId]);
	assert.deepEqual((await memory.document(documentId, "current", context))?.value, { text: "checkpoint" });
	assert.ok(lines.some((line) => /"level":"warn".*could not read a document's conversation/.test(line)), "the skipped owner is logged");
});

test("a sink that throws after the commit does not reject it", async (t) => {
	t.mock.method(process.stdout, "write", () => true);
	const tracker = new ChangeTracker(fakeInner(new Map()), {
		changed: () => {
			throw new Error("sink broke");
		},
	});
	assert.equal(await tracker.commit([{ type: "conversation", value: { id: id<ConversationId>(1) } }], context), 1);
});

// Auth events --------------------------------------------------------------------------------------------------------

test("sign-in changes are posted as auth, and the key is left out when none changed", async () => {
	const events = new Events({ railsUrl, token: TOKEN });
	events.auth("openai");
	events.changed(3);
	events.auth("openai");
	await events.flush();
	events.changed(4);
	await events.flush();
	assert.deepEqual(
		received.map((request) => request.body),
		[
			{ conversations: [3], reports: [], auth: ["openai"] },
			{ conversations: [4], reports: [] },
		],
	);
});

test("a completed login and a logout each announce the provider", async () => {
	const announced: string[] = [];
	const models = {
		login: async (_provider: string, _type: string, { notify }: { notify: (event: unknown) => void }) => {
			notify({ type: "auth_url", url: "https://auth.example/authorize" });
		},
		logout: async () => {},
	} as unknown as Models;
	const logins = new Logins(models, "device", "test", (provider) => announced.push(provider));
	const login = await logins.start("openai");
	await until("the login to finish", () => login.status === "done");
	assert.deepEqual(announced, ["openai"]);
	await logins.logout("anthropic");
	assert.deepEqual(announced, ["openai", "anthropic"]);
});

test("a real Harness run announces its conversation to Rails", async () => {
	const sidecar = await bootTestSidecar({ config: { token: TOKEN, railsUrl } });
	try {
		const { harness, config: { model } } = sidecar;
		await sidecar.events.flush();
		received.length = 0;
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const submission = await conversation.submit({ type: "input", content: "Hello", requestId: "events-1" }, context);
		await submission.wait(context);
		await sidecar.events.flush();
		assert.ok(received.length >= 1);
		const ids = new Set(received.flatMap((request) => (request.body as { conversations: number[] }).conversations));
		assert.deepEqual([...ids], [conversation.id]);
	} finally {
		await sidecar.close();
	}
});
