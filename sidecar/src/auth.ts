// Provider sign-in for a headless process. pi-ai's login flows are interactive: they hand out a URL to open, wait
// for a loopback callback on 127.0.0.1:1455, and also accept the final redirect URL pasted back. Here the
// interaction is driven over HTTP: Rails starts a login, shows the user the URL, and posts back what the browser
// ended on when the loopback cannot reach this process (the usual case for a deployed sidecar).
import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, Models } from "@earendil-works/pi-ai";
import { log } from "./log.ts";

type LoginStatus = "starting" | "awaiting_browser" | "exchanging" | "done" | "failed";

export type Login = {
	readonly id: string;
	readonly provider: string;
	status: LoginStatus;
	url?: string;
	instructions?: string;
	/** A device-code flow (GitHub Copilot style): show this code at this URL instead of following `url`. */
	deviceCode?: { userCode: string; verificationUri: string };
	messages: string[];
	error?: string;
	readonly createdAt: number;
};

type Pending = {
	readonly login: Login;
	readonly abort: AbortController;
	resolveManual?: (input: string) => void;
};

export class Logins {
	readonly #models: Models;
	readonly #deviceId: string;
	readonly #agentName: string;
	readonly #pending = new Map<string, Pending>();
	readonly #changed: (provider: string) => void;

	/**
	 * `deviceId` is the installation's. `changed` hears of every completed sign-in and every sign-out, which reach Rails
	 * as auth events.
	 */
	constructor(models: Models, deviceId: string, agentName: string, changed: (provider: string) => void = () => {}) {
		this.#models = models;
		this.#deviceId = deviceId;
		this.#agentName = agentName;
		this.#changed = changed;
	}

	/** Start a login and resolve once the flow has something to show the user. One login per provider at a time. */
	async start(provider: string): Promise<Login> {
		for (const pending of this.#pending.values()) {
			if (pending.login.provider === provider && !settled(pending.login)) return pending.login;
		}
		const login: Login = { id: randomUUID(), provider, status: "starting", messages: [], createdAt: Date.now() };
		const abort = new AbortController();
		const pending: Pending = { login, abort };
		this.#pending.set(login.id, pending);

		let ready!: () => void;
		const shown = new Promise<void>((resolve) => {
			ready = resolve;
		});

		const notify = (event: AuthEvent): void => {
			switch (event.type) {
				case "auth_url":
					login.url = event.url;
					login.instructions = event.instructions;
					login.status = "awaiting_browser";
					ready();
					break;
				case "device_code":
					login.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
					login.status = "awaiting_browser";
					ready();
					break;
				case "progress":
					login.messages.push(event.message);
					if (login.status === "awaiting_browser") login.status = "exchanging";
					break;
				case "info":
					login.messages.push(event.message);
					break;
			}
		};

		const prompt = (request: AuthPrompt): Promise<string> => {
			if (request.type !== "manual_code") {
				// Text, secret, and select prompts would need a UI of their own; the providers wired here never ask.
				return Promise.reject(new Error(`login asked for a ${request.type} prompt, which this sidecar cannot answer`));
			}
			return new Promise<string>((resolve, reject) => {
				pending.resolveManual = resolve;
				request.signal?.addEventListener("abort", () => reject(new Error("login cancelled")), { once: true });
			});
		};

		void this.#models
			.login(provider, "oauth", { signal: abort.signal, notify, prompt }, { getDeviceId: () => this.#deviceId, agentName: this.#agentName })
			.then(() => {
				login.status = "done";
				log.info("provider connected", { provider });
				this.#changed(provider);
			})
			.catch((error: unknown) => {
				login.status = "failed";
				login.error = error instanceof Error ? error.message : String(error);
				log.warn("provider login failed", { provider, error: login.error });
			})
			.finally(() => {
				ready();
				setTimeout(() => this.#pending.delete(login.id), 10 * 60_000).unref();
			});

		await shown;
		return login;
	}

	get(id: string): Login | undefined {
		return this.#pending.get(id)?.login;
	}

	/** The browser ended on the redirect URL; hand it to the flow in place of the loopback callback. */
	complete(id: string, redirectUrl: string): Login | undefined {
		const pending = this.#pending.get(id);
		if (pending === undefined) return undefined;
		if (pending.resolveManual === undefined) {
			pending.login.messages.push("no manual input was expected; waiting for the flow");
			return pending.login;
		}
		pending.login.status = "exchanging";
		pending.resolveManual(redirectUrl);
		return pending.login;
	}

	cancel(id: string): Login | undefined {
		const pending = this.#pending.get(id);
		if (pending === undefined) return undefined;
		pending.abort.abort(new Error("login cancelled"));
		return pending.login;
	}

	/**
	 * Store an API key for `provider` through its own API-key login, which answers its one secret prompt with `key`.
	 * The caller has checked that the provider has API-key auth with a login.
	 */
	async storeApiKey(provider: string, key: string): Promise<void> {
		const prompt = (request: AuthPrompt): Promise<string> =>
			request.type === "secret" ? Promise.resolve(key) : Promise.reject(new Error(`API-key login asked for a ${request.type} prompt`));
		await this.#models.login(provider, "api_key", { signal: new AbortController().signal, notify: () => {}, prompt });
		log.info("provider API key stored", { provider });
		this.#changed(provider);
	}

	async logout(provider: string): Promise<void> {
		await this.#models.logout(provider);
		this.#changed(provider);
	}

	/** Cancel every pending login, for shutdown. */
	dispose(): void {
		for (const pending of this.#pending.values()) pending.abort.abort(new Error("sidecar shutting down"));
	}
}

const settled = (login: Login): boolean => login.status === "done" || login.status === "failed";
