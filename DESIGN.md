# durable_agent — v0 design and contract

pi-durable (a durable agent runtime in TypeScript) packaged as one Rails gem. The gem contains a Rails engine
and the sidecar process that runs the agents. Apps install one gem, run one migration, and start one extra
process. `docs/design.html` is the illustrated version of this document; this file is the normative contract
that the Ruby side and the TypeScript side are both implemented against.

Reference implementation to port from (read it, do not copy blindly): `/Users/mikker/dev/slopdep`
(`sidecar/src`, `sidecar/test`, `rails/app/models/agent`, `rails/lib/agent`, `rails/test`).

## Names

| Thing | Name |
|---|---|
| Gem / module | `durable_agent` / `DurableAgent`, isolated engine mounted at `/durable_agent` |
| Tables | `durable_agent_conversations`, `_entries`, `_documents`, `_submissions`, `_reports`, `_credentials`, `_settings` |
| NOTIFY channels | `durable_agent_mirror`, `durable_agent_reports` |
| Schema version | row `schema_version = "1"` in `durable_agent_settings`; `GET /health` reports it |
| Sidecar | `sidecar/` (TypeScript source), bundled to `sidecar/dist/sidecar.js`, shipped in the gem |
| Env prefix | `DURABLE_AGENT_*` |

## Runtime shape

- The sidecar is the only writer of agent state and the only owner of its SQLite harness file.
- Rails sends commands to the sidecar over HTTP and reads agent state from the mirror tables in its own Postgres.
- The sidecar writes every committed frame into the mirror tables and raises `NOTIFY durable_agent_mirror`.
- The gem's relay process LISTENs and calls an app-configurable callback; the default broadcasts a Turbo
  refresh to the conversation's stream.
- The sidecar calls back into Rails for two things only: fetching tool definitions and running a tool.

## Sidecar HTTP API v1

JSON bodies, `Authorization: Bearer <token>` on everything except `/health`. Unknown routes 404.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | | `200 {ok: true, schemaVersion: 1, model: {provider, modelId}}` |
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

Submissions are idempotent on `request_id`: the same id returns the same submission.

Nothing else from the reference sidecar (compact, reset, configure, SSE events, task graph, usage) is in v0.

## Sidecar environment

Provided by `bin/rails durable_agent:sidecar`, which derives every value from Rails configuration.

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | the app's primary Postgres | from `database.yml` |
| `DURABLE_AGENT_TOKEN` | shared bearer secret | `DurableAgent.config.token` |
| `DURABLE_AGENT_HOST`, `DURABLE_AGENT_PORT` | bind address | `127.0.0.1`, `4010` |
| `DURABLE_AGENT_RAILS_URL` | where Rails answers `/durable_agent/tools` | `http://127.0.0.1:3000` |
| `DURABLE_AGENT_MODEL` | default model as `provider/modelId`; `faux/faux-1` runs the scripted offline model | `openai/gpt-6.1-sol` |
| `DURABLE_AGENT_STORAGE_PATH` | SQLite harness file | `storage/durable_agent.sqlite` |
| `DURABLE_AGENT_WORKSPACE_ROOT` | cwd for built-in tools (unused in v0, keep the knob) | `storage/durable_agent` |
| `DURABLE_AGENT_NAME` | agent name shown on provider consent screens | the Rails application name |
| `DURABLE_AGENT_MIRROR_DOCS` | `all` or a comma list of document kinds | `all` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | pass-through | |

Behaviour: an unknown default model logs an error at boot and the sidecar keeps running (conversation creation
then returns 422). Missing provider credentials are not an error at boot; runs settle `unanswered` with reason
`no_model` until someone signs in.

## Mirror schema v1

Written only by the sidecar. `sidecar/sql/schema.sql` and the Rails migration template must describe the same
tables. IDs are pi's own integer ids.

