// A sidecar wired as main.ts wires it, over the test database, without the HTTP listener: open, root, tools, resume.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { DbCredentialStore } from "../src/credentials.ts";
import type { Db } from "../src/db/index.ts";
import { Events, type EventsOptions } from "../src/events.ts";
import { createProcessModels, type OpenedHarness, openHarness } from "../src/harness.ts";
import { createReporter, type Reporter } from "../src/reports.ts";
import { checkSchemaVersion } from "../src/settings.ts";
import type { BootRetry } from "../src/tools.ts";
import { openTestDatabase, testConfig } from "./helpers.ts";

export type TestSidecarOptions = {
	readonly config?: Partial<Config>;
	/** Defaults to the process models for the config (faux). */
	readonly models?: (db: Db) => MutableModels;
	readonly fetch?: EventsOptions["fetch"];
	readonly toolsRetry?: BootRetry;
	/** Open this database again (from testDatabaseUrl()) without emptying it, as a restarted process would. */
	readonly databaseUrl?: string;
	readonly reset?: boolean;
};

export type TestSidecar = {
	readonly db: Db;
	readonly config: Config;
	readonly opened: OpenedHarness;
	readonly events: Events;
	readonly reporter: Reporter;
	close(): Promise<void>;
};

export async function bootTestSidecar(options: TestSidecarOptions = {}): Promise<TestSidecar> {
	const context = BACKGROUND_CONTEXT;
	const db = await openTestDatabase({
		...(options.databaseUrl === undefined ? {} : { url: options.databaseUrl }),
		...(options.reset === undefined ? {} : { reset: options.reset }),
	});
	const config = await testConfig(options.config);
	await checkSchemaVersion(db);
	const models = options.models?.(db) ?? createProcessModels(config, new DbCredentialStore(db, config.token));
	const events = new Events({
		railsUrl: config.railsUrl,
		token: config.token,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	const reporter = createReporter(db, events);
	const opened = await openHarness(
		config,
		models,
		{
			db,
			events,
			onReport: reporter,
			...(options.toolsRetry === undefined ? {} : { toolsRetry: options.toolsRetry }),
		},
		context,
	);
	await opened.harness.root(context, { agent: { model: opened.model } });
	await opened.tools.load();
	opened.harness.resume();
	return {
		db,
		config,
		opened,
		events,
		reporter,
		close: async () => {
			await reporter.settled();
			await opened.close(context);
			await events.flush();
			await db.close();
		},
	};
}
