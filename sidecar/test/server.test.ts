// The HTTP API v1 surface, through Hono's in-process `app.request()` on a faux-model Harness.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type pg from "pg";
import { Logins } from "../src/auth.ts";
import { createServer } from "../src/server.ts";
import { bootTestSidecar, type TestSidecar, testConfig, testPool } from "./helpers.ts";

const TOKEN = "server-test-token";
let pool: pg.Pool;
let sidecar: TestSidecar;
let app: ReturnType<typeof createServer>;

before(async () => {
	pool = await testPool();
	sidecar = await bootTestSidecar(pool, await testConfig({ token: TOKEN }));
	app = createServer({
		harness: sidecar.opened.harness,
		models: sidecar.opened.models,
		mirror: sidecar.mirror,
		logins: new Logins(sidecar.opened.models, () => "device", "test"),
		tools: sidecar.opened.tools,
		token: TOKEN,
		defaultModel: sidecar.opened.model,
		context: BACKGROUND_CONTEXT,
	});
});

after(async () => {
	await sidecar.close();
	await pool.end();
});

/** `token: null` sends no Authorization header. */
const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
	app.request(path, {
		method,
		headers: {
			"content-type": "application/json",
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

test("health needs no token and reports the schema version and default model", async () => {
	const response = await call("GET", "/health", undefined, null);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, schemaVersion: 1, model: { provider: "faux", modelId: "faux-1" } });
});

test("everything else needs the bearer token", async () => {
	assert.equal((await call("GET", "/auth", undefined, null)).status, 401);
	assert.equal((await call("POST", "/conversations", {}, "wrong")).status, 401);
});

test("routes outside the v1 contract are 404", async () => {
	for (const [method, path] of [
		["GET", "/conversations/1"],
		["PATCH", "/conversations/1/agent"],
		["POST", "/conversations/1/reset"],
		["POST", "/conversations/1/compact"],
		["GET", "/conversations/1/events"],
		["GET", "/submissions/1"],
		["GET", "/tasks"],
		["GET", "/usage"],
	] as const) {
		const response = await call(method, path);
		assert.equal(response.status, 404, `${method} ${path}`);
	}
});

test("an unknown model is a 422 with suggestions", async () => {
	const response = await call("POST", "/conversations", { model: { provider: "openai", modelId: "gpt-6.0-sol" } });
	assert.equal(response.status, 422);
	const body = (await response.json()) as { error: string; suggestions: string[] };
	assert.ok(body.suggestions.includes("gpt-6-sol"), `suggestions: ${body.suggestions.join(", ")}`);
});

test("conversations take submissions idempotently by request_id, and abort", async () => {
	const created = await call("POST", "/conversations", { instructions: "Be brief." });
	assert.equal(created.status, 201);
	const { id } = (await created.json()) as { id: number };

	const first = await call("POST", `/conversations/${id}/submissions`, { content: "Hi", request_id: "r-1" });
	assert.equal(first.status, 202);
	const submission = (await first.json()) as { id: number; status: string };
	assert.equal(typeof submission.status, "string");
	const again = await call("POST", `/conversations/${id}/submissions`, { content: "Hi", request_id: "r-1" });
	assert.equal(((await again.json()) as { id: number }).id, submission.id);

	assert.equal((await call("POST", `/conversations/${id}/submissions`, { content: "Hi" })).status, 400);
	assert.equal((await call("POST", `/conversations/${id}/submissions`, { content: "Hi", request_id: "r-2", when_busy: "later" })).status, 400);
	assert.equal((await call("POST", "/conversations/999999/submissions", { content: "Hi", request_id: "r-3" })).status, 404);

	const aborted = await call("POST", `/conversations/${id}/abort`);
	assert.deepEqual(await aborted.json(), { ok: true });
	assert.equal((await call("POST", "/conversations/999999/abort")).status, 404);
});

test("tools reload without a Rails URL answers an empty list", async () => {
	const response = await call("POST", "/tools/reload");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { tools: [] });
});
