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

## Schema

Created by `lib/generators/durable_agent/install/templates/create_durable_agent_tables.rb.tt` with adapter-neutral
Rails DDL; `test/dummy/db/migrate` carries the same file. The first nine tables are pi-durable 1.3.0's SQLite
schema (`storage/sqlite/migrations.js`, version 1) rendered for Rails under the prefix: the same table names,
columns, indexes and partial index, so pi-durable's storage core runs over them unchanged. Deliberate
differences from pi-durable's own DDL: no `STRICT`, no `json_valid` checks, `record` and `content` are `text`
holding JSON (never `jsonb`, which rejects `\u0000` and would turn a model output into a fatal commit), integer
ids are `bigint`. The `singleton` primary keys get an autoincrement on both adapters, which is harmless because
the sidecar always writes `1`.

```ruby
create_table :durable_agent_durable_schema, id: false do |t|
  t.integer :singleton, primary_key: true
  t.integer :version, null: false
end
create_table :durable_agent_durable_metadata, id: false do |t|
  t.integer :singleton, primary_key: true
  t.text :next_id, null: false            # pi stores it as text: ids may exceed 2^53 in principle
  t.bigint :next_seq, null: false
end
create_table :durable_agent_record_ids, id: false do |t|
  t.bigint :id, primary_key: true, default: nil
  t.text :record_type, null: false        # conversation | entry | task | submission | document
end
create_table :durable_agent_conversations, id: false do |t|
  t.bigint :id, primary_key: true, default: nil
  t.bigint :owner_conversation_id
  t.bigint :owner_task_id
  t.text :record, null: false             # ConversationRecord JSON: {id, parent?: {conversationId, at}, owner?, ...}
  t.index [ :owner_conversation_id, :id ], name: "durable_agent_conversations_by_owner_conversation"
  t.index [ :owner_task_id, :id ], name: "durable_agent_conversations_by_owner_task"
end
create_table :durable_agent_entries, id: false do |t|
  t.bigint :id, primary_key: true, default: nil
  t.bigint :conversation_id, null: false
  t.bigint :head
  t.bigint :commit_seq, null: false
  t.text :record, null: false             # EntryRecord JSON: {id, conversationId, kind, data?, model?, head?, byTaskId?}
  t.index [ :conversation_id, :id ], order: { id: :desc }, name: "durable_agent_entries_by_conversation"
  t.index [ :conversation_id, :id ], order: { id: :desc }, name: "durable_agent_entry_heads_by_conversation", where: "head IS NOT NULL"
end
create_table :durable_agent_tasks, id: false do |t|
  t.bigint :id, primary_key: true, default: nil
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
create_table :durable_agent_submissions, id: false do |t|
  t.bigint :id, primary_key: true, default: nil
  t.bigint :conversation_id, null: false
  t.text :request_id                      # JSON-encoded string, e.g. "\"42\""; NULL when the harness made it
  t.text :status, null: false             # queued | placed | done | unanswered
  t.text :record, null: false             # SubmissionRecord JSON: {id, conversationId, requestId?, type, status, entry?, answer?, reason?, detail?}
  t.index [ :conversation_id, :request_id ], name: "durable_agent_submissions_by_request"
  t.index [ :conversation_id, :id ], name: "durable_agent_submissions_by_conversation"
  t.index [ :status, :id ], name: "durable_agent_submissions_by_status"
end
create_table :durable_agent_documents, id: false do |t|
  t.bigint :id, primary_key: true, default: nil
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
sidecar's tests; a Ruby test keeps their table and column names in step with the migration.

## Sidecar

### Storage layer (`sidecar/src`)

- `db/index.ts`: `type Dialect = "postgres" | "sqlite"`; `interface Db extends SqliteDatabase { readonly dialect }`
  (`SqliteDatabase` is pi-durable's facade: `exec`, `run`, `get`, `all`, `transaction`, `close`, `?`
  placeholders); `openDatabase(url)` picks the adapter by scheme (`postgres:`/`postgresql:`, `sqlite:`/`sqlite3:`).
- `db/sqlite.ts`: pi-durable's `openNodeSqliteDatabase` (WAL, `synchronous = NORMAL`, 5 s busy timeout, the
  same settings Rails 8 uses, so Puma and the sidecar share one file).
- `db/postgres.ts`: `PostgresDatabase` over a `pg.Pool` (max 2). `int8` is parsed to a JS number (ids and seqs
  are safe integers; `next_id` is text). Every operation runs through one serial queue, as pi-durable's node
  adapter does: a `transaction` checks out a client, `BEGIN`s, runs the callback on an executor bound to that
  client, then `COMMIT`s or `ROLLBACK`s and rethrows; everything else waits. Outside a transaction a
  connection-class error (`ECONNRESET`, `57P01`, `08*`) is retried once, because pi-durable treats a storage error
  as fatal to the session. Connections run with `TimeZone=UTC` so `CURRENT_TIMESTAMP` matches Rails' timestamp
  columns. The pool logs idle-client errors.
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
  `readSchemaVersion`, `readHarnessSchemaVersion`, `SCHEMA_VERSION = 2`.
- `credentials.ts`: `DbCredentialStore(db, token)`, pi-ai's `CredentialStore` over the facade. Each credential is
  stored as `{"enc": 1, "type", "iv", "tag", "data"}`: AES-256-GCM with the provider id as associated data,
  keyed by HKDF-SHA256(token, salt `durable_agent_credentials`, info `v1`). `type` stays clear for `GET /auth`.
  Dumps and replicas hold ciphertext; the sidecar holds the key, so anyone with the database and the token can
  decrypt; Rails never decrypts. Rotating the token makes stored sign-ins unreadable: the sidecar logs a warning
  per provider and treats them as absent until the user signs in again. Plaintext rows are rewritten encrypted on
  the next modify. Modifications to one provider are serialized.
- `reports.ts`: `createReporter(db, events)` stores Harness reports (faulted tasks, hook errors, a failed session)
  with `RETURNING id` and `CURRENT_TIMESTAMP`, then `events.report(id)`. pi-durable 1.3.0 calls `onReport(error)`
  with one argument; the `info` of newer releases is read when present.

SQL in `settings.ts`, `credentials.ts` and `reports.ts` is written once in the SQLite dialect and translated on
Postgres like the core's.

### Documents are stored as bases (`documents.ts`)

pi-durable stores a document as a base revision plus chord deltas and checkpoints a new base only when the
document's definition says so (`pi.live`: when idle; `pi.inbox`: when empty). Rails would have to replay chord
deltas to read a streaming `pi.live`. `withBaseDocuments(inner)` wraps `commit(writes)`: for each
`document.change` carrying a delta whose document has `history: "latest"` (every `pi.*` document Rails reads:
live, inbox, usage, provider; `pi.agent` is `rewindable` but always checkpoints) it reads
`inner.document(id, "current")`, applies the ops with `apply` from `@earendil-works/chord/delta` on a structured
clone, and replaces the write with `{kind: "base", version, value}`. The storage core deletes the previous
revisions of a `latest` document on a base, so such a document always has exactly one revision row. Commits
through the wrapper are serialized so the read and the commit cannot interleave. Deltas on `rewindable`
documents pass through. The Harness sees the same value and version either way.

The rule Rails relies on: **the current value of a document is the content of its newest `base` revision, and no
`delta` follows it for any document Rails reads.** If one does, `DurableAgent::Document#value` raises
`DurableAgent::Document::HistoryNotSupported`.

