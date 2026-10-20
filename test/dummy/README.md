# Slopdep

The gem's dummy app and its example app in one: a small chat app on durable_agent, crash-safe, resumable agent
conversations run by the pi-durable sidecar, rendered by Rails with Phlex views and Nitro Kit 2 components. The
engine's tests run inside it, and its own tests (chats, settings, tools, the live page) are part of the gem's suite
under `test/`.

- `Chat` holds a title and a `durable_agent_conversation_id`. Everything else (transcript, streaming answer, running
  tools, failures) is read from the `durable_agent_*` tables, which only the sidecar writes.
- Sending a message is `chat.conversation.say(content, request_id: SecureRandom.uuid)`; Stop is `conversation.abort`.
- Pages update live without polling: the chat page subscribes with `turbo_stream_from chat.conversation`, the
  sidecar posts a change event to `POST /durable_agent/events` after every commit, and `Chat#broadcast_changes`
  (this app's `config.on_change`) sends one Turbo Stream message that morphs the transcript, the live answer and
  the composer in place.
- The chats list orders by `conversation.last_activity_at` (the newest entry's `created_at`, else the
  conversation's).
- `app/tools/` holds three example Ruby tools, registered in `config/initializers/durable_agent.rb`:
  `CurrentTime` (read-only, replay-safe), `SearchChats` (reads this app's records: chats by title or message text)
  and `RenameChat` (a side effect on the chat the model is answering in, found through
  `DurableAgent::Current.conversation_id`; not replay-safe, so an interrupted call is reported, never repeated).
  The sidecar fetches their definitions at boot and on `DurableAgent.client.reload_tools`; changing the list in
  the initializer needs a restart of both processes.

The app runs on the gem's Gemfile (`config/boot.rb` points at it), so its UI gems are the gem's development
dependencies.

## Running

Needs Ruby 4, Node 22.19+ (for the sidecar) and SQLite, from this directory:

```sh
cd test/dummy
bin/setup --skip-server
bin/dev
```

`bin/dev` runs `Procfile.dev`: Puma on port 3000, the Tailwind watcher, and the sidecar
(`bin/rails durable_agent:sidecar`, listening on 127.0.0.1:4010). Open http://localhost:3000. Both processes share
`storage/development.sqlite3`. If the sidecar is not running, pages say so instead of failing; while it boots,
commands answer "The agent sidecar is starting".

`db/migrate/*_create_durable_agent_tables.rb` is the gem's `durable_agent:install` template; the gem's schema test
keeps them equal. On an empty database Rails 8.1's `db:migrate` loads `db/schema.rb` instead of migrating, so a
schema change means regenerating that file too.

## Signing in with ChatGPT

Settings (`/settings/chatgpt_connection`) shows whether the sidecar holds a ChatGPT sign-in, and the model and
tools the sidecar runs (from its `/health`). Sign in with ChatGPT starts the OAuth flow and shows a link to open.
When the browser runs on the same machine as the sidecar, its redirect to `127.0.0.1:1455` completes the sign-in by
itself; otherwise paste the address the browser ended on into Redirect URL. The page subscribes with
`turbo_stream_from "durable_agent:auth"`: when a sign-in completes or a provider signs out, the sidecar posts an
auth event and the gem's default `on_auth` refreshes it. The sidecar stores the credential, encrypted, in `durable_agent_credentials`
and refreshes it. Disconnect signs out.

A credential shared with another installation dies as soon as the other side refreshes it (OpenAI rotates refresh
tokens), and the next message ends in a model error `invalid_grant`; the chat shows it with a link back to Settings.

## The model

The model is `provider/modelId`. `config.model` is left commented out in `config/initializers/durable_agent.rb`,
so it is `DURABLE_AGENT_MODEL` if set, else `openai/gpt-6.1-sol` on the ChatGPT sign-in, in both processes.
`faux/faux-1` is a scripted offline model:

```sh
DURABLE_AGENT_MODEL=faux/faux-1 bin/dev
```

## Tests

From the gem's root, `rake test` (SQLite) or `rake test:postgres`; both build this app's CSS first. The app's tests
use the gem's `DurableAgent::TestHelper`: `fake_sidecar` answers `create_conversation`, `submit` and `abort` after
committing the rows the sidecar would (ids from 950001), `stub_sidecar` replaces any other client call and seals
the rest, and `sidecar_calls` records them. Fixtures are the gem's, in `test/fixtures` (ids from 900000, pi-durable's
record shapes), plus `chats.yml`.
