// Accounts as provider ids: the pattern, the scoped id round trip, and the clones registered for an account.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
	ACCOUNT_PATTERN,
	ensureAccountProvider,
	isValidAccount,
	parseProviderId,
	registerStoredAccounts,
	scopedProviderId,
	UnknownBaseProvider,
} from "../src/accounts.ts";
import { createProcessModels } from "../src/harness.ts";

const storeWith = (ids: string[]): CredentialStore =>
	({
		read: async () => undefined,
		modify: async () => undefined,
		delete: async () => {},
		list: async () => ids.map((providerId) => ({ providerId, type: "api_key" as const })),
	}) as CredentialStore;

const processModels = (ids: string[] = []) => createProcessModels(storeWith(ids));

test("accounts are 1 to 64 letters, digits, underscores, dots and dashes", () => {
	for (const good of ["u42", "a", "A.b_c-9", "x".repeat(64)]) assert.ok(isValidAccount(good), good);
	for (const bad of ["", "x".repeat(65), "u 42", "u@42", "u/42", "ü", 42, null, undefined]) assert.equal(isValidAccount(bad), false, String(bad));
	assert.equal(ACCOUNT_PATTERN.source, "^[A-Za-z0-9_.-]{1,64}$");
});

test("scoped provider ids round-trip, splitting on the first @", () => {
	assert.equal(scopedProviderId("openai", "u42"), "openai@u42");
	assert.deepEqual(parseProviderId("openai@u42"), { provider: "openai", account: "u42" });
	assert.deepEqual(parseProviderId("openai"), { provider: "openai" });
	assert.deepEqual(parseProviderId("a@b@c"), { provider: "a", account: "b@c" });
	assert.deepEqual(parseProviderId(scopedProviderId("anthropic", "x.y")), { provider: "anthropic", account: "x.y" });
});

test("ensureAccountProvider registers a clone once, with the base provider's models and auth methods", async () => {
	const models = processModels();
	assert.equal(models.getProvider("openai@u42"), undefined);
	assert.equal(ensureAccountProvider(models, "openai", "u42"), "openai@u42");
	const clone = models.getProvider("openai@u42");
	assert.ok(clone);
	assert.equal(ensureAccountProvider(models, "openai", "u42"), "openai@u42");
	assert.equal(models.getProvider("openai@u42"), clone, "registered once");

	const base = models.getProvider("openai");
	assert.ok(base);
	assert.deepEqual(
		models.getModels("openai@u42").map((model) => model.id),
		models.getModels("openai").map((model) => model.id),
	);
	assert.deepEqual(
		models.getAllModels("openai@u42").map((model) => model.id),
		models.getAllModels("openai").map((model) => model.id),
	);
	// pi-ai routes and authenticates a request by `model.provider`.
	assert.equal(models.getModel("openai@u42", "gpt-6.1-sol")?.provider, "openai@u42");
	assert.equal(models.getModel("openai", "gpt-6.1-sol")?.provider, "openai");
	assert.deepEqual(Object.keys(clone.auth).sort(), Object.keys(base.auth).sort());
	assert.equal(typeof clone.auth.apiKey?.login, "function");
	assert.equal(clone.auth.oauth?.loginLabel, "Sign in with ChatGPT");

	ensureAccountProvider(models, "anthropic", "u42");
	assert.notEqual(models.getModel("anthropic@u42", "claude-fable-5-1"), undefined);
	ensureAccountProvider(models, "faux", "u42");
	assert.notEqual(models.getModel("faux@u42", "faux-1"), undefined);
});

test("an account's provider ignores the app's environment and resolves only its own credential", async () => {
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "sk-app-key";
	try {
		const models = processModels();
		ensureAccountProvider(models, "openai", "u42");
		assert.equal((await models.checkAuth("openai"))?.source, "OPENAI_API_KEY");
		assert.equal(await models.checkAuth("openai@u42"), undefined);
	} finally {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	}
});

test("an unknown base provider throws UnknownBaseProvider", async () => {
	const models = processModels();
	assert.throws(() => ensureAccountProvider(models, "mystery", "u42"), UnknownBaseProvider);
	assert.throws(() => ensureAccountProvider(models, "toString", "u42"), UnknownBaseProvider);
	assert.equal(models.getProvider("mystery@u42"), undefined);
});

test("stored account credentials register their providers, skipping unknown bases", async () => {
	const models = processModels();
	const registered = await registerStoredAccounts(models, storeWith(["openai", "openai@u42", "anthropic@u7", "mystery@u42", "openai@bad id"]));
	assert.deepEqual(registered, ["openai@u42", "anthropic@u7"]);
	assert.ok(models.getProvider("openai@u42"));
	assert.ok(models.getProvider("anthropic@u7"));
	assert.equal(models.getProvider("mystery@u42"), undefined);
});