### Change events (`events.ts`)

`ChangeTracker` wraps `commit(writes)` too: after `inner.commit` resolves it collects the conversation ids
touched: `conversation` writes, `entry` and `submission` writes (`value.conversationId`),
`document.create`/`document.copy` with a conversation scope, and `document.change`/`document.retire` through a
read-through cache from document id to conversation id (filled by creates and by the base-rewrite read; a miss
reads `inner.document`; retirements are resolved before the commit). `task` writes are ignored.

`Events` debounces for 100 ms (a steady stream still posts every 100 ms) and does
`POST {RAILS_URL}/durable_agent/events` with the bearer token and `{"conversations": [7, 9], "reports": [3]}`.
A non-2xx or network error is retried once after 1 s, then logged at `warn` and dropped: events are a hint, the
state is in the database, and the next event or page load shows it. Unset `DURABLE_AGENT_RAILS_URL` disables
events with one boot log line. `flush()` is awaited on shutdown, after the Harness has closed.

### Boot and shutdown (`main.ts`)

Open the database from `DATABASE_URL` → record the gem schema version → credential store and models → device
id → logins → Harness over `ChangeTracker(withBaseDocuments(openHarnessStorage(db)))` → ensure the root
conversation → `resume()` → load tools in the background → serve. A missing table anywhere in that sequence is
reported as `MissingSchema` and the process exits 1. Shutdown: stop the server, dispose logins, close the
Harness (which commits nothing new and closes the database), flush events, exit 0. Unhandled rejections are
logged, not fatal.

### HTTP API v1 (`server.ts`)

