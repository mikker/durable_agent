// The base-document wrapper: unit cases over pi-durable's in-memory storage, then one streaming answer through a
// real Harness on faux against the test database.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ConversationId,
	DocumentCreate,
	DocumentId,
	JsonObject,
	Seq,
	Storage,
	StorageWrite,
	TaskId,
	TaskRecord,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { withBaseDocuments } from "../src/documents.ts";
import { bootTestSidecar, type TestSidecar } from "./sidecar.ts";

const context = BACKGROUND_CONTEXT;

/** A memory storage that records every batch it is asked to commit. */
const recording = () => {
	const memory = new MemoryStorage();
	const batches: StorageWrite[][] = [];
	const commit = memory.commit.bind(memory);
	memory.commit = (writes, ctx) => {
		batches.push([...writes]);
		return commit(writes, ctx);
	};
	return { memory, batches };
};

const seedConversation = async (storage: Storage): Promise<ConversationId> => {
	const id = await storage.mintId<ConversationId>();
	await storage.commit([{ type: "conversation", value: { id } }], context);
	return id;
};

const createDocument = async (
	storage: Storage,
	conversationId: ConversationId,
	history: "latest" | "rewindable",
	value: JsonObject,
): Promise<DocumentId> => {
	const id = await storage.mintId<DocumentId>();
	const record: DocumentCreate =
		history === "latest"
			? { id, kind: "test.doc", scope: { kind: "conversation", conversationId }, history, fork: "current" }
			: { id, kind: "test.rewindable", scope: { kind: "conversation", conversationId }, history, fork: "asOf" };
	await storage.commit([{ type: "document.create", record, content: { kind: "base", version: 1, value } }], context);
	return id;
};

const delta = (id: DocumentId, text: string): StorageWrite => ({
	type: "document.change",
	id,
	content: { kind: "delta", version: 1, ops: [["a", ["text"], text]] },
});

test("a delta on a latest document is committed as a base and reads back the same value", async () => {
	const { memory, batches } = recording();
	const storage = withBaseDocuments(memory);
	const conversationId = await seedConversation(storage);
	const id = await createDocument(storage, conversationId, "latest", { text: "Hel" });

	const { owners } = await storage.commitWithOwners([delta(id, "lo")], context);

	assert.deepEqual(batches.at(-1), [{ type: "document.change", id, content: { kind: "base", version: 1, value: { text: "Hello" } } }]);
	const stored = await storage.document(id, "current", context);
	assert.deepEqual(stored?.value, { text: "Hello" });
	assert.equal(stored?.version, 1);
	assert.equal(stored?.deltasSinceBase, 0);
	assert.deepEqual(owners, [conversationId]);
});

test("a delta on a task-scoped document is committed as a base too", async () => {
	const { memory, batches } = recording();
	const storage = withBaseDocuments(memory);
	const conversationId = await seedConversation(storage);
	const taskId = await storage.mintId<TaskId>();
	await storage.commit(
		[
			{
				type: "task",
				value: { id: taskId, conversationId, kind: "test.task", input: {}, state: { status: "pending" } } as unknown as TaskRecord<never, never, never>,
			},
		],
		context,
	);
	const id = await storage.mintId<DocumentId>();
	await storage.commit(
		[{ type: "document.create", record: { id, kind: "test.task-doc", scope: { kind: "task", taskId } }, content: { kind: "base", version: 1, value: { text: "Hel" } } }],
		context,
	);

	const { owners } = await storage.commitWithOwners([delta(id, "lo")], context);

	assert.deepEqual(batches.at(-1), [{ type: "document.change", id, content: { kind: "base", version: 1, value: { text: "Hello" } } }]);
	const stored = await storage.document(id, "current", context);
	assert.deepEqual(stored?.value, { text: "Hello" });
	assert.equal(stored?.deltasSinceBase, 0);
	assert.deepEqual(owners, [], "a task document names no conversation");
});

test("the current value is not mutated by the rewrite", async () => {
	const memory = new MemoryStorage();
	const storage = withBaseDocuments(memory);
	const conversationId = await seedConversation(storage);
	const id = await createDocument(storage, conversationId, "latest", { text: "a" });
	const before = await memory.document(id, "current", context);
	await storage.commit([delta(id, "b")], context);
	assert.deepEqual(before?.value, { text: "a" });
	assert.deepEqual((await memory.document(id, "current", context))?.value, { text: "ab" });
});

