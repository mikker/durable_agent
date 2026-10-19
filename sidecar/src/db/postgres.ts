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
	const pool = new pg.Pool({ connectionString: inUtc(url), max: 2, types });
	pool.on("error", (error) => log.warn("postgres: idle client error", { error }));
	const db = new PostgresDatabase(pool);
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

type Queryable = Pick<pg.Pool, "query">;

const bind = (params: SqliteValue[]): unknown[] =>
	params.map((value) => (typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Buffer.from(value) : value));

// Errors after which the same statement can be sent again on another connection: the server or the network
// dropped the connection, so the statement never ran (or ran and was rolled back with its implicit transaction).
const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"]);

export function isConnectionError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && (CONNECTION_CODES.has(code) || code.startsWith("08"))) return true;
	return error instanceof Error && /Connection terminated|connection ended|Client has encountered a connection error/i.test(error.message);
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
	}

	exec(sql: string): Promise<void> {
		return this.#outside(() => this.#direct.exec(sql));
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#outside(() => this.#direct.run(sql, ...params));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#outside(() => this.#direct.get<T>(sql, ...params));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#outside(() => this.#direct.all<T>(sql, ...params));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#serial(async () => {
			this.#assertOpen();
			const client = await this.#begin();
			let active = true;
			const handle = new Executor(() => {
				if (!active) throw new Error("Postgres transaction handle is no longer active");
				return client;
			});
			let broken: Error | undefined;
			try {
				const result = await callback(handle);
				active = false;
				await client.query("COMMIT");
				return result;
			} catch (error) {
				active = false;
				try {
					await client.query("ROLLBACK");
				} catch (rollbackError) {
					broken = rollbackError as Error;
					throw new AggregateError([error, rollbackError], "Postgres transaction failed and rollback failed");
				}
				throw error;
			} finally {
				client.release(broken);
			}
		});
	}

	// Nothing has run yet when checkout or BEGIN fails, so a connection error there is retried like a statement.
	async #begin(retry = true): Promise<pg.PoolClient> {
		const client = await this.#pool.connect().catch((error: unknown) => {
			if (retry && isConnectionError(error)) return undefined;
			throw error;
		});
		if (client === undefined) return this.#begin(false);
		try {
			await client.query("BEGIN");
			return client;
		} catch (error) {
			client.release(error as Error);
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

	// pi-durable treats a failed storage call as fatal to the session, so a statement that lost its connection
	// (an idle client the server dropped, a failover) gets one more try on a fresh one.
	#outside<T>(operation: () => Promise<T>): Promise<T> {
		return this.#serial(async () => {
			this.#assertOpen();
			try {
				return await operation();
			} catch (error) {
				if (!isConnectionError(error)) throw error;
				log.warn("postgres: retrying after a connection error", { error });
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
