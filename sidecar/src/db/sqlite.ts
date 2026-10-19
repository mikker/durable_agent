// SQLite through pi-durable's own node:sqlite adapter: WAL, synchronous = NORMAL and a 5 s busy timeout, the
// same settings Rails 8 uses, so Puma and the sidecar share the file.
import { resolve } from "node:path";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
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

export async function openSqliteDatabase(path: string): Promise<Db> {
	return new SqliteDb(await openNodeSqliteDatabase(path));
}

class SqliteDb implements Db {
	readonly dialect = "sqlite";
	readonly #inner: Inner;

	constructor(inner: Inner) {
		this.#inner = inner;
	}

	exec(sql: string): Promise<void> {
		return this.#inner.exec(sql);
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#inner.run(sql, ...params);
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#inner.get<T>(sql, ...params);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#inner.all<T>(sql, ...params);
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#inner.transaction(callback);
	}

	close(): Promise<void> {
		return this.#inner.close();
	}
}
