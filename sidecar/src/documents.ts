// Documents are stored as bases (DESIGN.md, "Documents are stored as bases"). pi-durable writes a streaming document
// as a base plus chord deltas and checkpoints only when the definition says so; Rails cannot replay chord deltas. This
// wrapper turns every delta on a `history: "latest"` document into a base of the same version, so the storage core
// keeps exactly one revision row for it. Rewindable documents keep their deltas.
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
	/** The conversation owning a document, or `undefined` for session and task documents and unknown ids. */
	conversationOf(id: DocumentId, context: Context): Promise<ConversationId | undefined>;
};

const rewriteAsBase = (write: Extract<StorageWrite, { type: "document.change" }>, stored: StoredDocument | undefined): StorageWrite => {
	if (write.content.kind !== "delta" || stored === undefined) return write;
	if (stored.record.scope.kind !== "conversation" || stored.record.history !== "latest") return write;
	// A version mismatch is an invalid batch; pass it through so the storage core rejects it as it would without us.
	if (stored.version !== write.content.version) return write;
	const value = apply<JsonObject>(structuredClone(stored.value), write.content.ops);
	return { type: "document.change", id: write.id, content: { kind: "base", version: write.content.version, value } };
};

export function withBaseDocuments(inner: Storage): BaseDocumentStorage {
	const conversations = new DocumentConversations(inner);
	// The read of the current value and the commit that replaces it must not interleave with another commit.
	let queue: Promise<unknown> = Promise.resolve();

	const rewrite = async (writes: readonly StorageWrite[], context: Context): Promise<StorageWrite[]> => {
		const rewritten: StorageWrite[] = [];
		for (const write of writes) {
			if (write.type === "document.create" || write.type === "document.copy") conversations.remember(write.record);
			if (write.type !== "document.change" || write.content.kind !== "delta") {
				rewritten.push(write);
				continue;
			}
			const stored = await inner.document(write.id, "current", context);
			if (stored !== undefined) conversations.remember(stored.record);
			rewritten.push(rewriteAsBase(write, stored));
		}
		return rewritten;
	};

	const commit = (writes: readonly StorageWrite[], context: Context): Promise<Seq> => {
		const run = queue.then(async () => {
			const seq = await inner.commit(await rewrite(writes, context), context);
			for (const write of writes) if (write.type === "document.retire") conversations.forget(write.id);
			return seq;
		});
		queue = run.catch(() => undefined);
		return run;
	};

	return {
		...delegateStorage(inner),
		commit,
		conversationOf: (id, context) => conversations.of(id, context),
	};
}
