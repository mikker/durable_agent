# durable_agent — v1 design and contract (one database)

pi-durable (a durable agent runtime in TypeScript) packaged as one Rails gem. The gem contains a Rails engine
and the sidecar process that runs the agents. Apps install one gem, run one migration, and start one extra
process. `docs/design.html` is the illustrated version of this document; this file is the normative contract
that the Ruby side and the TypeScript side are both implemented against.

v1 replaces v0's mirror. In v0 the sidecar kept pi-durable's state in its own SQLite file and copied it into
Postgres for Rails, which was the source of every serious review finding (`docs/reviews/`). In v1 pi-durable's
storage lives **in the app's database**, Postgres or SQLite, through a storage adapter in the sidecar. There is
one copy of the state, Rails reads pi-durable's own tables, and nothing has to converge. The relay process and
`LISTEN/NOTIFY` are gone; the sidecar tells Rails about changes over HTTP.

## Names

| Thing | Name |
|---|---|
| Gem / module | `durable_agent` / `DurableAgent`, isolated engine mounted at `/durable_agent` |
| Harness tables (pi-durable's, prefixed) | `durable_agent_conversations`, `_entries`, `_tasks`, `_submissions`, `_documents`, `_document_revisions`, `_record_ids`, `_durable_schema`, `_durable_metadata` |
| Gem tables | `durable_agent_reports`, `_credentials`, `_settings` |
| Schema version | `durable_agent_durable_schema.version` is pi-durable's (1 for pi-durable 1.3.0); `durable_agent_settings` row `schema_version = "2"` is the gem's; `GET /health` reports both |
| Sidecar | `sidecar/` (TypeScript source), bundled to `sidecar/dist/sidecar.js`, shipped in the gem |
| Env prefix | `DURABLE_AGENT_*` |

## Runtime shape

```
browser ◀─Turbo─ Puma ◀─POST /durable_agent/events─ sidecar (node)
                  │                                     │
                  │ reads durable_agent_* tables         │ pi-durable Harness over a storage adapter
                  ▼                                     ▼
              the app's database (Postgres or SQLite) ◀─┘
                  ▲
                  └─ Rails ─HTTP commands─▶ sidecar; sidecar ─GET/POST /durable_agent/tools─▶ Rails
```

- The sidecar owns a pi-durable Harness whose `Storage` is pi-durable's portable SQLite storage core
  (`SqliteStorage` from `@earendil-works/pi-durable/storage/sqlite`) running over one of two database adapters:
  pi-durable's own `openNodeSqliteDatabase` for SQLite, or the gem's `PostgresDatabase` for Postgres. Both
  open the tables under the prefix `durable_agent_`.
- Rails owns the schema: the install migration creates every table on either adapter. The sidecar never runs
  DDL; it refuses to boot with a clear message when the tables are missing.
- The sidecar is the only writer of the harness tables and the gem tables. Rails models are read-only.
- Rails sends commands to the sidecar over HTTP. After each commit that touches a conversation, the sidecar
  posts a change event to Rails, which calls an app-configurable callback; the default broadcasts a Turbo
  refresh to the conversation's stream from inside Puma, so the stock `async` cable adapter works in development.
- The sidecar calls into Rails for three things: tool definitions, running a tool, and change events.
- One sidecar per app. SQLite is for development, test and single-host production; Postgres for everything else.

## Sidecar HTTP API v1

Unchanged from v0 except `/health`. JSON bodies, `Authorization: Bearer <token>` on everything except `/health`.
Unknown routes 404. The bearer comparison is constant-time.

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

Submissions are idempotent on `request_id`: the same id returns the same submission. The submission row is
committed before the 202 is sent, so Rails can `find` it at once.

## Sidecar environment

Provided by `bin/rails durable_agent:sidecar`, which derives every value from Rails configuration.

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | the app's primary database: `postgres://…` (with `?sslmode=…` when `database.yml` sets it) or `sqlite:///absolute/path/to/development.sqlite3` | from `database.yml` |
| `DURABLE_AGENT_TOKEN` | shared bearer secret | `DurableAgent.config.token` |
| `DURABLE_AGENT_HOST`, `DURABLE_AGENT_PORT` | bind address | `127.0.0.1`, `4010` |
| `DURABLE_AGENT_RAILS_URL` | where Rails answers `/durable_agent/tools` and `/durable_agent/events`; unset runs without tools or events | `http://127.0.0.1:3000` |
| `DURABLE_AGENT_MODEL` | default model as `provider/modelId`; `faux/faux-1` runs the scripted offline model | `openai/gpt-6.1-sol` |
| `DURABLE_AGENT_WORKSPACE_ROOT` | cwd for built-in tools (unused in v1, keep the knob) | `storage/durable_agent` |
| `DURABLE_AGENT_NAME` | agent name shown on provider consent screens | the Rails application name |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | pass-through | |

`DURABLE_AGENT_STORAGE_PATH` and `DURABLE_AGENT_MIRROR_DOCS` are gone.

Behaviour: an unknown default model logs an error at boot and the sidecar keeps running (conversation creation
then returns 422). Missing provider credentials are not an error at boot; runs settle `unanswered` with reason
`no_model` until someone signs in. Missing tables stop the boot with "run bin/rails db:migrate".

## Schema v2

Created by the install migration (`lib/generators/durable_agent/install/templates/create_durable_agent_tables.rb.tt`)
with adapter-neutral Rails DDL; the same file is copied verbatim into `test/dummy/db/migrate`. The first nine
tables are pi-durable 1.3.0's SQLite schema (`storage/sqlite/migrations.js`, version 1) rendered for Rails under
the `durable_agent_` prefix: same table names, column names, indexes and partial index, so pi-durable's storage
core runs over them unchanged. Differences from pi-durable's own DDL, all deliberate: no `STRICT`, no
`json_valid` checks, `record`/`content` are `text` (JSON text; never `jsonb`, which rejects `\u0000` and would
turn a model output into a fatal commit), integer ids are `bigint`.

```ruby
create_table :durable_agent_durable_schema, id: false do |t|
  t.integer :singleton, primary_key: true
  t.integer :version, null: false
end
create_table :durable_agent_durable_metadata, id: false do |t|
  t.integer :singleton, primary_key: true
  t.text :next_id, null: false            # pi stores it as text: ids can exceed 2^53 in principle
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
data; the sidecar seeds the two singleton rows at boot (below), so a database loaded from `schema.rb` works.

## Sidecar storage layer

Module layout in `sidecar/src`:

- `db/index.ts`: `export type Dialect = "postgres" | "sqlite"`; `export interface Db extends SqliteDatabase { readonly dialect: Dialect }`
  (`SqliteDatabase` is pi-durable's facade type: `exec`, `run`, `get`, `all`, `transaction`, `close`, with `?`
  placeholders); `export async function openDatabase(url: string): Promise<Db>` picks the adapter from the URL
  scheme (`postgres:`/`postgresql:` → Postgres, `sqlite:`/`sqlite3:` → SQLite).
- `db/sqlite.ts`: wraps `openNodeSqliteDatabase(path)` from `@earendil-works/pi-durable/storage/sqlite/node`
  (WAL, `synchronous = NORMAL`, 5 s busy timeout, same as Rails 8's defaults, so both processes share the file).
- `db/postgres.ts`: `PostgresDatabase implements Db` over a `pg.Pool` (max 2) whose type parsers return `int8` as
  a JS number (ids and seqs are safe integers; `next_id` is text anyway). All operations run through one serial
  queue, as pi-durable's node adapter does: a `transaction` checks out a client, runs `BEGIN`, executes the
  callback on an executor bound to that client, then `COMMIT`, or `ROLLBACK` and rethrow; every other operation
  waits until the transaction settles. Outside a transaction, one retry after a connection-class error
  (`ECONNRESET`, `57P01`, `08*`), because pi-durable treats a storage error as fatal to the session.
  `pool.on("error")` logs idle-client errors.
- `db/translate.ts`: turns the SQLite dialect the storage core speaks into Postgres: `?` → `$1, $2, …` (the core
  never puts `?` inside a literal), `INSERT OR IGNORE INTO …` → `INSERT INTO … ON CONFLICT DO NOTHING`, drop
  ` STRICT`, drop `CHECK (json_valid(x))`. `excluded.col`, `ON CONFLICT(id) DO UPDATE`, partial indexes and
  `LIMIT ?` are already valid Postgres. Translations are memoized by SQL text.
- `storage.ts`: `export async function openHarnessStorage(db: Db): Promise<Storage>`:
  1. checks that `durable_agent_conversations` exists (one `SELECT … LIMIT 0`) and otherwise throws
     `MissingSchema` with "run bin/rails db:migrate";
  2. seeds `durable_agent_durable_schema (singleton=1, version=CURRENT_SQLITE_SCHEMA_VERSION)` and
     `durable_agent_durable_metadata (singleton=1, next_id='2', next_seq=1)` with `ON CONFLICT DO NOTHING`;
  3. `SqliteStorage.open(db, { prefix: "durable_agent_" })`, which finds the version current and runs no DDL;
  4. returns the storage wrapped by `withBaseDocuments` (next section) and by `ChangeTracker` (events).
  A pi-durable release whose `CURRENT_SQLITE_SCHEMA_VERSION` is greater than the stored version is a gem
  upgrade: the gem ships a Rails migration for it and bumps the version row; the sidecar never migrates.
- `settings.ts`: `installationDeviceId(db)`, `recordSchemaVersion(db)` (`schema_version = "2"`, `DO NOTHING`),
  `readSchemaVersion(db)`; `GET /health` reports `schemaVersion` from the settings row and
  `harnessSchemaVersion` from `durable_agent_durable_schema`.
- `credentials.ts`: `DbCredentialStore(db, token)`, the v0 encrypted envelope unchanged, over the facade:
  `credential` is JSON text; `list()` selects every row and reads `type` from the envelope.
- `reports.ts`: inserts with `RETURNING id` (valid on both; SQLite ≥ 3.35) and `CURRENT_TIMESTAMP`, then hands
  the id to the events module.

SQL in `settings.ts`, `credentials.ts` and `reports.ts` is written once in the SQLite dialect (`?`,
`CURRENT_TIMESTAMP`, `ON CONFLICT (k) DO UPDATE SET …`) and goes through the same translation on Postgres.

### Documents are stored as bases

pi-durable stores a document as a base revision plus chord deltas, and checkpoints a new base only when the
document's definition says so (`pi.live`: when idle; `pi.inbox`: when empty). Rails would have to replay chord
deltas to read a streaming `pi.live`. Instead `withBaseDocuments(inner: Storage): Storage` intercepts
`commit(writes)`: for every `document.change` whose content is a `delta` and whose document has
`history: "latest"` (every `pi.*` document Rails reads: live, inbox, usage, provider; `pi.agent` is
`rewindable` but always checkpoints), it reads the current value with `inner.document(id, "current")`, applies
the ops with `apply` from `@earendil-works/chord/delta` on a structured clone, and replaces the write with
`{kind: "base", version, value}`. The storage core then deletes the previous revisions of a `latest` document, so
such a document always has exactly one revision row, a base. Commits through the wrapper are serialized so the
read and the commit cannot interleave. Deltas on `rewindable` documents pass through untouched. The wrapper is
contract-neutral for the Harness: `document()` returns the same value and version either way.

The rule Rails relies on: **the current value of a document is the content of its newest `base` revision; no
`delta` revision follows it for any document Rails reads.** If one does (a rewindable, non-checkpointing
document), `DurableAgent::Document#value` raises `DurableAgent::Document::HistoryNotSupported`.

### Change events

`ChangeTracker` wraps `commit(writes)` as well: after `inner.commit` resolves it collects the conversation ids
touched: `conversation` writes (the id), `entry` and `submission` writes (`value.conversationId`),
`document.create`/`document.copy` with a conversation scope (`record.scope.conversationId`), and
`document.change`/`document.retire` through a read-through cache id → conversation id (filled from creates and
from the base-rewrite read; a miss reads `inner.document(id, "current")`). `task` writes are ignored.

`events.ts`: `Events` debounces per process (100 ms, flushed at most every 100 ms while changes keep coming)
and does `POST {RAILS_URL}/durable_agent/events` with the bearer token and
`{"conversations": [7, 9], "reports": [3]}`. A non-2xx or network error is retried once after 1 s, then logged
at `warn` and dropped: events are a hint, the state is in the database, and the next event or page load shows
it. Unset `DURABLE_AGENT_RAILS_URL` disables events (logged once at boot). `events.flush()` is awaited on
shutdown.

## Tools protocol

Unchanged from v0, plus boot retry.

1. At boot and on `POST /tools/reload`, the sidecar does `GET {RAILS_URL}/durable_agent/tools` with the bearer
   token and expects `200 [{name, description, parameters: <JSON Schema object>, replay: "safe" | "unsafe"}]`.
   At boot a failed fetch is retried with backoff (500 ms doubling to 10 s) for up to 60 s in the background
   while the sidecar serves requests, because `bin/dev` starts node before Puma listens; after that it logs a
   warning and runs with no tools until `/tools/reload`. If `DURABLE_AGENT_RAILS_URL` is unset it runs with no tools.
2. Each definition becomes a pi-durable tool. Executing it does
   `POST {RAILS_URL}/durable_agent/tools/:name` with `{arguments, conversation_id, call_id}`.
   `200 {result}` → the tool output is `result` when it is a string, else `JSON.stringify(result)`.
   Any other status with `{error}` → an error result carrying the message. Network failure → error result.
   Timeout 120 s.

Ruby side:

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

`DurableAgent::Tool.tool_name` is the underscored class name (`lookup_invoice`). `to_definition` returns the
hash above. Param types: `:string`, `:integer`, `:number`, `:boolean`, `:array`, `:object`.
`DurableAgent::ToolsController` (engine routes `GET /tools`, `POST /tools/:name`) authenticates the bearer
token against `DurableAgent.config.token` (a blank configured token is rejected at boot, never compared),
returns 404 for an unknown tool, 422 `{error}` for `ArgumentError` or `ActiveRecord::RecordNotFound` or any
`StandardError` raised by `call` (message included), and sets `DurableAgent::Current.conversation_id` /
`call_id` during the call.

## Events endpoint

`POST /durable_agent/events` (engine route `events#create`), same bearer check as tools. Body
`{"conversations": [ids], "reports": [ids]}`. For each conversation id that exists, calls
`DurableAgent.config.on_change.call(conversation)`; for each report, `config.on_report.call(report)`. Ids that
do not exist are skipped. Callback errors are reported with `Rails.error.report` and do not fail the request.
Responds `204`.

## Ruby API

```ruby
DurableAgent.configure do |config|
  config.model = "openai/gpt-6.1-sol"       # "provider/modelId"
  config.tools = [ LookupInvoice ]
  config.url = "http://127.0.0.1:4010"      # sidecar
  config.rails_url = "http://127.0.0.1:3000"
  config.token = "..."                      # default below
  config.port, config.host, config.workspace_root, config.agent_name
  config.on_change = ->(conversation) { ... }   # default: Turbo::StreamsChannel.broadcast_refresh_to(conversation)
  config.on_report = ->(report) { ... }         # default: refresh broadcast to report.conversation when present
end

DurableAgent.start(model: nil, instructions: nil)   # => DurableAgent::Conversation (created on the sidecar, then found)
DurableAgent.conversation(id)
DurableAgent.auth                                   # => {"openai" => {"type" => "oauth"}, "anthropic" => nil}

conversation.say("Hello", request_id: message.id, when_busy: nil)   # => DurableAgent::Submission (the row exists)
conversation.abort
conversation.transcript                              # Array of visible entries, oldest first
conversation.entries / submissions / tasks / reports / documents
conversation.document("pi.live") / live / busy? / streaming_message / running_tools / inbox / last_failure
conversation.parent / parent_at                      # from record["parent"]

DurableAgent::Connection.new("openai").connected? / subscription? / unreachable? / error / start_login / login(id) / complete_login(id, url) / cancel_login(id) / disconnect
```

Models (`app/models/durable_agent/`), all `readonly?`, all over the harness tables, inheriting
`DurableAgent::ApplicationRecord`:

- `Conversation`: `attribute :record, :json`; `parent` / `parent_at` read `record["parent"]`; `top_level` scope
  is `owner_conversation_id: nil`; `has_many :entries/:submissions/:tasks/:reports` on `conversation_id` (own
  rows only; a forked conversation's inherited entries are not followed in v1); `documents` is
  `Document.where(scope_kind: "conversation", owner_id: id, retired_at: nil)`; `document(kind)` returns that
  document's `value` or `{}`. `say` returns `submissions.find(response["id"])`. `last_failure` is the newest
  `unanswered` submission whose `entry_id` is greater than the id of the newest `pi.assistant` entry (or any
  unanswered one when there is no answer yet).
- `Entry`: `attribute :record, :json`; `kind`, `data`, `model`, `head`, `by_task_id` read from the record (there
  are no such columns). Scopes `chronologically` / `reverse_chronologically` on id. `HIDDEN_KINDS`,
  `visible?`, `user?`, `assistant?`, `tool_result?`, `compaction?`, `messages`, `text`, `tool_calls`,
  `thinking?`, `tool_name`, `error?` as in v0. Kind filtering happens in Ruby: `Entry.visible` and
  `Entry.of_kind` are class methods that return arrays from a relation (`relation.select(&:visible?)`).
- `Submission`: `attribute :record, :json`; `request_id` column is the JSON-encoded string, so
  `Submission.for_request(id)` / `conversation.submissions.for_request(id)` encode with `to_json`; `type`,
  `entry_id` (`record["entry"]`), `answer_entry_id` (`record["answer"]`), `reason`, `detail` read from the
  record; `status` is a column: scopes `pending`, `settled`, `unanswered`; `explanation` and `REASONS` as in v0.
- `Task`: `attribute :record, :json`; `kind` decodes the JSON-encoded column; `status`, `abort_requested?`,
  `background?`.
- `Document`: columns as above; `kind` decodes the JSON column; `value` = parsed content of the newest `base`
  revision (`Revision.where(document_id: id, kind: "base").order(seq: :desc).first`), raising
  `HistoryNotSupported` when a `delta` revision has a greater seq; `has_many :revisions`.
- `Report`: `attribute :info, :json`; `belongs_to :conversation, optional: true`; `latest` scope.
- `Credential` and settings have no models.

Other Ruby:

- Token default: `Rails.application.credentials.dig(:durable_agent, :token)`, then `ENV["DURABLE_AGENT_TOKEN"]`,
  then in development and test a value derived from `secret_key_base`. Production with none of these raises at
  boot of either half. A configured blank token raises `MissingToken`.
- Credentials at rest: unchanged from v0 (AES-256-GCM envelope, HKDF from the token, provider id as associated
  data, legacy plaintext rows re-encrypted on modify, token rotation invalidates sign-ins).
- `DurableAgent::Client` wraps Net::HTTP. Errors: `DurableAgent::Error` (status, body), `Busy` (409),
  `UnknownModel` (422 on conversations, carries `suggestions`), `Unavailable` (connection refused / timeout).
- `DurableAgent::Sidecar.env` builds the environment table above; `.database_url` renders the primary
  `database.yml` entry: `sqlite3` → `sqlite:///<absolute path>`; `postgresql` → `postgres://user:pass@host:port/db`
  plus `?host=` for a socket directory and `?sslmode=` when set; an explicit `url` is passed through.
  `.command` returns `["node", <dist/sidecar.js or src/main.ts>]`; `.exec` replaces the process.
- `DurableAgent::EventsController` as above. `DurableAgent::Relay`, `on_mirror`, `mirror_docs`, `storage_path`
  and the `durable_agent:relay` task are removed.
- Rake task: `durable_agent:sidecar`.
- Generator `durable_agent:install`: copies the migration, writes `config/initializers/durable_agent.rb` (which
  also shows, commented, how to exclude `/durable_agent` from `force_ssl`'s redirect and from `config.hosts`
  in production, because the sidecar calls Rails over plain loopback HTTP), mounts the engine, appends a
  `sidecar:` line to `Procfile.dev` when it exists (creates it with `web:` and `sidecar:` otherwise), and prints
  what it did and how to set a production token. No relay line, no cable note.

## Tests

Both suites run on both databases.

- Ruby: Minitest with the dummy app. `test/dummy/config/database.yml` selects the adapter from
  `DURABLE_AGENT_DB` (`sqlite`, the default, with files under `test/dummy/storage/`; `postgres` with
  `durable_agent_development` / `durable_agent_test`). `rake test` runs the suite on SQLite; `rake test:postgres`
  on Postgres; `rake test:all` both. Fixtures for the harness tables use high ids (≥ 900000) and `record` JSON
  that matches pi-durable's shapes. Cover models (including `Document#value` on a base, on a base followed by a
  delta, and the JSON-encoded `kind` / `request_id` columns), client errors, the tools controller, the events
  controller (auth, unknown ids skipped, callbacks called, callback error reported), the generator, and one
  round-trip integration test that boots the real sidecar on `faux/faux-1` against the test database when `node`
  is available (skip otherwise). Poll across processes with `ActiveRecord::Base.uncached`.
- TypeScript: `node --test` suites. `test/helpers.ts` opens the database from `DURABLE_AGENT_TEST_DATABASE_URL`
  (default: a fresh SQLite file in a temp dir) and creates the schema from `sidecar/sql/schema.sqlite.sql` or
  `sidecar/sql/schema.postgres.sql` (SQL renderings of the migration, kept in step by a Ruby test that compares
  the table and column names the migration produces with the ones in these files). `npm test` runs on SQLite;
  `npm run test:postgres` sets the URL. Suites: pi-durable's storage conformance cases
  (`createStorageConformance` from `@earendil-works/pi-durable/testing` with assertions over `node:assert`)
  against `openHarnessStorage` on the current database; the translator; the base-document wrapper (a streaming
  `pi.live` through a real Harness on faux ends with one base revision whose value equals
  `watch.value.docs["pi.live"]`); the change tracker and events (fake Rails server records bodies; debounce;
  retry; disabled when unset); credentials; models check; tools protocol and the boot retry.

## Conventions

- Ruby in 37signals style: fat models, thin controllers, concerns, no service objects, Minitest, fixtures.
- TypeScript: strict, ESM, `.ts` imports, Node 22.19+ (type stripping), no build step to run from source.
- Do not commit; the orchestrator commits.
- Out of v1: per-user credentials, more than one sidecar, compaction/reset/task-graph routes, any UI, MCP, a
  Ruby port of chord deltas, following forked conversations' inherited entries.
