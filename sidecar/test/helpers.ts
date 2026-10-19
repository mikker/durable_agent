// Shared setup for the sidecar tests: the database named by DURABLE_AGENT_TEST_DATABASE_URL (default: a fresh
// SQLite file per call) with the schema from sql/schema.<dialect>.sql applied and every table empty.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { Config } from "../src/config.ts";
import { type Db, type Dialect, dialectOf, openDatabase } from "../src/db/index.ts";

export const TEST_DATABASE_URL = process.env.DURABLE_AGENT_TEST_DATABASE_URL || undefined;

/** The dialect the suite runs on. */
export const TEST_DIALECT: Dialect = TEST_DATABASE_URL === undefined ? "sqlite" : (dialectOf(TEST_DATABASE_URL) ?? "sqlite");

export const TABLES = [
	"durable_agent_durable_schema",
	"durable_agent_durable_metadata",
	"durable_agent_record_ids",
	"durable_agent_conversations",
	"durable_agent_entries",
	"durable_agent_tasks",
	"durable_agent_submissions",
	"durable_agent_documents",
	"durable_agent_document_revisions",
	"durable_agent_reports",
	"durable_agent_credentials",
	"durable_agent_settings",
] as const;

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "durable-agent-sidecar-test-"));

/** A database URL for one test: the configured one, or a new SQLite file. */
export async function testDatabaseUrl(): Promise<string> {
	if (TEST_DATABASE_URL !== undefined) return TEST_DATABASE_URL;
	return `sqlite://${join(await tempDir(), "test.sqlite3")}`;
}

/**
 * Open the test database with the schema applied and every durable_agent table empty. Pass the `url` from
 * testDatabaseUrl() and `reset: false` to open the same database again as another process would.
 */
export async function openTestDatabase(options: { url?: string; reset?: boolean } = {}): Promise<Db> {
	const url = options.url ?? (await testDatabaseUrl());
	if (dialectOf(url) === "postgres") await ensurePostgresDatabase(url);
	const db = await openDatabase(url);
	await prepareSchema(db, url);
	if (options.reset !== false) await resetTables(db);
	return db;
}

const prepared = new Set<string>();

// Once per process: drop whatever durable_agent tables an earlier schema left behind, then create the current ones.
async function prepareSchema(db: Db, url: string): Promise<void> {
	if (prepared.has(url)) return;
	await dropTables(db);
	await applySchema(db);
	prepared.add(url);
}

async function dropTables(db: Db): Promise<void> {
	const rows =
		db.dialect === "postgres"
			? await db.all<{ name: string }>(
					"SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'durable\\_agent\\_%'",
				)
			: await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'durable\\_agent\\_%' ESCAPE '\\'");
	for (const { name } of rows) await db.exec(`DROP TABLE IF EXISTS "${name}"${db.dialect === "postgres" ? " CASCADE" : ""}`);
}

/** A test database without any durable_agent table: a fresh SQLite file, or a Postgres schema of its own. */
export async function openEmptyDatabase(): Promise<{ db: Db; dispose(): Promise<void> }> {
	if (TEST_DIALECT === "sqlite") {
		const db = await openDatabase(`sqlite://${join(await tempDir(), "empty.sqlite3")}`);
		return { db, dispose: () => db.close() };
	}
	const url = TEST_DATABASE_URL as string;
	await ensurePostgresDatabase(url);
	const schema = `empty_${process.pid}_${Date.now()}`;
	const admin = await openDatabase(url);
	await admin.exec(`CREATE SCHEMA ${schema}`);
	const scoped = new URL(url);
	scoped.searchParams.set("options", `-c search_path=${schema}`);
	const db = await openDatabase(scoped.toString());
	return {
		db,
		dispose: async () => {
			await db.close();
			await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
			await admin.close();
		},
	};
}

export async function applySchema(db: Db): Promise<void> {
	await db.exec(await readFile(new URL(`../sql/schema.${db.dialect}.sql`, import.meta.url), "utf8"));
}

/** Empty every durable_agent table; each test Harness numbers its records from 1 again. */
export async function resetTables(db: Db): Promise<void> {
	if (db.dialect === "postgres") {
		await db.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`);
		return;
	}
	await db.transaction(async (tx) => {
		for (const table of TABLES) await tx.run(`DELETE FROM ${table}`);
		await tx.exec("DELETE FROM sqlite_sequence WHERE name = 'durable_agent_reports'");
	});
}

const ensured = new Map<string, Promise<void>>();

/** Create the Postgres database the URL names when it is missing, through the `postgres` maintenance database. */
export function ensurePostgresDatabase(url: string): Promise<void> {
	let done = ensured.get(url);
	if (done === undefined) {
		done = createIfMissing(url);
		ensured.set(url, done);
	}
	return done;
}

async function createIfMissing(url: string): Promise<void> {
	const target = new URL(url);
	const name = decodeURIComponent(target.pathname.slice(1));
	const adminUrl = new URL(url);
	adminUrl.pathname = "/postgres";
	const admin = new pg.Client({ connectionString: adminUrl.toString() });
	await admin.connect();
	try {
		const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
		if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
	} finally {
		await admin.end();
	}
}

/** A faux-model config pointing at `databaseUrl` (empty by default). */
export async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
	return {
		port: 0,
		host: "127.0.0.1",
		token: "t",
		databaseUrl: "",
		workspaceRoot: await tempDir(),
		model: { provider: "faux", modelId: "faux-1" },
		agentName: "test",
		railsUrl: undefined,
		...overrides,
	};
}

export const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};
