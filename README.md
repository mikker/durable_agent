# Slopdep

A small chat app on top of [durable_agent](../durable_agent): crash-safe, resumable agent conversations run by the
pi-durable sidecar, rendered by Rails with Phlex views and Nitro Kit 2 components.

- `Chat` holds a title and a `durable_agent_conversation_id`. Everything else (transcript, streaming answer, running
  tools, failures) is read from the `durable_agent_*` tables, which only the sidecar writes.
- Sending a message is `chat.conversation.say(content, request_id: SecureRandom.uuid)`; Stop is `conversation.abort`.
- Pages update live without polling: the chat page subscribes with `turbo_stream_from chat.conversation`, the
  sidecar posts a change event to `POST /durable_agent/events` after every commit, and the gem's default `on_change`
  broadcasts a Turbo refresh that morphs the page (`turbo_refreshes_with method: :morph, scroll: :preserve`).
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
`storage/development.sqlite3`. If the sidecar is not running, pages say so instead of failing.

## Signing in with ChatGPT

Settings (`/settings/chatgpt_connection`) shows whether the sidecar holds a ChatGPT sign-in. Sign in with ChatGPT
starts the OAuth flow and shows a link to open. When the browser runs on the same machine as the sidecar, its
redirect to `127.0.0.1:1455` completes the sign-in by itself and the page notices; otherwise paste the address the
browser ended on into Redirect URL. The sidecar stores the credential, encrypted, in `durable_agent_credentials`
and refreshes it. Disconnect signs out.

`bin/rails chatgpt:import` copies the sign-in from the previous version of this app (the `agent_credentials` table
in the Postgres database `slopdep_development`, read only) so you do not have to sign in again.

## The model

`config.model` in `config/initializers/durable_agent.rb` picks the model, as `provider/modelId`; the default is
`openai/gpt-6.1-sol` on the ChatGPT sign-in. `DURABLE_AGENT_MODEL` overrides it, and `faux/faux-1` is a scripted
offline model:

```sh
DURABLE_AGENT_MODEL=faux/faux-1 bin/dev
```

## Tests

```sh
bin/rails test
```

Controller and model tests stub `DurableAgent.client` (`test/support/sidecar_stubs.rb`, copied from the gem) and
read fixture rows in `test/fixtures/durable_agent` (ids from 900000, pi-durable's record shapes).
