// pi-durable's portable SQLite storage core over the app's database. Rails' install migration owns the tables;
// this only checks they exist and seeds the two singleton rows the migration deliberately leaves out, so a
// database loaded from schema.rb works too.
import type { Storage } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Db } from "./db/index.ts";

export const TABLE_PREFIX = "durable_agent_";

export class MissingSchema extends Error {
	constructor(cause: unknown) {
		super("the durable_agent tables are missing: run bin/rails db:migrate", { cause });
		this.name = "MissingSchema";
	}
}

export async function openHarnessStorage(db: Db): Promise<Storage> {
	await assertSchema(db);
	await seed(db);
	await assertVersion(db);
	return SqliteStorage.open(db, { prefix: TABLE_PREFIX });
}

async function assertSchema(db: Db): Promise<void> {
	try {
		await db.all(`SELECT id FROM ${TABLE_PREFIX}conversations LIMIT 0`);
	} catch (error) {
		throw new MissingSchema(error);
	}
}

// What pi-durable's version-1 migration inserts; `next_id` starts at 2 because id 1 is the root conversation.
async function seed(db: Db): Promise<void> {
	await db.run(
		`INSERT INTO ${TABLE_PREFIX}durable_schema (singleton, version) VALUES (1, ?) ON CONFLICT DO NOTHING`,
		CURRENT_SQLITE_SCHEMA_VERSION,
	);
	await db.run(
		`INSERT INTO ${TABLE_PREFIX}durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1) ON CONFLICT DO NOTHING`,
	);
}

// SqliteStorage.open would run the missing migrations' DDL itself; schema changes belong to Rails migrations.
async function assertVersion(db: Db): Promise<void> {
	const row = await db.get<{ version: number }>(`SELECT version FROM ${TABLE_PREFIX}durable_schema WHERE singleton = 1`);
	const version = Number(row?.version);
	if (version < CURRENT_SQLITE_SCHEMA_VERSION) {
		throw new Error(
			`durable_agent harness schema is version ${version}, this sidecar needs ${CURRENT_SQLITE_SCHEMA_VERSION}: run bin/rails db:migrate after upgrading the gem`,
		);
	}
}
