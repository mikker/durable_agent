// Gem-level settings in durable_agent_settings, plus the two schema versions GET /health reports.
import { randomUUID } from "node:crypto";
import type { Db } from "./db/index.ts";
import { log } from "./log.ts";

/** The gem's schema version (DESIGN.md "Schema v2"). pi-durable's own version lives in durable_agent_durable_schema. */
export const SCHEMA_VERSION = 2;

const insertIfAbsent = (db: Db, key: string, value: string): Promise<void> =>
	db.run(
		"INSERT INTO durable_agent_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING",
		key,
		value,
	);

const read = async (db: Db, key: string): Promise<string | undefined> =>
	(await db.get<{ value: string }>("SELECT value FROM durable_agent_settings WHERE key = ?", key))?.value;

/** The stable UUID OpenAI identifies this installation by. Created on first use, then constant. */
export async function installationDeviceId(db: Db): Promise<string> {
	await insertIfAbsent(db, "device_id", randomUUID());
	const value = await read(db, "device_id");
	if (value === undefined) throw new Error("could not read or create the installation device id");
	return value;
}

/** Record the schema version, leaving a value Rails (or an earlier boot) wrote alone. */
export function recordSchemaVersion(db: Db): Promise<void> {
	return insertIfAbsent(db, "schema_version", String(SCHEMA_VERSION));
}

/**
 * Boot check of the gem's schema version: record it on a fresh database, refuse a database a newer gem migrated
 * (its tables may not be what this sidecar writes), and warn about an older one, whose migration has not run yet.
 */
export async function checkSchemaVersion(db: Db): Promise<void> {
	await recordSchemaVersion(db);
	const stored = await readSchemaVersion(db);
	if (stored === undefined || stored === SCHEMA_VERSION) return;
	if (stored > SCHEMA_VERSION) {
		throw new Error(
			`durable_agent schema version ${stored} is newer than this gem's ${SCHEMA_VERSION}: the database is newer than this gem; upgrade the gem`,
		);
	}
	log.warn("durable_agent schema is older than this gem: run bin/rails db:migrate", { stored, expected: SCHEMA_VERSION });
}

export async function readSchemaVersion(db: Db): Promise<number | undefined> {
	const value = await read(db, "schema_version");
	return value === undefined ? undefined : Number(value);
}

/** pi-durable's storage schema version, as seeded by openHarnessStorage. */
export async function readHarnessSchemaVersion(db: Db): Promise<number | undefined> {
	return (await db.get<{ version: number }>("SELECT version FROM durable_agent_durable_schema WHERE singleton = 1"))?.version;
}
