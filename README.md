# durable_agent

A durable AI agent runtime for Rails. [pi-durable](https://github.com/earendil-works/pi) runs as a sidecar
process shipped inside this gem; every committed frame of every conversation is mirrored into your Postgres;
the gem broadcasts over Turbo and lets you write tools in Ruby.

Status: v0, being built. See `DESIGN.md` for the contract and `docs/design.html` for the illustrated sketch.

```sh
bundle add durable_agent
bin/rails g durable_agent:install
bin/rails db:migrate
bin/dev   # web, sidecar, relay
```

```ruby
conversation = DurableAgent.start
conversation.say("Summarize the invoice", request_id: message.id)
conversation.transcript
```
