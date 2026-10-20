import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { registerStoredAccounts } from "./accounts.ts";
import { Logins } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { DbCredentialStore } from "./credentials.ts";
import { type Db, openDatabase } from "./db/index.ts";
import { Events } from "./events.ts";
import { createProcessModels, openHarness } from "./harness.ts";
import { log } from "./log.ts";
import { createReporter } from "./reports.ts";
import { createServer } from "./server.ts";
import { checkSchemaVersion, installationDeviceId } from "./settings.ts";
import { MissingSchema } from "./storage.ts";

// pi-ai loads its OAuth flows with a computed `import("./openai-chatgpt.js")` so web bundlers skip them. In the esbuild
// bundle (dist/sidecar.js) those relative files do not exist; registering the flows statically keeps sign-in working
// there. The "Bun" in the name is historical: it is a plain static registration and works the same from source.
registerBunOAuthFlows();

const SHUTDOWN_DEADLINE_MS = 30_000;
const SERVER_CLOSE_DEADLINE_MS = 10_000;

const context = BACKGROUND_CONTEXT;
const config = loadConfig();

// A stray rejection must not take down running agents; the state they were writing is in the database.
process.on("unhandledRejection", (error) => log.error("unhandled rejection", { error }));
// A thrown exception leaves the process in an unknown state; exit so a supervisor starts a clean one.
process.on("uncaughtException", (error) => {
	log.error("uncaught exception; exiting", { error });
	process.exit(1);
});

const db = await openDatabase(config.databaseUrl).catch((error: unknown) => {
	log.error("could not open the database named by DATABASE_URL", { error });
	process.exit(1);
});

const { opened, logins, events, reporter } = await boot(db).catch(stopBoot);
const readiness = { resumed: false };
let shuttingDown = false;

// pi-durable closes the session, database included, after the first failed storage call. Nothing here reopens it;
// a supervisor restarting the process does.
void opened.harness.closed.then((end) => {
	if (end.reason === "failed") log.error("the harness session failed; exiting", { error: end.error });
	else if (!shuttingDown) log.error("the harness closed unexpectedly; exiting");
	else return;
	process.exit(1);
});

const app = createServer({
	harness: opened.harness,
	readiness,
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
) as Server;
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// pi-durable replays an interrupted tool call only if the tool is registered when the run resumes, so the tools come
// first. Rails may not be listening yet (bin/dev starts both at once); load() retries for up to 60 s, then gives up.
await opened.tools.load();
if (!shuttingDown) {
	log.info(`resuming with ${opened.tools.names.length} tools`, { tools: opened.tools.names });
	// Continue any run the previous process left unfinished, and start the scheduler for sleeping tasks.
	opened.harness.resume();
	readiness.resumed = true;
}

/** Everything from the schema check to the root conversation; a missing table at any step is `MissingSchema`. */
async function boot(db: Db) {
	try {
		await checkSchemaVersion(db);
		// Provider credentials (API keys, Sign in with ChatGPT tokens) live in the app's database, encrypted under a key
		// derived from the shared token, and survive redeploys.
		const credentials = new DbCredentialStore(db, config.token);
		const models = createProcessModels(config, credentials);
		// Every account that has signed in has a provider of its own (`openai@u42`); its conversations pin it.
		await registerStoredAccounts(models, credentials);
		const deviceId = await installationDeviceId(db);
		const events = new Events({ railsUrl: config.railsUrl, token: config.token });
		const logins = new Logins(models, () => deviceId, config.agentName, (provider) => events.auth(provider));
		const reporter = createReporter(db, events);
		const opened = await openHarness(config, models, { db, events, onReport: reporter }, context);
		// Make sure the root conversation exists, so a Rails app that only ever wants one conversation can use id 1.
		await opened.harness.root(context, { agent: { model: opened.model } });
		return { opened, logins, events, reporter };
	} catch (error) {
		throw !(error instanceof MissingSchema) && isMissingTable(error) ? new MissingSchema(error) : error;
	}
}

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) {
		log.error("second signal during shutdown; exiting now", { signal });
		process.exit(1);
	}
	shuttingDown = true;
	log.info("shutting down", { signal });
	setTimeout(() => {
		log.error(`shutdown did not finish within ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting`);
		process.exit(1);
	}, SHUTDOWN_DEADLINE_MS).unref();
	try {
		await closeServer();
		logins.dispose();
		// A report raised just before the signal is still being inserted; the Harness closes the database.
		await reporter.settled();
		// Close commits nothing new; interrupted work stays pending and resumes on the next start.
		await opened.close(context);
		await events.flush();
		await db.close().catch(() => undefined);
	} catch (error) {
		log.error("shutdown failed", { error });
		process.exit(1);
	}
	process.exit(0);
}

/** Stop accepting requests and let the ones underway finish, for at most SERVER_CLOSE_DEADLINE_MS. */
async function closeServer(): Promise<void> {
	const closed = new Promise<boolean>((resolve) => server.close(() => resolve(true)));
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), SERVER_CLOSE_DEADLINE_MS);
	});
	const finished = await Promise.race([closed, late]);
	clearTimeout(timer);
	if (finished) return;
	log.warn(`requests still open after ${SERVER_CLOSE_DEADLINE_MS / 1000} s; closing their connections`);
	server.closeAllConnections();
}

/** SQLite's "no such table", Postgres' undefined_table, here or in a cause: the install migration has not run. */
function isMissingTable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ((error as Error & { code?: unknown }).code === "42P01" || /no such table/i.test(error.message)) return true;
	return isMissingTable(error.cause);
}

async function stopBoot(error: unknown): Promise<never> {
	if (error instanceof MissingSchema) log.error(error.message);
	else log.error("sidecar failed to boot", { error });
	await db.close().catch(() => undefined);
	process.exit(1);
}
