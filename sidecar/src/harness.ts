// Opens the pi-durable Harness this process owns: storage, model access, the extension registry, and the tool
// environment. Everything the HTTP API and the mirror do goes through the Harness returned here.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type ConversationRecord,
	createRegistry,
	defineExtension,
	type Harness as HarnessType,
	Harness,
	type ModelRef,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { assertKnownModel } from "./models-check.ts";
import { createLookupRecordTool } from "./tools/lookup-record.ts";

export type HarnessCallbacks = {
	/** Runs inside the creating commit; must not do async work against the Harness. Queue and act after. */
	readonly onConversationCreated: (conversation: ConversationRecord) => void;
	/** `info` arrives from pi-durable releases newer than 1.3.0; it is `undefined` on 1.3.0. */
	readonly onReport: (error: unknown, info?: unknown) => void;
};

export type OpenedHarness = {
	readonly harness: HarnessType;
	readonly models: MutableModels;
	readonly model: ModelRef;
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
	callbacks: HarnessCallbacks,
	context: Context,
): Promise<OpenedHarness> {
	await mkdir(dirname(config.storagePath), { recursive: true });
	await mkdir(config.workspaceRoot, { recursive: true });

	const model: ModelRef = config.model.provider === "faux" ? { provider: "faux", modelId: "faux-1" } : config.model;
	// A wrong default model must not take the service down: existing conversations keep their own model and can be
	// reconfigured. New conversations and agent changes are rejected with 422 until the default is fixed.
	try {
		assertKnownModel(models, model);
	} catch (error) {
		log.error("default model is unknown; fix MODEL_ID and restart", { error });
	}
	const auth = await models.checkAuth(model.provider).catch(() => undefined);
	if (model.provider !== "faux" && auth === undefined) {
		log.warn("default provider has no credentials; runs fail until someone signs in", { provider: model.provider });
	}

	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "app",
			sections: [
				section(
					"preamble",
					() => "You are the assistant inside this application. Be concise and act through the tools you are given.",
					{ tag: false },
				),
			],
			tools: config.railsUrl === undefined ? [] : [createLookupRecordTool(config.railsUrl, config.token)],
		}),
	);
	if (config.enableCodingTools) registry.install(CodingTools);

	const storage = await openNodeSqliteStorage(config.storagePath);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceRoot }),
			conversationCreated: (_tx, conversation) => callbacks.onConversationCreated(conversation),
			onReport: callbacks.onReport,
		},
		context,
	);

	return { harness, models, model, close: (ctx) => harness.close(ctx) };
}
