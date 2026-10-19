# Slopdep

A small chat app on top of [durable_agent](../durable_agent): crash-safe, resumable agent conversations run by the
pi-durable sidecar, rendered by Rails with Phlex views and Nitro Kit 2 components.

- `Chat` holds a title and a `durable_agent_conversation_id`. Everything else (transcript, streaming answer, running
  tools, failures) is read from the `durable_agent_*` tables, which only the sidecar writes.
- Sending a message is `chat.conversation.say(content, request_id: SecureRandom.uuid)`; Stop is `conversation.abort`.
- Pages update live without polling: the chat page subscribes with `turbo_stream_from chat.conversation`, the
  sidecar posts a change event to `POST /durable_agent/events` after every commit, and the gem's default `on_change`
  broadcasts a Turbo refresh that morphs the page (`turbo_refreshes_with method: :morph, scroll: :preserve`).
- The chats list orders by `conversation.last_activity_at` (the newest entry's `created_at`, else the
  conversation's).
- `app/tools/current_time.rb` is an example Ruby tool, registered in `config/initializers/durable_agent.rb`.

The gem is referenced by path, `gem "durable_agent", path: "../durable_agent"`, so this checkout expects
`durable_agent` next to it.

## Running

Needs Ruby 4, Node 22.19+ (for the sidecar) and SQLite.

```sh
bin/setup --skip-server
bin/dev
```

`bin/dev` runs `Procfile.dev`: Puma on port 3000, the Tailwind watcher, and the sidecar
(`bin/rails durable_agent:sidecar`, listening on 127.0.0.1:4010). Open http://localhost:3000. Both processes share
`storage/development.sqlite3`. If the sidecar is not running, pages say so instead of failing; while it boots,
commands answer "The agent sidecar is starting".

`db/migrate/*_create_durable_agent_tables.rb` is the gem's `durable_agent:install` template. To take a newer
template, delete it, rerun `bin/rails g durable_agent:install` (keep the existing initializer), delete
`db/schema.rb` (on an empty database Rails 8.1's `db:migrate` loads the old schema instead of migrating), then
`bin/rails db:drop db:create db:migrate` and `bin/rails chatgpt:import`.

## Signing in with ChatGPT

Settings (`/settings/chatgpt_connection`) shows whether the sidecar holds a ChatGPT sign-in, and the model and
tools the sidecar runs (from its `/health`). Sign in with ChatGPT starts the OAuth flow and shows a link to open.
When the browser runs on the same machine as the sidecar, its redirect to `127.0.0.1:1455` completes the sign-in by
itself; otherwise paste the address the browser ended on into Redirect URL. The page subscribes with
`turbo_stream_from "durable_agent:auth"`: when a sign-in completes or a provider signs out, the sidecar posts an
auth event and the gem's default `on_auth` refreshes it. The sidecar stores the credential, encrypted, in `durable_agent_credentials`
and refreshes it. Disconnect signs out.

`bin/rails chatgpt:import` copies the sign-in from the previous version of this app (the `agent_credentials` table
in the Postgres database `slopdep_development`, read only) so you do not have to sign in again.

## The model

The model is `provider/modelId`. `config.model` is left commented out in `config/initializers/durable_agent.rb`,
so it is `DURABLE_AGENT_MODEL` if set, else `openai/gpt-6.1-sol` on the ChatGPT sign-in, in both processes.
`faux/faux-1` is a scripted offline model:

```sh
DURABLE_AGENT_MODEL=faux/faux-1 bin/dev
```

## Tests

```sh
bin/rails test
```

Tests include the gem's `DurableAgent::TestHelper`: `fake_sidecar` answers `create_conversation`, `submit` and
`abort` after committing the rows the sidecar would (ids from 950001), `stub_sidecar` replaces any other client call,
and `sidecar_calls` records them. Pages read a small set of fixture rows in `test/fixtures/durable_agent` (ids from
900000, pi-durable's record shapes). `record` and `content` are JSON text (`value.to_json.to_json` in the YAML: a
YAML Hash would be stored as YAML), and `kind`, `key_value` and `request_id` use `DurableAgent::IndexedString.encode`.
