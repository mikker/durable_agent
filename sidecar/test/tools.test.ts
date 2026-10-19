// The tools protocol against a fake Rails: definitions come from GET /durable_agent/tools, a scripted faux tool call
// runs through POST /durable_agent/tools/:name, and the result lands in durable_agent_entries as a pi.tool-result
// entry. Boot fetches retry with backoff until Rails listens.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DbCredentialStore } from "../src/credentials.ts";
import { RailsTools, type ToolDefinition } from "../src/tools.ts";
import { bootTestSidecar, type TestSidecar } from "./sidecar.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "tools-test-token";

type Call = { readonly name: string; readonly authorization: string | undefined; readonly body: Record<string, unknown> };
const calls: Call[] = [];
let definitions: ToolDefinition[] = [
	{
		name: "lookup_invoice",
		description: "Fetch one invoice by number",
		parameters: {
			type: "object",
			properties: { number: { type: "string", description: "Invoice number" } },
			required: ["number"],
		},
		replay: "safe",
	},
	{ name: "explode", description: "Always fails", parameters: { type: "object", properties: {} }, replay: "unsafe" },
];

let rails: Server;
let railsUrl: string;
let sidecar: TestSidecar;

const readBody = async (request: IncomingMessage): Promise<string> => {
	let text = "";
	for await (const chunk of request) text += String(chunk);
	return text;
};

before(async () => {
	rails = createServer(async (request, response) => {
		const send = (status: number, value: unknown): void => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
		if (request.method === "GET" && request.url === "/durable_agent/tools") return send(200, definitions);
		const match = /^\/durable_agent\/tools\/([^/]+)$/.exec(request.url ?? "");
		if (request.method === "POST" && match?.[1] !== undefined) {
			const name = decodeURIComponent(match[1]);
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			calls.push({ name, authorization: request.headers.authorization, body });
			if (name === "lookup_invoice") return send(200, { result: { number: "INV-1042", total: 99 } });
			return send(422, { error: "boom from Rails" });
		}
		send(404, { error: "not found" });
	});
	await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
	railsUrl = `http://127.0.0.1:${(rails.address() as AddressInfo).port}`;

	sidecar = await bootTestSidecar({
		config: { token: TOKEN, railsUrl },
		models: (db) => {
			const models = createModels({ credentials: new DbCredentialStore(db, "t") });
			const faux = fauxProvider({ tokensPerSecond: 1000 });
			models.setProvider(faux.provider);
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("lookup_invoice", { number: "INV-1042" }, { id: "call-1" }),
						fauxToolCall("explode", {}, { id: "call-2" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("Invoice INV-1042 totals 99.")]),
			]);
			return models;
		},
	});
});

after(async () => {
	await sidecar.close();
	await new Promise((resolve) => rails.close(resolve));
});

test("a scripted tool call runs through Rails over HTTP and its result is stored", async () => {
	const { harness, model } = sidecar.opened;
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const submission = await conversation.submit({ type: "input", content: "What does INV-1042 total?", requestId: "tools-1" }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done");

	const lookup = calls.find((call) => call.name === "lookup_invoice");
	assert.ok(lookup, "lookup_invoice was called over HTTP");
	assert.equal(lookup.authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(lookup.body, { arguments: { number: "INV-1042" }, conversation_id: conversation.id, call_id: "call-1" });
	assert.ok(calls.some((call) => call.name === "explode"));

	// The tool result message is the entry record's model message, an array of one.
	type Message = { toolCallId?: string; isError?: boolean; content?: { text?: string }[] };
	type Entry = { kind: string; model: Message[] };
	const rows = await sidecar.db.all<{ record: string }>(
		"SELECT record FROM durable_agent_entries WHERE conversation_id = ? ORDER BY id",
		conversation.id,
	);
	const results = rows.map((row) => JSON.parse(row.record) as Entry).filter((entry) => entry.kind === "pi.tool-result");
	assert.equal(results.length, 2);
	const byCall = new Map(results.map((entry) => [entry.model[0]?.toolCallId, entry.model[0]]));
	const ok = byCall.get("call-1");
	assert.equal(ok?.isError, false);
	assert.equal(ok?.content?.[0]?.text, JSON.stringify({ number: "INV-1042", total: 99 }));
	const failed = byCall.get("call-2");
	assert.equal(failed?.isError, true);
	assert.equal(failed?.content?.[0]?.text, "boom from Rails");
});

test("reload replaces the rails extension's tools in place", async () => {
	const registry = createRegistry();
	const tools = new RailsTools(registry, railsUrl, TOKEN);
	assert.deepEqual(await tools.load(), ["lookup_invoice", "explode"]);
	const saved = definitions;
	definitions = [saved[0]!, { ...saved[0]!, name: "lookup_customer" }];
	try {
		assert.deepEqual(await tools.reload(), ["lookup_invoice", "lookup_customer"]);
	} finally {
		definitions = saved;
	}
	const snapshot = registry.snapshot();
	assert.equal(snapshot.installed().length, 1);
	assert.deepEqual(
		snapshot.tools().map(({ extension, tool }) => `${extension.name}:${tool.name}`),
		["rails:lookup_invoice", "rails:lookup_customer"],
	);
});

const QUICK_RETRY = { initialMs: 50, maxMs: 200, totalMs: 300 };

test("an unreachable Rails means no tools once the boot retry gives up, and a rejected reload", async () => {
	const tools = new RailsTools(createRegistry(), "http://127.0.0.1:1", TOKEN, QUICK_RETRY);
	const started = Date.now();
	assert.deepEqual(await tools.load(), []);
	assert.ok(Date.now() - started >= 150, "load retried before giving up");
	await assert.rejects(tools.reload());
});

test("the boot load keeps retrying until Rails starts listening", async () => {
	// Reserve a free port, then leave it closed so the first attempt is refused.
	const late = createServer((request, response) => {
		if (request.headers.authorization === `Bearer ${TOKEN}` && request.url === "/durable_agent/tools") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(definitions));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => late.listen(0, "127.0.0.1", resolve));
	const port = (late.address() as AddressInfo).port;
	await new Promise((resolve) => late.close(resolve));
	let attempts = 0;
	const countingFetch = globalThis.fetch;
	globalThis.fetch = (...args) => {
		attempts += 1;
		return countingFetch(...args);
	};
	const tools = new RailsTools(createRegistry(), `http://127.0.0.1:${port}`, TOKEN, { initialMs: 100, maxMs: 400, totalMs: 5_000 });
	try {
		const loading = tools.load();
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.ok(attempts >= 1, "a first attempt was made and failed");
		await new Promise<void>((resolve) => late.listen(port, "127.0.0.1", resolve));
		assert.deepEqual(await loading, ["lookup_invoice", "explode"]);
		assert.ok(attempts >= 2);
	} finally {
		globalThis.fetch = countingFetch;
		tools.stop();
		await new Promise((resolve) => late.close(resolve));
	}
});

test("stop ends a boot retry that is waiting", async () => {
	const tools = new RailsTools(createRegistry(), "http://127.0.0.1:1", TOKEN, { initialMs: 10_000, maxMs: 10_000, totalMs: 60_000 });
	const loading = tools.load();
	await new Promise((resolve) => setTimeout(resolve, 50));
	const started = Date.now();
	tools.stop();
	assert.deepEqual(await loading, []);
	assert.ok(Date.now() - started < 1_000);
});