```sql
durable_agent_conversations (id bigint pk, parent_conversation_id bigint, parent_at_entry_id bigint,
  owner_conversation_id bigint, owner_task_id bigint, created_at timestamptz, updated_at timestamptz)
durable_agent_entries (id bigint pk, conversation_id bigint fk, kind text, data jsonb, model jsonb,
  head_entry_id bigint, by_task_id bigint, created_at timestamptz)            -- immutable, insert once
durable_agent_documents (conversation_id bigint fk, kind text, body jsonb, updated_at; pk (conversation_id, kind))
durable_agent_submissions (id bigint pk, conversation_id fk, request_id text, type text, status text,
  entry_id bigint, answer_entry_id bigint, reason text, detail jsonb, created_at, updated_at)
durable_agent_reports (id bigserial pk, type text, conversation_id bigint, task_id bigint, task_kind text,
  extension text, message text, info jsonb, created_at)
durable_agent_credentials (provider_id text pk, credential jsonb, updated_at)   -- encrypted envelope; Rails has no model
durable_agent_settings (key text pk, value text, updated_at)                   -- device_id, schema_version
```

NOTIFY payloads:

```
durable_agent_mirror   {"conversationId": 7, "entries": [18, 19], "docs": ["pi.live"]}
durable_agent_mirror   {"conversationId": 7, "submission": {"id": 19, "status": "done"}}
durable_agent_reports  {"id": 3, "type": "task_faulted", "conversationId": 7, "taskId": 12, "message": "..."}
```

Mirror semantics (as in the reference): entries inserted with ON CONFLICT DO NOTHING; documents upserted when
their JSON changes; submissions inserted when made and updated when settled; unsettled submissions re-awaited
on boot; every conversation in storage re-attached on boot; conversations created by tools picked up through
the Harness `conversationCreated` hook. Postgres failures converge without agent activity: an attach registers the
conversation only after its row, first frame and watch are in place, so a failed attach leaves nothing behind and
is retried (the HTTP caller sees the error; hook-driven attaches retry with backoff, capped at 30 s). A failed
frame write resets the in-memory bookkeeping and marks the conversation dirty; a failed settlement write is
remembered. A reconcile pass every 5 s rewrites the whole current view of each dirty conversation and re-reads
each remembered settlement from the Harness. On boot, every `durable_agent_submissions` row still `queued` or
`placed` is looked up in the Harness and written once it is settled there (an id the Harness no longer knows is
logged and left). The sidecar logs, rather than dies on, unhandled rejections and idle pg client errors.

## Tools protocol

Tools are Ruby classes. The sidecar is generic.

1. At boot and on `POST /tools/reload`, the sidecar does `GET {RAILS_URL}/durable_agent/tools` with the bearer
   token and expects `200 [{name, description, parameters: <JSON Schema object>, replay: "safe" | "unsafe"}]`.
   If `DURABLE_AGENT_RAILS_URL` is unset or the request fails, it logs a warning and runs with no tools.
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
token against `DurableAgent.config.token`, returns 404 for an unknown tool, 422 `{error}` for `ArgumentError`
or `ActiveRecord::RecordNotFound` or any `StandardError` raised by `call` (message included), and sets
`DurableAgent::Current.conversation_id` / `call_id` during the call.

## Ruby API

```ruby
DurableAgent.configure do |config|
  config.model = "openai/gpt-6.1-sol"       # "provider/modelId"
  config.tools = [ LookupInvoice ]
  config.url = "http://127.0.0.1:4010"      # sidecar
  config.rails_url = "http://127.0.0.1:3000"
  config.token = "..."                      # default below
  config.port, config.host, config.storage_path, config.workspace_root, config.agent_name, config.mirror_docs
  config.on_mirror = ->(conversation, entries:, docs:, submission:) { ... }   # default: refresh broadcast
  config.on_report = ->(report) { ... }                                       # default: refresh broadcast
end

DurableAgent.start(model: nil, instructions: nil)   # => DurableAgent::Conversation (created on the sidecar, then found)
DurableAgent.conversation(id)
DurableAgent.auth                                   # => {"openai" => {"type" => "oauth"}, "anthropic" => nil}

conversation.say("Hello", request_id: message.id, when_busy: nil)   # => DurableAgent::Submission (inserted row may lag; returns a struct/record by id)
conversation.abort
conversation.transcript / entries / documents / submissions / reports
conversation.document("pi.live") / live / busy? / streaming_message / running_tools / inbox / last_failure

DurableAgent::Connection.new("openai").connected? / subscription? / unreachable? / error / start_login / login(id) / complete_login(id, url) / cancel_login(id) / disconnect
```

