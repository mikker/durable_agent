import { serve } from "@hono/node-server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pg from "pg";
import { Logins } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { installationDeviceId, PostgresCredentialStore } from "./credentials.ts";
import { createProcessModels, openHarness } from "./harness.ts";
import { log } from "./log.ts";
import { Mirror } from "./mirror.ts";
import { createReporter } from "./reports.ts";
import { createServer } from "./server.ts";

const context = BACKGROUND_CONTEXT;
const config = loadConfig();

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
await pool.query("SELECT 1");

// Provider credentials (API keys, Sign in with ChatGPT tokens) live in Postgres and survive redeploys.
const models = createProcessModels(config, new PostgresCredentialStore(pool));
const deviceId = await installationDeviceId(pool);
const logins = new Logins(models, () => deviceId, config.agentName);

// The mirror needs the Harness and the Harness's hooks need the mirror; the hook closes over a late-bound reference.
let mirror: Mirror | undefined;
const opened = await openHarness(
	config,
	models,
	{
		onConversationCreated: (record) => mirror?.enqueue(record),
		onReport: createReporter(pool, config),
	},
	context,
);
mirror = new Mirror(pool, opened.harness, config, context);
await mirror.start();

// Make sure the root conversation exists, so a Rails app that only ever wants one conversation can use id 1.
await opened.harness.root(context, { agent: { model: opened.model } });
await mirror.attach((await opened.harness.root(context)).id);

// Continue any run the previous process left unfinished, and start the scheduler for sleeping tasks.
opened.harness.resume();

const app = createServer({
	harness: opened.harness,
	models: opened.models,
	mirror,
	logins,
	token: config.token,
	defaultModel: opened.model,
	context,
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
	log.info("sidecar listening", { host: info.address, port: info.port, storage: config.storagePath, model: opened.model }),
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info("shutting down", { signal });
	server.close();
	logins.dispose();
	await mirror?.stop();
	// Close commits nothing new; interrupted work stays pending and resumes on the next start.
	await opened.close(context);
	await pool.end();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
