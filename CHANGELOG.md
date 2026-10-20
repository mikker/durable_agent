# Changelog

## Unreleased

- First release: pi-durable as a bundled sidecar over the app's own database (Postgres or SQLite), read-only
  Active Record models, Ruby tools, Turbo refreshes on change, sign-in and auth events, and
  `DurableAgent::TestHelper` for apps' tests.
- The faux model is registered on every sidecar, so a conversation started on `faux/faux-1` keeps answering after
  `DURABLE_AGENT_MODEL` moves to a real provider. `Conversation#model` reads the pinned model, and a `no_model`
  submission's `explanation` names it.
