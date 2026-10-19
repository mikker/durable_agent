// Shared setup for the sidecar tests: a dedicated Postgres database with the mirror schema applied.
import { readFile } from "node:fs/promises";
import pg from "pg";

export const TEST_DATABASE = process.env.SIDECAR_TEST_DATABASE ?? "slopdep_sidecar_test";
const ADMIN_URL = process.env.SIDECAR_TEST_ADMIN_URL ?? "postgres://localhost/postgres";

export async function testPool(): Promise<pg.Pool> {
	const admin = new pg.Client({ connectionString: ADMIN_URL });
	await admin.connect();
	const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DATABASE]);
	if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${TEST_DATABASE}"`);
	await admin.end();

	const pool = new pg.Pool({ connectionString: `${ADMIN_URL.replace(/\/postgres$/, "")}/${TEST_DATABASE}`, max: 4 });
	await pool.query(await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8"));
	await pool.query(
		"TRUNCATE agent_reports, agent_submissions, agent_documents, agent_entries, agent_conversations, agent_credentials, agent_settings",
	);
	return pool;
}
