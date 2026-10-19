// Mirror-to-Postgres: the sidecar is the only writer of agent state, Rails only reads it. Every committed frame of a
// conversation's view (new entries, changed documents) lands in the durable_agent_* tables, followed by a
// NOTIFY on durable_agent_mirror so the Rails relay can broadcast a Turbo refresh without polling.
//
// Entries are immutable and globally identified, so they are inserted once with ON CONFLICT DO NOTHING. Documents are
// upserted whole whenever their JSON changes. The mirror never blocks the Harness and converges after Postgres
// failures without waiting for agent activity:
// - attach is all or nothing: a conversation is registered only once its row, first frame and watch are in place, so a
//   failed attach can simply be retried (hook-driven attaches retry with backoff);
// - a failed frame write drops the in-memory bookkeeping and marks the conversation dirty; the periodic reconcile pass
//   rewrites the whole current view of every dirty conversation;
// - a failed settlement write is remembered and retried by the reconcile pass, and boot settles every row Postgres
//   still has as queued/placed from the Harness, which covers settlements missed while the sidecar was down.
import type { Context } from "@earendil-works/chord/context";
import type {
	Conversation,
	ConversationId,
	ConversationRecord,
	ConversationView,
	ConversationWatch,
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

export const MIRROR_CHANNEL = "durable_agent_mirror";

type Attached = {
	readonly watch: ConversationWatch;
	seenEntries: Set<number>;
	docHashes: Map<string, string>;
	/** The last frame write failed; the reconcile pass rewrites the whole view. */
	dirty: boolean;
	/** Frame writes and reconcile rewrites of one conversation run one at a time, in order. */
	writes: Promise<void>;
};

export type MirrorOptions = {
	/** How often failed frame and settlement writes are retried. */
	readonly reconcileMs?: number;
};

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

export class Mirror {
	readonly #pool: Pool;
	readonly #harness: Harness;
	readonly #config: Config;
	readonly #context: Context;
	readonly #attached = new Map<ConversationId, Attached>();
	readonly #attaching = new Map<ConversationId, Promise<void>>();
	readonly #waits = new Set<number>();
	/** Submissions whose settlement did not reach Postgres, with their conversation; the reconcile pass retries them. */
	readonly #unsettled = new Map<SubmissionId, ConversationId>();
	readonly #reconcileMs: number;
	#reconcileTimer: NodeJS.Timeout | undefined;
	#reconciling = false;
	#stopped = false;

	constructor(pool: Pool, harness: Harness, config: Config, context: Context, options: MirrorOptions = {}) {
		this.#pool = pool;
		this.#harness = harness;
		this.#config = config;
		this.#context = context;
		this.#reconcileMs = options.reconcileMs ?? 5_000;
	}

	/**
	 * Attach to every conversation in storage, re-arm waits for every unsettled submission, settle the rows Postgres
	 * still shows as unsettled, and start the reconcile pass.
	 */
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
		const stale = await this.#settleStaleRows();
		this.#reconcileTimer = setInterval(() => void this.#reconcile(), this.#reconcileMs);
		this.#reconcileTimer.unref();
		log.info("mirror started", {
			conversations: this.#attached.size,
			pendingSubmissions: inspection.submissions.length,
			staleRows: stale,
		});
	}

	/** Rows left queued/placed by a settlement the mirror missed: a failed write, or one that landed while it was down. */
	async #settleStaleRows(): Promise<number> {
		const rows = await this.#pool.query<{ id: string; conversation_id: string }>(
			"SELECT id, conversation_id FROM durable_agent_submissions WHERE status IN ('queued', 'placed')",
		);
		for (const row of rows.rows) {
			const submission = await this.#harness.submission(Number(row.id) as SubmissionId, this.#context);
			if (submission === undefined) log.warn("mirror: unsettled row unknown to the harness", { submissionId: row.id });
			else this.#awaitSettlement(submission, Number(row.conversation_id) as ConversationId);
		}
		return rows.rows.length;
	}

	/**
	 * Called from the Harness's `conversationCreated` hook, inside the creating commit. Attaching needs the commit to
	 * have landed, so it is scheduled for the next turn and retried briefly until the record is readable. A failed attach
	 * (Postgres) is logged and retried with backoff; nothing here may reject, an unhandled rejection would end the process.
	 */
	enqueue(record: ConversationRecord): void {
		const attempt = async (left: number, failures: number): Promise<void> => {
			if (this.#stopped) return;
			try {
				const conversation = await this.#harness.conversation(record.id, this.#context);
				if (conversation !== undefined) return await this.attach(record.id);
				if (left > 0) setTimeout(() => void attempt(left - 1, failures), 50).unref();
				else log.warn("created conversation never became readable", { conversationId: record.id });
			} catch (error) {
				if (this.#stopped) return;
				// The conversation must end up mirrored: retry until the attach lands, backing off up to 30 s.
				const delay = Math.min(100 * 2 ** failures, 30_000);
				log.error("mirror: attach failed, retrying", { conversationId: record.id, delay, error });
				setTimeout(() => void attempt(left, failures + 1), delay).unref();
			}
		};
		setImmediate(() => void attempt(20, 0));
	}

	async attach(id: ConversationId): Promise<void> {
		if (this.#attached.has(id)) return;
		const inFlight = this.#attaching.get(id);
		if (inFlight !== undefined) return inFlight;
		const promise = this.#attach(id).finally(() => this.#attaching.delete(id));
		this.#attaching.set(id, promise);
		return promise;
	}

	/** Registers the conversation only after its row, first frame and watch are in place; otherwise leaves nothing. */
	async #attach(id: ConversationId): Promise<void> {
		const conversation = await this.#harness.conversation(id, this.#context);
		if (conversation === undefined) return;
		const watch = await conversation.watch(this.#context);
		const attached: Attached = { watch, seenEntries: new Set(), docHashes: new Map(), dirty: false, writes: Promise.resolve() };
		try {
			await this.#upsertConversation(watch.value.conversation);
			const seeded = await this.#pool.query<{ id: string }>("SELECT id FROM durable_agent_entries WHERE conversation_id = $1", [id]);
			for (const row of seeded.rows) attached.seenEntries.add(Number(row.id));
			await this.#writeFrame(id, attached, watch.value);
			watch.start((value) => this.#queueFrame(id, attached, () => value));
		} catch (error) {
			await watch.stop().catch(() => undefined);
			throw error;
		}
		this.#attached.set(id, attached);
		void watch.closed.then((end) => {
			if (this.#attached.get(id) === attached) this.#attached.delete(id);
			if (!this.#stopped) log.warn("conversation watch ended", { conversationId: id, end });
		});
	}

	/** Record a submission the API just made and update its row once it settles. */
	track(submission: Submission, conversation: Conversation, draft: SubmissionDraft): void {
		void this.#pool
			.query(
				`INSERT INTO durable_agent_submissions (id, conversation_id, request_id, type, status)
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
			.then(() => this.#unsettled.delete(submission.id))
			.catch((error) => {
				if (this.#stopped) return;
				this.#unsettled.set(submission.id, conversationId);
				log.error("mirror: submission settlement not mirrored, will retry", { submissionId: submission.id, error });
			})
			.finally(() => this.#waits.delete(submission.id));
	}

	/** Retries what failed, independent of agent activity: dirty conversations and unwritten settlements. */
	async #reconcile(): Promise<void> {
		if (this.#reconciling || this.#stopped) return;
		this.#reconciling = true;
		try {
			for (const [id, attached] of this.#attached) {
				if (attached.dirty) await this.#queueFrame(id, attached, () => attached.watch.value);
			}
			for (const [submissionId, conversationId] of this.#unsettled) {
				if (this.#stopped) return;
				const submission = await this.#harness.submission(submissionId, this.#context);
				if (submission === undefined) {
					this.#unsettled.delete(submissionId);
					log.warn("mirror: unsettled submission unknown to the harness", { submissionId });
				} else this.#awaitSettlement(submission, conversationId);
			}
		} catch (error) {
			log.error("mirror: reconcile failed", { error });
		} finally {
			this.#reconciling = false;
		}
	}

	async #writeSubmission(record: SubmissionRecord, conversationId: ConversationId): Promise<void> {
		await this.#pool.query(
			`INSERT INTO durable_agent_submissions (id, conversation_id, request_id, type, status, entry_id, answer_entry_id, reason, detail)
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
			`INSERT INTO durable_agent_conversations (id, parent_conversation_id, parent_at_entry_id, owner_conversation_id, owner_task_id)
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

	/** Queue a frame write behind the conversation's earlier ones; `view` is read when the write runs. */
	#queueFrame(id: ConversationId, attached: Attached, view: () => ConversationView): Promise<void> {
		attached.writes = attached.writes.then(() => this.#mirrorFrame(id, attached, view()));
		return attached.writes;
	}

	async #mirrorFrame(id: ConversationId, attached: Attached, view: ConversationView): Promise<void> {
		try {
			await this.#writeFrame(id, attached, view);
		} catch (error) {
			log.error("mirror: frame write failed, reconcile will rewrite the view", { conversationId: id, error });
		}
	}

	/** On failure, forgets what was mirrored and marks the conversation dirty, so the next write re-upserts everything. */
	async #writeFrame(id: ConversationId, attached: Attached, view: ConversationView): Promise<void> {
		const entries = view.entries.filter((entry) => !attached.seenEntries.has(entry.id));
		const docs: { kind: string; body: string }[] = [];
		for (const [kind, body] of Object.entries(view.docs)) {
			if (this.#config.mirrorDocs !== undefined && !this.#config.mirrorDocs.has(kind)) continue;
			const hash = JSON.stringify(body);
			if (attached.docHashes.get(kind) !== hash) docs.push({ kind, body: hash });
		}
		if (entries.length === 0 && docs.length === 0) {
			attached.dirty = false;
			return;
		}

		let client: PoolClient | undefined;
		try {
			client = await this.#pool.connect();
			await client.query("BEGIN");
			for (const entry of entries) {
				await client.query(
					`INSERT INTO durable_agent_entries (id, conversation_id, kind, data, model, head_entry_id, by_task_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
					[entry.id, id, entry.kind, json(entry.data), json(entry.model), entry.head ?? null, entry.byTaskId ?? null],
				);
			}
			for (const doc of docs) {
				await client.query(
					`INSERT INTO durable_agent_documents (conversation_id, kind, body) VALUES ($1, $2, $3)
					 ON CONFLICT (conversation_id, kind) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
					[id, doc.kind, doc.body],
				);
			}
			await client.query("UPDATE durable_agent_conversations SET updated_at = now() WHERE id = $1", [id]);
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
			attached.dirty = false;
		} catch (error) {
			await client?.query("ROLLBACK").catch(() => undefined);
			attached.seenEntries.clear();
			attached.docHashes.clear();
			attached.dirty = true;
			throw error;
		} finally {
			client?.release();
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#reconcileTimer);
		await Promise.all([...this.#attached.values()].map((attached) => attached.watch.stop()));
		this.#attached.clear();
	}
}

export type { EntryId, SubmissionId };
