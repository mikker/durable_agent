// The sidecar without its HTTP server: credential store and models, account providers, sign-ins, change events,
// reports, the tools from Rails, and the pi-durable Harness over the app's database. main.ts serves it and the
// tests boot the same one.
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerStoredAccounts } from "./accounts.ts";
import { Logins } from "./auth.ts";
import type { Config } from "./config.ts";
import { DbCredentialStore } from "./credentials.ts";
import type { Db } from "./db/index.ts";
import { withBaseDocuments } from "./documents.ts";
import { ChangeTracker, Events } from "./events.ts";
import { log } from "./log.ts";
import { assertKnownModel } from "./models-check.ts";
import { createReporter, type Reporter } from "./reports.ts";
import { checkSchemaVersion, installationDeviceId } from "./settings.ts";
import { isMissingTable, MissingSchema, openHarnessStorage } from "./storage.ts";
import { type BootRetry, RailsTools } from "./tools.ts";

const context = BACKGROUND_CONTEXT;

export type SidecarOptions = {
	/** Model access over the credential store; `createProcessModels` by default. */
	readonly models?: (credentials: CredentialStore) => MutableModels;
	readonly toolsRetry?: BootRetry;
};

export type Sidecar = {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly tools: RailsTools;
	readonly logins: Logins;
	readonly events: Events;
	readonly reporter: Reporter;
	/** Cancel logins, store the reports in flight, close the Harness (and the database with it), flush events. */
	close(): Promise<void>;
};

/**
 * Model access for the whole process. OpenAI accepts an `OPENAI_API_KEY` or a Sign in with ChatGPT credential
 * from the store (see auth.ts); Anthropic an `ANTHROPIC_API_KEY` or its own OAuth. `faux` is the scripted
 * offline model, always registered: a conversation pins the model it was started with, so one started on
 * `faux/faux-1` must still answer after the default moves to a real provider.
 */
export function createProcessModels(credentials: CredentialStore): MutableModels {
	const models = createModels({ credentials });
	models.setProvider(openaiProvider());
	models.setProvider(anthropicProvider());
	const faux = fauxProvider({ tokensPerSecond: 400 });
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 1000 }, () => fauxAssistantMessage("(faux model) Offline development reply.")));
	return models;
}

/**
 * Boot up to the root conversation (DESIGN.md, "Boot and shutdown"); a missing table at any step is `MissingSchema`.
 * The caller loads the tools, then resumes the Harness.
 */
export async function openSidecar(db: Db, config: Config, options: SidecarOptions = {}): Promise<Sidecar> {
	try {
		await checkSchemaVersion(db);
		// Provider credentials live in the app's database, encrypted under a key derived from the shared token.
		const credentials = new DbCredentialStore(db, config.token);
		const models = options.models?.(credentials) ?? createProcessModels(credentials);
		// Every account that has signed in has a provider of its own (`openai@u42`); its conversations pin it.
		await registerStoredAccounts(models, credentials);
		const deviceId = await installationDeviceId(db);
		const events = new Events({ railsUrl: config.railsUrl, token: config.token });
		const logins = new Logins(models, deviceId, config.agentName, (provider) => events.auth(provider));
		const reporter = createReporter(db, events);
		await mkdir(config.workspaceRoot, { recursive: true });
		await checkDefaultModel(models, config);

		const registry = createRegistry();
		const tools = new RailsTools(registry, config.railsUrl, config.token, options.toolsRetry);
		const storage = new ChangeTracker(withBaseDocuments(await openHarnessStorage(db)), events);
		const harness = await Harness.open(
			storage,
			{ models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceRoot }), onReport: reporter },
			context,
		);
		// The root conversation exists from the first boot, so a Rails app that only ever wants one can use id 1.
		await harness.root(context, { agent: { model: config.model } });

		return {
			harness,
			models,
			tools,
			logins,
			events,
			reporter,
			close: async () => {
				logins.dispose();
				// A report raised just before shutdown may still be inserting; the Harness closes the database.
				await reporter.settled();
				tools.stop();
				// Close commits nothing new; interrupted work stays pending and resumes on the next start.
				await harness.close(context);
				await events.flush();
			},
		};
	} catch (error) {
		throw !(error instanceof MissingSchema) && isMissingTable(error) ? new MissingSchema(error) : error;
	}
}

// A wrong default model must not take the service down: existing conversations keep their own model. New
// conversations without an explicit model are rejected with 422 until the default is fixed.
async function checkDefaultModel(models: MutableModels, { model }: Config): Promise<void> {
	try {
		assertKnownModel(models, model);
	} catch (error) {
		log.error("default model is unknown; fix DURABLE_AGENT_MODEL and restart", { error });
	}
	const auth = await models.checkAuth(model.provider).catch(() => undefined);
	if (model.provider !== "faux" && auth === undefined) {
		log.warn("default provider has no credentials; runs settle unanswered until someone signs in", { provider: model.provider });
	}
}
