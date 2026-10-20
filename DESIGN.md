# durable_agent — design and contract

pi-durable, a durable agent runtime written in TypeScript, packaged as one Rails gem. The gem contains a Rails
engine and the sidecar process that runs the agents. An app installs the gem, runs one migration, and starts one
extra process. State lives in the app's own database, Postgres or SQLite, and Rails reads it with ordinary
models. `docs/design.html` is the illustrated version of this document; this file is the normative contract both
halves are implemented against.

## Shape

```
browser ◀─Turbo─ Puma ◀─POST /durable_agent/events─ sidecar (node)
                  │                                     │
                  │ reads durable_agent_* tables         │ pi-durable Harness over a storage adapter
                  ▼                                     ▼
              the app's database (Postgres or SQLite) ◀─┘
                  ▲
                  └─ Rails ─HTTP commands─▶ sidecar; sidecar ─GET/POST /durable_agent/tools─▶ Rails
```

- One sidecar per app. It owns a pi-durable Harness whose `Storage` is pi-durable's portable SQLite storage
  core (`SqliteStorage` from `@earendil-works/pi-durable/storage/sqlite`) running over a database adapter:
  pi-durable's own `openNodeSqliteDatabase` for SQLite, the gem's `PostgresDatabase` for Postgres. Both open
  the tables under the prefix `durable_agent_`.
- Rails owns the schema. The install migration creates every table on either adapter; the sidecar never runs
  DDL and refuses to boot when the tables are missing.
- The sidecar is the only writer of every `durable_agent_*` table. Rails models are read-only.
- Rails sends commands to the sidecar over HTTP. After each commit that touches a conversation the sidecar
  posts a change event to Rails; Rails calls a configurable callback whose default broadcasts a Turbo refresh
  from inside Puma, so the stock `async` cable adapter works in development.
- The sidecar calls into Rails for tool definitions, tool execution and change events. Nothing else.
- SQLite suits development, test and single-host production. Postgres suits everything else.

## Names

