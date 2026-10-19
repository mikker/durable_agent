// pi-durable's storage conformance suite against openHarnessStorage, on a freshly emptied database per case.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { openHarnessStorage } from "../src/storage.ts";
import { openTestDatabase, TEST_DIALECT } from "./helpers.ts";

const assertions: StorageConformanceAssertions = {
	ok: (value, message) => assert.ok(value, message),
	strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
	deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
	partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
	greaterThan: (actual, expected) => assert.ok(actual > expected, `expected ${actual} > ${expected}`),
	rejects: (operation, messageIncludes) =>
		assert.rejects(operation, (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.ok(message.includes(messageIncludes), `expected an error including ${JSON.stringify(messageIncludes)}, got ${JSON.stringify(message)}`);
			return true;
		}),
};

const cases = createStorageConformance({
	assertions,
	withStorage: async (use) => {
		const storage = await openHarnessStorage(await openTestDatabase());
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	},
});

describe(`pi-durable storage conformance [${TEST_DIALECT}]`, () => {
	for (const conformance of cases) it(conformance.name, () => conformance.run());
});
