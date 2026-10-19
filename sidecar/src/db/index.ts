// The database facade every sidecar module writes through: pi-durable's `SqliteDatabase` (exec/run/get/all/
// transaction/close, `?` placeholders, SQLite dialect) over the app's own database, SQLite or Postgres.
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openPostgresDatabase } from "./postgres.ts";
import { openSqliteDatabase, sqlitePath } from "./sqlite.ts";

export type Dialect = "postgres" | "sqlite";

export interface Db extends SqliteDatabase {
	readonly dialect: Dialect;
}

/** `postgres://…` / `postgresql://…`, or `sqlite:///abs/path`, `sqlite3:///abs/path`, `sqlite:relative/path`, `:memory:`. */
export async function openDatabase(url: string): Promise<Db> {
	if (/^postgres(ql)?:/i.test(url)) return openPostgresDatabase(url);
	const path = sqlitePath(url);
	if (path !== undefined) return openSqliteDatabase(path);
	throw new Error(`DATABASE_URL must be a postgres:// or sqlite:// URL, got ${JSON.stringify(redact(url))}`);
}

export function dialectOf(url: string): Dialect | undefined {
	if (/^postgres(ql)?:/i.test(url)) return "postgres";
	return sqlitePath(url) === undefined ? undefined : "sqlite";
}

const redact = (url: string): string => url.replace(/\/\/([^/@]*)@/, "//***@");
