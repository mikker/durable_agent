import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	type SqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite";
import type { Db } from "../src/db/index.ts";
import { numberPlaceholders, toPostgres } from "../src/db/translate.ts";
import { openTestDatabase, TEST_DIALECT } from "./helpers.ts";

test("? placeholders become $1, $2, … outside quoted literals, identifiers and comments", () => {
	assert.equal(toPostgres("SELECT a FROM t WHERE x = ? AND y IN (?, ?) LIMIT ?"), "SELECT a FROM t WHERE x = $1 AND y IN ($2, $3) LIMIT $4");
	assert.equal(numberPlaceholders("SELECT '?', 'it''s ?', \"?\" FROM t WHERE x = ? -- why?\nAND y = ?"), "SELECT '?', 'it''s ?', \"?\" FROM t WHERE x = $1 -- why?\nAND y = $2");
	assert.equal(toPostgres("SELECT 1"), "SELECT 1");
});

test("INSERT OR IGNORE becomes INSERT … ON CONFLICT DO NOTHING, before any RETURNING clause", () => {
	assert.equal(
		toPostgres("INSERT OR IGNORE INTO t (id, kind) VALUES (?, ?)"),
		"INSERT INTO t (id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING",
	);
	assert.equal(
		toPostgres("INSERT OR IGNORE INTO t (id) VALUES (?);\n"),
		"INSERT INTO t (id) VALUES ($1) ON CONFLICT DO NOTHING",
	);
	assert.equal(
		toPostgres("INSERT OR IGNORE INTO t (id) VALUES (?) RETURNING id"),
		"INSERT INTO t (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
	);
	assert.equal(toPostgres("INSERT INTO t (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET id = excluded.id"), "INSERT INTO t (id) VALUES ($1) ON CONFLICT(id) DO UPDATE SET id = excluded.id");
});

test("STRICT and json_valid checks are dropped, other checks stay", () => {
	const sql = `CREATE TABLE t (
			id INTEGER PRIMARY KEY CHECK (id > 0),
			record TEXT NOT NULL CHECK (json_valid(record)),
			content TEXT NOT NULL CHECK (json_valid(content))
		) STRICT`;
	assert.equal(
		toPostgres(sql),
		`CREATE TABLE t (
			id INTEGER PRIMARY KEY CHECK (id > 0),
			record TEXT NOT NULL,
			content TEXT NOT NULL
		)`,
	);
	assert.equal(toPostgres("CREATE TABLE t (a TEXT, CHECK (json_valid(a)))"), "CREATE TABLE t (a TEXT)");
});

test("translations are memoized by SQL text", () => {
	const sql = `SELECT ${"x".repeat(10)} FROM t WHERE id = ?`;
	assert.equal(toPostgres(sql), toPostgres(sql));
});

test("pi-durable's own migrations translate to SQL without SQLite-only syntax", () => {
	for (const migration of SQLITE_MIGRATIONS) {
		for (const statement of migration.statements) {
			const translated = toPostgres(statement);
			assert.doesNotMatch(translated, /\bSTRICT\b|json_valid|INSERT OR IGNORE|\?/, translated);
		}
	}
});

let db: Db | undefined;
after(() => db?.close());

test("pi-durable's own migrations run on Postgres once translated", { skip: TEST_DIALECT !== "postgres" }, async () => {
	db = await openTestDatabase();
	const rollback = new Error("roll back");
	// Unprefixed names, inside a transaction that is rolled back: the test database keeps only the gem's tables.
	await assert.rejects(
		db.transaction(async (tx) => {
			// pi-durable's real migration runner, its own transaction folded into this one.
			const nested: SqliteDatabase = {
				exec: (sql) => tx.exec(sql),
				run: (sql, ...params) => tx.run(sql, ...params),
				get: (sql, ...params) => tx.get(sql, ...params),
				all: (sql, ...params) => tx.all(sql, ...params),
				transaction: (callback) => callback(tx),
				close: async () => {},
			};
			await applySqliteMigrations(nested);
			const version = await tx.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1");
			assert.equal(version?.version, CURRENT_SQLITE_SCHEMA_VERSION);
			const row = await tx.get<{ next_id: string; next_seq: number }>("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = ?", 1);
			assert.deepEqual(row, { next_id: "2", next_seq: 1 });
			throw rollback;
		}),
		(error) => error === rollback,
	);
});
