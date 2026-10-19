import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { type Db, dialectOf, openDatabase } from "../src/db/index.ts";
import { isConnectionError, PostgresDatabase } from "../src/db/postgres.ts";
import { sqlitePath } from "../src/db/sqlite.ts";
import { openTestDatabase, TEST_DATABASE_URL, TEST_DIALECT, tempDir } from "./helpers.ts";

let db: Db;
before(async () => {
	db = await openTestDatabase();
});
after(() => db.close());

/** node:sqlite rows have a null prototype; pg rows do not. */
const plain = (row: object | undefined): object | undefined => (row === undefined ? undefined : { ...row });

const setting = async (key: string): Promise<string | undefined> =>
	(await db.get<{ value: string }>("SELECT value FROM durable_agent_settings WHERE key = ?", key))?.value;

const insertSetting = (executor: Pick<Db, "run">, key: string, value: string) =>
	executor.run("INSERT INTO durable_agent_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)", key, value);

test("database URLs pick the adapter by scheme; sqlite paths resolve absolute or from the cwd", () => {
	assert.equal(dialectOf("postgres://localhost/x"), "postgres");
	assert.equal(dialectOf("postgresql://u:p@h:5432/x?sslmode=require"), "postgres");
	assert.equal(dialectOf("sqlite:///var/db/x.sqlite3"), "sqlite");
	assert.equal(dialectOf("mysql://localhost/x"), undefined);
	assert.equal(sqlitePath("sqlite:///var/db/x.sqlite3"), "/var/db/x.sqlite3");
	assert.equal(sqlitePath("sqlite3:///var/db/x.sqlite3"), "/var/db/x.sqlite3");
	assert.equal(sqlitePath("sqlite:storage/x.sqlite3"), join(process.cwd(), "storage/x.sqlite3"));
	assert.equal(sqlitePath("sqlite::memory:"), ":memory:");
	assert.equal(sqlitePath(":memory:"), ":memory:");
	assert.throws(() => sqlitePath("sqlite://host/x.sqlite3"), /host/);
});

