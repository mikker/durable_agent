# Reviews

Two rounds of three independent read-only reviews each: GPT-6 Astra and GPT-6 Sol through Codex, and Claude
Fable 5.1. Raw outputs are in this directory.

## Round 2: the one-database design (HEAD e0d356e, 2026-10-19)

Files: `2026-10-19-v1-gpt-6-astra.md`, `2026-10-19-v1-gpt-6-sol.md`, `2026-10-19-v1-claude-fable.md`. Codex's
sandbox could not open database files or reach Postgres, so only Fable ran the suites and the failure probes;
Astra ran pi-durable's conformance cases over in-memory SQLite and reproduced its main finding with the real
Harness over memory storage.

Agreed, or confirmed with a probe:

1. **A dropped Postgres connection inside a transaction kills the process** (fable C1): no `client.on("error")`
   on the checked-out client, and only `unhandledRejection` is handled.
2. **A failed pi-durable session leaves a dead sidecar running** (fable C2): nothing watches `harness.closed`.
3. **A 5 s write lock on a shared SQLite file is fatal** (fable C3): no retry around `BEGIN IMMEDIATE`, and the
   busy wait stalls the event loop.
4. **The change tracker can fail a durable commit** (sol 3, fable C4): owners are resolved after the commit, and a
   failed read rejects it.
5. **Resuming before tools load loses replay-safe tool calls after a restart** (astra P1, reproduced).
6. **Postgres retries can double-apply a write** (astra P2 reproduced with fault injection, sol plausible, fable
   P5): the reports insert in particular.
7. **Rails encodes indexed strings differently from JavaScript** (astra P2, reproduced): `to_json` escapes `&`,
   `<`, `>` as `\u00XX`, `JSON.stringify` does not, so `for_request("a&b")` finds nothing.
8. **A report raised just before shutdown can be lost** (sol 1): the insert promise is not tracked.
9. **`busy?` and friends are stale in the request that called `say`** (fable C5): the query cache.
10. **The base rewrite skips non-conversation scopes** (sol 2, fable): the contract says every `latest` document.
11. Smaller, confirmed: `schema_version` never checked (fable C6); packaging needs `rake build` (fable C7);
    the default `on_report` never fires on 1.3.0 (fable C8); SQLite primary keys are not rowid aliases and the
    schema test compares names only (fable C9); login routes ignore `:provider` (fable C10); tool exception
    messages reach the model verbatim (fable C11); a bare secret without `Bearer ` authenticates (astra);
    whitespace-only token accepted by the sidecar (astra); `DURABLE_AGENT_WORKSPACE_ROOT`/`NAME` ignored by
    Rails config (astra); `MissingSchema` only for the conversations table (astra, sol).

Plausible: `sslmode=require` semantics differ between libpq and node (fable P1); Postgres 15 `public` CREATE
(fable P2); multi-database role switching (fable P3); the production boot-time token check (fable P4); no
shutdown deadline (fable P6, astra); `last_failure` loads every entry (fable P7); `EOFError` not mapped to
`Unavailable` (fable P8); long indexed strings (astra).

From building the demo app on the gem (`/Users/mikker/dev/slopdep`): the generated initializer pins the model
so `DURABLE_AGENT_MODEL` is ignored; the generated Procfile can put Puma on foreman's port 5000 while
`rails_url` says 3000; no shipped test support; `DurableAgent.auth` returns more than documented; logins emit no
change events; conversations and entries carry no timestamps; `DurableAgent.start` cannot share the app's
transaction, so a failed app row leaves an orphan conversation.

## Round 1: the mirror design (HEAD fc3455a, 2026-10-19)

Files: `2026-10-19-gpt-6-astra.md`, `2026-10-19-gpt-6-sol.md`, `2026-10-19-claude-fable.md`. All three agreed the
mirror could silently diverge after a Postgres failure, attach was not atomic, OAuth tokens were plaintext, and
the relay died on connection loss. The first two were patched in `ff8b1ce`; the design was then replaced by the
one-database design, which removed the mirror and the relay.
