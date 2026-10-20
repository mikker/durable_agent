// Tools are Ruby classes; the sidecar forwards calls to them. At boot and on POST /tools/reload it fetches the
// definitions from `GET {railsUrl}/durable_agent/tools`, and every call the model makes becomes
// `POST {railsUrl}/durable_agent/tools/:name`. The definitions live in one extension named "rails"; the registry's
// `install()` replaces an installed extension of the same name in place, so a reload swaps the tool set atomically
// and the next model request sees it.
import type { TSchema } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type JsonObject,
	type Registry,
	section,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { log } from "./log.ts";

const RAILS_EXTENSION = "rails";
const TOOL_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;

export type ToolDefinition = {
	readonly name: string;
	readonly description: string;
	readonly parameters: JsonObject;
	readonly replay: "safe" | "unsafe";
};

// Provider tool names: OpenAI and Anthropic both accept this alphabet and length.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Keep the definitions that are well formed; log and drop the rest, so one bad Ruby class does not hide the others. */
function parseDefinitions(body: unknown): ToolDefinition[] {
	if (!Array.isArray(body)) throw new Error("expected a JSON array of tool definitions");
	const definitions: ToolDefinition[] = [];
	const seen = new Set<string>();
	for (const raw of body) {
		if (!isObject(raw) || typeof raw.name !== "string" || !TOOL_NAME.test(raw.name)) {
			log.warn("tools: skipping a definition without a valid name", { definition: raw });
			continue;
		}
		if (seen.has(raw.name)) {
			log.warn("tools: skipping a duplicate definition", { name: raw.name });
			continue;
		}
		const parameters = raw.parameters ?? { type: "object", properties: {} };
		if (!isObject(parameters) || parameters.type !== "object") {
			log.warn("tools: skipping a definition whose parameters are not an object schema", { name: raw.name });
			continue;
		}
		seen.add(raw.name);
		definitions.push({
			name: raw.name,
			description: typeof raw.description === "string" ? raw.description : "",
			parameters: parameters as JsonObject,
			replay: raw.replay === "safe" ? "safe" : "unsafe",
		});
	}
	return definitions;
}

