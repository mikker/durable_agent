# Independent review by Claude Fable 5.1 (2026-10-19, HEAD e0d356e, one-database design)

Both suites ran: `bin/rails test` 100 runs/0 failures (round trip included), `DURABLE_AGENT_DB=postgres bin/rails test` 100/0, `npm test` 77 pass/5 skipped, `npm run test:postgres` 81 pass/1 skipped, `npx tsc --noEmit` clean. Probes ran against a temp SQLite file and a Postgres database created and dropped for the purpose.

## 1. Confirmed findings

**C1. High — Losing the Postgres connection inside a transaction kills the sidecar process.** `sidecar/src/db/postgres.ts:103-131` checks a client out and runs the batch on it without `client.on("error", …)`. pg routes a dropped connection to the active query and emits `'error'` on the client; pg-pool removes its idle listener on checkout. `main.ts` handles `unhandledRejection` only, so the emitter error is an uncaught exception. Probe (terminate this transaction's backend while `pg_sleep(2)` runs inside `db.transaction`): `UNCAUGHT EXCEPTION while inTransaction=true: Connection terminated unexpectedly`, exit 3. Stress probe: 141 transactions OK, then the first hit → uncaught `read ECONNRESET`. The documented one-retry path for idle clients works. The TS test "a connection error inside a transaction is not retried" throws from the callback and never loses a connection.

**C2. High — A failed storage call leaves a permanently dead sidecar that keeps running.** pi-durable makes any `commit` error fatal to the session, which closes the storage and the shared `Db`. `main.ts` never observes `harness.closed`, never exits, never reopens. Probe: after the failure the process was alive, `GET /health` → 500 `database is not open`, every command → 500 `Session failed after a storage error`, SIGTERM exits 0. Under a supervisor that watches the process, agents are gone until someone notices.

**C3. High (SQLite) — Any other writer holding the SQLite write lock for more than 5 s kills the session (then C2).** The node adapter's commit starts with `BEGIN IMMEDIATE` under a 5 s busy timeout and `sidecar/src/db/sqlite.ts` retries nothing. Probe: a second process held `BEGIN IMMEDIATE` for 8 s; the submission request stalled 8 s (the busy wait is synchronous in `node:sqlite`, so every other HTTP request stalls too), then 500 `database is locked`; from then on C2. Nothing documents the 5 s rule.

**C4. Medium — ChangeTracker's post-commit owner lookup turns a successful commit into a fatal session failure.** `events.ts:133-134` awaits `inner.commit`, then resolves owners, which for `document.change`/`retire` on a cache miss reads `inner.document`. The cache is filled only by creates and delta-rewrite reads, so after every restart the first checkpoint base of every existing conversation misses. If that read fails, `commit` rejects although the batch is durable, the session fails, no event is posted. Probes: `tracker.commit: REJECTED`, value durable, `session.closed -> {"reason":"failed"}`.

**C5. Low-Medium — Within one request, `busy?`, `live`, `inbox` and `transcript` are stale after `say`.** The executor's query cache serves the earlier SELECTs again. Probe: `busy? after the sidecar wrote, same request: false`, `uncached: true`.

**C6. Low — The gem's `schema_version` is written but never enforced.**

**C7. Low — Packaging depends on `rake build`.** `gem build` from a checkout or a `github:` source ships no sidecar; `changelog_uri` points at a file that does not exist.

**C8. Low — On pi-durable 1.3.0 every report is `type: "error"` with no conversation, so the default `on_report` never broadcasts.**

**C9. Low — Schema drift the name-only test does not see.** On SQLite every harness primary key is `bigint NOT NULL PRIMARY KEY`, not a rowid alias as in pi-durable's own DDL, so each table carries a second B-tree; on Postgres `singleton` is a `bigint` serial. Index definitions match. The schema test compares names only.

**C10. Low — Login routes ignore `:provider`.**

**C11. Low — Tool exception messages reach the model verbatim.**

## 2. Plausible findings

- **P1.** `sslmode=require` means encrypt-only to libpq but verify-full to `pg-connection-string`; `schema_search_path`, `sslrootcert` and other `database.yml` keys are not forwarded.
- **P2.** Postgres 15+ gives non-owners no CREATE on `public`, and pi-durable still sends one `CREATE TABLE IF NOT EXISTS`.
- **P3.** `DurableAgent::ApplicationRecord < ActiveRecord::Base` breaks under `connects_to` role switching.
- **P4.** The `after_initialize` token check raises in production for `db:migrate`, `console`, and any non-local env such as `staging`.
- **P5.** The one-retry rule can double-apply a non-idempotent statement (the reports insert).
- **P6.** Shutdown has no deadline; a second SIGTERM is ignored.
- **P7.** `last_failure` and `of_kind` load every entry per call.
- **P8.** `EOFError`/`IOError` from a sidecar dying mid-response surface raw instead of as `Unavailable`.

## 3. Contract disagreements

"Unhandled rejections are logged, not fatal" (C1); "shutdown exits 0" is the only exit path (C2); the retry rule's scope (C1, C3); the tracker's failure fails the commit (C4); the base rewrite additionally requires conversation scope; `on_report` default (C8); `/health` after a failed session; column types (C9); `schema_version` never checked (C6). Everything else checked line by line matches.

## 4. Test quality

Proven: the translator on every statement the core emits (conformance on Postgres, migration DDL in a rolled-back transaction); the base-document invariant under a real streaming run; events; tools; the HTTP surface; credentials; the Rails models and controllers; the generator; a round trip per adapter. Only apparently proven: resilience (no test drops a connection, holds the SQLite lock, injects a failing read after a commit, or observes the process after a session failure); the Rails↔sidecar boundary (the round trip runs with no Rails URL, so the real controllers are never driven by the real sidecar); schema parity (names only); `last_failure`/`busy?` through a live run with the query cache on; `Document#value` with several bases.

## 5. The three changes first

1. Make the Postgres adapter and the process survive connection loss, and supervise the Harness: `client.on("error")` for the life of a checkout, `uncaughtException` as a logged last resort, and exit 1 (or reopen) when `harness.closed` reports failure; test with a real `pg_terminate_backend` during a commit and a held `BEGIN IMMEDIATE` on SQLite.
2. Never let the change-event path decide a commit's fate: resolve owners before `inner.commit`, wrap remaining post-commit work in try/log.
3. Treat SQLite sharing honestly: retry `BEGIN IMMEDIATE` busy failures in the adapter with a longer budget, document the lock rule, and clear the query cache after `say` so `busy?` cannot lie in the same request.

## 6. Prerelease readiness

Not yet. The data model is sound: no path corrupts or loses committed agent state on either database, the one-base rule holds under streaming, the Postgres translation passes pi-durable's own conformance suite, credentials are encrypted as documented, and the Rails half is small, read-only and matches the contract. What fails is operability (C1–C4). Hold the tag until change 1 lands with real-failure tests; the rest can follow.
