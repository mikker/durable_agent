// Documents are stored as bases (DESIGN.md, "Documents are stored as bases"). pi-durable writes a streaming document
// as a base plus chord deltas and checkpoints only when the definition says so; Rails cannot replay chord deltas. This
// wrapper turns every delta on a current-only document (every one but a `history: "rewindable"` conversation document)
// into a base of the same version, so the storage core keeps exactly one revision row for it. Rewindable documents
// keep their deltas.
import type { Context } from "@earendil-works/chord/context";
import { apply } from "@earendil-works/chord/delta";
import type {
	ConversationId,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	JsonObject,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
} from "@earendil-works/pi-durable";
import { log } from "./log.ts";

/** Every `Storage` method, so a wrapper can bind the ones it does not override. Checked against the interface below. */
const STORAGE_METHODS = [
	"commit",
	"mintId",
	"conversation",
	"scanConversations",
	"entry",
	"findLatestHeadMarker",
	"scanEntries",
	"task",
	"scanTasks",
	"submission",
	"scanSubmissions",
	"submissionByRequest",
	"findDocument",
	"document",
	"scanDocuments",
	"close",
] as const satisfies readonly (keyof Storage)[];
type Missing = Exclude<keyof Storage, (typeof STORAGE_METHODS)[number]>;
const complete: [Missing] extends [never] ? true : Missing = true;
void complete;

/** `inner`'s methods bound to it, except `commit`, which every wrapper here supplies itself. */
export function delegateStorage(inner: Storage): Omit<Storage, "commit"> {
	const bound: Record<string, unknown> = {};
	for (const name of STORAGE_METHODS) {
		if (name === "commit") continue;
		bound[name] = (inner[name] as (...args: unknown[]) => unknown).bind(inner);
	}
	return bound as unknown as Omit<Storage, "commit">;
}

/** Document id → owning conversation, read through to storage on a miss. `null` marks a session or task document. */
export class DocumentConversations {
	readonly #inner: Storage;
	readonly #known = new Map<DocumentId, ConversationId | null>();

	constructor(inner: Storage) {
		this.#inner = inner;
	}

	remember(record: DocumentCreate | DocumentRecord): void {
		this.#known.set(record.id, record.scope.kind === "conversation" ? record.scope.conversationId : null);
	}

	forget(id: DocumentId): void {
		this.#known.delete(id);
	}

	async of(id: DocumentId, context: Context): Promise<ConversationId | undefined> {
		const known = this.#known.get(id);
		if (known !== undefined) return known ?? undefined;
		const stored = await this.#inner.document(id, "current", context);
		if (stored === undefined) return undefined;
		this.remember(stored.record);
		return this.#known.get(id) ?? undefined;
	}
}

export type BaseDocumentStorage = Storage & {
	/**
	 * `commit`, also naming the conversations that own the batch's `document.change` and `document.retire` writes.
	 * They are resolved before the commit: a retired document can no longer be read back, and a read after a durable
	 * commit must not be able to fail it. An owner that cannot be read is logged and left out; the commit goes ahead.
	 */
	commitWithOwners(writes: readonly StorageWrite[], context: Context): Promise<{ seq: Seq; owners: ConversationId[] }>;
};

type DocumentChange = Extract<StorageWrite, { type: "document.change" }>;

/** The storage core's own rule: every document except a rewindable conversation document keeps only its current value. */
const isCurrentOnly = (record: DocumentRecord): boolean => record.scope.kind !== "conversation" || record.history === "latest";

const rewriteAsBase = (write: DocumentChange, stored: StoredDocument | undefined): StorageWrite => {
	if (write.content.kind !== "delta" || stored === undefined || !isCurrentOnly(stored.record)) return write;
	// A version mismatch is an invalid batch; pass it through so the storage core rejects it as it would without us.
	if (stored.version !== write.content.version) return write;
	const value = apply<JsonObject>(structuredClone(stored.value), write.content.ops);
	return { type: "document.change", id: write.id, content: { kind: "base", version: write.content.version, value } };
};

export function withBaseDocuments(inner: Storage): BaseDocumentStorage {
	const conversations = new DocumentConversations(inner);
	// The read of the current value and the commit that replaces it must not interleave with another commit.
	let queue: Promise<unknown> = Promise.resolve();

	const ownerOf = async (id: DocumentId, context: Context): Promise<ConversationId | undefined> => {
		try {
			return await conversations.of(id, context);
		} catch (error) {
			log.warn("could not read a document's conversation; no change event for it", { document: id, error });
			return undefined;
		}
	};

	const prepare = async (writes: readonly StorageWrite[], context: Context) => {
		const rewritten: StorageWrite[] = [];
		const owners: ConversationId[] = [];
		for (const write of writes) {
			if (write.type === "document.create" || write.type === "document.copy") conversations.remember(write.record);
			if (write.type === "document.change" && write.content.kind === "delta") {
				// This read is the rewrite's, so it fails the commit: without the current value there is no base to write.
				const stored = await inner.document(write.id, "current", context);
				if (stored !== undefined) conversations.remember(stored.record);
				rewritten.push(rewriteAsBase(write, stored));
			} else {
				rewritten.push(write);
			}
			if (write.type === "document.change" || write.type === "document.retire") {
				const owner = await ownerOf(write.id, context);
				if (owner !== undefined) owners.push(owner);
			}
		}
		return { rewritten, owners };
	};

	const commitWithOwners = (writes: readonly StorageWrite[], context: Context) => {
		const run = queue.then(async () => {
			const { rewritten, owners } = await prepare(writes, context);
			const seq = await inner.commit(rewritten, context);
			for (const write of writes) if (write.type === "document.retire") conversations.forget(write.id);
			return { seq, owners };
		});
		queue = run.catch(() => undefined);
		return run;
	};

	return {
		...delegateStorage(inner),
		commit: async (writes, context) => (await commitWithOwners(writes, context)).seq,
		commitWithOwners,
	};
}
