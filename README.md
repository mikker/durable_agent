# durable_agent

Crash-safe, resumable AI agent conversations for Rails. The gem ships [pi-durable](https://github.com/earendil-works/pi-durable)
as a bundled sidecar process that keeps its state in your app's own database, Postgres or SQLite, which Rails reads
with Active Record. Tools are Ruby classes. Pages update over Turbo.

```sh
bundle add durable_agent
bin/rails g durable_agent:install   # migration, initializer, mount, Procfile.dev line
bin/rails db:migrate
bin/dev                             # web, sidecar
```

```ruby
conversation = DurableAgent.start
conversation.say("Summarize the invoice", request_id: message.id)
conversation.transcript
```

Early. The contract is in [DESIGN.md](DESIGN.md), the guide in [docs/guide.md](docs/guide.md), the example app in
[test/dummy](test/dummy). Needs Ruby 3.3+, Rails 8+, Node 22.19+.

MIT.
