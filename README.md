# durable_agent

Crash-safe, resumable AI agent conversations for Rails.

durable_agent packages [pi-durable](https://github.com/earendil-works/pi), a durable agent runtime written in
TypeScript, as one gem: a Rails engine plus the sidecar process that runs the agents. pi-durable keeps its state
in your app's own database, Postgres or SQLite, in tables your migration creates. The sidecar is their only
writer; your app reads conversations with plain Active Record and gets live updates over Turbo. Tools are Ruby
classes.

```
browser ◀─Turbo── Puma ──HTTP commands─────────────────▶ sidecar (node)
                   │   ◀──GET/POST /durable_agent/tools──   │
                   │   ◀──POST /durable_agent/events─────   │
                   │ reads                                  │ writes
                   ▼                                        ▼
                  your database (Postgres or SQLite), durable_agent_* tables
```

Status: v1. `DESIGN.md` is the contract both halves are built against.

## Requirements

- Rails 8, with Postgres or SQLite (the app brings its own `pg` or `sqlite3` gem; durable_agent depends on neither)
- Node 22.19 or newer on the machine that runs the sidecar

## Install

```sh
bundle add durable_agent
bin/rails generate durable_agent:install
bin/rails db:migrate
```

The generator:

- copies `db/migrate/*_create_durable_agent_tables.rb` (twelve `durable_agent_*` tables, the same on either database),
- writes `config/initializers/durable_agent.rb`,
- mounts the engine: `mount DurableAgent::Engine => "/durable_agent"`,
- adds a `sidecar:` line to `Procfile.dev` (creating it with `web: bin/rails server -p 3000` and `sidecar:` if
  needed; the sidecar calls Rails at port 3000 by default, and foreman would otherwise run Puma on 5000),
- prints how to set a production token.

## Use

```ruby
conversation = DurableAgent.start                       # or start(model: "anthropic/claude-x", instructions: "Be brief")
chat.update!(durable_agent_conversation_id: conversation.id)

conversation.say("Summarize invoice INV-1042", request_id: message.id)
conversation.say("Actually, only the total", request_id: other.id, when_busy: :steer)   # :followUp, :steer, :reject
conversation.abort

conversation.transcript      # visible entries, oldest first (an Array)
conversation.busy?           # a run is in progress
conversation.streaming_message
conversation.running_tools
conversation.inbox
conversation.last_failure    # the newest unanswered input, with #explanation
```

`say` is idempotent on `request_id`: retrying with the same id returns the same submission. It returns the
`DurableAgent::Submission` row, which the sidecar commits before it answers. Find it later with
`conversation.submissions.for_request(id)`. `start`, `say` and `abort` clear the query cache, so `busy?`,
`transcript` and friends read the sidecar's commit within the same request.

`DurableAgent.start` cannot take part in your transaction: the sidecar commits the conversation on its own
connection before it answers. If saving your own record fails afterwards, the conversation stays behind,
unreferenced. It is harmless, and you can find such leftovers by comparing `DurableAgent::Conversation.top_level`
with your own references.

`DurableAgent::Conversation.top_level` lists conversations no task owns, without the root conversation the sidecar
creates at boot (id 1, `DurableAgent::Conversation.root`). Conversations, entries and submissions carry
`created_at`; `conversation.last_activity_at` is the newest entry's, or the conversation's own.

Every entry has `kind` (`pi.user`, `pi.assistant`, `pi.tool-result`, ...), `text`, `tool_calls`, `tool_name` and
`error?`. In a view, subscribe to the conversation and the default `on_change` callback refreshes the page
whenever the sidecar commits a change to it:

```erb
<%= turbo_stream_from @chat.conversation %>
<% @chat.conversation.transcript.each do |entry| %>
  <p class="<%= entry.kind %>"><%= entry.text %></p>
<% end %>
```

Add `<meta name="turbo-refresh-method" content="morph">` for smooth refreshes.

### Errors

All inherit from `DurableAgent::Error` (`status`, `body`):

- `DurableAgent::Busy`: 409, the conversation is running and the submission used `when_busy: :reject`.
- `DurableAgent::UnknownModel`: the model id is not one pi knows; `suggestions` lists close matches.
- `DurableAgent::Unavailable`: the sidecar is not running, timed out, went away mid-response, or is still starting.

### Provider sign-in

Sign-ins (including OAuth refresh tokens) are stored in your app's database, in
`durable_agent_credentials`, encrypted by the sidecar with AES-256-GCM under a key derived from the shared
`DURABLE_AGENT_TOKEN`. Database dumps, replicas and read-only database users see ciphertext. Rails has no model for
the table and never decrypts it. This is not a vault: the sidecar process holds the key, and anyone with both the
database and the token can decrypt. API keys work through `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, read from the environment rather
than this table; subscriptions sign in with OAuth:

```ruby
DurableAgent.auth
# => {"openai" => {"type" => "oauth", "source" => "OAuth"},
#     "anthropic" => {"type" => "api_key", "source" => "ANTHROPIC_API_KEY"},
#     "google" => nil, ...}

connection = DurableAgent::Connection.new("openai")
connection.connected? / connection.subscription? / connection.unreachable?
login = connection.start_login                  # => {"id" => ..., "status" => "awaiting_browser", "url" => ...}
connection.complete_login(login["id"], url_the_browser_ended_on)
connection.login(login["id"])                   # poll status
connection.cancel_login(login["id"])
connection.disconnect
```

`DurableAgent.auth` lists every provider the sidecar's pi-ai knows, signed in or not (`nil`), plus `faux`, the
offline model. `type` is `"oauth"` or `"api_key"`; `source` says where pi-ai found it (`"OAuth"`,
`"stored credential"`, or the environment variable). `Connection` covers OpenAI and Anthropic, and tolerates an
unreachable sidecar: it reads as not connected with `error` set.

When a sign-in completes or a provider signs out, the sidecar posts an auth event and `config.on_auth` runs. Its
default refreshes pages subscribed to `"durable_agent:auth"`, so a settings page updates by itself:

```erb
<%= turbo_stream_from "durable_agent:auth" %>
```

## Tools

```ruby
# app/tools/lookup_invoice.rb
class LookupInvoice < DurableAgent::Tool
  description "Fetch one invoice by number"
  param :number, :string, "Invoice number like INV-1042"          # required by default
  param :include_lines, :boolean, "Include line items", required: false
  param :currency, :string, required: false, enum: %w[ EUR USD ] # extra JSON Schema keywords pass through
  replay :safe                                                    # default :unsafe

  def call(number:, include_lines: false)
    invoice = Invoice.find_by!(number:)
    invoice.as_json(include: include_lines ? :lines : nil)
  end
end
```

```ruby
DurableAgent.configure { |config| config.tools = %w[ LookupInvoice ] }
```

Give tool names as strings (classes work too); names are resolved on every request so code reloading keeps
working. Param types are `:string`, `:integer`, `:number`, `:boolean`, `:array`, `:object`. The tool name is the
underscored class name without its namespace (`lookup_invoice`); override with `tool_name "other"`.

`replay :safe` lets pi run the tool again if the sidecar crashed mid-call. Leave tools that change the world
`:unsafe`.

At boot (and on `DurableAgent.client.reload_tools`) the sidecar fetches `GET /durable_agent/tools`. Each call is a
`POST /durable_agent/tools/:name`, authenticated with the shared token. Inside `call`,
`DurableAgent::Current.conversation_id` and `.call_id` say who asked. Return a string or anything JSON
serialisable.

Errors become an error result the model sees. Unknown or missing arguments (`ArgumentError`),
`ActiveRecord::RecordNotFound` and `DurableAgent::Tool::Error` carry their message; raise the last to tell the model
what went wrong:

```ruby
raise DurableAgent::Tool::Error, "Invoices before 2020 are archived; ask for a newer one"
```

Any other exception reaches the model only as `"<ErrorClass> while running <tool>"` and is reported to
`Rails.error` in full, so messages carrying SQL, paths or secrets stay in your app.

## Configuration

```ruby
DurableAgent.configure do |config|
  config.model = "openai/gpt-6.1-sol"      # "provider/modelId"; "faux/faux-1" is a scripted offline model
  config.tools = %w[ LookupInvoice ]
  config.host = "127.0.0.1"                # sidecar bind address
  config.port = 4010
  config.url = "http://127.0.0.1:4010"     # where Rails reaches the sidecar; defaults to host and port
  config.rails_url = "http://127.0.0.1:3000"  # where the sidecar reaches Rails for tools and change events
  config.token = "..."
  config.workspace_root = "storage/durable_agent"
  config.agent_name = "MyApp"              # shown on provider consent screens
  config.parent_record_class = "ApplicationRecord"  # default "ActiveRecord::Base"
  config.on_change = ->(conversation) { ... }
  config.on_report = ->(report) { ... }
  config.on_auth = ->(providers) { ... }
end
```

Every setting the sidecar also reads defaults to its `DURABLE_AGENT_*` variable (`MODEL`, `HOST`, `PORT`,
`RAILS_URL`, `TOKEN`, `WORKSPACE_ROOT`, `NAME`), so `DURABLE_AGENT_MODEL=faux/faux-1 bin/dev` moves both
processes. A value set in the initializer wins over the variable, which is why the generated initializer leaves
`config.model` commented out.

A conversation pins the model it was started with (`DurableAgent.start(model:)`, else the default) and keeps it
when the default changes; `conversation.model` reads it. The faux model is registered on every sidecar, so
conversations from a `faux/faux-1` session still answer after the switch to a real provider.

If your `ApplicationRecord` uses `connects_to` (roles, shards), set `config.parent_record_class =
"ApplicationRecord"` in the initializer, so the durable_agent models inherit it and follow role switching.

The token is read from `credentials.durable_agent.token`, then `ENV["DURABLE_AGENT_TOKEN"]`. In development and
test it falls back to a value derived from `secret_key_base`, so both processes agree with no setup. In
production a missing or blank token raises where it is used (starting the sidecar, the engine's endpoints, the
client), not at boot, so `db:migrate` and `console` work without one.

The token is also the key for stored provider sign-ins (see [Provider sign-in](#provider-sign-in)). Rotating it, or
moving from the development fallback to a real token, makes the stored sign-ins unreadable: the sidecar logs a
warning per provider, treats them as signed out, and users must sign in again.

```sh
bin/rails credentials:edit
# durable_agent:
#   token: <output of `bin/rails secret`>
```

## Running the processes

```
web: bin/rails server -p 3000
sidecar: bin/rails durable_agent:sidecar
```

`durable_agent:sidecar` derives the sidecar's whole environment from Rails (`DurableAgent::Sidecar.env`):
`DATABASE_URL` from the primary database in `database.yml` (`postgres://…` with `sslmode`, `sslrootcert`,
`sslcert`, `sslkey` and `schema_search_path` carried over, or `sqlite:///absolute/path`), the token, bind address, Rails URL, model and agent name, and passes
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` through. It then replaces itself with `node sidecar/dist/sidecar.js` (or
the TypeScript source when no bundle is built). Run exactly one sidecar per app.

The sidecar refuses to boot until the tables exist ("run bin/rails db:migrate"). An unknown default model is
logged and the sidecar keeps running. Missing provider credentials are not an error: inputs settle as
unanswered with reason `no_model` until someone signs in.

SQLite suits development, test and single-host production: both processes open the same file (WAL, 5 s busy
timeout, as Rails 8 configures it). Use Postgres when the web and sidecar processes run on different hosts.

`sslmode=require` means "encrypt, but do not verify the certificate" to libpq (and Rails), while node-postgres
reads it as full verification and would refuse the self-signed certificates many hosted databases use. The
sidecar is therefore given `sslmode=no-verify`, node-postgres' name for the same thing, whether `require` comes
from `database.yml` or from `DATABASE_URL`. `verify-ca` and `verify-full` pass through and verify, against
`sslrootcert` when you set it.

### Production

The sidecar calls Rails over plain HTTP at `rails_url` (loopback by default). If you use `config.force_ssl`,
keep `/durable_agent` out of the HTTPS redirect; if you set `config.hosts`, allow the sidecar's host. In
`config/environments/production.rb`:

```ruby
config.ssl_options = { redirect: { exclude: ->(request) { request.path.start_with?("/durable_agent") } } }
config.hosts << "127.0.0.1"
```

## How it works

pi-durable's storage lives in your database. The sidecar runs pi-durable's own storage core over these tables,
so there is one copy of the state and nothing to keep in sync:

| Table | Holds | Model |
|---|---|---|
| `durable_agent_conversations` | one row per conversation, including ones tools created (`owner_conversation_id`) | `Conversation` |
| `durable_agent_entries` | the immutable transcript | `Entry` |
| `durable_agent_tasks` | durable work: runs, tool calls, compactions | `Task` |
| `durable_agent_submissions` | every input Rails sent, from queued to done or unanswered | `Submission` |
| `durable_agent_documents`, `_document_revisions` | conversation documents (`pi.live`, `pi.inbox`, `pi.agent`, ...) | `Document`, `Document::Revision` |
| `durable_agent_record_ids`, `_durable_schema`, `_durable_metadata` | pi-durable's bookkeeping | |
| `durable_agent_reports` | faults the harness reported | `Report` |
| `durable_agent_credentials` | provider sign-ins, encrypted; Rails has no model for it | |
| `durable_agent_settings` | `device_id`, `schema_version` | |

Rails owns the schema: the migration creates every table and the sidecar never runs DDL. The sidecar owns the
rows: every model is read-only, and a write from Rails would bypass the harness. Ids are pi's own. Records keep
pi-durable's shapes as JSON text (`record`, `content`, `info`), and a few indexed columns are JSON-encoded
strings (`kind`, `request_id`, `key_value`); the models decode them, and scopes such as `for_request` and
`of_kind` encode their arguments. Kind filtering on entries (`visible`, `of_kind`) happens in Ruby and returns
arrays. On boot the sidecar re-attaches every conversation and re-awaits unsettled submissions, so a crash loses
nothing that was committed.

pi-durable stores a document as a base revision plus deltas. The sidecar folds every delta into a new base
before it commits, so **a document's current value is the content of its newest base revision**, which is what
`Document#value` and `conversation.document(kind)` read. A document whose newest revision is a delta (a
rewindable document that does not checkpoint) raises `DurableAgent::Document::HistoryNotSupported`; none of the
`pi.*` documents Rails reads do.