| Thing | Name |
|---|---|
| Gem / module | `durable_agent` / `DurableAgent`, isolated engine mounted at `/durable_agent` |
| Harness tables (pi-durable's) | `durable_agent_conversations`, `_entries`, `_tasks`, `_submissions`, `_documents`, `_document_revisions`, `_record_ids`, `_durable_schema`, `_durable_metadata` |
| Gem tables | `durable_agent_reports`, `_credentials`, `_settings` |
| Schema versions | `durable_agent_durable_schema.version` is pi-durable's (1 for pi-durable 1.3.0); `durable_agent_settings` row `schema_version` is the gem's (2); `GET /health` reports both |
| Sidecar | `sidecar/` (TypeScript), bundled to `sidecar/dist/sidecar.js` by `rake build`, shipped in the gem |
| Env prefix | `DURABLE_AGENT_*`, read by both halves |
| Account | an app-chosen string (`[A-Za-z0-9_.-]{1,64}`, typically a user id) naming whose provider credentials a conversation runs on; `openai@u42` is the account `u42`'s OpenAI provider id, `openai@u42/gpt-6.1-sol` its model ref; no `@` is the app's own account |

## Schema

Created by `lib/generators/durable_agent/install/templates/create_durable_agent_tables.rb.tt` with adapter-neutral
Rails DDL; `test/dummy/db/migrate` carries the same file. The first nine tables are pi-durable 1.3.0's SQLite
schema (`storage/sqlite/migrations.js`, version 1) rendered for Rails under the prefix: the same table names,
columns, indexes and partial index, so pi-durable's storage core runs over them unchanged. Deliberate
differences from pi-durable's own DDL: no `STRICT`, no `json_valid` checks, `record` and `content` are `text`
holding JSON (never `jsonb`, which rejects `\u0000` and would turn a model output into a fatal commit), and
`created_at` on conversations, entries and submissions. Ids and singletons use Rails' default primary key:
`integer PRIMARY KEY AUTOINCREMENT` on SQLite, a rowid alias as in pi-durable's own `INTEGER PRIMARY KEY`;
`bigserial` on Postgres, whose sequence goes unused because the sidecar supplies every id (and always writes
singleton `1`). `created_at` is `DEFAULT CURRENT_TIMESTAMP`: pi-durable's inserts name their columns and its
submission upsert updates named columns only, so the database fills it once, at insert (UTC on both: SQLite's
`CURRENT_TIMESTAMP` is UTC, and the sidecar's Postgres connections run with `TimeZone=UTC`). Because both
adapters dump these keys the same way, `schema.rb` loads to the migration's schema on either.

```ruby
create_table :durable_agent_durable_schema, primary_key: :singleton do |t|
  t.integer :version, null: false
end
create_table :durable_agent_durable_metadata, primary_key: :singleton do |t|
  t.text :next_id, null: false            # pi stores it as text: ids may exceed 2^53 in principle
  t.bigint :next_seq, null: false
end
create_table :durable_agent_record_ids do |t|
  t.text :record_type, null: false        # conversation | entry | task | submission | document
end
create_table :durable_agent_conversations do |t|
  t.bigint :owner_conversation_id
  t.bigint :owner_task_id
  t.text :record, null: false             # ConversationRecord JSON: {id, parent?: {conversationId, at}, owner?, ...}
  t.datetime :created_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
  t.index [ :owner_conversation_id, :id ], name: "durable_agent_conversations_by_owner_conversation"
  t.index [ :owner_task_id, :id ], name: "durable_agent_conversations_by_owner_task"
end
create_table :durable_agent_entries do |t|
  t.bigint :conversation_id, null: false
  t.bigint :head
  t.bigint :commit_seq, null: false
  t.text :record, null: false             # EntryRecord JSON: {id, conversationId, kind, data?, model?, head?, byTaskId?}
  t.datetime :created_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
  t.index [ :conversation_id, :id ], order: { id: :desc }, name: "durable_agent_entries_by_conversation"
  t.index [ :conversation_id, :id ], order: { id: :desc }, name: "durable_agent_entry_heads_by_conversation", where: "head IS NOT NULL"
end
create_table :durable_agent_tasks do |t|
  t.bigint :conversation_id, null: false
  t.text :kind, null: false               # JSON-encoded string, e.g. "\"pi.run\""
  t.text :status, null: false             # pending | running | waiting | completing | terminal
  t.integer :abort_requested, null: false # 0 | 1
  t.integer :background, null: false      # 0 | 1
  t.text :record, null: false
  t.index [ :status, :id ], name: "durable_agent_tasks_by_status"
  t.index [ :conversation_id, :id ], name: "durable_agent_tasks_by_conversation"
  t.index [ :kind, :id ], name: "durable_agent_tasks_by_kind"
  t.index [ :abort_requested, :id ], name: "durable_agent_tasks_by_abort_requested"
  t.index [ :background, :id ], name: "durable_agent_tasks_by_background"
end
create_table :durable_agent_submissions do |t|
  t.bigint :conversation_id, null: false
  t.text :request_id                      # JSON-encoded string, e.g. "\"42\""; NULL when the harness made it
  t.text :status, null: false             # queued | placed | done | unanswered
  t.text :record, null: false             # SubmissionRecord JSON: {id, conversationId, requestId?, type, status, entry?, answer?, reason?, detail?}
  t.datetime :created_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
  t.index [ :conversation_id, :request_id ], name: "durable_agent_submissions_by_request"
  t.index [ :conversation_id, :id ], name: "durable_agent_submissions_by_conversation"
  t.index [ :status, :id ], name: "durable_agent_submissions_by_status"
end
create_table :durable_agent_documents do |t|
  t.text :kind, null: false               # JSON-encoded string, e.g. "\"pi.live\""
  t.integer :family, null: false          # 0 = unkeyed, 1 = keyed
  t.text :key_value, null: false          # JSON-encoded key, "\"\"" when unkeyed
  t.text :scope_kind, null: false         # session | conversation | task
  t.bigint :owner_id, null: false         # 0, the conversation id, or the task id
  t.bigint :created_at, null: false       # commit seq, not a time
  t.bigint :retired_at                    # commit seq, not a time
  t.text :record, null: false             # DocumentRecord JSON: {id, kind, scope: {kind, conversationId?|taskId?}, key?, history, fork?, createdAt, retiredAt?}
  t.index [ :kind, :scope_kind, :owner_id, :family, :key_value, :created_at, :retired_at ], order: { created_at: :desc }, name: "durable_agent_documents_by_address"
  t.index [ :scope_kind, :owner_id, :id ], name: "durable_agent_documents_by_scope"
  t.index [ :scope_kind, :owner_id, :kind, :id ], name: "durable_agent_documents_by_scope_kind"
end
create_table :durable_agent_document_revisions, primary_key: [ :document_id, :seq ] do |t|
  t.bigint :document_id, null: false
  t.bigint :seq, null: false
  t.text :kind, null: false               # base | delta
  t.bigint :version, null: false
  t.text :content, null: false            # base: the value as JSON; delta: chord ops as JSON
  t.index [ :document_id, :kind, :seq ], order: { seq: :desc }, name: "durable_agent_document_revisions_by_kind"
end

create_table :durable_agent_reports do |t|  # written by the sidecar through its database facade
  t.text :type, null: false
  t.bigint :conversation_id
  t.bigint :task_id
  t.text :task_kind
  t.text :extension
  t.text :message, null: false
  t.text :info, null: false               # JSON text
  t.datetime :created_at, null: false
  t.index [ :conversation_id, :id ]
end
create_table :durable_agent_credentials, id: false do |t|
  t.text :provider_id, primary_key: true
  t.text :credential, null: false         # the encrypted envelope as JSON text
  t.datetime :updated_at, null: false
end
create_table :durable_agent_settings, id: false do |t|
  t.text :key, primary_key: true
  t.text :value, null: false
  t.datetime :updated_at, null: false
end
```

No foreign keys: pi-durable writes rows in its own order inside one transaction. The migration contains no
data; the sidecar seeds the two singleton rows at boot, so a database loaded from `schema.rb` works.
`sidecar/sql/schema.sqlite.sql` and `schema.postgres.sql` are SQL renderings of the same tables for the
sidecar's tests. A Ruby test runs the migration and the matching file against fresh databases of each adapter
and compares tables, primary keys, column types, nullability and defaults, and index definitions (name,
columns, order, predicate, uniqueness); it also checks that the test database loaded from `schema.rb` equals the
migration's.

Indexed strings (`tasks.kind`, `documents.kind`, `documents.key_value`, `submissions.request_id`) hold the
JSON encoding JavaScript's `JSON.stringify` produces, which escapes only `"`, `\` and control characters.
Rails encodes them with `DurableAgent::IndexedString` (`JSON.generate`), never `to_json`, which escapes `&`, `<`,
`>` and U+2028 and would find nothing.

## Sidecar

### Storage layer (`sidecar/src`)

- `db/index.ts`: `type Dialect = "postgres" | "sqlite"`; `interface Db extends SqliteDatabase { readonly dialect }`
  (`SqliteDatabase` is pi-durable's facade: `exec`, `run`, `get`, `all`, `transaction`, `close`, `?`
  placeholders); `openDatabase(url)` picks the adapter by scheme (`postgres:`/`postgresql:`, `sqlite:`/`sqlite3:`).
- `db/sqlite.ts`: pi-durable's `openNodeSqliteDatabase` (WAL, `synchronous = NORMAL`, `BEGIN IMMEDIATE`, the
  same settings Rails 8 uses, so Puma and the sidecar share one file) behind a serial queue of its own.
  `node:sqlite` waits for a lock synchronously, stalling the event loop, so its busy timeout is 100 ms
  (`SQLITE_BUSY_TIMEOUT_MS`) and the real wait is asynchronous: a `transaction` whose `BEGIN IMMEDIATE` fails
  with `SQLITE_BUSY` before the callback has run, and a `run`/`get`/`all` that fails busy (an autocommit statement
  that has not run), are retried with backoff (25 ms doubling to 500 ms) for up to `SQLITE_BUSY_BUDGET_MS`
  (30 s), then rejected with "SQLite database is locked: another writer held the write lock for more than …".
  A busy error after the callback started, and `exec` (a script may have partly committed), are not retried.
  Later operations wait behind the retrying one. Operational rule: no other writer (Puma, a console, a backup) may
  hold the SQLite write lock longer than 30 s, or the session fails.
- `db/postgres.ts`: `PostgresDatabase` over a `pg.Pool` (max 2). `int8` is parsed to a JS number (ids and seqs
  are safe integers; `next_id` is text). Every operation runs through one serial queue, as pi-durable's node
  adapter does: a `transaction` checks out a client, `BEGIN`s, runs the callback on an executor bound to that
  client, then `COMMIT`s or `ROLLBACK`s and rethrows; everything else waits. pg-pool drops its idle `error`
  listener on checkout, so the checked-out client carries the adapter's own `error` listener from checkout to
  release: a dropped connection rejects the pending query and every later one (the transaction rejects with the
  connection error, without a `ROLLBACK`), and the client is released broken so the pool discards it; it is never
  an uncaught exception. A transaction rejected this way may still have committed, when the connection died
  between the server's `COMMIT` and its acknowledgement; the Harness treats the rejection as fatal, and the
  restarted sidecar resumes from whatever the database holds, so both outcomes are consistent. Single statements go through `pool.query`, which guards its checkout the same way.
  Retries, because pi-durable treats a storage error as fatal to the session: a checkout or `BEGIN` that fails
  with a connection-class error (`ECONNRESET`, `57P01`, `08*`, "Connection terminated") is retried once, since
  nothing has run; outside a transaction only a statement that starts with `SELECT` (after leading comments) is
  sent once more, because a lost response may hide a committed write. `INSERT`/`UPDATE`/`DELETE`, CTEs and `exec`
  are never repeated, and nothing inside a transaction is. Connections run with `TimeZone=UTC` so
  `CURRENT_TIMESTAMP` matches Rails' timestamp columns. The pool logs idle-client errors.
- `db/translate.ts`: the storage core speaks SQLite; `toPostgres(sql)` turns `?` into `$1, $2, …` (never inside
  a literal), `INSERT OR IGNORE INTO …` into `INSERT INTO … ON CONFLICT DO NOTHING` (before any `RETURNING`),
  drops ` STRICT` and `CHECK (json_valid(x))`. `excluded.col`, `ON CONFLICT(id) DO UPDATE`, partial indexes and
  `LIMIT ?` are already valid Postgres. Memoized by SQL text.
- `storage.ts`: `openHarnessStorage(db)` checks that `durable_agent_conversations` exists (else `MissingSchema`,
  "run bin/rails db:migrate"), seeds `durable_agent_durable_schema (1, CURRENT_SQLITE_SCHEMA_VERSION)` and
  `durable_agent_durable_metadata (1, '2', 1)` with `ON CONFLICT DO NOTHING`, refuses a stored version lower than
  pi-durable's (a gem upgrade ships the Rails migration and bumps the row), and returns
  `SqliteStorage.open(db, { prefix: "durable_agent_" })`, which finds the version current and runs no DDL. One
  `CREATE TABLE IF NOT EXISTS` for the version table still reaches the database, so on Postgres the role needs
  `CREATE` on the schema. Closing the storage closes the database handle.
- `settings.ts`: `installationDeviceId`, `recordSchemaVersion` (`"2"`, do nothing if present),
  `readSchemaVersion`, `readHarnessSchemaVersion`, `SCHEMA_VERSION = 2`. `checkSchemaVersion` runs first at boot:
  it records the version on a fresh database, refuses to boot when the stored version is greater than
  `SCHEMA_VERSION` ("the database is newer than this gem"), and logs a warning ("run bin/rails db:migrate") but
  boots when it is lower.
- `credentials.ts`: `DbCredentialStore(db, token)`, pi-ai's `CredentialStore` over the facade. Each credential is
  stored as `{"enc": 1, "type", "iv", "tag", "data"}`: AES-256-GCM with the provider id as associated data,
  keyed by HKDF-SHA256(token, salt `durable_agent_credentials`, info `v1`). `type` stays clear for `GET /auth`.
  Dumps and replicas hold ciphertext; the sidecar holds the key, so anyone with the database and the token can
  decrypt; Rails never decrypts. Rotating the token makes stored sign-ins unreadable: the sidecar logs a warning
  per provider and treats them as absent until the user signs in again. Plaintext rows are rewritten encrypted on
  the next modify. Modifications to one provider are serialized. Rows are keyed by provider id, scoped or not:
  `openai` is the app's credential, `openai@u42` the account `u42`'s.
- `accounts.ts`: accounts as provider ids. `scopedProviderId("openai", "u42")` is `openai@u42`;
  `parseProviderId` splits it back; `ensureAccountProvider(models, base, account)` registers a clone of the base
  provider (the same factory, `openaiProvider()`, `anthropicProvider()` or faux, with the scoped id) when
  `models.getProvider` does not know it, so the catalog, auth methods and request code are the base provider's and
  only the credential row differs. At boot every scoped provider id in `durable_agent_credentials` is registered;
  `POST /conversations` and the auth routes register on demand. pi-ai keys the credential store, `login`, `logout`
  and `checkAuth` by provider id, and a conversation pins its provider in `pi.agent`, so a conversation started on
  `openai@u42` resolves that account's credential on every request, including after a restart. The clone's models
  carry the scoped id, since pi-ai routes a request and its auth by `model.provider`; the clone hands each
  request to the base provider with the base id again, because the request code switches on it (a Sign in with
  ChatGPT token is recognised for `provider === "openai"` only), so assistant entries record `provider: "openai"`
  while `pi.agent` keeps `openai@u42`. An account provider resolves its own stored credential only: the
  environment (`OPENAI_API_KEY`) and credential files are the app's, never an account's. An account whose
  credential is gone settles its runs `unanswered` with reason `model_error` ("Provider is not configured").
- `reports.ts`: `createReporter(db, events)` stores Harness reports (faulted tasks, hook errors, a failed session)
  with `RETURNING id` and `CURRENT_TIMESTAMP`, then `events.report(id)`. pi-durable 1.3.0 calls `onReport(error)`
  with one argument; the `info` of newer releases is read when present. The reporter tracks its inserts in flight;
  `reporter.settled()` waits for all of them and their `events.report`, and shutdown awaits it before closing the
  Harness, so a report raised just before a signal is stored and delivered.

SQL in `settings.ts`, `credentials.ts` and `reports.ts` is written once in the SQLite dialect and translated on
Postgres like the core's.

### Documents are stored as bases (`documents.ts`)

pi-durable stores a document as a base revision plus chord deltas and checkpoints a new base only when the
document's definition says so (`pi.live`: when idle; `pi.inbox`: when empty). Rails would have to replay chord
deltas to read a streaming `pi.live`. `withBaseDocuments(inner)` wraps `commit(writes)`: for each
`document.change` carrying a delta whose document keeps only its current value (the storage core's own
`isCurrentOnly`: `scope.kind !== "conversation" || history === "latest"`, so every session and task document and
every `latest` conversation document, which covers every `pi.*` document Rails reads: live, inbox, usage, provider;
`pi.agent` is `rewindable` but always checkpoints) it reads `inner.document(id, "current")`, applies the ops with `apply` from `@earendil-works/chord/delta` on a structured
clone, and replaces the write with `{kind: "base", version, value}`. The storage core deletes the previous
revisions of a current-only document on a base, so such a document always has exactly one revision row. Commits
through the wrapper are serialized so the read and the commit cannot interleave. Deltas on `rewindable`
conversation documents pass through. The Harness sees the same value and version either way. A failed read of the
current value fails the commit: without it there is no base to write.

The wrapper also resolves, before the commit and inside the same serialized step, the conversation owning each
`document.change` and `document.retire` (`commitWithOwners`): from a cache filled by creates and copies, from the
rewrite's own read of the record, or else from `inner.document`. A failed owner read is logged at `warn` and that
document is left out of the change event; the commit goes ahead.

The rule Rails relies on: **the current value of a document is the content of its newest `base` revision, and no
`delta` follows it for any document Rails reads.** If one does, `DurableAgent::Document#value` raises
`DurableAgent::Document::HistoryNotSupported`.

### Change events (`events.ts`)

`ChangeTracker` wraps `commit(writes)` too, and the change path never decides a commit's fate: every owner is known
before `inner.commit` runs, and nothing after it can reject. It announces the conversation ids touched:
`conversation` writes, `entry` and `submission` writes (`value.conversationId`), `document.create`/`document.copy`
with a conversation scope, and the owners of `document.change`/`document.retire` that the base-document wrapper
resolved before the commit (see above). `task` writes are ignored. Queuing the ids runs after the commit inside a
`try` that logs at `warn` and returns the commit's seq regardless.

`Events` debounces for 100 ms (a steady stream still posts every 100 ms) and does
`POST {RAILS_URL}/durable_agent/events` with the bearer token and `{"conversations": [7, 9], "reports": [3],
"auth": ["openai"]}`. `auth` names the provider ids whose credential changed (a login reached `done`, an API key was stored, or
`DELETE /auth/:provider` signed one out), scoped when an account's: `["openai", "openai@u42"]`. It is left out
when there are none.
A non-2xx or network error is retried once after 1 s, then logged at `warn` and dropped: events are a hint, the
state is in the database, and the next event or page load shows it. Unset `DURABLE_AGENT_RAILS_URL` disables
events with one boot log line. `flush()` is awaited on shutdown, after the Harness has closed.

### Boot and shutdown (`main.ts`, `harness.ts`)

Open the database from `DATABASE_URL` → `openSidecar(db, config)` (`harness.ts`): check the gem schema version →
credential store and models → account providers from the credentials table → device id → logins → Harness over
`ChangeTracker(withBaseDocuments(openHarnessStorage(db)))` → ensure the root conversation; then `main.ts` serves →
load tools (awaited, with the bounded boot retry; a failure or an unset Rails URL falls through with no tools) →
log "resuming with N tools" → `resume()`. The sidecar's tests boot through the same `openSidecar`. Every step of
`openSidecar` runs inside one handler: a missing table at any of them (SQLite "no such table", Postgres `42P01`,
also as a cause) is reported as `MissingSchema` ("run bin/rails db:migrate") and the process exits 1; any other
boot error exits 1 too. Until
`resume()` has run, `/health` reports `resumed: false` and submissions and aborts answer `503 {error: "starting"}`,
because either would start pi-durable's scheduler before the tools are installed.

Supervision: main watches `harness.closed`. When the session ends with `{reason: "failed", error}` (pi-durable
closes it, database included, after the first failed storage call) it logs the error and exits 1 so a supervisor
restarts the process; a clean close outside our own shutdown exits 1 as well. An uncaught exception is logged and
exits 1. Unhandled rejections are logged, not fatal.

Shutdown on SIGTERM or SIGINT: stop the server and wait up to 10 s for requests underway (then close their
connections), then `sidecar.close()`: dispose logins, await `reporter.settled()`, close the Harness (which commits
nothing new and closes the database), flush events; exit 0. The whole shutdown has a 30 s deadline, after which the process logs and
exits 1; a second SIGTERM or SIGINT during shutdown exits 1 at once. A signal during the tool load stops it and
the Harness is not resumed.

### HTTP API v1 (`server.ts`)

JSON bodies, `Authorization: Bearer <token>` on everything except `/health`, compared in constant time. Unknown
routes 404. The login routes with an `:id` answer 404 unless that login belongs to `:provider`.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | | `200 {ok: true, schemaVersion: 2, harnessSchemaVersion: 1, database: "postgres" \| "sqlite", model: {provider, modelId}, tools: [names], resumed: boolean}`; `503 {ok: false, error}` once the Harness has closed |
| POST | `/conversations` | `{model?: {provider, modelId}, instructions?, account?}` | `201 {id}`; `422 {error, suggestions: [ids]}` for an unknown model; `422 {error: "invalid_account"}`. With `account`, the model's provider becomes `provider@account` and the conversation runs on that account's credential. |
| POST | `/conversations/:id/submissions` | `{content, request_id, when_busy?: "followUp" \| "steer" \| "reject"}` | `202 {id, status}`; `404`; `409 {error: "conversation_busy"}`; `503 {error: "starting"}` before resume |
| POST | `/conversations/:id/abort` | | `200 {ok: true}`; `503 {error: "starting"}` before resume |
| GET | `/auth?account=` | | `200 {"<provider>": {type: "oauth" \| "api_key", source} \| null, ...}` for the app's providers, or the account's, under their base names |
| PUT | `/auth/:provider/api_key?account=` | `{key}` | `200 {type: "api_key", source: "stored credential"}` stores the key, encrypted; `422 {error}` for a blank key or a provider without API-key auth |
| POST | `/auth/:provider/logins?account=` | | `201 <login>`; `422 <login>` when it failed at once |
| GET | `/auth/:provider/logins/:id` | | `200 <login>`; `404` |
| POST | `/auth/:provider/logins/:id/callback` | `{url}` (the redirect URL the browser ended on) | `200 <login>` |
| DELETE | `/auth/:provider/logins/:id` | | `200 <login>` (cancelled) |
| DELETE | `/auth/:provider?account=` | | `200 {ok: true}` (sign out) |

`:provider` is the base provider id; `account` scopes it; the login routes with an `:id` also accept the scoped
id. `<login>.provider` carries the scoped id. Every account route answers `422 {error: "invalid_account"}` for an
account outside `[A-Za-z0-9_.-]{1,64}`, and `422 {error: "unknown_provider"}` for a base provider the sidecar
cannot clone (`openai`, `anthropic` and `faux` it can). `PUT …/api_key` on a provider without API-key login
(faux) is `422 {error: "no_api_key_auth"}`. `POST /conversations` also accepts an already scoped model ref
(`{provider: "openai@u42", modelId}`) without `account`.
| POST | `/tools/reload` | | `200 {tools: [names]}` re-fetches tool definitions from Rails |

`<login>` = `{id, provider, status: "starting" | "awaiting_browser" | "exchanging" | "done" | "failed", url?, instructions?, deviceCode?: {userCode, verificationUri}, messages: [], error?}`.
Sign in with ChatGPT and the other OAuth flows also listen on `127.0.0.1:1455` for the browser redirect, which
completes the login by itself when the browser runs on the sidecar's host; otherwise the user pastes the final
URL and Rails posts it to the callback route.

Submissions are idempotent on `request_id`. The submission row is committed before the 202, so Rails can `find`
it at once. An unknown default model logs an error at boot and the sidecar keeps running (creation then returns
422). Missing provider credentials are not an error at boot; runs settle `unanswered` with reason `no_model`
until someone signs in.

### Environment

`bin/rails durable_agent:sidecar` derives every value from Rails configuration, which in turn defaults to the same
variables, so setting one of these in the shell moves both halves.

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | the app's primary database: `postgres://…` (plus `?host=` for a socket directory, and `sslmode`, `sslrootcert`, `sslcert`, `sslkey` and `options=-c search_path=…` when `database.yml` sets them; see `Sidecar.database_url`) or `sqlite:///absolute/path/to/development.sqlite3` | rendered from `database.yml` |
| `DURABLE_AGENT_TOKEN` | shared bearer secret; required, and a whitespace-only value counts as unset (both halves refuse it) | `DurableAgent.config.token` |
| `DURABLE_AGENT_HOST`, `DURABLE_AGENT_PORT` | bind address | `127.0.0.1`, `4010` |
| `DURABLE_AGENT_RAILS_URL` | where Rails answers `/durable_agent/tools` and `/durable_agent/events`; unset runs without tools or events | `http://127.0.0.1:3000` |
| `DURABLE_AGENT_MODEL` | default model as `provider/modelId`; `faux/faux-1` is the scripted offline model | `openai/gpt-6.1-sol` |
| `DURABLE_AGENT_WORKSPACE_ROOT` | cwd for built-in tools (unused today, keep the knob) | `storage/durable_agent` |
| `DURABLE_AGENT_NAME` | agent name shown on provider consent screens | the Rails application name |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | pass-through | |

## Tools

Tools are Ruby classes; the sidecar is generic.

1. At boot and on `POST /tools/reload` the sidecar does `GET {RAILS_URL}/durable_agent/tools` with the bearer
   token and expects `200 [{name, description, parameters: <JSON Schema object>, replay: "safe" | "unsafe"}]`.
   At boot a failed fetch is retried with backoff (500 ms doubling to 10 s) for up to 60 s, because `bin/dev`
   starts node before Puma listens; then it logs a warning and runs with no tools until the next reload. A
   successful reload ends the retry early. The HTTP server answers meanwhile, but the Harness resumes only after
   this load: pi-durable re-runs an interrupted `replay: "safe"` call only when the tool is registered at the
   moment the run resumes, and otherwise settles it as interrupted for good.
2. Each definition becomes a pi-durable tool. Executing it does `POST {RAILS_URL}/durable_agent/tools/:name` with
   `{arguments, conversation_id, call_id}`. `200 {result}` → the tool output is `result` when it is a string,
   else `JSON.stringify(result)`. Any other status with `{error}` → an error result carrying the message.
   Network failure → error result. Timeout 120 s.

```ruby
class LookupInvoice < DurableAgent::Tool
  description "Fetch one invoice by number"
  param :number, :string, "Invoice number like INV-1042"          # required by default
  param :include_lines, :boolean, "Include line items", required: false
  replay :safe                                                    # default :unsafe

  def call(number:, include_lines: false)
    Invoice.find_by!(number:).as_json
  end
end

DurableAgent.configure { |config| config.tools = [ LookupInvoice ] }
```

`DurableAgent::Tool.tool_name` is the underscored class name. `to_definition` returns the hash above. Param
types: `:string`, `:integer`, `:number`, `:boolean`, `:array`, `:object`. `DurableAgent::ToolsController`
(engine routes `GET /tools`, `POST /tools/:name`) authenticates the bearer token against
`DurableAgent.config.token`, returns 404 for an unknown tool, and sets `DurableAgent::Current.conversation_id` /
`call_id` during the call. Errors answer 422 `{error}`, and `error` is what the model sees: the message for
`ArgumentError` (bad arguments), `ActiveRecord::RecordNotFound` and `DurableAgent::Tool::Error` (which tools raise
with a message meant for the model); for any other `StandardError` only `"<ErrorClass> while running <tool>"`,
with the error itself sent to `Rails.error.report`, so messages carrying SQL, paths or secrets stay in the app.

## Events endpoint

`POST /durable_agent/events` (engine route `events#create`), same bearer check as tools. Body
`{"conversations": [ids], "reports": [ids], "auth": ["openai"]}`, every key optional. For each conversation that
exists, `config.on_change.call(conversation)`; for each report, `config.on_report.call(report)`; when `auth` names
provider ids, `config.on_auth.call(providers)` once with them as given (`"openai"`, `"openai@u42"`). Unknown ids
are skipped. Callback errors go to
`Rails.error.report` and never fail the request. Responds 204.

The bearer check (tools and events) wants exactly `Authorization: Bearer <token>`: the scheme is case-sensitive,
then one space, then the token, compared in constant time. A bare token or any other form is 401.

The default callbacks broadcast Turbo refreshes from Puma: `on_change` to the conversation (`turbo_stream_from
conversation`); `on_report` to `report.conversation`, or to the stream `"durable_agent:reports"` when the report
has none (every report on pi-durable 1.3.0); `on_auth` to the stream `"durable_agent:auth"` and, for each account named, `"durable_agent:auth:<account>"`;
a settings page subscribes with `turbo_stream_from DurableAgent.auth_stream(account)`.

## Who pays

Three arrangements. Each is a credential on an account plus a conversation started on that account; the app picks
per conversation, and can mix them (a user with a credential runs on their account, the rest on the app's).

- The app pays: one credential for everyone (`OPENAI_API_KEY`, a key stored with `connection.set_api_key`, or the
  operator's Sign in with ChatGPT), conversations from `DurableAgent.start`. The operator's bill or plan carries
  every user.
- Each user pays with an API key: `Connection.new("openai", account: user.id).set_api_key(key)`, conversations
  from `DurableAgent.start(account: user.id)`. Usage lands on the user's own provider bill. No browser flow.
- Each user pays with their ChatGPT plan: `Connection.new("openai", account: user.id).start_login`, the user
  approves in the browser, conversations from `DurableAgent.start(account: user.id)`. Usage is drawn from the plan,
  under limits the user manages in ChatGPT settings; the app holds a refreshable token per user and never a key.

## Accounts

The app decides which account a conversation runs on and what to do when an account has no credential:
`DurableAgent.auth(account:)` says, and `start` without `account:` runs on the app's. A user's sign-out
(`connection.disconnect`) leaves their running conversations settling `model_error` until they connect again. Usage
per account is the sum of `pi.usage` over that account's conversations, which the app relates to its users.

Sign in with ChatGPT is pi-ai's OpenAI OAuth: a public client registered dynamically per login, scopes
`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, the resulting token sent to the
Responses API, usage drawn from the signed-in user's plan. Its redirect is `http://127.0.0.1:1455/auth/callback`.
When the browser runs on the sidecar's host, the sidecar's listener completes the login; a user elsewhere lands
on their own machine's port 1455 and pastes the final URL into the app, which posts it to the callback route.

## Ruby API

```ruby
DurableAgent.configure do |config|
  config.model = "openai/gpt-6.1-sol"       # "provider/modelId"; default DURABLE_AGENT_MODEL
  config.tools = [ LookupInvoice ]
  config.url = "http://127.0.0.1:4010"      # the sidecar; built from host and port
  config.host, config.port                  # defaults DURABLE_AGENT_HOST / DURABLE_AGENT_PORT, then 127.0.0.1:4010
  config.rails_url = "http://127.0.0.1:3000" # default DURABLE_AGENT_RAILS_URL
  config.token = "..."                      # default below
  config.workspace_root, config.agent_name  # defaults DURABLE_AGENT_WORKSPACE_ROOT / DURABLE_AGENT_NAME, then the table's
  config.parent_record_class = "ApplicationRecord" # DurableAgent::ApplicationRecord's superclass; default "ActiveRecord::Base"
  config.on_change = ->(conversation) { ... }   # default: Turbo::StreamsChannel.broadcast_refresh_to(conversation)
  config.on_report = ->(report) { ... }         # default: refresh report.conversation, else "durable_agent:reports"
  config.on_auth = ->(providers) { ... }        # provider ids, scoped for accounts ("openai@u42"); default: refresh
                                                # "durable_agent:auth" and "durable_agent:auth:<account>" for each account named
end

DurableAgent.start(model: nil, instructions: nil, account: nil)   # => DurableAgent::Conversation (created on the sidecar, then found)
DurableAgent.conversation(id)
DurableAgent.auth(account: nil)   # => {"openai" => {"type" => "oauth", "source" => "OAuth"},
                                  #     "anthropic" => {"type" => "api_key", "source" => "ANTHROPIC_API_KEY"}, "google" => nil, ...}
                                  # the app's providers, or the account's under their base names; `source` is pi-ai's:
                                  # "OAuth", "stored credential", or the environment variable it read
DurableAgent.auth_stream(account = nil)   # "durable_agent:auth" or "durable_agent:auth:u42", for turbo_stream_from

conversation.say("Hello", request_id: message.id, when_busy: nil)   # => DurableAgent::Submission (persisted)
conversation.abort
conversation.transcript                              # Array of visible entries, oldest first
conversation.entries / submissions / tasks / reports / documents
conversation.document("pi.live") / live / busy? / streaming_message / running_tools / inbox / last_failure
conversation.model / agent / usage / usage_by_model / total_tokens / total_cost   # pi.agent and pi.usage
conversation.provider / account                      # "openai" and "u42" from model "openai@u42/gpt-6.1-sol"; account nil for the app's
entry.message / provider / model_id / model_ref / stop_reason / error_message / usage / total_tokens / cost / duration_ms / timestamp
entry.failed? / answer?                              # an assistant entry whose request ended in an error or abort is no answer
conversation.parent / parent_at                      # from record["parent"]: the parent Conversation and the Entry it forked at
conversation.created_at / last_activity_at           # the row's insert time; the newest entry's created_at, else created_at
DurableAgent::Conversation.root / top_level          # the root the sidecar creates at boot (id 1); the others no task owns

DurableAgent::Connection.new("openai", account: nil)   # the app's OpenAI sign-in, or account u42's
connection.connected? / subscription? / api_key? / unreachable? / error / source
connection.set_api_key(key) / start_login / login(id) / complete_login(id, url) / cancel_login(id) / disconnect
connection.account / stream_name                      # DurableAgent.auth_stream(account)
DurableAgent::Connection.all(account: nil)
```

Models in `app/models/durable_agent/`, all `readonly?`, all over the tables above, inheriting
`DurableAgent::ApplicationRecord` and the `HarnessRecord` concern (table name prefix, read-only).
`DurableAgent::ApplicationRecord` inherits from `config.parent_record_class`, resolved when the models load; an
app whose `ApplicationRecord` uses `connects_to` sets it to `"ApplicationRecord"` so role and shard switching apply.
`DurableAgent.start`, `Conversation#say` and `#abort` clear the query cache once the sidecar has answered, so
`busy?`, `live` and `transcript` read its commit in the same request. `DurableAgent.start` cannot join the caller's
transaction (the sidecar commits on its own connection): when the app's own record fails to save afterwards, the
conversation remains, unreferenced.

- `Conversation`: `attribute :record, :json`; `top_level` scope is `owner_conversation_id: nil` without the root
  (id 1, which the sidecar creates at boot; `Conversation.root` returns it); `created_at` is a column and
  `last_activity_at` the newest entry's `created_at`, else the conversation's;
  `has_many :entries / :submissions / :tasks / :reports` on `conversation_id` (own rows only; a forked
  conversation's inherited entries are not followed); `documents` is `Document.current.where(scope_kind:
  "conversation", owner_id: id)`; `document(kind)` returns that document's `value` or `{}`. `say` returns
  `submissions.find(response["id"])`. `last_failure` is the newest `unanswered` submission whose `entry_id` is
  greater than the id of the newest `pi.assistant` entry that is an answer (`stopReason` neither `error` nor
  `aborted`), or any unanswered one when there is no answer yet. `model` is `"provider/modelId"` from the
  `pi.agent` document; `usage`, `usage_by_model`, `total_tokens`, `total_cost` read `pi.usage`.
- `Entry`: `attribute :record, :json`; `kind`, `data`, `model`, `head`, `by_task_id` come from the record (there
  are no such columns); `created_at` is a column. Scopes `chronologically` / `reverse_chronologically` on id. `HIDDEN_KINDS =
  %w[pi.system pi.reset]`, `visible?`, `user?`, `assistant?`, `tool_result?`, `compaction?`, `messages`, `text`,
  `tool_calls`, `thinking?`, `tool_name`, `error?`. Kind filtering happens in Ruby: `Entry.visible` and
  `Entry.of_kind(*kinds)` return arrays and work on relations.
- `Submission`: `attribute :record, :json`; the `request_id` column is the JSON-encoded string, so
  `Submission.for_request(id)` encodes with `IndexedString`; `created_at` is a column; `type`, `entry_id`, `answer_entry_id`, `reason`, `detail`,
  `entry`, `answer` come from the record; `status` is a column with scopes `pending`, `settled`, `unanswered`;
  `explanation` turns pi's reasons (`no_model`, `run_failed`, `aborted`, …) into a sentence.
- `Task`: `attribute :record, :json`; `kind` decodes the JSON column; `status`, `abort_requested?`,
  `background?`, `terminal?`; scopes `of_kind`, `unfinished`.
- `Document`: `kind` and `key` decode their JSON columns; `current` scope (`retired_at: nil`); `of_kind(kind)`
  encodes; `has_many :revisions` (`Document::Revision`, table `durable_agent_document_revisions`); `value` is the
  parsed content of the newest `base` revision and raises `HistoryNotSupported` when a `delta` has a greater seq.
- `Report`: `attribute :info, :json`; `belongs_to :conversation, optional: true`; `latest` scope.
- Credentials and settings have no models.

Other Ruby:

- `Configuration#token`: `Rails.application.credentials.dig(:durable_agent, :token)`, then
  `ENV["DURABLE_AGENT_TOKEN"]`, then in development and test a value derived from `secret_key_base` so both
  halves agree with zero setup. Production with none of these raises `MissingToken` where the token is used (the
  `durable_agent:sidecar` task, the engine's controllers, the client), not at boot, so `db:migrate`, `console`
  and asset builds run without one. A blank token raises `MissingToken` rather than being compared.
- `DurableAgent::IndexedString.encode(value)` / `.decode(text)`: the indexed-string encoding (see Schema).
- `DurableAgent::MessageText` extracts text, tool calls and thinking from pi messages (string content or blocks
  of `{type: "text" | "thinking" | "toolCall"}`).
- `DurableAgent::Client` wraps Net::HTTP. Errors: `DurableAgent::Error` (status, body), `Busy` (409),
  `UnknownModel` (422 on conversations, carries `suggestions`), `Unavailable` (connection refused, reset or
  timed out; `EOFError`, `IOError` or `Errno::EPIPE` from a sidecar that went away mid-response; 503 `{error:
  "starting"}` before the sidecar has resumed, with the message "sidecar is starting").
- `DurableAgent::Sidecar.env` builds the environment table; `.database_url` renders the primary `database.yml`
  entry (`sqlite3` → `sqlite:///<absolute path>`, relative paths resolved against `Rails.root`; `postgresql` →
  `postgres://user:pass@host:port/db` plus `?host=`, `sslmode`, `sslrootcert`/`sslcert`/`sslkey` (relative paths
  resolved against `Rails.root`) and `schema_search_path` as `options=-c search_path=<value>`; an explicit `url`
  passes through; other adapters raise `ArgumentError`). `sslmode=require`, rendered or in an explicit URL,
  reaches node as `sslmode=no-verify`: libpq's `require` encrypts without verifying the server certificate, while
  pg-connection-string reads `require` as `verify-full` and would refuse the self-signed certificates many hosted
  databases use; `no-verify` is its name for libpq's `require`. `verify-ca` and `verify-full` pass through.
  `.command` returns `["node", <dist/sidecar.js, or src/main.ts from a
  checkout>]`; `.exec` replaces the process.
- Rake task: `durable_agent:sidecar`. Package with `rake build`, which bundles the sidecar (not checked in) before
  packaging; the gemspec aborts a bare `gem build` when `sidecar/dist/sidecar.js` is missing. `CHANGELOG.md` keeps
  an Unreleased section.
- `DurableAgent::TestHelper` (`require "durable_agent/test_helper"`, include it in `ActiveSupport::TestCase`):
  `stub_sidecar(**responses)` replaces client methods with values, callables or errors and records
  `sidecar_calls`; `fake_sidecar(**responses)` answers `create_conversation`, `submit` and `abort` as the sidecar
  does, committing the conversation or queued submission row first (ids from 950001, submissions idempotent on
  `request_id`, 404 for an unknown conversation). The gem's own tests use it.
- Generator `durable_agent:install`: copies the migration, writes `config/initializers/durable_agent.rb` with
  commented production notes for excluding `/durable_agent` from `force_ssl`'s redirect and from `config.hosts`
  (the sidecar calls Rails over plain loopback HTTP), mounts the engine, adds `sidecar: bin/rails
  durable_agent:sidecar` to `Procfile.dev` (creating it with `web: bin/rails server -p 3000` and `sidecar:`
  otherwise; when an existing `web:` line sets no port it says that foreman runs it on 5000 while `rails_url`
  defaults to 3000), and prints what it did and how to set a production token. The initializer leaves
  `config.model` commented out, so `DURABLE_AGENT_MODEL` keeps working, and shows all three callbacks.
- The app brings its own database adapter gem (`pg` or `sqlite3`); the gem depends on `rails` and `turbo-rails`.

## Tests

Both suites run on both databases.

- Ruby: Minitest with the dummy app. `test/dummy/config/database.yml` selects the adapter from
  `DURABLE_AGENT_DB` (`sqlite`, the default, files under `test/dummy/storage/`; `postgres` with
  `durable_agent_development` / `durable_agent_test`). `rake test` runs on SQLite, `rake test:postgres` on
  Postgres, `rake test:all` both. Fixtures use ids ≥ 900000 and `record` JSON in pi-durable's shapes. Covered:
  the models (document values on a base and on a base followed by a delta, the JSON-encoded columns against
  hand-written `JSON.stringify` output, transcript, `last_failure`, `busy?`, timestamps, the root), the query
  cache after commands (a second connection commits as the sidecar would), client errors, the tools and events
  controllers (Bearer scheme, error exposure, auth events), configuration (environment defaults, blank token),
  `Sidecar.database_url` on both adapters, the generator, `DurableAgent::TestHelper`, the migration against the
  sidecar's SQL files on both adapters in every run and against `schema.rb`, and one round trip that boots the
  real sidecar on `faux/faux-1` against the test database when `node` is available, after `/health` says
  `resumed`. Cross-process reads use `ActiveRecord::Base.uncached`.
- TypeScript: `node --test`. `test/helpers.ts` opens the database from `DURABLE_AGENT_TEST_DATABASE_URL`
  (default a fresh SQLite file in a temp dir) and applies the matching schema file. `npm test` runs on SQLite,
  `npm run test:postgres` on Postgres. Covered: pi-durable's storage conformance cases against
  `openHarnessStorage`, the translator (including pi-durable's own migration DDL), the Postgres queue, SELECT-only
  retry and backend termination inside transactions, the SQLite busy wait against a second connection holding the lock,
  storage open (missing schema, seeding, version refusal, a Harness on faux), the base-document wrapper (unit
  cases, a task-scoped document among them, and a streaming `pi.live` that is only ever one base row equal to `watch.value.docs["pi.live"]`), the
  change tracker (failing reads before and after the commit) and events (auth included) against a fake Rails,
  credentials, settings (schema version newer and older), reports (`settled()`), the model check, the HTTP API
  (health, readiness, login provider check), the process itself (`test/sidecar.test.ts` spawns `src/main.ts`: resume
  after tools, exit 1 on a failed storage call, a second signal, `MissingSchema` for any missing table, a newer
  schema), a restart that re-runs an interrupted replay-safe tool call once Rails lists the tools late,
  and the tools protocol with its boot retry.

## Conventions

- Ruby in 37signals style: fat models, thin controllers, concerns, no service objects, Minitest, fixtures.
- TypeScript: strict, ESM, `.ts` imports, Node 22.19+ (type stripping), runnable from source without a build.
- Do not commit from an agent; the orchestrator commits.
- Out of scope today: more than one sidecar, compaction/reset/task-graph routes, any UI, MCP, a Ruby port of
  chord deltas, following forked conversations' inherited entries.
