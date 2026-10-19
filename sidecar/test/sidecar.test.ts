// The process as main.ts runs it: boot order, readiness, supervision of the Harness, refusals at boot, and signals.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Db } from "../src/db/index.ts";
import { openDatabase } from "../src/db/index.ts";
import { ensurePostgresDatabase, openTestDatabase, TEST_DATABASE_URL, TEST_DIALECT, tempDir, testDatabaseUrl, until } from "./helpers.ts";

const TOKEN = "process-test-token";
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

type Line = Record<string, unknown> & { message?: string; level?: string };

type Sidecar = {
	readonly child: ChildProcess;
	readonly lines: Line[];
	readonly exited: Promise<number | null>;
	/** Resolves with the first log line matching `message`. */
	line(message: RegExp, ms?: number): Promise<Line>;
	/** Resolves with the HTTP base URL once the server listens. */
	url(): Promise<string>;
};

function start(databaseUrl: string, env: Record<string, string> = {}): Sidecar {
	const { DURABLE_AGENT_RAILS_URL: _unset, ...inherited } = process.env;
	const child = spawn(process.execPath, [MAIN], {
		env: {
			...inherited,
			DATABASE_URL: databaseUrl,
			DURABLE_AGENT_TOKEN: TOKEN,
			DURABLE_AGENT_MODEL: "faux/faux-1",
			DURABLE_AGENT_PORT: "0",
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: Line[] = [];
	const collect = (chunk: Buffer) => {
		for (const text of String(chunk).split("\n")) {
			if (text.trim() === "") continue;
			try {
				lines.push(JSON.parse(text) as Line);
			} catch {
				lines.push({ message: text });
			}
		}
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const line = async (message: RegExp, ms = 20_000): Promise<Line> => {
		let found: Line | undefined;
		await until(`a log line ${message}`, () => (found = lines.find((entry) => message.test(String(entry.message)))) !== undefined, ms);
		return found as Line;
	};
	return {
		child,
		lines,
		exited,
		line,
		url: async () => `http://127.0.0.1:${(await line(/sidecar listening/)).port}`,
	};
}

const get = async (url: string) => {
	const response = await fetch(url);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const post = async (url: string, body: unknown = {}) => {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
};

/** A fake Rails whose tool list answers after `listDelayMs`, or never when it is `Infinity`. */
async function fakeRails(listDelayMs: number): Promise<{ url: string; lists: () => number; close(): Promise<void> }> {
	let lists = 0;
	const server: Server = createServer((request, response) => {
		if (request.url === "/durable_agent/tools") {
			lists += 1;
			if (listDelayMs === Number.POSITIVE_INFINITY) return;
			setTimeout(() => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify([{ name: "ping", description: "", parameters: { type: "object", properties: {} }, replay: "safe" }]));
			}, listDelayMs);
			return;
		}
		response.writeHead(204).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		lists: () => lists,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/** The test database, prepared and emptied, plus a handle the test keeps. */
async function database(): Promise<{ url: string; db: Db }> {
	const url = await testDatabaseUrl();
	return { url, db: await openTestDatabase({ url }) };
}

test(`[${TEST_DIALECT}] the server answers while tools load, and the Harness resumes only after them`, async () => {
	const rails = await fakeRails(1_500);
	const { url, db } = await database();
	const sidecar = start(url, { DURABLE_AGENT_RAILS_URL: rails.url });
	try {
		const base = await sidecar.url();
		const early = await get(`${base}/health`);
		assert.equal(early.status, 200);
		assert.equal(early.body.resumed, false);
		const created = await post(`${base}/conversations`);
		assert.equal(created.status, 201);
		const submitted = await post(`${base}/conversations/${created.body.id}/submissions`, { content: "Hi", request_id: "early" });
		assert.equal(submitted.status, 503);

		await sidecar.line(/^resuming with 1 tools$/);
		const ready = await get(`${base}/health`);
		assert.equal(ready.body.resumed, true);
		assert.deepEqual(ready.body.tools, ["ping"]);
		assert.equal((await post(`${base}/conversations/${created.body.id}/submissions`, { content: "Hi", request_id: "late" })).status, 202);

		sidecar.child.kill("SIGTERM");
		assert.equal(await sidecar.exited, 0);
	} finally {
		sidecar.child.kill("SIGKILL");
		await rails.close();
		await db.close();
	}
});

test(`[${TEST_DIALECT}] a failed storage call ends the process with exit 1`, async () => {
	const { url, db } = await database();
	const sidecar = start(url);
	try {
		const base = await sidecar.url();
		await sidecar.line(/^resuming with 0 tools$/);
		const created = await post(`${base}/conversations`);
		await injectFailure(db);
		await post(`${base}/conversations/${created.body.id}/submissions`, { content: "Hi", request_id: "doomed" }).catch(() => undefined);
		assert.equal(await sidecar.exited, 1);
		assert.ok(sidecar.lines.some((line) => line.level === "error" && /harness session failed/.test(String(line.message))));
	} finally {
		sidecar.child.kill("SIGKILL");
		await removeFailure(db);
		await db.close();
	}
});

test(`[${TEST_DIALECT}] a second signal during shutdown exits 1 at once`, async () => {
	const rails = await fakeRails(Number.POSITIVE_INFINITY);
	const { url, db } = await database();
	const sidecar = start(url, { DURABLE_AGENT_RAILS_URL: rails.url });
	try {
		const base = await sidecar.url();
		// A reload that hangs on Rails keeps a request open, so closing the server takes a while.
		void post(`${base}/tools/reload`).catch(() => undefined);
		await until("the reload to reach Rails", () => rails.lists() >= 2);
		sidecar.child.kill("SIGTERM");
		await sidecar.line(/^shutting down$/);
		sidecar.child.kill("SIGTERM");
		assert.equal(await sidecar.exited, 1);
		assert.ok(sidecar.lines.some((line) => /second signal/.test(String(line.message))));
	} finally {
		sidecar.child.kill("SIGKILL");
		await rails.close();
		await db.close();
	}
});

test(`[${TEST_DIALECT}] a database newer than this gem refuses to boot`, async () => {
	const { url, db } = await database();
	await db.run("INSERT INTO durable_agent_settings (key, value, updated_at) VALUES ('schema_version', '99', CURRENT_TIMESTAMP)");
	const sidecar = start(url);
	try {
		assert.equal(await sidecar.exited, 1);
		assert.ok(sidecar.lines.some((line) => /database is newer than this gem/.test(JSON.stringify(line))));
	} finally {
		await db.close();
	}
});

test(`[${TEST_DIALECT}] a database without the tables is MissingSchema at boot`, async () => {
	const empty = await emptyDatabaseUrl();
	const sidecar = start(empty.url);
	try {
		assert.equal(await sidecar.exited, 1);
		assert.ok(sidecar.lines.some((line) => /tables are missing: run bin\/rails db:migrate/.test(String(line.message))));
	} finally {
		await empty.dispose();
	}
});

// Last in the file: it drops a table, which the next test file's helpers recreate.
test(`[${TEST_DIALECT}] a missing table past the first is MissingSchema too`, async () => {
	const { url, db } = await database();
	await db.exec("DROP TABLE durable_agent_durable_metadata");
	const sidecar = start(url);
	try {
		assert.equal(await sidecar.exited, 1);
		assert.ok(sidecar.lines.some((line) => /tables are missing: run bin\/rails db:migrate/.test(String(line.message))));
	} finally {
		await db.close();
	}
});

// Every insert into the submissions table fails, so the next submission's commit fails the session.
async function injectFailure(db: Db): Promise<void> {
	if (db.dialect === "postgres") {
		await db.exec(`CREATE OR REPLACE FUNCTION durable_agent_test_fail() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'injected storage failure'; END $$ LANGUAGE plpgsql`);
		await db.exec(
			"CREATE TRIGGER durable_agent_test_fail BEFORE INSERT ON durable_agent_submissions FOR EACH ROW EXECUTE FUNCTION durable_agent_test_fail()",
		);
		return;
	}
	await db.exec(
		"CREATE TRIGGER durable_agent_test_fail BEFORE INSERT ON durable_agent_submissions BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
	);
}

async function removeFailure(db: Db): Promise<void> {
	await db.exec(
		db.dialect === "postgres"
			? "DROP TRIGGER IF EXISTS durable_agent_test_fail ON durable_agent_submissions"
			: "DROP TRIGGER IF EXISTS durable_agent_test_fail",
	);
}

async function emptyDatabaseUrl(): Promise<{ url: string; dispose(): Promise<void> }> {
	if (TEST_DIALECT === "sqlite") return { url: `sqlite://${join(await tempDir(), "empty.sqlite3")}`, dispose: async () => {} };
	const url = TEST_DATABASE_URL as string;
	await ensurePostgresDatabase(url);
	const schema = `empty_process_${process.pid}_${Date.now()}`;
	const admin = await openDatabase(url);
	await admin.exec(`CREATE SCHEMA ${schema}`);
	const scoped = new URL(url);
	scoped.searchParams.set("options", `-c search_path=${schema}`);
	return {
		url: scoped.toString(),
		dispose: async () => {
			await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
			await admin.close();
		},
	};
}
