# Independent review by Claude Fable 5.1 (2026-10-19, HEAD fc3455a)

Both suites pass (`bin/rails test`: 63 runs, 0 failures, 0 skips, round-trip included; `npm test`: 16 pass; `tsc --noEmit` clean; `dist/sidecar.js` is newer than every `src/*.ts`). Paths are relative to the repo root.

## Confirmed findings (verified by reading the code path or by running something)

**C1. High — A Postgres error during a hook-driven attach crashes the sidecar.**
`sidecar/src/mirror.ts:75-84` (`enqueue` → `void attempt(20)` has no `.catch`), `sidecar/src/main.ts` (no `unhandledRejection` handler). Scenario: a tool creates a sub-conversation while Postgres hiccups; `#upsertConversation` rejects inside `attempt`, Node's default `--unhandled-rejections=throw` kills the process mid-run. Reproduced with a probe that failed one `INSERT INTO durable_agent_conversations`: the process exited with that stack.

**C2. High — A failed first write during attach permanently un-mirrors that conversation.**
`sidecar/src/mirror.ts:99-107`: `#attached.set(id, …)` happens before `#upsertConversation`, the seed SELECT and `watch.start`; `attach()` at `:87` returns early on `#attached.has(id)`. Scenario: Postgres is unavailable for one second while `POST /conversations` runs; Rails gets a 500, every later `attach` resolves instantly, the watch is never started. Probe result after one simulated failure then a full faux run: `conversationRows: 0, entriesMirroredAfterRun: 0`, `secondAttach: 'resolved'`. Invisible to Rails until the sidecar restarts.

**C3. High — A failed settlement write is never retried; the submission row stays `queued` forever.**
`sidecar/src/mirror.ts:126-134` (`.catch` only logs), `:63-67` (boot re-awaits only `inspect().submissions`, which pi-durable documents as "Queued and placed submissions"). Probe: one failed upsert → `mirrorStatus: 'queued', harnessStatus: 'done'`, unchanged after Postgres "returned"; a restart would not reconcile it either. Rails' `pending?`/`last_failure` lie permanently for that input.

**C4. Medium-High — Frame-write failures only heal on the next frame of the same conversation.**
`sidecar/src/mirror.ts:215-221`. Scenario: the final frame of a run (the assistant answer, `pi.live` losing `run`) fails to write; the conversation is finished so no further frame arrives; `busy?` stays true and the answer is missing until a restart or another `say`. No timer, no reconciliation pass.

**C5. Medium-High — Stock Rails production (`config.force_ssl = true`) breaks the tools callback.**
`sidecar/src/tools.ts:73,94,106` call `http://127.0.0.1:3000/durable_agent/tools…` (default `lib/durable_agent/configuration.rb:12`); Rails 7.1+/8 defaults `force_ssl = true`. `ActionDispatch::SSL` 301s the GET to `https://127.0.0.1/…` (connection refused) and turns tool POSTs into GETs; the sidecar logs "running with no tools" and every tool call becomes an error result. Nothing in README/generator mentions it.

**C6. Medium-High — `bin/dev` boots the sidecar with no tools almost every time.**
`sidecar/src/tools.ts:172-183`: `load()` tries Rails once at boot with no retry; foreman starts node (~300 ms) and Puma (seconds) together, so the fetch gets ECONNREFUSED. Users get a tool-less agent until they discover `DurableAgent.client.reload_tools`.

**C7. Medium — Default live updates do not work in development.**
`lib/durable_agent/configuration.rb:36-41` broadcasts via `Turbo::StreamsChannel` from the relay process; the stock Rails `config/cable.yml` uses `adapter: async`, which is in-process only. The README's `turbo_stream_from` example silently never refreshes in a fresh app. Needs solid_cable/redis in development and a sentence in the README/generator output.

**C8. Medium — Refresh storm while streaming.**
`sidecar/src/mirror.ts:175-212` NOTIFYs on every `pi.live` change (up to every 100 ms); `lib/durable_agent/relay.rb:46` calls `broadcast_refresh_to`, which in turbo-rails 2.0.23 is not debounced. Every subscribed browser does a full page GET+morph up to ~10×/s per streaming conversation. Debounce per conversation in the relay or skip `pi.live`-only frames by default.

