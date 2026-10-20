// Accounts as provider ids (DESIGN.md, "Accounts"). An account is an app-chosen name for whose credentials a
// conversation runs on: `openai@u42` is the account `u42`'s OpenAI provider. Its provider is a clone of the base
// provider registered under the scoped id, so pi-ai keys the credential store, login, logout and checkAuth by it and
// a conversation pins it in `pi.agent`. Only the credential row differs from the base provider.
import type { ApiKeyAuth, AuthContext, CredentialStore, MutableModels, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { log } from "./log.ts";

export const ACCOUNT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const isValidAccount = (value: unknown): value is string => typeof value === "string" && ACCOUNT_PATTERN.test(value);

export const scopedProviderId = (base: string, account: string): string => `${base}@${account}`;

/** `openai@u42` → `{provider: "openai", account: "u42"}`; split on the first `@`. */
export function parseProviderId(id: string): { provider: string; account?: string } {
	const at = id.indexOf("@");
	return at < 0 ? { provider: id } : { provider: id.slice(0, at), account: id.slice(at + 1) };
}

/** A base provider no account can be scoped to; the server answers 422. */
export class UnknownBaseProvider extends Error {
	readonly provider: string;
	constructor(provider: string) {
		super(`Provider ${provider} cannot be scoped to an account`);
		this.name = "UnknownBaseProvider";
		this.provider = provider;
	}
}

/**
 * A fresh base provider per account. openai and anthropic are built by their factories again; faux reuses the
 * registered provider so its scripted responses keep coming from one queue.
 */
const BASES: Readonly<Record<string, (models: MutableModels) => Provider | undefined>> = {
	openai: () => openaiProvider(),
	anthropic: () => anthropicProvider(),
	faux: (models) => models.getProvider("faux"),
};

/** The account's provider id for `base`, registering its clone the first time. Throws `UnknownBaseProvider`. */
export function ensureAccountProvider(models: MutableModels, base: string, account: string): string {
	if (!isValidAccount(account)) throw new Error(`invalid account ${JSON.stringify(account)}`);
	const id = scopedProviderId(base, account);
	if (models.getProvider(id) !== undefined) return id;
	const factory = Object.hasOwn(BASES, base) ? BASES[base] : undefined;
	const provider = factory?.(models);
	if (provider === undefined) throw new UnknownBaseProvider(base);
	models.setProvider(accountProvider(provider, id));
	return id;
}

/** Register every account provider named by a stored credential, so restarted conversations find theirs. */
export async function registerStoredAccounts(models: MutableModels, credentials: CredentialStore): Promise<string[]> {
	const registered: string[] = [];
	for (const { providerId } of await credentials.list()) {
		const { provider, account } = parseProviderId(providerId);
		if (account === undefined) continue;
		try {
			registered.push(ensureAccountProvider(models, provider, account));
		} catch (error) {
			log.warn("stored credential names an account provider this sidecar cannot register; skipping it", { provider: providerId, error });
		}
	}
	return registered;
}

/** No environment and no files: an account runs on its own credential only, never on the app's OPENAI_API_KEY. */
const NO_AMBIENT: AuthContext = { env: async () => undefined, fileExists: async () => false };

const withoutAmbient = (auth: ApiKeyAuth): ApiKeyAuth => ({
	...auth,
	resolve: (input) => auth.resolve({ ...input, ctx: NO_AMBIENT }),
	...(auth.check === undefined ? {} : { check: (input: Parameters<NonNullable<ApiKeyAuth["check"]>>[0]) => auth.check!({ ...input, ctx: NO_AMBIENT }) }),
});

/**
 * `base` under the scoped id. pi-ai routes a request and resolves its auth by `model.provider`, so the clone's
 * models carry the scoped id; the request code sees the base id again, because it switches on it (Sign in with
 * ChatGPT is recognised only for `provider === "openai"`, for one).
 */
function accountProvider(base: Provider, id: string): Provider {
	const scoped = new WeakMap<object, object>();
	const scope = <M extends { provider: string }>(model: M): M => {
		let clone = scoped.get(model) as M | undefined;
		if (clone === undefined) {
			clone = { ...model, provider: id };
			scoped.set(model, clone);
		}
		return clone;
	};
	const unscope = <M extends { provider: string }>(model: M): M => ({ ...model, provider: base.id });
	const clone: Provider = {
		...base,
		id,
		auth: { ...base.auth, ...(base.auth.apiKey === undefined ? {} : { apiKey: withoutAmbient(base.auth.apiKey) }) },
		getModels: () => base.getModels().map(scope),
		getAllModels: () => (base.getAllModels?.() ?? base.getModels()).map(scope),
		stream: (model, context, options) => base.stream(unscope(model), context, options),
		streamSimple: (model, context, options) => base.streamSimple(unscope(model), context, options),
	};
	const mutable = clone as { -readonly [K in keyof Provider]: Provider[K] };
	if (base.fetchDeferred !== undefined) {
		const fetchDeferred = base.fetchDeferred;
		mutable.fetchDeferred = (model, handle, options) => fetchDeferred(unscope(model), handle, options);
	}
	if (base.cancelDeferred !== undefined) {
		const cancelDeferred = base.cancelDeferred;
		mutable.cancelDeferred = (model, handle, options) => cancelDeferred(unscope(model), handle, options);
	}
	if (base.generateImages !== undefined) {
		const generateImages = base.generateImages;
		mutable.generateImages = (model, context, options) => generateImages(unscope(model), context, options);
	}
	if (base.classify !== undefined) {
		const classify = base.classify;
		mutable.classify = (model, context, options) => classify(unscope(model), context, options);
	}
	return clone;
}
