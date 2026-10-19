import { resolve } from "node:path";

export type Config = {
	readonly port: number;
	readonly host: string;
	readonly token: string;
	readonly databaseUrl: string;
	readonly storagePath: string;
	readonly workspaceRoot: string;
	/** Default model for new conversations. Provider `faux` runs pi-ai's scripted model, for offline development. */
	readonly model: { readonly provider: string; readonly modelId: string };
	/** Name shown to the user during Sign in with ChatGPT and sent to OpenAI as the agent name. */
	readonly agentName: string;
	readonly enableCodingTools: boolean;
	readonly railsUrl: string | undefined;
	readonly railsWebhookPath: string;
	/** `undefined` mirrors every document. */
	readonly mirrorDocs: ReadonlySet<string> | undefined;
};

const env = (name: string, fallback?: string): string => {
	const value = process.env[name];
	if (value !== undefined && value !== "") return value;
	if (fallback !== undefined) return fallback;
	throw new Error(`Missing required environment variable ${name}`);
};

export function loadConfig(): Config {
	const mirrorDocs = env("MIRROR_DOCS", "all");
	return {
		// SIDECAR_PORT first: process managers (foreman, overmind) set PORT per process, which must not move the sidecar.
		port: Number(process.env.SIDECAR_PORT || env("PORT", "4010")),
		host: env("HOST", "127.0.0.1"),
		token: env("SIDECAR_TOKEN"),
		databaseUrl: env("DATABASE_URL"),
		storagePath: resolve(env("STORAGE_PATH", "./data/harness.sqlite")),
		workspaceRoot: resolve(env("WORKSPACE_ROOT", "./data/workspace")),
		model: { provider: env("MODEL_PROVIDER", "openai"), modelId: env("MODEL_ID", "gpt-6.1-sol") },
		agentName: env("AGENT_NAME", "slopdep"),
		enableCodingTools: env("ENABLE_CODING_TOOLS", "false") === "true",
		railsUrl: process.env.RAILS_URL || undefined,
		railsWebhookPath: env("RAILS_WEBHOOK_PATH", "/internal/agent/reports"),
		mirrorDocs: mirrorDocs === "all" ? undefined : new Set(mirrorDocs.split(",").map((kind) => kind.trim())),
	};
}
