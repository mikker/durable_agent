// Change events (DESIGN.md, "Change events"). After each commit the tracker names the conversations it touched;
// `Events` batches them with new report ids and changed sign-ins and posts `{conversations, reports, auth?}` to
// Rails, which refreshes pages.
// Events are a hint: the state is in the database, so a failed post is retried once and then dropped.
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { type BaseDocumentStorage, delegateStorage } from "./documents.ts";
import { log } from "./log.ts";

export const DEBOUNCE_MS = 100;
const RETRY_MS = 1_000;
const POST_TIMEOUT_MS = 10_000;

type Timers = {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

type EventsOptions = {
	readonly railsUrl: string | undefined;
	readonly token: string;
	readonly fetch?: typeof fetch;
	readonly timers?: Timers;
};

const realTimers: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** `auth` is left out when no sign-in changed. */
type Batch = { readonly conversations: number[]; readonly reports: number[]; readonly auth?: string[] };

export class Events {
	readonly #url: URL | undefined;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #timers: Timers;
	readonly #conversations = new Set<number>();
	readonly #reports = new Set<number>();
	readonly #auth = new Set<string>();
	readonly #inFlight = new Set<Promise<void>>();
	#timer: unknown;

	constructor({ railsUrl, token, fetch: fetchImpl = fetch, timers = realTimers }: EventsOptions) {
		this.#url = railsUrl === undefined ? undefined : new URL("/durable_agent/events", railsUrl);
		this.#token = token;
		this.#fetch = fetchImpl;
		this.#timers = timers;
		if (this.#url === undefined) log.info("DURABLE_AGENT_RAILS_URL is not set; change events are disabled");
	}

	changed(conversationId: number): void {
		if (this.#url === undefined) return;
		this.#conversations.add(conversationId);
		this.#schedule();
	}

	report(id: number): void {
		if (this.#url === undefined) return;
		this.#reports.add(id);
		this.#schedule();
	}

	/** A provider was signed in or out. */
	auth(provider: string): void {
		if (this.#url === undefined) return;
		this.#auth.add(provider);
		this.#schedule();
	}

	/** Send whatever is pending now and wait for every post, retries included. */
	async flush(): Promise<void> {
		if (this.#timer !== undefined) {
			this.#timers.clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#send();
		while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
	}

	// A timer that is already armed is not pushed back, so a steady stream still posts every DEBOUNCE_MS.
	#schedule(): void {
		if (this.#timer !== undefined) return;
		this.#timer = this.#timers.setTimeout(() => {
			this.#timer = undefined;
			this.#send();
		}, DEBOUNCE_MS);
	}

	#send(): void {
		if (this.#conversations.size === 0 && this.#reports.size === 0 && this.#auth.size === 0) return;
		const batch: Batch = {
			conversations: [...this.#conversations],
			reports: [...this.#reports],
			...(this.#auth.size === 0 ? {} : { auth: [...this.#auth] }),
		};
		this.#conversations.clear();
		this.#reports.clear();
		this.#auth.clear();
		const delivery = this.#deliver(batch).finally(() => this.#inFlight.delete(delivery));
		this.#inFlight.add(delivery);
	}

	async #deliver(batch: Batch): Promise<void> {
		const first = await this.#post(batch);
		if (first === undefined) return;
		await new Promise<void>((resolve) => this.#timers.setTimeout(resolve, RETRY_MS));
		const second = await this.#post(batch);
		if (second !== undefined) log.warn("change event dropped after one retry", { ...batch, error: second });
	}

	/** `undefined` on success, else what went wrong. */
	async #post(batch: Batch): Promise<unknown> {
		try {
			const response = await this.#fetch(this.#url as URL, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
				body: JSON.stringify(batch),
				signal: AbortSignal.timeout(POST_TIMEOUT_MS),
			});
			await response.body?.cancel();
			return response.ok ? undefined : `HTTP ${response.status}`;
		} catch (error) {
			return error;
		}
	}
}

type ChangeSink = Pick<Events, "changed">;

/**
 * Wraps `commit` to announce the conversations each successful commit touched. Task writes are ignored. Owners are
 * resolved before the commit (see `commitWithOwners`), and nothing after the commit can reject it: the batch is
 * durable by then, and pi-durable would treat a rejection as a failed session.
 */
export interface ChangeTracker extends Storage {}
// The interface declares the read methods the constructor binds through to `inner`.
export class ChangeTracker {
	readonly #inner: BaseDocumentStorage;
	readonly #events: ChangeSink;

	constructor(inner: BaseDocumentStorage, events: ChangeSink) {
		Object.assign(this, delegateStorage(inner));
		this.#inner = inner;
		this.#events = events;
	}

	async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		const { seq, owners } = await this.#inner.commitWithOwners(writes, context);
		try {
			for (const id of new Set([...directOwners(writes), ...owners])) this.#events.changed(id);
		} catch (error) {
			log.warn("change event not queued after a commit", { error });
		}
		return seq;
	}
}

/** The conversations a batch names without a read; document changes and retirements are resolved by the wrapper. */
function directOwners(writes: readonly StorageWrite[]): ConversationId[] {
	const ids: ConversationId[] = [];
	for (const write of writes) {
		switch (write.type) {
			case "conversation":
				ids.push(write.value.id);
				break;
			case "entry":
			case "submission":
				ids.push(write.value.conversationId);
				break;
			case "document.create":
			case "document.copy":
				if (write.record.scope.kind === "conversation") ids.push(write.record.scope.conversationId);
				break;
			default:
				break;
		}
	}
	return ids;
}