After each commit the sidecar posts the ids it touched to `POST /durable_agent/events`
(`{"conversations": [7], "reports": [3], "auth": ["openai"]}`), authenticated with `Authorization: Bearer
<token>`. Puma calls `config.on_change(conversation)` and `config.on_report(report)` for each id that exists, and
`config.on_auth(providers)` when sign-ins changed. The defaults broadcast Turbo refreshes: `on_change` to the
conversation; `on_report` to the report's conversation, or to the `"durable_agent:reports"` stream when it has
none (an operator page can `turbo_stream_from "durable_agent:reports"`); `on_auth` to `"durable_agent:auth"`.
Replace them to broadcast your own partials or to notify other systems. Callback errors go to `Rails.error` and never fail the request. Because the broadcast
happens inside Puma, the default `async` cable adapter works in development. Events are a hint, debounced and
retried once: the state is already in the database, and the next event or page load shows anything a dropped
event missed.

## Testing your app

durable_agent ships test support. In `test/test_helper.rb`:

```ruby
require "durable_agent/test_helper"

class ActiveSupport::TestCase
  include DurableAgent::TestHelper
end
```

`fake_sidecar` answers `create_conversation`, `submit` and `abort` the way the sidecar does: it commits the
conversation or the queued submission row first, then answers with its id, so `DurableAgent.start` and
`conversation.say` find their rows inside the test's transaction. Submissions are idempotent on `request_id`, and
an unknown conversation raises the sidecar's 404. `stub_sidecar` replaces any client call with a value, a
callable or an exception; both record calls in `sidecar_calls`.

