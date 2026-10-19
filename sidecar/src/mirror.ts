// Mirror-to-Postgres: the sidecar is the only writer of agent state, Rails only reads it. Every committed frame of a
// conversation's view (new entries, changed documents) lands in the agent_* tables, followed by a NOTIFY so Rails can
// broadcast a Turbo Stream or wake a job without polling.
//
// Entries are immutable and globally identified, so they are inserted once with ON CONFLICT DO NOTHING. Documents are
// upserted whole whenever their JSON changes. A failed write drops the in-memory bookkeeping, so the next frame
// re-upserts everything the view holds; the mirror converges without ever blocking the Harness.
import type { Context } from "@earendil-works/chord/context";
import type {
	Conversation,
	ConversationId,
	ConversationRecord,
	ConversationView,
	Cursor,
	EntryId,
	Harness,
	Submission,
	SubmissionDraft,
	SubmissionId,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Pool, PoolClient } from "pg";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export const MIRROR_CHANNEL = "agent_mirror";

type Attached = {
	readonly stop: () => Promise<unknown>;
	seenEntries: Set<number>;
	docHashes: Map<string, string>;
};

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

export class Mirror {
	readonly #pool: Pool;
	readonly #harness: Harness;
	readonly #config: Config;
	readonly #context: Context;
	readonly #attached = new Map<number, Attached>();
	readonly #attaching = new Map<number, Promise<void>>();
	readonly #waits = new Set<number>();
	#stopped = false;

	constructor(pool: Pool, harness: Harness, config: Config, context: Context) {
		this.#pool = pool;
		this.#harness = harness;
		this.#config = config;
		this.#context = context;
	}

