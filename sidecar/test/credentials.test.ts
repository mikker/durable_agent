import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type pg from "pg";
import { installationDeviceId, PostgresCredentialStore, recordSchemaVersion } from "../src/credentials.ts";
import { testPool } from "./helpers.ts";

let pool: pg.Pool;
before(async () => {
	pool = await testPool();
});
after(() => pool.end());

test("credentials round-trip through Postgres and modifications serialize per provider", async () => {
	const store = new PostgresCredentialStore(pool);
	assert.equal(await store.read("openai"), undefined);

	await store.modify("openai", async () => ({ type: "oauth", access: "a1", refresh: "r1", expires: 1 }));
	assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);

	// Two concurrent refreshes: the second must see the first's result.
	const seen: string[] = [];
	await Promise.all([
		store.modify("openai", async (current) => {
			seen.push(current?.type === "oauth" ? current.access : "none");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { type: "oauth", access: "a2", refresh: "r1", expires: 2 };
		}),
		store.modify("openai", async (current) => {
			seen.push(current?.type === "oauth" ? current.access : "none");
			return undefined; // keep
		}),
	]);
	assert.deepEqual(seen, ["a1", "a2"]);

	await store.delete("openai");
	assert.equal(await store.read("openai"), undefined);
});

test("the installation device id is created once and then stable", async () => {
	const first = await installationDeviceId(pool);
	const second = await installationDeviceId(pool);
	assert.match(first, /^[0-9a-f-]{36}$/);
	assert.equal(first, second);
});

test("the schema version row is written once and never overwritten", async () => {
	await recordSchemaVersion(pool);
	await pool.query("UPDATE durable_agent_settings SET value = '7' WHERE key = 'schema_version'");
	await recordSchemaVersion(pool);
	const result = await pool.query<{ value: string }>("SELECT value FROM durable_agent_settings WHERE key = 'schema_version'");
	assert.equal(result.rows[0]?.value, "7");
	await pool.query("UPDATE durable_agent_settings SET value = '1' WHERE key = 'schema_version'");
});
