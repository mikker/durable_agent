# durable_agent sidecar

The Node process that runs the agents for the `durable_agent` gem. It owns a pi-durable Harness (a SQLite file),
takes commands from Rails over HTTP, writes every committed frame into the app's Postgres (`durable_agent_*` tables,
`NOTIFY durable_agent_mirror` / `durable_agent_reports`), and calls back into Rails to list and run tools. The
contract it implements is `../DESIGN.md`.

## Running

Rails launches it: `bin/rails durable_agent:sidecar` builds the environment below from `DurableAgent.config` and
`database.yml`, then replaces itself with `node <gem>/sidecar/dist/sidecar.js` (from the Rails root, so relative
storage paths land in the app's `storage/`). The install generator adds that line to `Procfile.dev`.

By hand, from this directory: `cp .env.example .env`, edit, then `npm run dev` (runs `src/main.ts` directly; Node
22.19+ strips the types).

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | the app's Postgres (required) | |
| `DURABLE_AGENT_TOKEN` | shared bearer secret (required) | |
| `DURABLE_AGENT_HOST`, `DURABLE_AGENT_PORT` | bind address | `127.0.0.1`, `4010` |
| `DURABLE_AGENT_RAILS_URL` | where Rails answers `/durable_agent/tools`; unset runs with no tools | |
| `DURABLE_AGENT_MODEL` | default model, `provider/modelId`; `faux/faux-1` is the scripted offline model | `openai/gpt-6.1-sol` |
| `DURABLE_AGENT_STORAGE_PATH` | SQLite harness file | `storage/durable_agent.sqlite` |
| `DURABLE_AGENT_WORKSPACE_ROOT` | cwd for built-in tools (unused in v0) | `storage/durable_agent` |
| `DURABLE_AGENT_NAME` | agent name on provider consent screens | `durable_agent` |
| `DURABLE_AGENT_MIRROR_DOCS` | `all` or a comma list of document kinds | `all` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | pass-through | |

The mirror tables must exist (the gem's migration; `npm run db:schema` applies `sql/schema.sql` for standalone use).
Boot fails on a missing table; an unknown default model only logs an error.

## Build

`npm run build` bundles everything, dependencies included, into `dist/sidecar.js` with esbuild. The bundle needs
no `node_modules`: the gem ships that one file and runs it with plain `node`. Rebuild and ship it whenever `src/`
or the dependencies change.

Two bundling details: a banner defines `require` through `createRequire`, because `pg` and the SDKs call
`require("events")` and friends; and `main.ts` registers pi-ai's OAuth flows statically, because pi-ai otherwise
loads them with a computed relative `import()` that has nothing to point at inside a bundle. Photon (image
processing, wasm) is not reached from this entry point, so it is not in the bundle.

## Checks

```sh
npm run typecheck
npm test   # needs local Postgres; uses (and creates) the database durable_agent_sidecar_test
```

Tests run one file at a time because they share that database. Override with `DURABLE_AGENT_TEST_ADMIN_URL`
(default `postgres://localhost/postgres`) and `DURABLE_AGENT_TEST_DATABASE`.