test("an unsupported URL is refused without echoing the password", async () => {
	await assert.rejects(openDatabase("mysql://root:hunter2@localhost/x"), (error: Error) => {
		assert.match(error.message, /postgres:\/\/ or sqlite:\/\//);
		assert.doesNotMatch(error.message, /hunter2/);
		return true;
	});
});

test("an in-memory SQLite database opens with the sqlite dialect", async () => {
	const memory = await openDatabase(":memory:");
	assert.equal(memory.dialect, "sqlite");
	assert.deepEqual(plain(await memory.get("SELECT 1 + ? AS two", 1)), { two: 2 });
	await memory.close();
});

test("a SQLite file is opened in WAL mode, as Rails opens it", { skip: TEST_DIALECT !== "sqlite" }, async () => {
	const file = await openDatabase(`sqlite://${join(await tempDir(), "wal.sqlite3")}`);
	assert.deepEqual(plain(await file.get("PRAGMA journal_mode")), { journal_mode: "wal" });
	await file.close();
});

test(`[${TEST_DIALECT}] an operation issued during a transaction waits until the transaction commits`, async () => {
	const order: string[] = [];
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started: () => void = () => {};
	const inside = new Promise<void>((resolve) => {
		started = resolve;
	});
	const transaction = db.transaction(async (tx) => {
		await insertSetting(tx, "isolation", "committed");
		started();
		await gate;
		order.push("commit");
	});
	await inside;
	const read = setting("isolation").then((value) => {
		order.push("read");
		return value;
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(order, [], "the read must not run while the transaction is open");
	release();
	await transaction;
	assert.equal(await read, "committed");
	assert.deepEqual(order, ["commit", "read"]);
});

test(`[${TEST_DIALECT}] a failing callback rolls back and rejects with its own error`, async () => {
	const failure = new Error("callback failed");
	let handle: Pick<Db, "run"> | undefined;
	await assert.rejects(
		db.transaction(async (tx) => {
			handle = tx;
			await insertSetting(tx, "rolled_back", "x");
			throw failure;
		}),
		(error) => error === failure,
	);
	assert.equal(await setting("rolled_back"), undefined);
	assert.ok(handle);
	await assert.rejects(insertSetting(handle, "late", "x"), /no longer active/);
	assert.equal(await setting("ok"), undefined, "the database keeps working after a rollback");
});

test(`[${TEST_DIALECT}] bigint columns read back as numbers`, async () => {
	await db.run(
		"INSERT INTO durable_agent_record_ids (id, record_type) VALUES (?, ?)",
		Number.MAX_SAFE_INTEGER,
		"entry",
	);
	assert.deepEqual(plain(await db.get("SELECT id FROM durable_agent_record_ids WHERE id = ?", Number.MAX_SAFE_INTEGER)), {
		id: Number.MAX_SAFE_INTEGER,
	});
	assert.deepEqual(plain(await db.get("SELECT COUNT(*) AS n FROM durable_agent_record_ids")), { n: 1 });
});

const connectionError = (): Error => Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });

test("connection-class errors are recognised by code and message", () => {
	assert.ok(isConnectionError(connectionError()));
	assert.ok(isConnectionError(Object.assign(new Error("x"), { code: "08006" })));
	assert.ok(isConnectionError(Object.assign(new Error("x"), { code: "ECONNRESET" })));
	assert.ok(isConnectionError(new Error("Connection terminated unexpectedly")));
	assert.ok(!isConnectionError(Object.assign(new Error("x"), { code: "23505" })));
	assert.ok(!isConnectionError(undefined));
});

/** A pool whose next `failures` queries (pooled or on a checked-out client) fail with `error()` before reaching Postgres. */
function flakyPool(failures: { pooled: number; error: () => Error }): { pool: pg.Pool; attempts: string[] } {
	const attempts: string[] = [];
	const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
	const query = pool.query.bind(pool) as (sql: string, params?: unknown[]) => Promise<unknown>;
	const proxy = new Proxy(pool, {
		get: (target, key) => {
			if (key === "query") {
				return (sql: string, params?: unknown[]) => {
					attempts.push(sql);
					if (failures.pooled > 0) {
						failures.pooled--;
						return Promise.reject(failures.error());
					}
					return query(sql, params);
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { pool: proxy, attempts };
}

test("[postgres] a statement that lost its connection is retried once", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const { pool, attempts } = flakyPool({ pooled: 1, error: connectionError });
	const flaky = new PostgresDatabase(pool);
	assert.deepEqual(plain(await flaky.get("SELECT ? :: int AS n", 7)), { n: 7 });
	assert.equal(attempts.length, 2);
	await flaky.close();
});

test("[postgres] a second connection error, or any other error, is not retried", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const twice = flakyPool({ pooled: 2, error: connectionError });
	const flaky = new PostgresDatabase(twice.pool);
	await assert.rejects(flaky.get("SELECT 1 AS n"), /administrator command/);
	assert.equal(twice.attempts.length, 2);
	await flaky.close();

	const other = flakyPool({ pooled: 1, error: () => Object.assign(new Error("duplicate key"), { code: "23505" }) });
	const strict = new PostgresDatabase(other.pool);
	await assert.rejects(strict.get("SELECT 1 AS n"), /duplicate key/);
	assert.equal(other.attempts.length, 1);
	await strict.close();
});

test("[postgres] a connection error inside a transaction is not retried", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const failure = connectionError();
	let calls = 0;
	await assert.rejects(
		db.transaction(async () => {
			calls++;
			throw failure;
		}),
		(error) => error === failure,
	);
	assert.equal(calls, 1);
});

test("[postgres] CURRENT_TIMESTAMP is stored in UTC", { skip: TEST_DIALECT !== "postgres" }, async () => {
	await insertSetting(db, "clock", "x");
	const row = await db.get<{ skew: number }>(
		"SELECT ABS(EXTRACT(EPOCH FROM (updated_at - (now() AT TIME ZONE 'UTC')))) AS skew FROM durable_agent_settings WHERE key = ?",
		"clock",
	);
	assert.ok(Number(row?.skew) < 60, `skew ${row?.skew}`);
});
