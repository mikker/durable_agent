// Shared setup for the sidecar tests: a dedicated Postgres database with the mirror schema applied.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import pg from "pg";
import type { Config } from "../src/config.ts";
import { PostgresCredentialStore } from "../src/credentials.ts";
import { createProcessModels, type OpenedHarness, openHarness } from "../src/harness.ts";
import { Mirror, type MirrorOptions } from "../src/mirror.ts";

export const TEST_DATABASE = process.env.DURABLE_AGENT_TEST_DATABASE ?? "durable_agent_sidecar_test";
const ADMIN_URL = process.env.DURABLE_AGENT_TEST_ADMIN_URL ?? "postgres://localhost/postgres";

export async function testPool(): Promise<pg.Pool> {
	const admin = new pg.Client({ connectionString: ADMIN_URL });
	await admin.connect();
	const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DATABASE]);
	if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${TEST_DATABASE}"`);
	await admin.end();

	const pool = new pg.Pool({ connectionString: `${ADMIN_URL.replace(/\/postgres$/, "")}/${TEST_DATABASE}`, max: 4 });
	await pool.query(await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8"));
	await truncateMirror(pool);
	return pool;
}

/** Empty every durable_agent table; each test Harness numbers its conversations and entries from 1. */
export async function truncateMirror(pool: pg.Pool): Promise<void> {
	await pool.query(
		`TRUNCATE durable_agent_reports, durable_agent_submissions, durable_agent_documents, durable_agent_entries,
		 durable_agent_conversations, durable_agent_credentials, durable_agent_settings`,
	);
}

/**
 * `pool`, except that any query (pooled or on a checked-out client) for which `fail(sql, params)` returns true
 * rejects without reaching Postgres: a simulated outage scoped to the statements a test cares about.
 */
export function faultyPool(pool: pg.Pool, fail: (sql: string, params: unknown[]) => boolean): pg.Pool {
	type Queryable = { query(sql: string, params: unknown[]): Promise<unknown> };
	const guard = (target: Queryable) => (sql: string, params: unknown[] = []) =>
		fail(sql, params) ? Promise.reject(new Error(`injected failure: ${sql.trim().split("\n")[0]}`)) : target.query(sql, params);
	const client = (real: pg.PoolClient): pg.PoolClient =>
		new Proxy(real, {
			get: (target, key) => (key === "query" ? guard(target as unknown as Queryable) : Reflect.get(target, key, target)),
		});
	return new Proxy(pool, {
		get: (target, key) => {
			if (key === "query") return guard(target as unknown as Queryable);
			if (key === "connect") return async () => client(await target.connect());
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A faux-model config with a fresh storage file. */
export async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
	const dir = await mkdtemp(join(tmpdir(), "durable-agent-sidecar-test-"));
	return {
		port: 0,
		host: "127.0.0.1",
		token: "t",
		databaseUrl: "",
		storagePath: join(dir, "harness.sqlite"),
		workspaceRoot: dir,
		model: { provider: "faux", modelId: "faux-1" },
		agentName: "test",
		railsUrl: undefined,
		mirrorDocs: undefined,
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

export type TestSidecar = { readonly opened: OpenedHarness; readonly mirror: Mirror; close(): Promise<void> };

/** A Harness plus its mirror, wired as main.ts wires them. `models` defaults to the process models for `config`. */
export async function bootTestSidecar(
	pool: pg.Pool,
	config: Config,
	models?: MutableModels,
	options?: MirrorOptions,
): Promise<TestSidecar> {
	let late: Mirror | undefined;
	const opened = await openHarness(
		config,
		models ?? createProcessModels(config, new PostgresCredentialStore(pool, config.token)),
		{ onConversationCreated: (record) => late?.enqueue(record), onReport: () => undefined },
		BACKGROUND_CONTEXT,
	);
	const mirror = new Mirror(pool, opened.harness, config, BACKGROUND_CONTEXT, options);
	late = mirror;
	await mirror.start();
	opened.harness.resume();
	return {
		opened,
		mirror,
		close: async () => {
			await mirror.stop();
			await opened.close(BACKGROUND_CONTEXT);
		},
	};
}
