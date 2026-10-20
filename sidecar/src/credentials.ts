// pi-ai CredentialStore backed by the app's database, so OAuth tokens from Sign in with ChatGPT survive restarts and
// redeploys. Modifications to one provider are serialized, as pi-ai's in-memory store does, because a token
// refresh and a login can race.
//
// Credentials are encrypted at rest with AES-256-GCM under a key derived from the shared DURABLE_AGENT_TOKEN, which
// lives outside the database, so dumps, replicas and read-only database users see only ciphertext. `type` stays in
// the clear because list() reports it without decrypting, and it is not secret.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Db } from "./db/index.ts";
import { log } from "./log.ts";

type Envelope = { enc: 1; type: Credential["type"]; iv: string; tag: string; data: string };
type Stored = Envelope | Credential;
type Loaded = { credential: Credential | undefined; plaintext: boolean };

const isEnvelope = (stored: Stored): stored is Envelope => (stored as Partial<Envelope>).enc === 1;

function parseStored(providerId: string, text: string): Stored | undefined {
	try {
		return JSON.parse(text) as Stored;
	} catch (error) {
		log.warn("stored credential is not JSON; treating it as absent", { provider: providerId, error });
		return undefined;
	}
}

const KEY_SALT = "durable_agent_credentials";
const KEY_INFO = "v1";

export class DbCredentialStore implements CredentialStore {
	readonly #db: Db;
	readonly #key: Buffer;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(db: Db, token: string) {
		this.#db = db;
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
		const row = await this.#db.get<{ credential: string }>(
			"SELECT credential FROM durable_agent_credentials WHERE provider_id = ?",
			providerId,
		);
		const stored = row === undefined ? undefined : parseStored(providerId, row.credential);
		if (stored === undefined) return { credential: undefined, plaintext: false };
		if (isEnvelope(stored)) return { credential: this.#decrypt(providerId, stored), plaintext: false };
		return { credential: stored, plaintext: true };
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
		const rows = await this.#db.all<{ provider_id: string; credential: string }>(
			"SELECT provider_id, credential FROM durable_agent_credentials ORDER BY provider_id",
		);
		return rows.flatMap((row) => {
			const stored = parseStored(row.provider_id, row.credential);
			return stored === undefined ? [] : [{ providerId: row.provider_id, type: stored.type }];
		});
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serialize(
			providerId,
			async () => {
				const { credential: current, plaintext } = await this.#load(providerId);
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				// A plaintext row is rewritten encrypted even when fn keeps it.
				const write = next ?? (plaintext ? current : undefined);
				if (write !== undefined) {
					await this.#db.run(
						`INSERT INTO durable_agent_credentials (provider_id, credential, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
						 ON CONFLICT (provider_id) DO UPDATE SET credential = excluded.credential, updated_at = excluded.updated_at`,
						providerId,
						JSON.stringify(this.#encrypt(providerId, write)),
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
				await this.#db.run("DELETE FROM durable_agent_credentials WHERE provider_id = ?", providerId);
			},
			options,
		);
	}
}