JSON bodies, `Authorization: Bearer <token>` on everything except `/health`, compared in constant time. Unknown
routes 404.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | | `200 {ok: true, schemaVersion: 2, harnessSchemaVersion: 1, database: "postgres" \| "sqlite", model: {provider, modelId}}` |
| POST | `/conversations` | `{model?: {provider, modelId}, instructions?}` | `201 {id}`; `422 {error, suggestions: [ids]}` for an unknown model |
| POST | `/conversations/:id/submissions` | `{content, request_id, when_busy?: "followUp" \| "steer" \| "reject"}` | `202 {id, status}`; `404`; `409 {error: "conversation_busy"}` |
| POST | `/conversations/:id/abort` | | `200 {ok: true}` |
| GET | `/auth` | | `200 {"<provider>": {type: "oauth" \| "api_key"} \| null, ...}` |
| POST | `/auth/:provider/logins` | | `201 <login>`; `422 <login>` when it failed at once |
| GET | `/auth/:provider/logins/:id` | | `200 <login>`; `404` |
| POST | `/auth/:provider/logins/:id/callback` | `{url}` (the redirect URL the browser ended on) | `200 <login>` |
| DELETE | `/auth/:provider/logins/:id` | | `200 <login>` (cancelled) |
| DELETE | `/auth/:provider` | | `200 {ok: true}` (sign out) |
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
| `DATABASE_URL` | the app's primary database: `postgres://…` (plus `?host=` for a socket directory and `?sslmode=` when `database.yml` sets it) or `sqlite:///absolute/path/to/development.sqlite3` | rendered from `database.yml` |
| `DURABLE_AGENT_TOKEN` | shared bearer secret | `DurableAgent.config.token` |
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
   At boot a failed fetch is retried in the background with backoff (500 ms doubling to 10 s) for up to 60 s,
   because `bin/dev` starts node before Puma listens; then it logs a warning and runs with no tools until the
   next reload. A successful reload ends the retry early.
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
`DurableAgent.config.token`, returns 404 for an unknown tool, 422 `{error}` for any `StandardError` raised by
`call` (message included), and sets `DurableAgent::Current.conversation_id` / `call_id` during the call.

## Events endpoint

`POST /durable_agent/events` (engine route `events#create`), same bearer check as tools. Body
`{"conversations": [ids], "reports": [ids]}`. For each conversation that exists, `config.on_change.call(conversation)`;
for each report, `config.on_report.call(report)`. Unknown ids are skipped. Callback errors go to
`Rails.error.report` and never fail the request. Responds 204.

## Ruby API

```ruby
DurableAgent.configure do |config|
  config.model = "openai/gpt-6.1-sol"       # "provider/modelId"; default DURABLE_AGENT_MODEL
  config.tools = [ LookupInvoice ]
  config.url = "http://127.0.0.1:4010"      # the sidecar; built from host and port
  config.host, config.port                  # defaults DURABLE_AGENT_HOST / DURABLE_AGENT_PORT, then 127.0.0.1:4010
  config.rails_url = "http://127.0.0.1:3000" # default DURABLE_AGENT_RAILS_URL
  config.token = "..."                      # default below
  config.workspace_root, config.agent_name
  config.on_change = ->(conversation) { ... }   # default: Turbo::StreamsChannel.broadcast_refresh_to(conversation)
  config.on_report = ->(report) { ... }         # default: refresh broadcast to report.conversation when present
end

DurableAgent.start(model: nil, instructions: nil)   # => DurableAgent::Conversation (created on the sidecar, then found)
DurableAgent.conversation(id)
DurableAgent.auth                                   # => {"openai" => {"type" => "oauth"}, "anthropic" => nil}

conversation.say("Hello", request_id: message.id, when_busy: nil)   # => DurableAgent::Submission (persisted)
conversation.abort
conversation.transcript                              # Array of visible entries, oldest first
conversation.entries / submissions / tasks / reports / documents
conversation.document("pi.live") / live / busy? / streaming_message / running_tools / inbox / last_failure
conversation.parent / parent_at                      # from record["parent"]: the parent Conversation and the Entry it forked at

DurableAgent::Connection.new("openai").connected? / subscription? / unreachable? / error / start_login / login(id) / complete_login(id, url) / cancel_login(id) / disconnect
```

Models in `app/models/durable_agent/`, all `readonly?`, all over the tables above, inheriting
`DurableAgent::ApplicationRecord` and the `HarnessRecord` concern (table name prefix, read-only):