test("a delta on a rewindable document passes through untouched", async () => {
	const { memory, batches } = recording();
	const storage = withBaseDocuments(memory);
	const conversationId = await seedConversation(storage);
	const id = await createDocument(storage, conversationId, "rewindable", { text: "Hel" });

	const write = delta(id, "lo");
	await storage.commit([write], context);

	assert.deepEqual(batches.at(-1), [write]);
	const stored = await storage.document(id, "current", context);
	assert.deepEqual(stored?.value, { text: "Hello" });
	assert.equal(stored?.deltasSinceBase, 1);
});

test("concurrent commits are serialized: each delta applies on the value the previous one left", async () => {
	const memory = new MemoryStorage();
	let active = 0;
	let overlapped = false;
	const commit = memory.commit.bind(memory);
	const slow = async <T>(work: () => Promise<T>): Promise<T> => {
		active += 1;
		if (active > 1) overlapped = true;
		try {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return await work();
		} finally {
			active -= 1;
		}
	};
	memory.commit = (writes, ctx) => slow(() => commit(writes, ctx));
	const storage = withBaseDocuments(memory);
	const conversationId = await seedConversation(storage);
	const id = await createDocument(storage, conversationId, "latest", { text: "" });

	const seqs: Seq[] = await Promise.all(["a", "b", "c", "d"].map((text) => storage.commit([delta(id, text)], context)));

	assert.equal(overlapped, false);
	assert.deepEqual([...seqs].sort((x, y) => x - y), seqs);
	assert.deepEqual((await storage.document(id, "current", context))?.value, { text: "abcd" });
});

test("a failed commit does not block the next one", async () => {
	const storage = withBaseDocuments(new MemoryStorage());
	const conversationId = await seedConversation(storage);
	await assert.rejects(storage.commit([delta(999_999 as DocumentId, "x")], context));
	const id = await createDocument(storage, conversationId, "latest", { text: "ok" });
	assert.deepEqual((await storage.document(id, "current", context))?.value, { text: "ok" });
});

// Real Harness ---------------------------------------------------------------------------------------------------

let sidecar: TestSidecar;
const ANSWER = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

before(async () => {
	sidecar = await bootTestSidecar({
		models: (credentials) => {
			const models = createModels({ credentials });
			const faux = fauxProvider({ tokensPerSecond: 300 });
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage(ANSWER)]);
			return models;
		},
	});
});

after(async () => {
	await sidecar?.close();
});

type Revision = { kind: string; content: string };

const liveRevisions = async (conversationId: number): Promise<Revision[] | undefined> => {
	const live = await sidecar.db.get<{ id: number }>(
		"SELECT id FROM durable_agent_documents WHERE scope_kind = 'conversation' AND owner_id = ? AND kind = ? AND retired_at IS NULL",
		conversationId,
		JSON.stringify("pi.live"),
	);
	if (live === undefined) return undefined;
	return sidecar.db.all<Revision>("SELECT kind, content FROM durable_agent_document_revisions WHERE document_id = ?", live.id);
};

test("a streamed answer keeps pi.live at exactly one base revision, equal to the watched value", async () => {
	const { harness, config: { model } } = sidecar;
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const submission = await conversation.submit({ type: "input", content: "Hello", requestId: "documents-1" }, context);

	// While the answer streams, pi.live never checkpoints by itself; every row seen must still be a single base.
	let settled = false;
	const seen: string[] = [];
	const done = submission.wait(context).finally(() => {
		settled = true;
	});
	while (!settled) {
		const revisions = await liveRevisions(conversation.id);
		if (revisions !== undefined) seen.push(revisions.map((revision) => revision.kind).join(","));
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal((await done).status, "done");
	assert.ok(seen.length > 0, "pi.live was observed while streaming");
	assert.deepEqual([...new Set(seen)], ["base"]);

	const watch = await conversation.watch(context);
	try {
		const revisions = await liveRevisions(conversation.id);
		assert.equal(revisions?.length, 1);
		assert.equal(revisions?.[0]?.kind, "base");
		assert.deepEqual(JSON.parse(revisions?.[0]?.content ?? "null"), watch.value.docs["pi.live"]);
	} finally {
		await watch.stop();
	}
});
