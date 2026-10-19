// The internal HTTP API Rails calls. Commands only: Rails never asks the sidecar for state it can read from the
// mirror tables, except the debug endpoints (GET view, SSE events), which exist for development and operators.
import type { Context as PiContext } from "@earendil-works/chord/context";
import {
	type AgentChange,
	ConversationBusy,
	type ConversationId,
	type Harness,
	type ModelRef,
	type SubmissionDraft,
	type SubmissionId,
	type TaskId,
	watchEvents,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { Models } from "@earendil-works/pi-ai";
import type { Logins } from "./auth.ts";
import type { Mirror } from "./mirror.ts";
import { assertKnownModel, UnknownModel } from "./models-check.ts";

type InputDraft = Extract<SubmissionDraft, { type: "input" }>;
type WriteDraft = Extract<SubmissionDraft, { type: "write" }>;

export type ServerDeps = {
	readonly harness: Harness;
	readonly models: Models;
	readonly mirror: Mirror;
	readonly logins: Logins;
	readonly token: string;
	readonly defaultModel: ModelRef;
	readonly context: PiContext;
};

const id = <T extends number>(raw: string | undefined, what: string): T => {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new HTTPException(400, { message: `invalid ${what} id` });
	return value as T;
};

const agentChange = (body: Record<string, unknown>, models: Models): AgentChange => {
	const change: Record<string, unknown> = {};
	for (const key of ["model", "thinkingLevel", "instructions", "cwd"] as const) {
		if (key in body) change[key] = body[key];
	}
	const model = change.model as ModelRef | null | undefined;
	if (model !== undefined && model !== null) {
		if (typeof model.provider !== "string" || typeof model.modelId !== "string") {
			throw new HTTPException(400, { message: "model must be {provider, modelId}" });
		}
		assertKnownModel(models, model);
	}
	return change as AgentChange;
};

export function createServer({ harness, models, mirror, logins, token, defaultModel, context }: ServerDeps) {
	const app = new Hono();

	app.use("*", async (c, next) => {
		if (c.req.path === "/health") return next();
		if (c.req.header("authorization") !== `Bearer ${token}`) throw new HTTPException(401, { message: "unauthorized" });
		return next();
	});

	app.onError((error, c) => {
		if (error instanceof HTTPException) return error.getResponse();
		if (error instanceof ConversationBusy) return c.json({ error: "conversation_busy" }, 409);
		if (error instanceof UnknownModel) return c.json({ error: error.message, suggestions: error.suggestions }, 422);
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
	});

	const conversation = async (raw: string | undefined) => {
		const found = await harness.conversation(id<ConversationId>(raw, "conversation"), context);
		if (found === undefined) throw new HTTPException(404, { message: "conversation not found" });
		return found;
	};

	app.get("/health", (c) => c.json({ ok: true }));

	// Conversations -------------------------------------------------------------------------------------------------

	app.post("/conversations", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const change = agentChange(body, models);
		const created = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: defaultModel, ...change } },
			context,
		);
		await mirror.attach(created.id);
		return c.json({ id: created.id }, 201);
	});

	app.get("/conversations/:id", async (c) => {
		const found = await conversation(c.req.param("id"));
		const view = await found.viewState(context);
		try {
			return c.json({ view: view.value, agent: await found.agent(context) });
		} finally {
			view.dispose();
		}
	});

	app.patch("/conversations/:id/agent", async (c) => {
		const found = await conversation(c.req.param("id"));
		await found.configure(agentChange((await c.req.json()) as Record<string, unknown>, models), context);
		return c.json({ agent: await found.agent(context) });
	});

	app.post("/conversations/:id/submissions", async (c) => {
		const found = await conversation(c.req.param("id"));
		const body = (await c.req.json()) as {
			content?: unknown;
			request_id?: string;
			when_busy?: "steer" | "followUp" | "reject";
			entry?: { kind: string; data?: unknown };
			write?: { kind: string; data?: unknown };
		};
		let draft: SubmissionDraft;
		if (body.write !== undefined) {
			draft = { type: "write", requestId: body.request_id, entry: body.write as WriteDraft["entry"] };
		} else {
			if (typeof body.content !== "string" && !Array.isArray(body.content)) {
				throw new HTTPException(400, { message: "content must be a string or content blocks" });
			}
			draft = {
				type: "input",
				requestId: body.request_id,
				content: body.content as InputDraft["content"],
				whenBusy: body.when_busy,
				entry: body.entry as InputDraft["entry"],
			};
		}
		const submission = await found.submit(draft, context);
		mirror.track(submission, found, draft);
		return c.json({ id: submission.id, status: await submission.status(context) }, 202);
	});

	app.post("/conversations/:id/abort", async (c) => {
		const found = await conversation(c.req.param("id"));
		await found.abort(context);
		return c.json({ ok: true });
	});

	app.post("/conversations/:id/reset", async (c) => {
		const found = await conversation(c.req.param("id"));
		const body = (await c.req.json().catch(() => ({}))) as { handoff?: string };
		await found.reset(body.handoff, context);
		return c.json({ ok: true });
	});

	app.post("/conversations/:id/compact", async (c) => {
		const found = await conversation(c.req.param("id"));
		const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
		const taskId = await found.compact(body.instructions, context);
		return c.json({ task_id: taskId }, 202);
	});

	// Debug stream: the experimental agent events, as server-sent events. Rails relays through ActionCable in
	// production; this is for development, operators, and tests.
	app.get("/conversations/:id/events", async (c) => {
		const found = await conversation(c.req.param("id"));
		const stream = await watchEvents(harness, found.id, context);
		return streamSSE(c, async (sse) => {
			await sse.writeSSE({ event: "snapshot", data: JSON.stringify(stream.snapshot) });
			let closed = false;
			sse.onAbort(() => {
				closed = true;
				void stream.stop();
			});
			stream.start(async (events) => {
				for (const event of events) await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
			});
			await stream.closed;
			if (!closed) await sse.close();
		});
	});

	// Submissions ---------------------------------------------------------------------------------------------------

	app.get("/submissions/:id", async (c) => {
		const submission = await harness.submission(id<SubmissionId>(c.req.param("id"), "submission"), context);
		if (submission === undefined) throw new HTTPException(404, { message: "submission not found" });
		return c.json(await submission.status(context));
	});

	app.delete("/submissions/:id", async (c) => {
		const result = await harness.abortSubmission(id<SubmissionId>(c.req.param("id"), "submission"), context);
		if (result === "not_found") throw new HTTPException(404, { message: "submission not found" });
		return c.json({ result });
	});

	// Tasks and operations -------------------------------------------------------------------------------------------

	app.get("/tasks", async (c) => c.json(await harness.inspect(context)));

	app.post("/tasks/:id/abort", async (c) => {
		const result = await harness.abortTask(id<TaskId>(c.req.param("id"), "task"), context);
		return c.json({ result });
	});

	app.get("/usage", async (c) => c.json(await harness.usage(context)));

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
		const body = (await c.req.json()) as { url?: string };
		if (typeof body.url !== "string") throw new HTTPException(400, { message: "url is required" });
		const login = logins.complete(c.req.param("id"), body.url);
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

	return app;
}