**C9. Medium — The relay wedges silently or dies on any connection problem.**
`lib/durable_agent/relay.rb:16-28`: `wait_for_notify` with no timeout, no keepalive, no reconnect/re-LISTEN; only `handle` errors are rescued. A silently dropped idle TCP session → relay "runs" forever delivering nothing; a Postgres restart → process exits; PgBouncer transaction pooling → LISTEN never delivers. Use `wait_for_notify(30)` plus a `SELECT 1` heartbeat and reconnect in a loop.

**C10. Medium (security) — Sidecar bearer comparison is not constant-time.**
`sidecar/src/server.ts:67` uses `!==`; the Rails side correctly uses `secure_compare`. Only matters when `DURABLE_AGENT_HOST` is widened beyond loopback, but then it is the sole gate. Use `crypto.timingSafeEqual` on equal-length buffers.

**C11. Medium (security/docs) — OAuth refresh tokens are plaintext in the app database; README says otherwise.**
`sidecar/src/credentials.ts:59-64` upserts the credential JSON as-is; `README.md` ("Credentials live in the sidecar, never in Rails") and the migration comment claim isolation, but every `pg_dump` and replica exposes refresh tokens. At minimum say so; better, encrypt with a key derived from the shared token or exclude the table from dumps.

**C12. Medium — Engine models break in multi-database apps with automatic role switching.**
`app/models/durable_agent/application_record.rb:2` inherits `ActiveRecord::Base` directly. Reproduced on the dummy: `ActiveRecord::Base.connected_to(role: :reading) { DurableAgent::Conversation.count }` → `ActiveRecord::ConnectionNotDefined`. Offer `config.parent_record_class` (the usual engine pattern).

**C13. Medium — A single `\u0000` in any entry poisons that conversation's mirror forever.**
`sidecar/src/mirror.ts:189-194` inserts `JSON.stringify(entry.model)` into `jsonb`; Postgres rejects NUL (`unsupported Unicode escape sequence`, verified). Because the failure clears `seenEntries`, the same entry is retried on every frame and the whole transaction fails with it. Strip `\u0000` or fall back to inserting that entry's `model` as null.

**C14. Low — 1.3.0 reports never carry a conversation, so `on_report`'s default never fires and DESIGN's payload is aspirational.**
pi-durable 1.3.0's `onReport` has one argument; `sidecar/src/reports.ts:23-27` therefore always writes `type: "error"`, `conversation_id: null`; the default `on_report` then broadcasts nothing.

**C15. Low — Tool exception messages go straight to the model.**
`app/controllers/durable_agent/tools_controller.rb:15-16` sends `error.message` for any `StandardError`. A `PG::Error` message includes the failing SQL. Consider allow-listing `ArgumentError`/`RecordNotFound` messages and a generic text for the rest.

**C16. Low — Packaging: the gem is empty of sidecar unless built via `rake build`.**
`durable_agent.gemspec:21-24` globs `sidecar/dist/**/*`, `.gitignore` ignores it, `lib/durable_agent/sidecar.rb:29-32` falls back to `src/main.ts` which the gemspec does not ship either; `gem build` straight from a checkout yields a gem whose `durable_agent:sidecar` fails. `changelog_uri` points at a file that does not exist.

**C17. Low — `faux/faux-1` is only registered when it is the default model.**
`sidecar/src/harness.ts:49-53` plus `models-check.ts:16` trusting `faux`. `DurableAgent.start(model: "faux/faux-1")` on an OpenAI-default sidecar is accepted (201) and then settles `no_model`.

## Plausible findings (reasoned, not reproduced)

