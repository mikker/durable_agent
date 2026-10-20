import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { openSidecar } from "./harness.ts";
import { log } from "./log.ts";
import { createServer } from "./server.ts";
import { MissingSchema } from "./storage.ts";

// pi-ai loads its OAuth flows with a computed `import("./openai-chatgpt.js")` so web bundlers skip them. In the esbuild
// bundle (dist/sidecar.js) those relative files do not exist; registering the flows statically keeps sign-in working
// there. Despite its name it is a plain static registration and works the same from source.
registerBunOAuthFlows();

const SHUTDOWN_DEADLINE_MS = 30_000;
const SERVER_CLOSE_DEADLINE_MS = 10_000;

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

const sidecar = await openSidecar(db, config).catch(stopBoot);
const readiness = { resumed: false };
let shuttingDown = false;

// pi-durable closes the session, database included, after the first failed storage call. Nothing here reopens it;
// a supervisor restarting the process does.
void sidecar.harness.closed.then((end) => {
	if (end.reason === "failed") log.error("the harness session failed; exiting", { error: end.error });
	else if (!shuttingDown) log.error("the harness closed unexpectedly; exiting");
	else return;
	process.exit(1);
});

const app = createServer({ ...sidecar, db, readiness, token: config.token, defaultModel: config.model });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
	log.info("sidecar listening", { host: info.address, port: info.port, database: db.dialect, model: config.model }),
) as Server;
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// pi-durable replays an interrupted tool call only if the tool is registered when the run resumes, so the tools come
// first. Rails may not be listening yet (bin/dev starts both at once); load() retries for up to 60 s, then gives up.
await sidecar.tools.load();
if (!shuttingDown) {
	log.info(`resuming with ${sidecar.tools.names.length} tools`, { tools: sidecar.tools.names });
	// Continue any run the previous process left unfinished, and start the scheduler for sleeping tasks.
	sidecar.harness.resume();
	readiness.resumed = true;
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
		await sidecar.close();
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

async function stopBoot(error: unknown): Promise<never> {
	if (error instanceof MissingSchema) log.error(error.message);
	else log.error("sidecar failed to boot", { error });
	await db.close().catch(() => undefined);
	process.exit(1);
}
