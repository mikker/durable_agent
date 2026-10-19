// pi-ai CredentialStore backed by Postgres, so OAuth tokens from Sign in with ChatGPT survive restarts and
// redeploys. Modifications to one provider are serialized, as pi-ai's in-memory store does, because a token
// refresh and a login can race.
import { randomUUID } from "node:crypto";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Pool } from "pg";

export class PostgresCredentialStore implements CredentialStore {
	readonly #pool: Pool;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(pool: Pool) {
		this.#pool = pool;
	}

	#serialize<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => undefined);
			options?.signal?.throwIfAborted();
			return task();
		})();
		const tail = queued.catch(() => undefined);
		this.#chains.set(providerId, tail);
		void tail.then(() => {
			if (this.#chains.get(providerId) === tail) this.#chains.delete(providerId);
		});
		return queued;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const result = await this.#pool.query<{ credential: Credential }>(
			"SELECT credential FROM agent_credentials WHERE provider_id = $1",
			[providerId],
		);
		return result.rows[0]?.credential;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const result = await this.#pool.query<{ provider_id: string; type: Credential["type"] }>(
			"SELECT provider_id, credential->>'type' AS type FROM agent_credentials ORDER BY provider_id",
		);
		return result.rows.map((row) => ({ providerId: row.provider_id, type: row.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serialize(
			providerId,
			async () => {
				const current = await this.read(providerId);
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				if (next !== undefined) {
					await this.#pool.query(
						`INSERT INTO agent_credentials (provider_id, credential) VALUES ($1, $2)
						 ON CONFLICT (provider_id) DO UPDATE SET credential = EXCLUDED.credential, updated_at = now()`,
						[providerId, JSON.stringify(next)],
					);
				}
				return next ?? current;
			},
			options,
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#serialize(
			providerId,
			async () => {
				await this.#pool.query("DELETE FROM agent_credentials WHERE provider_id = $1", [providerId]);
			},
			options,
		);
	}
}

/** The stable UUID OpenAI identifies this installation by. Created on first use, then constant. */
export async function installationDeviceId(pool: Pool): Promise<string> {
	const inserted = await pool.query<{ value: string }>(
		`INSERT INTO agent_settings (key, value) VALUES ('device_id', $1)
		 ON CONFLICT (key) DO UPDATE SET value = agent_settings.value RETURNING value`,
		[randomUUID()],
	);
	const value = inserted.rows[0]?.value;
	if (value === undefined) throw new Error("could not read or create the installation device id");
	return value;
}
