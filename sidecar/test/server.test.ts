// The HTTP API v1 surface, through Hono's in-process `app.request()` on a faux-model Harness.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { Logins } from "../src/auth.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import { TEST_DIALECT } from "./helpers.ts";
import { bootTestSidecar, type TestSidecar } from "./sidecar.ts";

const TOKEN = "server-test-token";
let sidecar: TestSidecar;
let app: ReturnType<typeof createServer>;

const serverFor = (from: TestSidecar, overrides: Partial<ServerDeps> = {}) =>
	createServer({
		harness: from.opened.harness,
		readiness: { resumed: true },
		models: from.opened.models,
		db: from.db,
		logins: new Logins(from.opened.models, () => "device", "test"),
		tools: from.opened.tools,
		token: TOKEN,
		defaultModel: from.opened.model,
		context: BACKGROUND_CONTEXT,
		...overrides,
	});

before(async () => {
	sidecar = await bootTestSidecar({ config: { token: TOKEN } });
	app = serverFor(sidecar);
});

after(async () => {
	await sidecar.close();
});

/** `token: null` sends no Authorization header. */
const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN, on = app) =>
	on.request(path, {
		method,
		headers: {
			"content-type": "application/json",
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

test("health needs no token and reports both schema versions, the database, the default model, tools and resume", async () => {
	const response = await call("GET", "/health", undefined, null);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		ok: true,
		schemaVersion: 2,
		harnessSchemaVersion: 1,
		database: TEST_DIALECT,
		model: { provider: "faux", modelId: "faux-1" },
		tools: [],
		resumed: true,
	});
});

test("health is 503 once the harness has closed", async () => {
	const other = await bootTestSidecar({ config: { token: TOKEN } });
	const closedApp = serverFor(other);
	await other.close();
	const response = await call("GET", "/health", undefined, null, closedApp);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { ok: false, error: "harness closed" });
});

test("until boot has resumed, submissions and aborts are 503 and health says so", async () => {
	const starting = serverFor(sidecar, { readiness: { resumed: false } });
	const created = await call("POST", "/conversations", {}, TOKEN, starting);
	assert.equal(created.status, 201);
	const { id } = (await created.json()) as { id: number };
	const submitted = await call("POST", `/conversations/${id}/submissions`, { content: "Hi", request_id: "early" }, TOKEN, starting);
	assert.equal(submitted.status, 503);
	assert.deepEqual(await submitted.json(), { error: "starting" });
	assert.equal((await call("POST", `/conversations/${id}/abort`, undefined, TOKEN, starting)).status, 503);
	const health = (await (await call("GET", "/health", undefined, null, starting)).json()) as { resumed: boolean };
	assert.equal(health.resumed, false);
});

/** Models whose OAuth login shows a URL and then waits for the redirect URL or a cancel; enough for Logins. */
const fakeLoginModels = (): Models =>
	({
		getProviders: () => [],
		checkAuth: async () => undefined,
		logout: async () => {},
		login: (
			_provider: string,
			_type: string,
			{ signal, notify, prompt }: { signal: AbortSignal; notify: (event: unknown) => void; prompt: (request: unknown) => Promise<string> },
		) => {
			notify({ type: "auth_url", url: "https://auth.example/authorize" });
			return prompt({ type: "manual_code", signal });
		},
	}) as unknown as Models;

test("login routes answer only for the provider the login belongs to", async () => {
	const withLogins = serverFor(sidecar, { logins: new Logins(fakeLoginModels(), () => "device", "test") });
	const started = await call("POST", "/auth/openai/logins", undefined, TOKEN, withLogins);
	assert.equal(started.status, 201);
	const login = (await started.json()) as { id: string; provider: string; status: string; url: string };
	assert.deepEqual([login.provider, login.status, login.url], ["openai", "awaiting_browser", "https://auth.example/authorize"]);

	assert.equal((await call("GET", `/auth/openai/logins/${login.id}`, undefined, TOKEN, withLogins)).status, 200);
	assert.equal((await call("GET", `/auth/anthropic/logins/${login.id}`, undefined, TOKEN, withLogins)).status, 404);
	const wrongCallback = await call("POST", `/auth/anthropic/logins/${login.id}/callback`, { url: "http://x" }, TOKEN, withLogins);
	assert.equal(wrongCallback.status, 404);
	assert.equal((await call("DELETE", `/auth/anthropic/logins/${login.id}`, undefined, TOKEN, withLogins)).status, 404);
	assert.equal((await call("GET", "/auth/openai/logins/nope", undefined, TOKEN, withLogins)).status, 404);

	const cancelled = await call("DELETE", `/auth/openai/logins/${login.id}`, undefined, TOKEN, withLogins);
	assert.equal(cancelled.status, 200);
});

test("everything else needs the bearer token", async () => {
	assert.equal((await call("GET", "/auth", undefined, null)).status, 401);
	assert.equal((await call("POST", "/conversations", {}, "wrong")).status, 401);
	assert.equal((await call("POST", "/conversations", {}, `${TOKEN}x`)).status, 401);
	assert.equal((await call("GET", "/auth", undefined, "")).status, 401);
	assert.equal((await call("GET", "/auth")).status, 200);
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
	// The row is committed before the 202, so a reader of the database finds it at once.
	const row = await sidecar.db.get<{ conversation_id: number; request_id: string }>(
		"SELECT conversation_id, request_id FROM durable_agent_submissions WHERE id = ?",
		submission.id,
	);
	assert.deepEqual({ ...row }, { conversation_id: id, request_id: JSON.stringify("r-1") });
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
