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
import { Mirror } from "../src/mirror.ts";

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
	await pool.query(
		`TRUNCATE durable_agent_reports, durable_agent_submissions, durable_agent_documents, durable_agent_entries,
		 durable_agent_conversations, durable_agent_credentials, durable_agent_settings`,
	);
	return pool;
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
export async function bootTestSidecar(pool: pg.Pool, config: Config, models?: MutableModels): Promise<TestSidecar> {
	let late: Mirror | undefined;
	const opened = await openHarness(
		config,
		models ?? createProcessModels(config, new PostgresCredentialStore(pool)),
		{ onConversationCreated: (record) => late?.enqueue(record), onReport: () => undefined },
		BACKGROUND_CONTEXT,
	);
	const mirror = new Mirror(pool, opened.harness, config, BACKGROUND_CONTEXT);
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
