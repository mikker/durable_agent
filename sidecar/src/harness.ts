// Opens the pi-durable Harness this process owns: storage in the app's database, model access, the extension
// registry, and the tool environment. Everything the HTTP API does goes through the Harness returned here.
import { mkdir } from "node:fs/promises";
import type { Context } from "@earendil-works/chord/context";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, type Harness as HarnessType, Harness, type ModelRef } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import { withBaseDocuments } from "./documents.ts";
import { ChangeTracker, type Events } from "./events.ts";
import { log } from "./log.ts";
import { assertKnownModel } from "./models-check.ts";
import { openHarnessStorage } from "./storage.ts";
import { type BootRetry, RailsTools } from "./tools.ts";

export type HarnessDeps = {
	readonly db: Db;
	readonly events: Events;
	/** `info` arrives from pi-durable releases newer than 1.3.0; it is `undefined` on 1.3.0. */
	readonly onReport: (error: unknown, info?: unknown) => void;
	readonly toolsRetry?: BootRetry;
};

export type OpenedHarness = {
	readonly harness: HarnessType;
	readonly models: MutableModels;
	readonly model: ModelRef;
	readonly tools: RailsTools;
	close(context: Context): Promise<void>;
};

/**
 * Model access for the whole process. OpenAI accepts an `OPENAI_API_KEY` or a Sign in with ChatGPT credential
 * from the store (see auth.ts); Anthropic an `ANTHROPIC_API_KEY` or its own OAuth. `faux` is the scripted
 * offline model.
 */
export function createProcessModels(config: Config, credentials: CredentialStore): MutableModels {
	const models = createModels({ credentials });
	models.setProvider(openaiProvider());
	models.setProvider(anthropicProvider());
	if (config.model.provider === "faux") {
		const faux = fauxProvider({ tokensPerSecond: 400 });
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: 1000 }, () => fauxAssistantMessage("(faux model) Offline development reply.")));
	}
	return models;
}

export async function openHarness(
	config: Config,
	models: MutableModels,
	{ db, events, onReport, toolsRetry }: HarnessDeps,
	context: Context,
): Promise<OpenedHarness> {
	await mkdir(config.workspaceRoot, { recursive: true });

	const model = config.model;
	// A wrong default model must not take the service down: existing conversations keep their own model. New
	// conversations without an explicit model are rejected with 422 until the default is fixed.
	try {
		assertKnownModel(models, model);
	} catch (error) {
		log.error("default model is unknown; fix DURABLE_AGENT_MODEL and restart", { error });
	}
	const auth = await models.checkAuth(model.provider).catch(() => undefined);
	if (model.provider !== "faux" && auth === undefined) {
		log.warn("default provider has no credentials; runs settle unanswered until someone signs in", { provider: model.provider });
	}

	const registry = createRegistry();
	// Loaded by the caller, in the background: boot must not wait for Rails.
	const tools = new RailsTools(registry, config.railsUrl, config.token, toolsRetry);

	const storage = new ChangeTracker(withBaseDocuments(await openHarnessStorage(db)), events);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceRoot }),
			onReport,
		},
		context,
	);

	return {
		harness,
		models,
		model,
		tools,
		close: async (ctx) => {
			tools.stop();
			await harness.close(ctx);
		},
	};
}