```ruby
test "sending a message" do
  fake_sidecar(auth: CONNECTED)              # CONNECTED / DISCONNECTED are sample DurableAgent.auth answers

  chat = Chat.create!                        # your code calls DurableAgent.start
  chat.conversation.say("Hi", request_id: 1)

  assert_equal 1, sidecar_calls(:submit).size
  assert chat.conversation.submissions.for_request(1).sole.pending?
end

test "the sidecar is down" do
  stub_sidecar(submit: DurableAgent::Unavailable)
  # ...
end
```

Rows for the harness tables can also come from fixtures under `test/fixtures/durable_agent/`. Use
`DurableAgent::IndexedString.encode` for the JSON-encoded columns (`kind`, `key_value`, `request_id`).

## Limits of v1

- One sidecar per app, one set of provider credentials for the whole app (no per-user credentials).
- No compaction, reset or task-graph routes; no SSE event stream; no usage endpoint.
- A forked conversation's inherited entries are not followed: `entries` are its own.
- No UI: the engine only serves the tool and event endpoints the sidecar calls.
- No MCP. Tools are Ruby classes only.
- The workspace root is reserved for built-in tools and unused.

## Development

```sh
(cd sidecar && npm install)        # enables the round-trip test
bin/rails test                     # SQLite (test/dummy/storage/test.sqlite3)
DURABLE_AGENT_DB=postgres bin/rails db:create
DURABLE_AGENT_DB=postgres bin/rails test   # Postgres: durable_agent_test
bundle exec rake test:all          # both
```

The round-trip test boots the real sidecar on `faux/faux-1` against the test database; it skips when
`sidecar/node_modules` is missing or `node` is not on the PATH.

Package the gem with `bundle exec rake build` (or `rake release`): it bundles the sidecar into
`sidecar/dist/sidecar.js`, which is not checked in, before packaging. A bare `gem build` refuses to run without
the bundle. Changes go in `CHANGELOG.md` under Unreleased.

## License

MIT
