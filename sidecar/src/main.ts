import { serve } from "@hono/node-server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { Logins } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { DbCredentialStore } from "./credentials.ts";
import { openDatabase } from "./db/index.ts";
import { Events } from "./events.ts";
import { createProcessModels, openHarness } from "./harness.ts";
import { log } from "./log.ts";
import { createReporter } from "./reports.ts";
import { createServer } from "./server.ts";
import { installationDeviceId, recordSchemaVersion } from "./settings.ts";
import { MissingSchema } from "./storage.ts";

// pi-ai loads its OAuth flows with a computed `import("./openai-chatgpt.js")` so web bundlers skip them. In the esbuild
// bundle (dist/sidecar.js) those relative files do not exist; registering the flows statically keeps sign-in working
// there. The "Bun" in the name is historical: it is a plain static registration and works the same from source.
registerBunOAuthFlows();

const context = BACKGROUND_CONTEXT;
const config = loadConfig();

// A stray rejection must not take down running agents; the state they were writing is in the database.
process.on("unhandledRejection", (error) => log.error("unhandled rejection", { error }));

const db = await openDatabase(config.databaseUrl).catch((error: unknown) => {
	log.error("could not open the database named by DATABASE_URL", { error });
	process.exit(1);
});
try {
	await recordSchemaVersion(db);
} catch (error) {
	await stopBoot(isMissingTable(error) ? new MissingSchema(error) : error);
}

// Provider credentials (API keys, Sign in with ChatGPT tokens) live in the app's database, encrypted under a key
// derived from the shared token, and survive redeploys.
const models = createProcessModels(config, new DbCredentialStore(db, config.token));
const deviceId = await installationDeviceId(db);
const logins = new Logins(models, () => deviceId, config.agentName);

const events = new Events({ railsUrl: config.railsUrl, token: config.token });
const opened = await openHarness(
	config,
	models,
	{ db, events, onReport: createReporter(db, events) },
	context,
).catch(stopBoot);

// Make sure the root conversation exists, so a Rails app that only ever wants one conversation can use id 1.
await opened.harness.root(context, { agent: { model: opened.model } });

// Continue any run the previous process left unfinished, and start the scheduler for sleeping tasks.
opened.harness.resume();

// Rails may not be listening yet (bin/dev starts both at once); the tools arrive when it is.
void opened.tools.load();

const app = createServer({
	harness: opened.harness,
	models: opened.models,
	db,
	logins,
	tools: opened.tools,
	token: config.token,
	defaultModel: opened.model,
	context,
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
	log.info("sidecar listening", { host: info.address, port: info.port, database: db.dialect, model: opened.model }),
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info("shutting down", { signal });
	server.close();
	logins.dispose();
	// Close commits nothing new; interrupted work stays pending and resumes on the next start.
	await opened.close(context);
	await events.flush();
	await db.close();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** SQLite's "no such table", Postgres' undefined_table: the install migration has not run. */
function isMissingTable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (error as Error & { code?: unknown }).code === "42P01" || /no such table/i.test(error.message);
}

async function stopBoot(error: unknown): Promise<never> {
	if (error instanceof MissingSchema) log.error(error.message);
	else log.error("sidecar failed to boot", { error });
	await db.close().catch(() => undefined);
	process.exit(1);
}
