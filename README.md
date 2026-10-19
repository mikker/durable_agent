# durable_agent

Crash-safe, resumable AI agent conversations for Rails.

durable_agent packages [pi-durable](https://github.com/earendil-works/pi), a durable agent runtime written in
TypeScript, as one gem: a Rails engine plus the sidecar process that runs the agents. The sidecar owns agent
state and writes every committed frame into tables in your own Postgres, so your app reads conversations with
plain Active Record and gets live updates over Turbo. Tools are Ruby classes.

```
 Rails ──HTTP commands──▶ sidecar (node) ──writes──▶ durable_agent_* tables ──NOTIFY──▶ relay ──Turbo──▶ browser
   ▲                         │
   └──── tool calls ─────────┘
```

Status: v0. `DESIGN.md` is the contract both halves are built against.

## Requirements

- Rails 8, Postgres
- Node 22.19 or newer on the machine that runs the sidecar

## Install

```sh
bundle add durable_agent
bin/rails generate durable_agent:install
bin/rails db:migrate
```

The generator:

- copies `db/migrate/*_create_durable_agent_tables.rb` (seven `durable_agent_*` tables),
- writes `config/initializers/durable_agent.rb`,
- mounts the engine: `mount DurableAgent::Engine => "/durable_agent"`,
- adds `sidecar:` and `relay:` lines to `Procfile.dev` (creating it if needed),
- prints how to set a production token.

## Use

```ruby
conversation = DurableAgent.start                       # or start(model: "anthropic/claude-x", instructions: "Be brief")
chat.update!(durable_agent_conversation_id: conversation.id)

conversation.say("Summarize invoice INV-1042", request_id: message.id)
conversation.say("Actually, only the total", request_id: other.id, when_busy: :steer)   # :followUp, :steer, :reject
conversation.abort

conversation.transcript      # visible entries, oldest first
conversation.busy?           # a run is in progress
conversation.streaming_message
conversation.running_tools
conversation.inbox
conversation.last_failure    # the newest unanswered input, with #explanation
```

`say` is idempotent on `request_id`: retrying with the same id returns the same submission. It returns a
`DurableAgent::Submission`; when the mirror has not written the row yet it is an unsaved record carrying the id and
status the sidecar answered with.

Every entry has `kind` (`pi.user`, `pi.assistant`, `pi.tool-result`, ...), `text`, `tool_calls`, `tool_name` and
`error?`. In a view, subscribe to the conversation and the default relay callback refreshes the page as the
mirror changes:

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
- `DurableAgent::Unavailable`: the sidecar is not running or timed out.

### Provider sign-in

Sign-ins (including OAuth refresh tokens) are stored in your app's Postgres database, in
`durable_agent_credentials`, encrypted by the sidecar with AES-256-GCM under a key derived from the shared
`DURABLE_AGENT_TOKEN`. Database dumps, replicas and read-only database users see ciphertext. Rails has no model for
the table and never decrypts it. This is not a vault: the sidecar process holds the key, and anyone with both the
database and the token can decrypt. API keys work through `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, read from the environment rather
than this table; subscriptions sign in with OAuth:

```ruby
DurableAgent.auth                               # => {"openai" => {"type" => "oauth"}, "anthropic" => nil}

connection = DurableAgent::Connection.new("openai")
connection.connected? / connection.subscription? / connection.unreachable?
login = connection.start_login                  # => {"id" => ..., "status" => "awaiting_browser", "url" => ...}
connection.complete_login(login["id"], url_the_browser_ended_on)
connection.login(login["id"])                   # poll status
connection.cancel_login(login["id"])
connection.disconnect
```

`Connection` tolerates an unreachable sidecar: it reads as not connected with `error` set.

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
serialisable. Unknown or missing arguments, `ActiveRecord::RecordNotFound`, and any other error become an error
result the model sees, with the exception message.

## Configuration

```ruby
DurableAgent.configure do |config|
  config.model = "openai/gpt-6.1-sol"      # "provider/modelId"; "faux/faux-1" is a scripted offline model
  config.tools = %w[ LookupInvoice ]
  config.host = "127.0.0.1"                # sidecar bind address
  config.port = 4010
  config.url = "http://127.0.0.1:4010"     # where Rails reaches the sidecar; defaults to host and port
  config.rails_url = "http://127.0.0.1:3000"  # where the sidecar reaches Rails for tools
  config.token = "..."
  config.storage_path = "storage/durable_agent.sqlite"
  config.workspace_root = "storage/durable_agent"
  config.agent_name = "MyApp"              # shown on provider consent screens
  config.mirror_docs = "all"               # or %w[ pi.live pi.inbox ]
  config.on_mirror = ->(conversation, entries:, docs:, submission:) { ... }
  config.on_report = ->(report) { ... }
end
```

The token is read from `credentials.durable_agent.token`, then `ENV["DURABLE_AGENT_TOKEN"]`. In development and
test it falls back to a value derived from `secret_key_base`, so both processes agree with no setup. In
production, booting without one raises.

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
web: bin/rails server
sidecar: bin/rails durable_agent:sidecar
relay: bin/rails durable_agent:relay
```

`durable_agent:sidecar` derives the sidecar's whole environment from Rails (`DurableAgent::Sidecar.env`):
`DATABASE_URL` from `database.yml`, the token, bind address, Rails URL, model, storage paths, agent name, mirrored
documents, and passes `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` through. It then replaces itself with
`node sidecar/dist/sidecar.js` (or the TypeScript source when no bundle is built).

The sidecar keeps its harness in a SQLite file (`storage_path`): put it on a persistent volume. Run exactly one
sidecar and one relay.

An unknown default model is logged and the sidecar keeps running. Missing provider credentials are not an error:
inputs settle as unanswered with reason `no_model` until someone signs in.

## How the mirror works

The sidecar is the only writer of agent state. After each committed frame it writes the mirror tables in your
database and raises `NOTIFY durable_agent_mirror`:

| Table | Holds |
|---|---|
| `durable_agent_conversations` | one row per conversation, including ones tools created (`owner_conversation_id`) |
| `durable_agent_entries` | the immutable transcript, inserted once |
| `durable_agent_documents` | current value of each conversation document (`pi.live`, `pi.inbox`, `pi.agent`, ...) |
| `durable_agent_submissions` | every input Rails sent, from queued to done or unanswered |
| `durable_agent_reports` | faults the harness reported (also `NOTIFY durable_agent_reports`) |
| `durable_agent_credentials` | provider sign-ins, encrypted with a key derived from the token; Rails has no model for it |
| `durable_agent_settings` | `device_id`, `schema_version` |

IDs are pi's own, so the mirror models (`DurableAgent::Conversation`, `Entry`, `Document`, `Submission`, `Report`)
are read-only: a Rails write would be overwritten by the next frame. On boot the sidecar re-attaches every
conversation and re-awaits unsettled submissions, so a crash loses nothing that was committed.

The relay LISTENs on both channels and calls `config.on_mirror(conversation, entries:, docs:, submission:)` and
`config.on_report(report)`. Both default to `Turbo::StreamsChannel.broadcast_refresh_to(conversation)`. Replace
them to broadcast your own partials or to notify other systems.

The relay holds one database connection of its own. When no notification arrives for 30 seconds it sends a
heartbeat (`SELECT 1`), so a silently dropped connection is noticed. On any connection failure it reports the
error to `Rails.error`, discards the connection, and reconnects with backoff (1 s doubling to 30 s). Postgres does
not queue a NOTIFY for a listener that is gone, so after reconnecting the relay calls `on_mirror` once for every
conversation updated since it last heard from the database, with `entries: []`, `docs: []` and `submission: nil`.
A custom `on_mirror` must accept such a frame; the default only needs the conversation. Reports raised during an
outage are not replayed. The relay does not work through a transaction-pooling PgBouncer, which drops LISTEN.

Broadcasts come from the relay process, not from Puma, so Action Cable's `async` adapter (the Rails default for
development in `config/cable.yml`) cannot deliver them: it only reaches subscribers in its own process. Use
`solid_cable` or `redis` in development as well as production.

## Limits of v0

- One sidecar per app, one set of provider credentials for the whole app (no per-user credentials).
- No compaction, reset or task-graph routes; no SSE event stream; no usage endpoint.
- No UI: the engine only serves the tool endpoints the sidecar calls.
- No MCP. Tools are Ruby classes only.
- The workspace root is reserved for built-in tools and unused.

## Development

```sh
bin/rails db:create db:migrate     # dummy app on Postgres: durable_agent_development / durable_agent_test
(cd sidecar && npm install)        # enables the round-trip test
bin/rails test
```

The round-trip test boots the real sidecar on `faux/faux-1` against the test database; it skips when
`sidecar/node_modules` is missing.

## License

MIT
