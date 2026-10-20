// Process-wide model access: which providers every sidecar knows, whatever its default model.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createProcessModels } from "../src/harness.ts";
import { assertKnownModel, UnknownModel } from "../src/models-check.ts";

const noCredentials: CredentialStore = {
	get: async () => undefined,
	set: async () => {},
	delete: async () => {},
	list: async () => [],
} as unknown as CredentialStore;

test("every sidecar registers faux/faux-1 beside the real providers", () => {
	const models = createProcessModels(noCredentials);

	// A conversation started on faux keeps answering after DURABLE_AGENT_MODEL moves to openai.
	assert.notEqual(models.getModel("faux", "faux-1"), undefined);
	assert.notEqual(models.getModel("openai", "gpt-6.1-sol"), undefined);
	assert.notEqual(models.getModel("anthropic", "claude-fable-5-1"), undefined);
	assert.throws(() => assertKnownModel(models, { provider: "openai", modelId: "gpt-6.1-sool" }), UnknownModel);
});
