// SQLite through pi-durable's own node:sqlite adapter: WAL, synchronous = NORMAL and `BEGIN IMMEDIATE`, the
// settings Rails 8 uses, so Puma and the sidecar share the file. node:sqlite waits for a busy lock synchronously,
// stalling the event loop, so its busy timeout is short and the long wait happens here, asynchronously.
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { log } from "../log.ts";
import type { Db } from "./index.ts";

type Inner = Awaited<ReturnType<typeof openNodeSqliteDatabase>>;

/** The file a `sqlite:` / `sqlite3:` URL names; relative paths resolve from the cwd. `undefined` for other URLs. */
export function sqlitePath(url: string): string | undefined {
	if (url === ":memory:") return url;
	const match = /^sqlite3?:(.*)$/i.exec(url);
	if (match === null) return undefined;
	let rest = match[1] as string;
	if (rest.startsWith("//")) {
		rest = rest.slice(2);
		if (rest !== ":memory:" && !rest.startsWith("/")) {
			throw new Error(`sqlite URLs with a host are not supported, use sqlite:///absolute/path: ${url}`);
		}
	}
	rest = rest.replace(/\?.*$/, "");
	if (rest === "") throw new Error(`sqlite URL without a path: ${url}`);
	return rest === ":memory:" ? rest : resolve(rest);
}

/** How long node:sqlite itself waits for a lock, blocking the event loop, before an attempt fails. */
export const SQLITE_BUSY_TIMEOUT_MS = 100;

/**
 * How long a transaction or statement keeps retrying, asynchronously, while another writer holds the write lock.
 * No other writer may hold it longer than this: past it the storage call fails, and pi-durable fails the session.
 */
export const SQLITE_BUSY_BUDGET_MS = 30_000;

const FIRST_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 500;
const SQLITE_BUSY = 5;

export function isBusyError(error: unknown): boolean {
	const errcode = (error as { errcode?: unknown } | null)?.errcode;
	if (typeof errcode === "number") return (errcode & 0xff) === SQLITE_BUSY;
	return error instanceof Error && /database is locked/i.test(error.message);
}

export async function openSqliteDatabase(path: string, options: { busyBudgetMs?: number } = {}): Promise<Db> {
	const inner = await openNodeSqliteDatabase(path, { busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS });
	return new SqliteDb(inner, options.busyBudgetMs ?? SQLITE_BUSY_BUDGET_MS);
}

/**
 * Adds the asynchronous busy wait on top of pi-durable's adapter, with a serial queue of its own: the inner queue
 * is released while a retry backs off, so this one keeps later operations behind the transaction.
 */
class SqliteDb implements Db {
	readonly dialect = "sqlite";
	readonly #inner: Inner;
	readonly #budgetMs: number;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(inner: Inner, budgetMs: number) {
		this.#inner = inner;
		this.#budgetMs = budgetMs;
	}

	// A multi-statement script may have committed part of itself before a later statement found the lock taken.
	exec(sql: string): Promise<void> {
		return this.#serial(() => this.#inner.exec(sql));
	}

	// An autocommit statement that fails busy has not run, so it is retried like a BEGIN IMMEDIATE.
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#serial(() => this.#whileBusy(() => this.#inner.run(sql, ...params)));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#serial(() => this.#whileBusy(() => this.#inner.get<T>(sql, ...params)));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#serial(() => this.#whileBusy(() => this.#inner.all<T>(sql, ...params)));
	}

	// Only a busy BEGIN IMMEDIATE is retried: once the callback has started, its statements may have run.
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#serial(() => {
			let started = false;
			const attempt = () =>
				this.#inner.transaction((tx) => {
					started = true;
					return callback(tx);
				});
			return this.#whileBusy(attempt, () => !started);
		});
	}

	close(): Promise<void> {
		return this.#serial(() => this.#inner.close());
	}

	async #whileBusy<T>(attempt: () => Promise<T>, retryable: () => boolean = () => true): Promise<T> {
		const deadline = Date.now() + this.#budgetMs;
		for (let backoff = FIRST_BACKOFF_MS; ; backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)) {
			try {
				return await attempt();
			} catch (error) {
				if (!isBusyError(error) || !retryable()) throw error;
				const wait = Math.min(backoff, deadline - Date.now());
				if (wait <= 0) throw this.#timedOut(error);
				if (backoff === FIRST_BACKOFF_MS) log.warn("sqlite: database is locked, waiting for the other writer", { error });
				await sleep(wait);
			}
		}
	}

	#timedOut(error: unknown): Error {
		return new Error(`SQLite database is locked: another writer held the write lock for more than ${this.#budgetMs} ms`, { cause: error });
	}

	#serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.catch(() => undefined);
		return result;
	}
}