- Token default: `Rails.application.credentials.dig(:durable_agent, :token)`, then `ENV["DURABLE_AGENT_TOKEN"]`,
  then in development and test a value derived from `secret_key_base` (so both halves agree with zero setup).
  Production with none of these raises at boot of either half.
- Credentials at rest: the sidecar stores each credential as `{"enc": 1, "type", "iv", "tag", "data"}`, AES-256-GCM
  with the provider id as associated data, keyed by HKDF-SHA256(token, salt "durable_agent_credentials", info "v1").
  `type` stays clear for `GET /auth`. Dumps and replicas hold ciphertext; the sidecar holds the key, so anyone with
  the database and the token can decrypt. Rails never decrypts. Rotating the token makes stored sign-ins unreadable:
  the sidecar logs a warning per provider and treats them as absent until the user signs in again. Plaintext rows
  from before encryption are read and rewritten encrypted on the next modify.
- Mirror models are read-only (`readonly?` true). `DurableAgent::Entry::HIDDEN_KINDS = %w[pi.system pi.reset]`;
  `transcript` = visible entries chronologically. `DurableAgent::MessageText` extracts text/tool calls from pi
  messages (string content or blocks of `{type: "text"|"thinking"|"toolCall"}`).
- `DurableAgent::Client` wraps Net::HTTP. Errors: `DurableAgent::Error` (status, body), `Busy` (409),
  `UnknownModel` (422 on conversations, carries `suggestions`), `Unavailable` (connection refused / timeout).
- `DurableAgent::Relay#run` does the LISTEN loop on a raw connection it checks out (and never returns to the
  pool) and dispatches to `config.on_mirror` / `config.on_report`. It waits 30 s at a time, heartbeats with
  `SELECT 1` after a quiet wait, and on any connection error discards the connection and reconnects with backoff
  (1 s doubling to 30 s, reset after a successful LISTEN). After a reconnect it calls `on_mirror` with empty
  `entries:`/`docs:` and `submission: nil` for every conversation updated since the last contact, since NOTIFYs
  sent during the outage are lost. `#stop` ends the loop; pool, wait, sleeper and clock are injectable for tests.
  Default callbacks: `Turbo::StreamsChannel.broadcast_refresh_to(conversation)`, which needs a cross-process
  Action Cable adapter (solid_cable or redis, not `async`) because the relay is its own process.
- `DurableAgent::Sidecar.env` builds the hash above; `.command` returns `["node", <path to dist/sidecar.js>]`
  (the single place to swap for a compiled binary later); `.exec` replaces the process.
- Rake tasks: `durable_agent:sidecar`, `durable_agent:relay`.
- Generator `durable_agent:install`: copies the migration, writes `config/initializers/durable_agent.rb`,
  mounts the engine in `config/routes.rb`, appends `sidecar:` and `relay:` lines to `Procfile.dev` when it
  exists (creates it otherwise), prints what it did and how to set a production token.

## Tests

- Ruby: Minitest with the dummy app on Postgres (`durable_agent_test`), fixtures for mirror tables with high
  ids (≥ 900000) so the real sidecar never collides. Cover models, client errors, the tools controller
  (auth, 404, 422, success, Current attributes), the relay dispatch with `Turbo::Broadcastable::TestHelper`,
  the generator, and one round-trip integration test that boots the real sidecar on `faux/faux-1` against the
  test database when `node` is available (skip otherwise). Poll the mirror with `ActiveRecord::Base.uncached`.
- TypeScript: `node --test` suites for the credential store, the mirror round-trip (in-process Harness on the
  faux model against a dedicated Postgres database), the model id check, and the tools protocol (fake Rails
  server in the test).

## Conventions

- Ruby in 37signals style: fat models, thin controllers, concerns, no service objects, Minitest, fixtures.
- TypeScript: strict, ESM, `.ts` imports, Node 22.19+ (type stripping), no build step to run from source.
- Do not commit; the orchestrator commits.
- Out of v0: per-user credentials, more than one sidecar, compaction/reset/task-graph routes, any UI, MCP.
