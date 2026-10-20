// The HTTP API v1 surface, through Hono's in-process `app.request()` on a faux-model Harness.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
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

// Accounts ---------------------------------------------------------------------------------------------------------

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const pinnedModel = async (id: number) => {
	const found = await sidecar.opened.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(found, `conversation ${id}`);
	return (await found.agent(BACKGROUND_CONTEXT)).model;
};

const credentialRows = async (): Promise<string[]> =>
	(await sidecar.db.all<{ provider_id: string }>("SELECT provider_id FROM durable_agent_credentials ORDER BY provider_id")).map(
		(row) => row.provider_id,
	);

/** A server whose Logins share the sidecar's models and record every auth change. */
const withAuthChanges = () => {
	const changed: string[] = [];
	const server = serverFor(sidecar, { logins: new Logins(sidecar.opened.models, () => "device", "test", (provider) => changed.push(provider)) });
	return { server, changed };
};

test("a conversation started with an account pins that account's provider", async () => {
	const created = await call("POST", "/conversations", { account: "u42", model: { provider: "openai", modelId: "gpt-6.1-sol" } });
	assert.equal(created.status, 201);
	const { id } = await json<{ id: number }>(created);
	assert.deepEqual(await pinnedModel(id), { provider: "openai@u42", modelId: "gpt-6.1-sol" });

	// The default model's provider is scoped the same way.
	const onDefault = await json<{ id: number }>(await call("POST", "/conversations", { account: "u42" }));
	assert.deepEqual(await pinnedModel(onDefault.id), { provider: "faux@u42", modelId: "faux-1" });

	// Without an account nothing changes.
	const plain = await json<{ id: number }>(await call("POST", "/conversations", {}));
	assert.deepEqual(await pinnedModel(plain.id), { provider: "faux", modelId: "faux-1" });

	const unknown = await call("POST", "/conversations", { account: "u42", model: { provider: "openai", modelId: "gpt-6.0-sol" } });
	assert.equal(unknown.status, 422);
	const mystery = await call("POST", "/conversations", { account: "u42", model: { provider: "mystery", modelId: "m" } });
	assert.equal(mystery.status, 422);
});

test("an invalid account is a 422 on every account route", async () => {
	for (const account of ["", "u 42", "u@42", "x".repeat(65), 42]) {
		const response = await call("POST", "/conversations", { account });
		assert.equal(response.status, 422, JSON.stringify(account));
		assert.deepEqual(await response.json(), { error: "invalid_account" });
	}
	for (const [method, path, body] of [
		["GET", "/auth?account=u%2042", undefined],
		["GET", "/auth?account=", undefined],
		["PUT", "/auth/openai/api_key?account=a@b", { key: "sk-x" }],
		["POST", "/auth/openai/logins?account=u%2F42", undefined],
		["DELETE", "/auth/openai?account=u%2042", undefined],
	] as const) {
		const response = await call(method, path, body);
		assert.equal(response.status, 422, `${method} ${path}`);
		assert.deepEqual(await response.json(), { error: "invalid_account" });
	}
});

test("an account's API key is stored for its provider, reported under the base name, and announced", async () => {
	const { server, changed } = withAuthChanges();
	const blank = await call("PUT", "/auth/openai/api_key?account=u42", { key: "  " }, TOKEN, server);
	assert.equal(blank.status, 422);
	assert.deepEqual(await blank.json(), { error: "blank_key" });
	assert.deepEqual(await json(await call("PUT", "/auth/openai/api_key?account=u42", {}, TOKEN, server)), { error: "blank_key" });
	const faux = await call("PUT", "/auth/faux/api_key?account=u42", { key: "k" }, TOKEN, server);
	assert.equal(faux.status, 422);
	assert.deepEqual(await faux.json(), { error: "no_api_key_auth" });
	assert.equal((await call("PUT", "/auth/mystery/api_key?account=u42", { key: "k" }, TOKEN, server)).status, 422);

	const stored = await call("PUT", "/auth/openai/api_key?account=u42", { key: "sk-test-u42" }, TOKEN, server);
	assert.equal(stored.status, 200);
	assert.deepEqual(await stored.json(), { type: "api_key", source: "stored credential" });
	assert.deepEqual(changed, ["openai@u42"]);
	assert.deepEqual(await credentialRows(), ["openai@u42"]);
	assert.deepEqual(await sidecar.opened.models.getAuth("openai@u42").then((auth) => auth?.auth.apiKey), "sk-test-u42");

	const forAccount = await json<Record<string, unknown>>(await call("GET", "/auth?account=u42", undefined, TOKEN, server));
	assert.deepEqual(forAccount.openai, { type: "api_key", source: "stored credential" });
	assert.equal(forAccount.anthropic, null);
	assert.ok(Object.keys(forAccount).every((id) => !id.includes("@")), Object.keys(forAccount).join(", "));
	const other = await json<Record<string, unknown>>(await call("GET", "/auth?account=u7", undefined, TOKEN, server));
	assert.equal(other.openai, null);

	// The app's own map never lists account providers, and the app has no OpenAI credential of its own.
	const app = await json<Record<string, unknown>>(await call("GET", "/auth", undefined, TOKEN, server));
	assert.ok(Object.keys(app).every((id) => !id.includes("@")), Object.keys(app).join(", "));
	assert.ok("openai" in app && "faux" in app);
	if (process.env.OPENAI_API_KEY === undefined) assert.equal(app.openai, null);
});

