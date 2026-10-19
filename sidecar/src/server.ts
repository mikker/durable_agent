// The HTTP API v1 Rails calls (DESIGN.md, "Sidecar HTTP API v1"). Commands only: Rails reads agent state from the
// mirror tables, never from here. Anything not listed below is a 404.
import type { Context as PiContext } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	ConversationBusy,
	type ConversationId,
	type Harness,
	type InputSubmissionDraft,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logins } from "./auth.ts";
import { parseModel } from "./config.ts";
import { SCHEMA_VERSION } from "./credentials.ts";
import type { Mirror } from "./mirror.ts";
import { assertKnownModel, UnknownModel } from "./models-check.ts";
import type { RailsTools } from "./tools.ts";

export type ServerDeps = {
	readonly harness: Harness;
	readonly models: Models;
	readonly mirror: Mirror;
	readonly logins: Logins;
	readonly tools: RailsTools;
	readonly token: string;
	readonly defaultModel: ModelRef;
	readonly context: PiContext;
};

const WHEN_BUSY = ["followUp", "steer", "reject"] as const;
type WhenBusy = (typeof WHEN_BUSY)[number];

const badRequest = (message: string): HTTPException => new HTTPException(400, { message });

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Missing or malformed JSON bodies read as `{}`; every route validates the fields it needs. */
const body = async (request: Request): Promise<Record<string, unknown>> => {
	const parsed: unknown = await request.json().catch(() => ({}));
	return isObject(parsed) ? parsed : {};
};

/** `{provider, modelId}` per the contract; a `provider/modelId` string is accepted too, as the env var spells it. */
const modelRef = (value: unknown): ModelRef | undefined => {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		try {
			return parseModel(value);
		} catch {
			throw badRequest("model must be {provider, modelId}");
		}
	}
	if (isObject(value) && typeof value.provider === "string" && typeof value.modelId === "string") {
		return { provider: value.provider, modelId: value.modelId };
	}
	throw badRequest("model must be {provider, modelId}");
};

export function createServer({ harness, models, mirror, logins, tools, token, defaultModel, context }: ServerDeps) {
	const app = new Hono();

	app.use("*", async (c, next) => {
		if (c.req.path === "/health") return next();
		if (c.req.header("authorization") !== `Bearer ${token}`) throw new HTTPException(401, { message: "unauthorized" });
		return next();
	});

	app.notFound((c) => c.json({ error: "not_found" }, 404));

	app.onError((error, c) => {
		if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
		if (error instanceof ConversationBusy) return c.json({ error: "conversation_busy" }, 409);
		if (error instanceof UnknownModel) return c.json({ error: error.message, suggestions: error.suggestions }, 422);
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
	});

	const conversation = async (raw: string) => {
		const id = Number(raw);
		const found = Number.isInteger(id) && id > 0 ? await harness.conversation(id as ConversationId, context) : undefined;
		if (found === undefined) throw new HTTPException(404, { message: "conversation not found" });
		return found;
	};

	app.get("/health", (c) => c.json({ ok: true, schemaVersion: SCHEMA_VERSION, model: defaultModel }));

	// Conversations -------------------------------------------------------------------------------------------------

	app.post("/conversations", async (c) => {
		const input = await body(c.req.raw);
		const model = modelRef(input.model) ?? defaultModel;
		assertKnownModel(models, model);
		if (input.instructions !== undefined && input.instructions !== null && typeof input.instructions !== "string") {
			throw badRequest("instructions must be a string");
		}
		const instructions = typeof input.instructions === "string" ? input.instructions : undefined;
		const created = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model, ...(instructions === undefined ? {} : { instructions }) } },
			context,
		);
		await mirror.attach(created.id);
		return c.json({ id: created.id }, 201);
	});

	app.post("/conversations/:id/submissions", async (c) => {
		const found = await conversation(c.req.param("id"));
		const input = await body(c.req.raw);
		if (typeof input.content !== "string" && !Array.isArray(input.content)) {
			throw badRequest("content must be a string or content blocks");
		}
		const requestId = typeof input.request_id === "number" ? String(input.request_id) : input.request_id;
		if (typeof requestId !== "string" || requestId === "") throw badRequest("request_id is required");
		const whenBusy = input.when_busy ?? undefined;
		if (whenBusy !== undefined && !WHEN_BUSY.includes(whenBusy as WhenBusy)) {
			throw badRequest(`when_busy must be one of ${WHEN_BUSY.join(", ")}`);
		}
		const draft: InputSubmissionDraft = {
			type: "input",
			requestId,
			content: input.content as InputSubmissionDraft["content"],
			...(whenBusy === undefined ? {} : { whenBusy: whenBusy as WhenBusy }),
		};
		// Idempotent: the Harness returns the existing submission for a request id it has seen.
		const submission = await found.submit(draft, context);
		mirror.track(submission, found, draft);
		const record = await submission.status(context);
		return c.json({ id: submission.id, status: record.status }, 202);
	});

	app.post("/conversations/:id/abort", async (c) => {
		const found = await conversation(c.req.param("id"));
		await found.abort(context);
		return c.json({ ok: true });
	});

	// Provider sign-in -----------------------------------------------------------------------------------------------
	// Sign in with ChatGPT and the other OAuth flows are interactive; Rails drives them through these routes. The
	// flow also listens on 127.0.0.1:1455 for the browser redirect, which completes the login by itself when the
	// browser runs on this host (development). Otherwise the user pastes the final redirect URL and Rails posts it.

	app.get("/auth", async (c) => c.json(await logins.status()));

	app.post("/auth/:provider/logins", async (c) => {
		const login = await logins.start(c.req.param("provider"));
		return c.json(login, login.status === "failed" ? 422 : 201);
	});

	app.get("/auth/:provider/logins/:id", (c) => {
		const login = logins.get(c.req.param("id"));
		if (login === undefined) throw new HTTPException(404, { message: "login not found" });
		return c.json(login);
	});

	app.post("/auth/:provider/logins/:id/callback", async (c) => {
		const input = await body(c.req.raw);
		if (typeof input.url !== "string") throw badRequest("url is required");
		const login = logins.complete(c.req.param("id"), input.url);
		if (login === undefined) throw new HTTPException(404, { message: "login not found" });
		return c.json(login);
	});

	app.delete("/auth/:provider/logins/:id", (c) => {
		const login = logins.cancel(c.req.param("id"));
		if (login === undefined) throw new HTTPException(404, { message: "login not found" });
		return c.json(login);
	});

	app.delete("/auth/:provider", async (c) => {
		await logins.logout(c.req.param("provider"));
		return c.json({ ok: true });
	});

	// Tools ----------------------------------------------------------------------------------------------------------

	app.post("/tools/reload", async (c) => {
		try {
			return c.json({ tools: await tools.reload() });
		} catch (error) {
			// The previous tool set stays installed.
			throw new HTTPException(502, { message: `could not fetch tool definitions: ${error instanceof Error ? error.message : String(error)}` });
		}
	});

	return app;
}
