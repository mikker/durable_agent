// Every knob comes from the environment. `bin/rails durable_agent:sidecar` derives each value from Rails
// configuration (see DESIGN.md, "Sidecar environment"); the defaults here only matter when running by hand.
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Config = {
	readonly port: number;
	readonly host: string;
	readonly token: string;
	readonly databaseUrl: string;
	readonly storagePath: string;
	/** cwd handed to the execution environment. No built-in tools use it in v0; the knob stays for later. */
	readonly workspaceRoot: string;
	/** Default model for new conversations. `faux/faux-1` runs pi-ai's scripted model, for offline development. */
	readonly model: ModelRef;
	/** Name shown to the user during Sign in with ChatGPT and sent to OpenAI as the agent name. */
	readonly agentName: string;
	/** Where Rails answers `/durable_agent/tools`; `undefined` runs without tools. */
	readonly railsUrl: string | undefined;
	/** `undefined` mirrors every document. */
	readonly mirrorDocs: ReadonlySet<string> | undefined;
};

type Env = Readonly<Record<string, string | undefined>>;

/** `provider/modelId`, split at the first slash so model ids that contain slashes (OpenRouter style) survive. */
export function parseModel(value: string): ModelRef {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`DURABLE_AGENT_MODEL must look like provider/modelId, got ${JSON.stringify(value)}`);
	}
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function loadConfig(source: Env = process.env): Config {
	const env = (name: string, fallback?: string): string => {
		const value = source[name];
		if (value !== undefined && value !== "") return value;
		if (fallback !== undefined) return fallback;
		throw new Error(`Missing required environment variable ${name}`);
	};
	const mirrorDocs = env("DURABLE_AGENT_MIRROR_DOCS", "all");
	return {
		port: Number(env("DURABLE_AGENT_PORT", "4010")),
		host: env("DURABLE_AGENT_HOST", "127.0.0.1"),
		token: env("DURABLE_AGENT_TOKEN"),
		databaseUrl: env("DATABASE_URL"),
		storagePath: resolve(env("DURABLE_AGENT_STORAGE_PATH", "storage/durable_agent.sqlite")),
		workspaceRoot: resolve(env("DURABLE_AGENT_WORKSPACE_ROOT", "storage/durable_agent")),
		model: parseModel(env("DURABLE_AGENT_MODEL", "openai/gpt-6.1-sol")),
		agentName: env("DURABLE_AGENT_NAME", "durable_agent"),
		railsUrl: source.DURABLE_AGENT_RAILS_URL || undefined,
		mirrorDocs:
			mirrorDocs === "all"
				? undefined
				: new Set(
						mirrorDocs
							.split(",")
							.map((kind) => kind.trim())
							.filter((kind) => kind !== ""),
					),
	};
}