- `Conversation`: `attribute :record, :json`; `top_level` scope is `owner_conversation_id: nil`;
  `has_many :entries / :submissions / :tasks / :reports` on `conversation_id` (own rows only; a forked
  conversation's inherited entries are not followed); `documents` is `Document.current.where(scope_kind:
  "conversation", owner_id: id)`; `document(kind)` returns that document's `value` or `{}`. `say` returns
  `submissions.find(response["id"])`. `last_failure` is the newest `unanswered` submission whose `entry_id` is
  greater than the id of the newest `pi.assistant` entry, or any unanswered one when there is no answer yet.
- `Entry`: `attribute :record, :json`; `kind`, `data`, `model`, `head`, `by_task_id` come from the record (there
  are no such columns). Scopes `chronologically` / `reverse_chronologically` on id. `HIDDEN_KINDS =
  %w[pi.system pi.reset]`, `visible?`, `user?`, `assistant?`, `tool_result?`, `compaction?`, `messages`, `text`,
  `tool_calls`, `thinking?`, `tool_name`, `error?`. Kind filtering happens in Ruby: `Entry.visible` and
  `Entry.of_kind(*kinds)` return arrays and work on relations.
- `Submission`: `attribute :record, :json`; the `request_id` column is the JSON-encoded string, so
  `Submission.for_request(id)` encodes with `to_json`; `type`, `entry_id`, `answer_entry_id`, `reason`, `detail`,
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
  halves agree with zero setup. Production with none of these raises at boot of either half. A blank token raises
  `MissingToken` rather than being compared.
- `DurableAgent::MessageText` extracts text, tool calls and thinking from pi messages (string content or blocks
  of `{type: "text" | "thinking" | "toolCall"}`).
- `DurableAgent::Client` wraps Net::HTTP. Errors: `DurableAgent::Error` (status, body), `Busy` (409),
  `UnknownModel` (422 on conversations, carries `suggestions`), `Unavailable` (connection refused / timeout).
- `DurableAgent::Sidecar.env` builds the environment table; `.database_url` renders the primary `database.yml`
  entry (`sqlite3` → `sqlite:///<absolute path>`, relative paths resolved against `Rails.root`; `postgresql` →
  `postgres://user:pass@host:port/db` plus `?host=` and `?sslmode=`; an explicit `url` passes through; other
  adapters raise `ArgumentError`); `.command` returns `["node", <dist/sidecar.js, or src/main.ts from a
  checkout>]`; `.exec` replaces the process.
- Rake task: `durable_agent:sidecar`. `rake build` bundles the sidecar before packaging the gem.
- Generator `durable_agent:install`: copies the migration, writes `config/initializers/durable_agent.rb` with
  commented production notes for excluding `/durable_agent` from `force_ssl`'s redirect and from `config.hosts`
  (the sidecar calls Rails over plain loopback HTTP), mounts the engine, adds `sidecar: bin/rails
  durable_agent:sidecar` to `Procfile.dev` (creating it with `web:` and `sidecar:` otherwise), and prints what it
  did and how to set a production token.
- The app brings its own database adapter gem (`pg` or `sqlite3`); the gem depends on `rails` and `turbo-rails`.

## Tests

Both suites run on both databases.

- Ruby: Minitest with the dummy app. `test/dummy/config/database.yml` selects the adapter from
  `DURABLE_AGENT_DB` (`sqlite`, the default, files under `test/dummy/storage/`; `postgres` with
  `durable_agent_development` / `durable_agent_test`). `rake test` runs on SQLite, `rake test:postgres` on
  Postgres, `rake test:all` both. Fixtures use ids ≥ 900000 and `record` JSON in pi-durable's shapes. Covered:
  the models (document values on a base and on a base followed by a delta, the JSON-encoded columns, transcript,
  `last_failure`, `busy?`), client errors, the tools and events controllers, configuration (environment
  defaults, blank token), `Sidecar.database_url` on both adapters, the generator, the migration against the
  sidecar's SQL files, and one round trip that boots the real sidecar on `faux/faux-1` against the test database
  when `node` is available. Cross-process reads use `ActiveRecord::Base.uncached`.
- TypeScript: `node --test`. `test/helpers.ts` opens the database from `DURABLE_AGENT_TEST_DATABASE_URL`
  (default a fresh SQLite file in a temp dir) and applies the matching schema file. `npm test` runs on SQLite,
  `npm run test:postgres` on Postgres. Covered: pi-durable's storage conformance cases against
  `openHarnessStorage`, the translator (including pi-durable's own migration DDL), the Postgres queue and retry,
  storage open (missing schema, seeding, version refusal, a Harness on faux), the base-document wrapper (unit
  cases and a streaming `pi.live` that is only ever one base row equal to `watch.value.docs["pi.live"]`), the
  change tracker and events against a fake Rails, credentials, settings, reports, the model check, the HTTP API,
  and the tools protocol with its boot retry.

## Conventions

- Ruby in 37signals style: fat models, thin controllers, concerns, no service objects, Minitest, fixtures.
- TypeScript: strict, ESM, `.ts` imports, Node 22.19+ (type stripping), runnable from source without a build.
- Do not commit from an agent; the orchestrator commits.
- Out of scope today: per-user credentials, more than one sidecar, compaction/reset/task-graph routes, any UI,
  MCP, a Ruby port of chord deltas, following forked conversations' inherited entries.
