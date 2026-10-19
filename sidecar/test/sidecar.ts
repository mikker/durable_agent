// A sidecar wired as main.ts wires it, over the test database, without the HTTP listener.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { DbCredentialStore } from "../src/credentials.ts";
import type { Db } from "../src/db/index.ts";
import { Events, type EventsOptions } from "../src/events.ts";
import { createProcessModels, type OpenedHarness, openHarness } from "../src/harness.ts";
import { createReporter } from "../src/reports.ts";
import { recordSchemaVersion } from "../src/settings.ts";
import type { BootRetry } from "../src/tools.ts";
import { openTestDatabase, testConfig } from "./helpers.ts";

export type TestSidecarOptions = {
	readonly config?: Partial<Config>;
	/** Defaults to the process models for the config (faux). */
	readonly models?: (db: Db) => MutableModels;
	readonly fetch?: EventsOptions["fetch"];
	readonly toolsRetry?: BootRetry;
};

export type TestSidecar = {
	readonly db: Db;
	readonly config: Config;
	readonly opened: OpenedHarness;
	readonly events: Events;
	close(): Promise<void>;
};

export async function bootTestSidecar(options: TestSidecarOptions = {}): Promise<TestSidecar> {
	const context = BACKGROUND_CONTEXT;
	const db = await openTestDatabase();
	const config = await testConfig(options.config);
	await recordSchemaVersion(db);
	const models = options.models?.(db) ?? createProcessModels(config, new DbCredentialStore(db, config.token));
	const events = new Events({
		railsUrl: config.railsUrl,
		token: config.token,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	const opened = await openHarness(
		config,
		models,
		{
			db,
			events,
			onReport: createReporter(db, events),
			...(options.toolsRetry === undefined ? {} : { toolsRetry: options.toolsRetry }),
		},
		context,
	);
	await opened.harness.root(context, { agent: { model: opened.model } });
	opened.harness.resume();
	await opened.tools.load();
	return {
		db,
		config,
		opened,
		events,
		close: async () => {
			await opened.close(context);
			await events.flush();
			await db.close();
		},
	};
}
