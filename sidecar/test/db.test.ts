import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { type Db, dialectOf, openDatabase } from "../src/db/index.ts";
import { isConnectionError, isRetryable, PostgresDatabase } from "../src/db/postgres.ts";
import { isBusyError, openSqliteDatabase, SQLITE_BUSY_BUDGET_MS, sqlitePath } from "../src/db/sqlite.ts";
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

/**
 * A pool whose next `failures.pooled` pooled queries fail with `error()`: before reaching Postgres, or with
 * `lost: true` after Postgres ran them (the response was lost).
 */
function flakyPool(failures: { pooled: number; error: () => Error; lost?: boolean }): { pool: pg.Pool; attempts: string[] } {
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
						const reached = failures.lost ? query(sql, params) : Promise.resolve();
						return reached.then(() => Promise.reject(failures.error()));
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

test("only a plain SELECT is retryable", () => {
	assert.ok(isRetryable("SELECT 1"));
	assert.ok(isRetryable("  \n\tselect * FROM t"));
	assert.ok(isRetryable("-- why\nSELECT 1"));
	assert.ok(isRetryable("/* a\nb */ -- c\n SELECT 1"));
	assert.ok(!isRetryable("SELECTION"));
	assert.ok(!isRetryable("INSERT INTO t (a) VALUES (?) RETURNING id"));
	assert.ok(!isRetryable("UPDATE t SET a = 1"));
	assert.ok(!isRetryable("DELETE FROM t"));
	assert.ok(!isRetryable("WITH x AS (DELETE FROM t RETURNING id) SELECT id FROM x"));
	assert.ok(!isRetryable("-- SELECT\nINSERT INTO t DEFAULT VALUES"));
});

const reportCount = async (): Promise<number> => Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM durable_agent_reports"))?.n);

const insertReport = (executor: Pick<Db, "get">) =>
	executor.get<{ id: number }>(
		"INSERT INTO durable_agent_reports (type, message, info, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) RETURNING id",
		"error",
		"lost",
		"{}",
	);

const resetByPeer = (): Error => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

test("[postgres] a write whose response was lost is not sent again", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const before = await reportCount();
	const { pool, attempts } = flakyPool({ pooled: 3, error: resetByPeer, lost: true });
	const lossy = new PostgresDatabase(pool);
	await assert.rejects(insertReport(lossy), /ECONNRESET/);
	await assert.rejects(lossy.run("UPDATE durable_agent_reports SET message = ? WHERE message = ?", "x", "lost"), /ECONNRESET/);
	await assert.rejects(lossy.exec("DELETE FROM durable_agent_reports WHERE message = 'none'"), /ECONNRESET/);
	assert.equal(attempts.length, 3, "each statement was sent exactly once");
	assert.equal(await reportCount(), before + 1, "the insert ran once");
	await lossy.close();
});

test("[postgres] a SELECT whose response was lost is sent again", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const { pool, attempts } = flakyPool({ pooled: 1, error: resetByPeer, lost: true });
	const lossy = new PostgresDatabase(pool);
	assert.deepEqual(plain(await lossy.get("-- probe\nSELECT ? :: int AS n", 3)), { n: 3 });
	assert.equal(attempts.length, 2);
	await lossy.close();
});

/** Collects uncaught exceptions until stopped, so a crash shows up as an assertion instead of killing the run. */
function watchUncaught(): { errors: unknown[]; stop(): void } {
	const errors: unknown[] = [];
	const listener = (error: unknown) => errors.push(error);
	process.on("uncaughtException", listener);
	return { errors, stop: () => process.off("uncaughtException", listener) };
}

async function withAdmin<T>(use: (admin: pg.Client) => Promise<T>): Promise<T> {
	const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
	await admin.connect();
	try {
		return await use(admin);
	} finally {
		await admin.end();
	}
}

const backendPid = async (tx: Pick<Db, "get">): Promise<number> =>
	Number((await tx.get<{ pid: number }>("SELECT pg_backend_pid() AS pid"))?.pid);

const terminate = (admin: pg.Client, pid: number) => admin.query("SELECT pg_terminate_backend($1)", [pid]);

test("[postgres] a connection lost inside a transaction rejects it and the database stays usable", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const uncaught = watchUncaught();
	try {
		await withAdmin(async (admin) => {
			let killed: Promise<unknown> = Promise.resolve();
			await assert.rejects(
				db.transaction(async (tx) => {
					const pid = await backendPid(tx);
					killed = sleep(200).then(() => terminate(admin, pid));
					await tx.get("SELECT pg_sleep(2)");
				}),
				(error) => isConnectionError(error),
			);
			await killed;
		});
		await sleep(100);
		assert.deepEqual(plain(await db.get("SELECT ? :: int AS n", 1)), { n: 1 });
		assert.deepEqual(uncaught.errors, []);
	} finally {
		uncaught.stop();
	}
});

