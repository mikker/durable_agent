import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseModel } from "../src/config.ts";

test("DURABLE_AGENT_MODEL is provider/modelId; faux/faux-1 selects the faux provider", () => {
	assert.deepEqual(parseModel("faux/faux-1"), { provider: "faux", modelId: "faux-1" });
	assert.deepEqual(parseModel("openai/gpt-6.1-sol"), { provider: "openai", modelId: "gpt-6.1-sol" });
	// Only the first slash separates; model ids may contain more.
	assert.deepEqual(parseModel("openrouter/anthropic/claude"), { provider: "openrouter", modelId: "anthropic/claude" });
	for (const bad of ["gpt-6.1-sol", "/x", "openai/"]) assert.throws(() => parseModel(bad), /provider\/modelId/);
});

test("the environment maps onto the config, with the documented defaults", () => {
	const config = loadConfig({ DATABASE_URL: "postgres://localhost/x", DURABLE_AGENT_TOKEN: "s", DURABLE_AGENT_MODEL: "faux/faux-1" });
	assert.deepEqual(config.model, { provider: "faux", modelId: "faux-1" });
	assert.equal(config.port, 4010);
	assert.equal(config.host, "127.0.0.1");
	assert.equal(config.railsUrl, undefined);
	assert.equal(config.mirrorDocs, undefined);
	assert.match(config.storagePath, /storage\/durable_agent\.sqlite$/);

	const custom = loadConfig({
		DATABASE_URL: "postgres://localhost/x",
		DURABLE_AGENT_TOKEN: "s",
		DURABLE_AGENT_PORT: "4999",
		DURABLE_AGENT_RAILS_URL: "http://127.0.0.1:3000",
		DURABLE_AGENT_MIRROR_DOCS: "pi.agent, pi.inbox",
	});
	assert.deepEqual(custom.model, { provider: "openai", modelId: "gpt-6.1-sol" });
	assert.equal(custom.port, 4999);
	assert.equal(custom.railsUrl, "http://127.0.0.1:3000");
	assert.deepEqual([...(custom.mirrorDocs ?? [])], ["pi.agent", "pi.inbox"]);

	assert.throws(() => loadConfig({ DATABASE_URL: "postgres://localhost/x" }), /DURABLE_AGENT_TOKEN/);
});
