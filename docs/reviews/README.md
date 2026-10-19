# Reviews of v0 (HEAD fc3455a, 2026-10-19)

Three independent read-only reviews of the same commit: GPT-6 Astra and GPT-6 Sol through Codex, and Claude
Fable 5.1. Raw outputs are in this directory. This file merges them.

## Agreed by all three

1. **The mirror does not converge after a Postgres failure.** A failed settlement write leaves a submission
   `queued` forever, and boot only re-awaits queued/placed submissions (astra 2, sol 1, fable C3). A failed frame
   only retries when the same conversation emits another frame, so a failed final frame leaves `busy?` true and
   the answer missing (astra 4, sol 3, fable C4). Fix: periodic reconciliation independent of agent activity.
2. **Attach is not atomic.** `#attached` is set before the first write, so a failure leaves a registered but
   unstarted watch; a hook-driven attach rejection is unhandled and kills Node (astra 3, fable C1, C2).
3. **OAuth refresh tokens are plaintext in the app database** and the README claims otherwise (astra 7, sol 4,
   fable C11). Either encrypt with a key outside Postgres or document the boundary honestly.
4. **The relay dies or wedges on connection loss**, and the sidecar's pool has no error listener (astra 6, sol 5,
   fable C9).

## Confirmed by one reviewer with a probe

- **Empty configured token disables tool authentication** on the Rails side: `config.token = ""` bypasses the
  fallback chain and `secure_compare("", "")` passes with no header (astra 1). Reject blank tokens.
- **`force_ssl` in stock Rails production breaks the tools callback** (fable C5); `config.hosts` has the same
  symptom (fable P3).
- **`bin/dev` boots with no tools** because the sidecar fetches definitions once before Puma is up (fable C6).
- **Default live updates do nothing in development** with the `async` cable adapter (fable C7).
- **Refresh storm**: a `pi.live` NOTIFY up to every 100 ms becomes an undebounced page refresh per subscriber
  (fable C8).
- **A `\u0000` in any entry poisons the conversation's mirror** (fable C13).
- **Engine models break under multi-database role switching** (fable C12).
- **Install generator uses Ruby 3.4's `it`** while the gemspec allows 3.3 (astra 8).
- **`gem build` without `rake build` ships no sidecar** (sol 6, fable C16).
- **Sidecar bearer comparison is not constant-time** (fable C10).
- **Schema version is written but never checked** (sol 7).
- **`DATABASE_URL` derivation drops `sslmode` and `schema_search_path`** (astra 5, fable P2).

## Disputed

- Sol 2, "concurrent frame writes can move documents backward", does not hold: pi-durable's `watch()` delivers
  callbacks one at a time (README, "Watching a Conversation") and the writer awaits each frame.

## Order of work

1. Mirror convergence and atomic attach, with tests that boot a second mirror over an existing harness file and
   inject a pool failure.
2. Boot paths: retry tool loading until Rails answers; exclude `/durable_agent` from the SSL redirect in the
   generated initializer; reject blank tokens; `timingSafeEqual`.
3. Relay: `wait_for_notify` with a timeout, heartbeat, reconnect loop, per-conversation debounce; generator
   output and README state that development needs a non-`async` cable adapter.
4. Documentation honesty: credentials at rest, `faux` availability, the 1.3.0 report shape.
5. Packaging: include `sidecar/src` or make `gem build` depend on the bundle; explicit block params in the
   generator; a CHANGELOG.