test("[postgres] transactions under random connection kills each commit or reject, none crash", { skip: TEST_DIALECT !== "postgres" }, async () => {
	const uncaught = watchUncaught();
	const outcomes = { committed: 0, rejected: 0 };
	try {
		await withAdmin(async (admin) => {
			const kills: Promise<unknown>[] = [];
			for (let i = 0; i < 30; i++) {
				const outcome = await db
					.transaction(async (tx) => {
						const pid = await backendPid(tx);
						if (Math.random() < 0.5) kills.push(sleep(Math.random() * 50).then(() => terminate(admin, pid)));
						await insertSetting(tx, `stress_${i}`, "x");
						await sleep(Math.random() * 30);
						await tx.get("SELECT pg_sleep(0.02)");
					})
					.then(
						() => "committed" as const,
						(error: unknown) => {
							assert.ok(isConnectionError(error), `not a connection error: ${error}`);
							return "rejected" as const;
						},
					);
				outcomes[outcome]++;
				assert.equal(await setting(`stress_${i}`), outcome === "committed" ? "x" : undefined);
			}
			await Promise.all(kills);
		});
		await sleep(100);
		assert.deepEqual(plain(await db.get("SELECT ? :: int AS n", 1)), { n: 1 });
		assert.deepEqual(uncaught.errors, []);
		assert.equal(outcomes.committed + outcomes.rejected, 30);
		assert.ok(outcomes.rejected > 0, "some transaction lost its connection");
	} finally {
		uncaught.stop();
	}
});

/** Another connection to the same SQLite file takes the write lock (as Puma would) and holds it for `ms`. */
function holdWriteLock(path: string, ms: number): Promise<void> {
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	return sleep(ms).then(() => {
		other.exec("COMMIT");
		other.close();
	});
}

async function sqliteFile(options: { busyBudgetMs?: number } = {}): Promise<{ db: Db; path: string }> {
	const path = join(await tempDir(), "busy.sqlite3");
	const file = await openSqliteDatabase(path, options);
	await file.exec("CREATE TABLE t (v text NOT NULL)");
	return { db: file, path };
}

test("the SQLite busy budget is 30 s", () => {
	assert.equal(SQLITE_BUSY_BUDGET_MS, 30_000);
});

test("[sqlite] a transaction waits for another writer's lock without stalling the event loop", { skip: TEST_DIALECT !== "sqlite" }, async () => {
	const { db: file, path } = await sqliteFile();
	const order: string[] = [];
	let ticks = 0;
	const ticker = setInterval(() => ticks++, 50);
	try {
		const started = Date.now();
		const held = holdWriteLock(path, 1_500).then(() => order.push("released"));
		const transaction = file.transaction(async (tx) => {
			await tx.run("INSERT INTO t (v) VALUES (?)", "after the lock");
			order.push("transaction");
		});
		const read = file.get<{ n: number }>("SELECT COUNT(*) AS n FROM t").then((row) => {
			order.push("read");
			return row?.n;
		});
		await held;
		const ticksDuringHold = ticks;
		await transaction;
		assert.equal(await read, 1, "the read waited for the transaction");
		assert.deepEqual(order, ["released", "transaction", "read"]);
		assert.ok(Date.now() - started >= 1_400);
		assert.ok(ticksDuringHold >= 5, `the event loop ran only ${ticksDuringHold} ticks during a 1.5 s hold`);
	} finally {
		clearInterval(ticker);
		await file.close();
	}
});

test("[sqlite] a statement outside a transaction waits for another writer's lock", { skip: TEST_DIALECT !== "sqlite" }, async () => {
	const { db: file, path } = await sqliteFile();
	const held = holdWriteLock(path, 500);
	await file.run("INSERT INTO t (v) VALUES (?)", "x");
	await held;
	assert.deepEqual(plain(await file.get("SELECT COUNT(*) AS n FROM t")), { n: 1 });
	await file.close();
});

test("[sqlite] a lock held past the busy budget rejects with a clear error", { skip: TEST_DIALECT !== "sqlite" }, async () => {
	const { db: file, path } = await sqliteFile({ busyBudgetMs: 300 });
	const held = holdWriteLock(path, 1_500);
	let calls = 0;
	await assert.rejects(
		file.transaction(async () => {
			calls++;
		}),
		(error: Error) => {
			assert.match(error.message, /locked.*more than 300 ms/);
			assert.ok(isBusyError(error.cause));
			return true;
		},
	);
	assert.equal(calls, 0);
	await held;
	await file.transaction((tx) => tx.run("INSERT INTO t (v) VALUES (?)", "later"));
	assert.deepEqual(plain(await file.get("SELECT COUNT(*) AS n FROM t")), { n: 1 });
	await file.close();
});

test("[sqlite] a busy error from inside the callback is not retried", { skip: TEST_DIALECT !== "sqlite" }, async () => {
	const { db: file, path } = await sqliteFile();
	const other = new DatabaseSync(path, { timeout: 0 });
	let calls = 0;
	await assert.rejects(
		file.transaction(async (tx) => {
			calls++;
			await tx.run("INSERT INTO t (v) VALUES (?)", "rolled back");
			other.exec("BEGIN IMMEDIATE");
		}),
		(error) => isBusyError(error),
	);
	other.close();
	assert.equal(calls, 1);
	assert.deepEqual(plain(await file.get("SELECT COUNT(*) AS n FROM t")), { n: 0 });
	await file.close();
});
