// Postgres behind pi-durable's SQLite facade. The storage core's SQL goes through translate.ts; this file adds the
// facade's transaction contract on top of a pg.Pool: one operation at a time, in call order, and nothing else runs
// while a transaction is open (as pi-durable's node:sqlite adapter does).
import type { SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import pg from "pg";
import { log } from "../log.ts";
import type { Db } from "./index.ts";
import { toPostgres } from "./translate.ts";

const INT8_OID = 20;

// Ids and seqs are safe integers, and `next_id` is text, so int8 parses to a number rather than pg's string.
const types = {
	getTypeParser: ((oid: number, format?: "text" | "binary") =>
		oid === INT8_OID && format !== "binary" ? (value: string) => Number(value) : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export async function openPostgresDatabase(url: string): Promise<Db> {
	const db = new PostgresDatabase(new pg.Pool({ connectionString: inUtc(url), max: 2, types }));
	await db.get("SELECT 1 AS ok");
	return db;
}

// `CURRENT_TIMESTAMP` lands in `timestamp without time zone` columns, which Rails reads as UTC. Set as a startup
// option (appended to any `options` the URL carries) so it holds on every pooled connection from the start.
export function inUtc(url: string): string {
	const parsed = new URL(url);
	const options = [parsed.searchParams.get("options"), "-c TimeZone=UTC"].filter(Boolean).join(" ");
	parsed.searchParams.set("options", options);
	return parsed.toString();
}

interface Queryable {
	query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const bind = (params: SqliteValue[]): unknown[] =>
	params.map((value) => (typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Buffer.from(value) : value));

const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"]);

/** The server or the network dropped the connection. Whether the statement ran is unknown. */
export function isConnectionError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && (CONNECTION_CODES.has(code) || code.startsWith("08"))) return true;
	return error instanceof Error && /Connection terminated|connection ended|Client has encountered a connection error/i.test(error.message);
}

const LEADING_COMMENTS = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/;

/**
 * A statement that may be sent again after its connection dropped: a plain SELECT. A lost response may hide a
 * committed write, so INSERT, UPDATE, DELETE, CTEs and `exec` scripts are never repeated.
 */
export function isRetryable(sql: string): boolean {
	return /^SELECT\b/i.test(sql.replace(LEADING_COMMENTS, ""));
}

/**
 * A client checked out of the pool for one transaction. pg-pool removes its idle `error` listener on checkout, and
 * a dropped connection emits `error` on the client, which would otherwise be an uncaught exception. The listener
 * stays until release, fails the pending and every later query, and the client is then released broken, so the
 * pool discards it.
 */
class Checkout implements Queryable {
	readonly #client: pg.PoolClient;
	readonly #lost: Promise<never>;
	readonly #onError: (error: Error) => void;
	#broken: Error | undefined;

	constructor(client: pg.PoolClient) {
		this.#client = client;
		let fail: (error: Error) => void = () => {};
		this.#lost = new Promise<never>((_resolve, reject) => {
			fail = reject;
		});
		this.#lost.catch(() => {});
		this.#onError = (error) => {
			this.#broken ??= error;
			fail(error);
		};
		client.on("error", this.#onError);
	}

	get broken(): boolean {
		return this.#broken !== undefined;
	}

	async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
		if (this.#broken !== undefined) throw this.#broken;
		try {
			return await Promise.race([this.#client.query(sql, params), this.#lost]);
		} catch (error) {
			if (isConnectionError(error)) this.#broken ??= error as Error;
			throw error;
		}
	}

	/** Have release() destroy the client rather than return it to the pool. */
	discard(error: unknown): void {
		this.#broken ??= error as Error;
	}

	release(): void {
		this.#client.removeListener("error", this.#onError);
		this.#client.release(this.#broken);
	}
}

class Executor implements SqliteExecutor {
	readonly #target: () => Queryable;

	constructor(target: () => Queryable) {
		this.#target = target;
	}

	async exec(sql: string): Promise<void> {
		await this.#target().query(toPostgres(sql));
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		await this.#target().query(toPostgres(sql), bind(params));
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return (await this.all<T>(sql, ...params))[0];
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		const result = await this.#target().query(toPostgres(sql), bind(params));
		return result.rows as T[];
	}
}

export class PostgresDatabase implements Db {
	readonly dialect = "postgres";
	readonly #pool: pg.Pool;
	readonly #direct: Executor;
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(pool: pg.Pool) {
		this.#pool = pool;
		this.#direct = new Executor(() => pool);
		if (pool.listenerCount("error") === 0) pool.on("error", (error) => log.warn("postgres: idle client error", { error }));
	}

	exec(sql: string): Promise<void> {
		return this.#outside(false, () => this.#direct.exec(sql));
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#outside(isRetryable(sql), () => this.#direct.run(sql, ...params));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#outside(isRetryable(sql), () => this.#direct.get<T>(sql, ...params));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#outside(isRetryable(sql), () => this.#direct.all<T>(sql, ...params));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#serial(async () => {
			this.#assertOpen();
			const checkout = await this.#begin();
			try {
				return await this.#commit(checkout, callback);
			} finally {
				checkout.release();
			}
		});
	}

	async #commit<T>(checkout: Checkout, callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		let active = true;
		const handle = new Executor(() => {
			if (!active) throw new Error("Postgres transaction handle is no longer active");
			return checkout;
		});
		try {
			const result = await callback(handle);
			active = false;
			await checkout.query("COMMIT");
			return result;
		} catch (error) {
			active = false;
			throw await this.#rollback(checkout, error);
		}
	}

	// A lost connection rolls the transaction back on the server; the client is discarded on release.
	async #rollback(checkout: Checkout, error: unknown): Promise<unknown> {
		if (checkout.broken || isConnectionError(error)) {
			checkout.discard(error);
			return error;
		}
		try {
			await checkout.query("ROLLBACK");
			return error;
		} catch (rollbackError) {
			checkout.discard(rollbackError);
			return new AggregateError([error, rollbackError], "Postgres transaction failed and rollback failed");
		}
	}

	// Nothing has run yet when checkout or BEGIN fails, so a connection error there is retried once.
	async #begin(retry = true): Promise<Checkout> {
		const client = await this.#pool.connect().catch((error: unknown) => {
			if (retry && isConnectionError(error)) return undefined;
			throw error;
		});
		if (client === undefined) return this.#begin(false);
		const checkout = new Checkout(client);
		try {
			await checkout.query("BEGIN");
			return checkout;
		} catch (error) {
			checkout.discard(error);
			checkout.release();
			if (retry && isConnectionError(error)) return this.#begin(false);
			throw error;
		}
	}

	close(): Promise<void> {
		return this.#serial(async () => {
			if (this.#closed) return;
			this.#closed = true;
			await this.#pool.end();
		});
	}

	// pi-durable treats a failed storage call as fatal to the session, so a SELECT that lost its connection (an
	// idle client the server dropped, a failover) gets one more try on a fresh one.
	#outside<T>(retryable: boolean, operation: () => Promise<T>): Promise<T> {
		return this.#serial(async () => {
			this.#assertOpen();
			try {
				return await operation();
			} catch (error) {
				if (!retryable || !isConnectionError(error)) throw error;
				log.warn("postgres: retrying a SELECT after a connection error", { error });
				return operation();
			}
		});
	}

	#serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.catch(() => undefined);
		return result;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Postgres database is closed");
	}
}