test("signing an account out removes only that account's credential", async () => {
	const { server, changed } = withAuthChanges();
	await call("PUT", "/auth/openai/api_key", { key: "sk-app" }, TOKEN, server);
	await call("PUT", "/auth/openai/api_key?account=u7", { key: "sk-u7" }, TOKEN, server);
	assert.deepEqual(await credentialRows(), ["openai", "openai@u42", "openai@u7"]);

	const signedOut = await call("DELETE", "/auth/openai?account=u42", undefined, TOKEN, server);
	assert.deepEqual(await signedOut.json(), { ok: true });
	assert.deepEqual(await credentialRows(), ["openai", "openai@u7"]);
	assert.deepEqual(changed, ["openai", "openai@u7", "openai@u42"]);
	assert.equal((await json<Record<string, unknown>>(await call("GET", "/auth?account=u42", undefined, TOKEN, server))).openai, null);

	await call("DELETE", "/auth/openai", undefined, TOKEN, server);
	await call("DELETE", "/auth/openai?account=u7", undefined, TOKEN, server);
	assert.deepEqual(await credentialRows(), []);
});

test("a login started for an account carries the scoped provider and answers under the base provider", async () => {
	const withLogins = serverFor(sidecar, { logins: new Logins(fakeLoginModels(), () => "device", "test") });
	const started = await call("POST", "/auth/openai/logins?account=u42", undefined, TOKEN, withLogins);
	assert.equal(started.status, 201);
	const login = await json<{ id: string; provider: string; status: string }>(started);
	assert.deepEqual([login.provider, login.status], ["openai@u42", "awaiting_browser"]);
	assert.ok(sidecar.opened.models.getProvider("openai@u42"), "the account provider is registered");

	assert.equal((await call("GET", `/auth/openai/logins/${login.id}`, undefined, TOKEN, withLogins)).status, 200);
	assert.equal((await call("GET", `/auth/anthropic/logins/${login.id}`, undefined, TOKEN, withLogins)).status, 404);
	// The app's own login for the same base provider is a separate one.
	const app = await json<{ id: string; provider: string }>(await call("POST", "/auth/openai/logins", undefined, TOKEN, withLogins));
	assert.notEqual(app.id, login.id);
	assert.equal(app.provider, "openai");
	for (const id of [login.id, app.id]) assert.equal((await call("DELETE", `/auth/openai/logins/${id}`, undefined, TOKEN, withLogins)).status, 200);
});

/** Submit through the Harness and wait for the run to settle. */
const answer = async (id: number, requestId: string) => {
	const found = await sidecar.opened.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(found);
	const submission = await found.submit({ type: "input", content: "Hello", requestId }, BACKGROUND_CONTEXT);
	return { found, settled: await submission.wait(BACKGROUND_CONTEXT) };
};

test("a conversation on an account's faux provider answers end to end", async () => {
	const { id } = await json<{ id: number }>(await call("POST", "/conversations", { account: "u42", model: "faux/faux-1" }));
	const { found, settled } = await answer(id, "account-faux");
	assert.equal(settled.status, "done");
	const entries = await found.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	assert.match(JSON.stringify(entries), /Offline development reply/);
});

test(
	"a conversation on an account's OpenAI provider sends that account's API key",
	{ skip: process.env.DURABLE_AGENT_SKIP_NETWORK_TESTS ? "DURABLE_AGENT_SKIP_NETWORK_TESTS is set" : false },
	async () => {
		const { id } = await json<{ id: number }>(await call("POST", "/conversations", { account: "u42", model: "openai/gpt-6.1-sol" }));
		const stored = await call("PUT", "/auth/openai/api_key?account=u42", { key: "sk-test-u42" });
		assert.equal(stored.status, 200);
		try {
			const { settled } = await answer(id, "account-openai");
			// OpenAI rejects the bogus key: the request went out with it, rather than settling for lack of a model or key.
			assert.equal(settled.status, "unanswered");
			assert.equal(settled.reason, "model_error");
			assert.match(String(settled.detail), /\b401\b/);
			assert.match(String(settled.detail), /sk-test-u42/);
			assert.doesNotMatch(String(settled.detail), /not configured/i);
		} finally {
			await call("DELETE", "/auth/openai?account=u42");
		}
	},
);