async function fetchDefinitions(railsUrl: string, token: string): Promise<ToolDefinition[]> {
	const response = await fetch(new URL("/durable_agent/tools", railsUrl), {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`GET /durable_agent/tools returned ${response.status}`);
	return parseDefinitions(await response.json());
}

const textResult = (text: string, isError = false): ToolExecutionResult => ({
	output: [{ type: "text", text }],
	...(isError ? { isError: true } : {}),
});

const errorMessage = (error: unknown): string => {
	if (!(error instanceof Error)) return String(error);
	if (error.name === "TimeoutError") return `timed out after ${TOOL_TIMEOUT_MS / 1000} s`;
	// undici reports "fetch failed" and puts the useful part (ECONNREFUSED, ...) in `cause`.
	return error.cause instanceof Error ? error.cause.message : error.message;
};

function railsTool(definition: ToolDefinition, railsUrl: string, token: string): ToolRegistration {
	const url = new URL(`/durable_agent/tools/${encodeURIComponent(definition.name)}`, railsUrl);
	return defineTool({
		name: definition.name,
		description: definition.description,
		// The JSON Schema as is: TypeBox's `TSchema` is an open interface, and pi-ai's `validateToolArguments` compiles
		// plain JSON Schema. `Type.Unsafe()` would add a `~unsafe` key that is then sent to providers.
		parameters: definition.parameters satisfies TSchema,
		replay: definition.replay,
		execute: async (args, api, context) => {
			const timeout = AbortSignal.timeout(TOOL_TIMEOUT_MS);
			const signal = context.abortSignal === undefined ? timeout : AbortSignal.any([timeout, context.abortSignal]);
			let response: Response;
			let text: string;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
					body: JSON.stringify({ arguments: args, conversation_id: api.conversationId, call_id: api.callId }),
					signal,
				});
				text = await response.text();
			} catch (error) {
				log.warn("tools: call to Rails failed", { tool: definition.name, error });
				return textResult(`Tool ${definition.name} could not reach the application: ${errorMessage(error)}`, true);
			}

			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				body = undefined;
			}
			if (response.ok) {
				if (!isObject(body) || !("result" in body)) return textResult(text);
				return textResult(typeof body.result === "string" ? body.result : JSON.stringify(body.result ?? null));
			}
			const message = isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}: ${text.slice(0, 500)}`;
			return textResult(message, true);
		},
	});
}

function railsExtension(tools: readonly ToolRegistration[]): Extension {
	return defineExtension({
		name: RAILS_EXTENSION,
		sections: [
			section(
				"preamble",
				() => "You are the assistant inside this application. Be concise and act through the tools you are given.",
				{ tag: false },
			),
		],
		tools,
	});
}

export type BootRetry = {
	readonly initialMs: number;
	readonly maxMs: number;
	readonly totalMs: number;
};

// `bin/dev` starts node before Puma listens, so the first fetches at boot are expected to fail.
const BOOT_RETRY: BootRetry = { initialMs: 500, maxMs: 10_000, totalMs: 60_000 };

/** Owns the "rails" extension in a registry: installs it once with no tools, then swaps in what Rails reports. */
export class RailsTools {
	readonly #registry: Registry;
	readonly #railsUrl: string | undefined;
	readonly #token: string;
	readonly #retry: BootRetry;
	readonly #stopped = new AbortController();
	#loaded = false;
	#names: readonly string[] = [];

	constructor(registry: Registry, railsUrl: string | undefined, token: string, retry: BootRetry = BOOT_RETRY) {
		this.#registry = registry;
		this.#railsUrl = railsUrl;
		this.#token = token;
		this.#retry = retry;
		registry.install(railsExtension([]));
	}

	/** Fetch and install. Throws when Rails cannot be asked; the installed tools stay as they were. */
	async reload(): Promise<string[]> {
		const railsUrl = this.#railsUrl;
		if (railsUrl === undefined) return [];
		const definitions = await fetchDefinitions(railsUrl, this.#token);
		this.#registry.install(railsExtension(definitions.map((definition) => railsTool(definition, railsUrl, this.#token))));
		this.#loaded = true;
		const names = definitions.map((definition) => definition.name);
		this.#names = names;
		log.info("tools loaded", { tools: names });
		return names;
	}

	/** The tools installed now, as `GET /health` reports them. */
	get names(): readonly string[] {
		return this.#names;
	}

	/**
	 * Boot: retries with backoff until Rails answers or the retry budget runs out, then runs with no tools until
	 * `/tools/reload`. Never rejects. Boot awaits it before resuming, because pi-durable decides whether an interrupted
	 * tool call may run again by the tool registered at that moment. Stops early once a reload succeeded or on `stop()`.
	 */
	async load(): Promise<string[]> {
		if (this.#railsUrl === undefined) {
			log.warn("DURABLE_AGENT_RAILS_URL is not set; running with no tools");
			return [];
		}
		const deadline = Date.now() + this.#retry.totalMs;
		let delay = this.#retry.initialMs;
		for (;;) {
			try {
				return await this.reload();
			} catch (error) {
				if (Date.now() + delay > deadline) {
					log.warn("could not fetch tool definitions from Rails; running with no tools", { railsUrl: this.#railsUrl, error });
					return [];
				}
			}
			if (!(await this.#sleep(delay)) || this.#loaded) return [];
			delay = Math.min(delay * 2, this.#retry.maxMs);
		}
	}

	stop(): void {
		this.#stopped.abort();
	}

	/** `false` when stopped while sleeping. */
	#sleep(ms: number): Promise<boolean> {
		const signal = this.#stopped.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", stop);
				resolve(true);
			}, ms);
			const stop = () => {
				clearTimeout(timer);
				resolve(false);
			};
			signal.addEventListener("abort", stop, { once: true });
		});
	}
}