- **P1.** `attach()` can resolve before the row exists if the hook's attach wins the race; `DurableAgent.start` would then raise `RecordNotFound`. 40 probe rounds never hit it; the fix for C2 removes it anyway.
- **P2.** `lib/durable_agent/sidecar.rb:43-61` forwards only user/password/host/port/database; `sslmode`, `schema_search_path`, `application_name` are dropped.
- **P3.** `config.hosts` set in production rejects the sidecar's `Host: 127.0.0.1:3000` with 403 → "no tools", same symptom as C5.
- **P4.** `lib/durable_agent/tool.rb:43` demodulizes names, so `Billing::Lookup` and `Crm::Lookup` collide; the sidecar silently drops the second.
- **P5.** `mirror.ts:208` caps the NOTIFY entry list at 50 and `relay.rb:43` loads only those, so a resync hands `on_mirror` a partial `entries:`; undocumented.
- **P6.** `lib/durable_agent/engine.rb:8-10` raises at boot in production for any command (`db:migrate`, `console`) until a token exists; Docker builds that run `db:prepare` fail first. Any non-local env (`staging`) raises too.
- **P7.** Each failed `POST /auth/:provider/logins` leaves a `Pending` entry for 10 minutes; `/auth/:provider/logins/:id` ignores `:provider`. Token-holder only.
- **P8.** Entries have no timestamp in pi-durable, so `durable_agent_entries.created_at` is mirror time; after a boot-time catch-up, transcript timestamps are the boot time.

## Contract disagreements

Request/response shapes, status codes, env names, NOTIFY payloads and the two schemas match on every line checked. The disagreements:
- DESIGN reports payload / `onReport(error, info)` vs 1.3.0's single-argument hook (C14).
- README "credentials never in Rails" vs reality (C11).
- README "faux/faux-1 is a scripted offline model" vs C17.
- DESIGN: "a failed frame write resets the in-memory bookkeeping so the next frame re-upserts everything" is implemented literally, which is the root of C3/C4.
- `sidecar/README.md` default `DURABLE_AGENT_NAME = durable_agent` vs DESIGN's "the Rails application name" (Ruby supplies it, so harmless).

## Test quality

Proven: HTTP shapes and status codes on both sides, auth 401s, the Ruby tool DSL and coercion, the real tools protocol against a fake Rails, credential-store serialisation, generator output, and one real end-to-end round trip.

Only apparently proven: crash recovery (every test boots with zero conversations and zero pending submissions; re-attach, re-await, the `conversationCreated` hook, failed-frame resync, `mirrorDocs` filtering and reports have no coverage); the relay's `run`; the tools boundary end to end (two fakes, never the real controller serving the real sidecar); `Logins`; the 409 branch; the tool timeout.

## The three changes I would make first

1. **Make the mirror actually converge.** Register in `#attached` only after the first write succeeds and always await an in-flight attach; catch `enqueue`'s `attempt` and add `unhandledRejection` logging; add periodic reconciliation (rewrite a dirty conversation's full frame from `watch.value`, re-read `harness.submission(id).status()` for rows still `queued`/`placed`); strip `\u0000` before insert. Add a sidecar test that boots a second `Mirror` over an existing harness file with a pending submission, and one that injects a pool failure.
2. **Fix the two "it just does nothing" boot paths.** Retry `tools.load()` with backoff until Rails answers; document/handle `force_ssl` (exclude `/durable_agent` from the SSL redirect in the generator's initializer); use `timingSafeEqual` in `server.ts`.
3. **Fix the relay for real deployments.** `wait_for_notify(30)` + heartbeat + reconnect loop; debounce refreshes per conversation (or skip `pi.live`-only frames by default); state in README/generator output that broadcasts come from a separate process, so the `async` cable adapter cannot work in development.

## Prerelease readiness

As a `0.1.0.pre` for people who read DESIGN.md first, the code is coherent, idiomatic on both halves, the contract is honoured, and nothing found is an attacker-exploitable hole on the default loopback configuration. But the product promise is "crash-safe, resumable", and the mirror has three confirmed ways (C1–C3) to crash or silently diverge on an ordinary Postgres blip, none covered by tests; and a developer following the README on a stock Rails 8 app gets no live updates in development (C7), a tool-less agent on `bin/dev` (C6), and broken tool callbacks in production (C5). Hold the tag until change 1 and the boot/SSL fixes in change 2 land and are tested; the rest can ship as documented limitations.
