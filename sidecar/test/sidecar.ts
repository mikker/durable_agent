// The sidecar as main.ts boots it, over the test database, without the HTTP listener: open, load tools, resume.
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db/index.ts";
import { openSidecar, type Sidecar, type SidecarOptions } from "../src/harness.ts";
import { openTestDatabase, testConfig } from "./helpers.ts";

export type TestSidecarOptions = SidecarOptions & {
	readonly config?: Partial<Config>;
	/** Open this database again (from testDatabaseUrl()) without emptying it, as a restarted process would. */
	readonly databaseUrl?: string;
	readonly reset?: boolean;
};

export type TestSidecar = Sidecar & { readonly db: Db; readonly config: Config };

export async function bootTestSidecar({ config: overrides, databaseUrl, reset, ...options }: TestSidecarOptions = {}): Promise<TestSidecar> {
	const db = await openTestDatabase({ url: databaseUrl, reset });
	const config = await testConfig(overrides);
	const sidecar = await openSidecar(db, config, options);
	await sidecar.tools.load();
	sidecar.harness.resume();
	return { ...sidecar, db, config };
}