	/** Attach to every conversation in storage and re-arm waits for every unsettled submission. */
	async start(): Promise<void> {
		// 1.3.0 exposes the conversation scan on a transaction only; this commit writes nothing.
		let cursor: Cursor | undefined;
		do {
			const page = await this.#harness.commit((tx) => tx.scanConversations({}, 200, cursor), this.#context);
			for (const record of page.items) await this.attach(record.id);
			cursor = page.next;
		} while (cursor !== undefined);

		const inspection = await this.#harness.inspect(this.#context);
		for (const record of inspection.submissions) {
			const submission = await this.#harness.submission(record.id, this.#context);
			if (submission !== undefined) this.#awaitSettlement(submission, record.conversationId);
		}
		log.info("mirror started", { conversations: this.#attached.size, pendingSubmissions: inspection.submissions.length });
	}

	/**
	 * Called from the Harness's `conversationCreated` hook, inside the creating commit. Attaching needs the commit to
	 * have landed, so it is scheduled for the next turn and retried briefly until the record is readable.
	 */
	enqueue(record: ConversationRecord): void {
		const attempt = async (left: number): Promise<void> => {
			if (this.#stopped) return;
			const conversation = await this.#harness.conversation(record.id, this.#context);
			if (conversation !== undefined) return this.attach(record.id);
			if (left > 0) setTimeout(() => void attempt(left - 1), 50);
			else log.warn("created conversation never became readable", { conversationId: record.id });
		};
		setImmediate(() => void attempt(20));
	}

	async attach(id: ConversationId): Promise<void> {
		if (this.#attached.has(id)) return;
		const inFlight = this.#attaching.get(id);
		if (inFlight !== undefined) return inFlight;
		const promise = this.#attach(id).finally(() => this.#attaching.delete(id));
		this.#attaching.set(id, promise);
		return promise;
	}

	async #attach(id: ConversationId): Promise<void> {
		const conversation = await this.#harness.conversation(id, this.#context);
		if (conversation === undefined) return;
		const watch = await conversation.watch(this.#context);
		const attached: Attached = { stop: () => watch.stop(), seenEntries: new Set(), docHashes: new Map() };
		this.#attached.set(id, attached);

		await this.#upsertConversation(watch.value.conversation);
		const seeded = await this.#pool.query<{ id: string }>("SELECT id FROM agent_entries WHERE conversation_id = $1", [id]);
		for (const row of seeded.rows) attached.seenEntries.add(Number(row.id));

		await this.#writeFrame(id, attached, watch.value);
		watch.start((value) => this.#writeFrame(id, attached, value));
		void watch.closed.then((end) => {
			this.#attached.delete(id);
			if (!this.#stopped) log.warn("conversation watch ended", { conversationId: id, end });
		});
	}

	/** Record a submission the API just made and update its row once it settles. */
	track(submission: Submission, conversation: Conversation, draft: SubmissionDraft): void {
		void this.#pool
			.query(
				`INSERT INTO agent_submissions (id, conversation_id, request_id, type, status)
				 VALUES ($1, $2, $3, $4, 'queued') ON CONFLICT (id) DO NOTHING`,
				[submission.id, conversation.id, draft.requestId ?? null, draft.type],
			)
			.catch((error) => log.error("mirror: submission insert failed", { submissionId: submission.id, error }));
		this.#awaitSettlement(submission, conversation.id);
	}

	#awaitSettlement(submission: Submission, conversationId: ConversationId): void {
		if (this.#waits.has(submission.id)) return;
		this.#waits.add(submission.id);
		void submission
			.wait(this.#context)
			.then((record) => this.#writeSubmission(record, conversationId))
			.catch((error) => log.error("mirror: submission wait failed", { submissionId: submission.id, error }))
			.finally(() => this.#waits.delete(submission.id));
	}

	async #writeSubmission(record: SubmissionRecord, conversationId: ConversationId): Promise<void> {
		await this.#pool.query(
			`INSERT INTO agent_submissions (id, conversation_id, request_id, type, status, entry_id, answer_entry_id, reason, detail)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (id) DO UPDATE SET
			   status = EXCLUDED.status, entry_id = EXCLUDED.entry_id, answer_entry_id = EXCLUDED.answer_entry_id,
			   reason = EXCLUDED.reason, detail = EXCLUDED.detail, updated_at = now()`,
			[
				record.id,
				conversationId,
				record.requestId ?? null,
				record.type,
				record.status,
				record.entry ?? null,
				record.answer ?? null,
				record.reason ?? null,
				json(record.detail),
			],
		);
		await this.#pool.query("SELECT pg_notify($1, $2)", [
			MIRROR_CHANNEL,
			JSON.stringify({ conversationId, submission: { id: record.id, status: record.status } }),
		]);
	}

	async #upsertConversation(record: ConversationRecord): Promise<void> {
		await this.#pool.query(
			`INSERT INTO agent_conversations (id, parent_conversation_id, parent_at_entry_id, owner_conversation_id, owner_task_id)
			 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
			[
				record.id,
				record.parent?.conversationId ?? null,
				record.parent?.at ?? null,
				record.owner?.conversationId ?? null,
				record.owner?.taskId ?? null,
			],
		);
	}

	async #writeFrame(id: ConversationId, attached: Attached, view: ConversationView): Promise<void> {
		const entries = view.entries.filter((entry) => !attached.seenEntries.has(entry.id));
		const docs: { kind: string; body: string }[] = [];
		for (const [kind, body] of Object.entries(view.docs)) {
			if (this.#config.mirrorDocs !== undefined && !this.#config.mirrorDocs.has(kind)) continue;
			const hash = JSON.stringify(body);
			if (attached.docHashes.get(kind) !== hash) docs.push({ kind, body: hash });
		}
		if (entries.length === 0 && docs.length === 0) return;

		let client: PoolClient | undefined;
		try {
			client = await this.#pool.connect();
			await client.query("BEGIN");
			for (const entry of entries) {
				await client.query(
					`INSERT INTO agent_entries (id, conversation_id, kind, data, model, head_entry_id, by_task_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
					[entry.id, id, entry.kind, json(entry.data), json(entry.model), entry.head ?? null, entry.byTaskId ?? null],
				);
			}
			for (const doc of docs) {
				await client.query(
					`INSERT INTO agent_documents (conversation_id, kind, body) VALUES ($1, $2, $3)
					 ON CONFLICT (conversation_id, kind) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
					[id, doc.kind, doc.body],
				);
			}
			await client.query("UPDATE agent_conversations SET updated_at = now() WHERE id = $1", [id]);
			await client.query("SELECT pg_notify($1, $2)", [
				MIRROR_CHANNEL,
				JSON.stringify({
					conversationId: id,
					entries: entries.slice(0, 50).map((entry) => entry.id),
					docs: docs.map((doc) => doc.kind),
				}),
			]);
			await client.query("COMMIT");
			for (const entry of entries) attached.seenEntries.add(entry.id);
			for (const doc of docs) attached.docHashes.set(doc.kind, doc.body);
		} catch (error) {
			await client?.query("ROLLBACK").catch(() => undefined);
			// Forget what was mirrored; the next frame re-upserts the whole view and converges.
			attached.seenEntries.clear();
			attached.docHashes.clear();
			log.error("mirror: frame write failed, will resync on next frame", { conversationId: id, error });
		} finally {
			client?.release();
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		await Promise.all([...this.#attached.values()].map((attached) => attached.stop()));
		this.#attached.clear();
	}
}

export type { EntryId, SubmissionId };
