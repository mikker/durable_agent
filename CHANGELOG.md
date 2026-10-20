# Changelog

## Unreleased

- First release: pi-durable as a bundled sidecar over the app's own database (Postgres or SQLite), read-only
  Active Record models, Ruby tools, Turbo refreshes on change, sign-in and auth events, and
  `DurableAgent::TestHelper` for apps' tests.
- The faux model is registered on every sidecar, so a conversation started on `faux/faux-1` keeps answering after
  `DURABLE_AGENT_MODEL` moves to a real provider. `Conversation#model` reads the pinned model, and a `no_model`
  submission's `explanation` names it.
- `Entry` exposes what pi-ai recorded on a message: `model_ref`, `stop_reason`, `error_message`, `usage`,
  `total_tokens`, `cost`, `duration_ms`, `timestamp`; `failed?` marks an assistant entry that ended in an error or
  abort, and `Conversation#last_failure` no longer counts one as an answer. `Conversation#usage`, `usage_by_model`,
  `total_tokens` and `total_cost` read `pi.usage`. `model_error` and `run_failed` explanations carry pi-durable's
  detail, such as the provider's OAuth error.
- `stub_sidecar` seals the client: calls it was not given raise `DurableAgent::Unavailable` instead of reaching a
  sidecar that happens to be running.
