// pi-ai CredentialStore backed by Postgres, so OAuth tokens from Sign in with ChatGPT survive restarts and
// redeploys. Modifications to one provider are serialized, as pi-ai's in-memory store does, because a token
// refresh and a login can race.
//
// Credentials are encrypted at rest with AES-256-GCM under a key derived from the shared DURABLE_AGENT_TOKEN, which
// lives outside Postgres, so dumps, replicas and read-only database users see only ciphertext. `type` stays in the
// clear because list() reads it in SQL and it is not secret.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import { log } from "./log.ts";

type Envelope = { enc: 1; type: Credential["type"]; iv: string; tag: string; data: string };
type Stored = Envelope | Credential;
type Loaded = { credential: Credential | undefined; legacy: boolean };

const isEnvelope = (stored: Stored): stored is Envelope => (stored as Partial<Envelope>).enc === 1;

const KEY_SALT = "durable_agent_credentials";
const KEY_INFO = "v1";

export class PostgresCredentialStore implements CredentialStore {
	readonly #pool: Pool;
	readonly #key: Buffer;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(pool: Pool, token: string) {
		this.#pool = pool;
		this.#key = Buffer.from(hkdfSync("sha256", token, KEY_SALT, KEY_INFO, 32));
	}

	// The provider id is bound as associated data so a row copied onto another provider fails to decrypt.
	#encrypt(providerId: string, credential: Credential): Envelope {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		cipher.setAAD(Buffer.from(providerId));
		const data = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
		return {
			enc: 1,
			type: credential.type,
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			data: data.toString("base64"),
		};
	}

	#decrypt(providerId: string, envelope: Envelope): Credential | undefined {
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64"));
			decipher.setAAD(Buffer.from(providerId));
			decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
			const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
			return JSON.parse(plain.toString("utf8")) as Credential;
		} catch (error) {
			log.warn("stored credential could not be decrypted; treating it as absent, sign in again", {
				provider: providerId,
				hint: "DURABLE_AGENT_TOKEN probably changed since this credential was saved",
				error,
			});
			return undefined;
		}
	}

	async #load(providerId: string): Promise<Loaded> {
		const result = await this.#pool.query<{ credential: Stored }>(
			"SELECT credential FROM durable_agent_credentials WHERE provider_id = $1",
			[providerId],
		);
		const stored = result.rows[0]?.credential;
		if (stored === undefined) return { credential: undefined, legacy: false };
		if (isEnvelope(stored)) return { credential: this.#decrypt(providerId, stored), legacy: false };
		return { credential: stored, legacy: true };
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
		return (await this.#load(providerId)).credential;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const result = await this.#pool.query<{ provider_id: string; type: Credential["type"] }>(
			"SELECT provider_id, credential->>'type' AS type FROM durable_agent_credentials ORDER BY provider_id",
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
				const { credential: current, legacy } = await this.#load(providerId);
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				// A plaintext row from before encryption is rewritten even when fn keeps it.
				const write = next ?? (legacy ? current : undefined);
				if (write !== undefined) {
					await this.#pool.query(
						`INSERT INTO durable_agent_credentials (provider_id, credential) VALUES ($1, $2)
						 ON CONFLICT (provider_id) DO UPDATE SET credential = EXCLUDED.credential, updated_at = now()`,
						[providerId, JSON.stringify(this.#encrypt(providerId, write))],
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
				await this.#pool.query("DELETE FROM durable_agent_credentials WHERE provider_id = $1", [providerId]);
			},
			options,
		);
	}
}

/** The stable UUID OpenAI identifies this installation by. Created on first use, then constant. */
export async function installationDeviceId(pool: Pool): Promise<string> {
	const inserted = await pool.query<{ value: string }>(
		`INSERT INTO durable_agent_settings (key, value) VALUES ('device_id', $1)
		 ON CONFLICT (key) DO UPDATE SET value = durable_agent_settings.value RETURNING value`,
		[randomUUID()],
	);
	const value = inserted.rows[0]?.value;
	if (value === undefined) throw new Error("could not read or create the installation device id");
	return value;
}

/** The mirror schema this sidecar writes. Rails' migration creates the same tables; both record version 1. */
export const SCHEMA_VERSION = 1;

/** Record the schema version, leaving a value Rails (or an earlier boot) wrote alone. */
export async function recordSchemaVersion(pool: Pool): Promise<void> {
	await pool.query(
		`INSERT INTO durable_agent_settings (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO NOTHING`,
		[String(SCHEMA_VERSION)],
	);
}
