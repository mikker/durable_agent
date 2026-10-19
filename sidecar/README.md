# durable_agent sidecar

The Node process that runs the agents for the `durable_agent` gem. It owns a pi-durable Harness whose storage
lives in the app's own database (Postgres or SQLite, `durable_agent_*` tables), takes commands from Rails over
HTTP, posts change events to Rails after each commit, and calls back into Rails to list and run tools. The
contract it implements is `../DESIGN.md`.

## Running

Rails launches it: `bin/rails durable_agent:sidecar` builds the environment below from `DurableAgent.config` and
`database.yml`, then replaces itself with `node <gem>/sidecar/dist/sidecar.js` from the Rails root. The install
generator adds that line to `Procfile.dev`.

By hand, from this directory: `cp .env.example .env`, edit, then `npm run dev` (runs `src/main.ts` directly; Node
22.19+ strips the types).

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | the app's database, see below (required) | |
| `DURABLE_AGENT_TOKEN` | shared bearer secret (required) | |
| `DURABLE_AGENT_HOST`, `DURABLE_AGENT_PORT` | bind address | `127.0.0.1`, `4010` |
| `DURABLE_AGENT_RAILS_URL` | where Rails answers `/durable_agent/tools` and `/durable_agent/events`; unset runs with neither | |
| `DURABLE_AGENT_MODEL` | default model, `provider/modelId`; `faux/faux-1` is the scripted offline model | `openai/gpt-6.1-sol` |
| `DURABLE_AGENT_WORKSPACE_ROOT` | cwd for built-in tools (unused in v1) | `storage/durable_agent` |
| `DURABLE_AGENT_NAME` | agent name on provider consent screens | `durable_agent` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | pass-through | |

`DURABLE_AGENT_STORAGE_PATH` and `DURABLE_AGENT_MIRROR_DOCS` are gone: there is no separate harness file and no
mirror.

## Database

There is one copy of the state: pi-durable's own tables, in the app's database, under the prefix
`durable_agent_`. Rails reads them; the sidecar is their only writer.

`DATABASE_URL` picks the adapter by scheme:

- `postgres://…` / `postgresql://…` (any libpq-style URL `pg` accepts, `?sslmode=` and `?host=/socket/dir` included).
- `sqlite:///absolute/path.sqlite3` or `sqlite3:///absolute/path.sqlite3`; `sqlite:relative/path.sqlite3` resolves
  from the cwd; `:memory:` (or `sqlite::memory:`) for throwaway runs. The path is used as written (no percent-decoding).

`src/db/` is the facade every module writes through: pi-durable's `SqliteDatabase` interface (`exec`, `run`,
`get`, `all`, `transaction`, `close`, `?` placeholders, SQLite dialect) plus a `dialect` field.

- **SQLite** is pi-durable's own `node:sqlite` adapter: WAL, `synchronous = NORMAL`, a 5 s busy timeout and
  `BEGIN IMMEDIATE`, the same settings Rails 8 uses, so Puma and the sidecar share the file.
- **Postgres** is `PostgresDatabase` over a `pg.Pool` of two. All operations run through one serial queue, as
  the SQLite adapter's do: a transaction checks out a client and runs `BEGIN` … `COMMIT` (or `ROLLBACK` and rethrow)
  on it, and nothing else runs until it settles. Outside a transaction a statement that fails with a
  connection-class error (`ECONNRESET`, `57P0x`, `08xxx`, "Connection terminated") is sent once more, and so is a
  checkout or `BEGIN` that fails that way, because pi-durable treats a failed storage call as fatal to its session.
  `int8` parses to a JS number (ids and seqs are safe integers; `next_id` is text anyway). Connections run with
  `TimeZone=UTC` (added to the URL's `options`), because `CURRENT_TIMESTAMP` lands in `timestamp without time zone`
  columns that Rails reads as UTC.

### Translation

The storage core speaks SQLite. `src/db/translate.ts` turns it into Postgres, memoized by SQL text:

| SQLite | Postgres |
|---|---|
| `?` | `$1, $2, …` (not inside `'…'`, `"…"` or `--` comments) |
| `INSERT OR IGNORE INTO … [RETURNING …]` | `INSERT INTO … ON CONFLICT DO NOTHING [RETURNING …]` |
| `) STRICT` | `)` |
| `CHECK (json_valid(col))` | dropped (with the whitespace or comma before it) |

`ON CONFLICT(id) DO UPDATE … excluded.col`, partial indexes, `id DESC` index columns and `LIMIT ?` are already
valid Postgres. The gem's own SQL (`settings.ts`, `credentials.ts`, `reports.ts`) is written once in the SQLite
dialect (`CURRENT_TIMESTAMP`, `ON CONFLICT (k) DO …`, `RETURNING id`) and goes through the same translation.
The translator test runs pi-durable's real migration runner, translated, inside a rolled-back Postgres transaction.

### Schema

Rails owns it: the gem's install migration (`lib/generators/durable_agent/install/templates/create_durable_agent_tables.rb.tt`)
creates every table on either adapter. The sidecar never runs schema changes. `openHarnessStorage(db)` (`src/storage.ts`):

1. checks that `durable_agent_conversations` exists and otherwise throws `MissingSchema` ("run bin/rails db:migrate");
2. seeds the two singleton rows the migration leaves out, so a database loaded from `schema.rb` works:
   `durable_agent_durable_schema (1, CURRENT_SQLITE_SCHEMA_VERSION)` and
   `durable_agent_durable_metadata (1, next_id '2', next_seq 1)`, both `ON CONFLICT DO NOTHING`;
3. refuses a stored harness version older than this pi-durable's (a gem upgrade ships the Rails migration for it);
4. opens `SqliteStorage` under the prefix. pi-durable finds the version current; the only DDL it still sends is its
   `CREATE TABLE IF NOT EXISTS durable_agent_durable_schema`, a no-op over the existing table (on Postgres the
   database user still needs `CREATE` on the schema for that statement to pass the permission check).

The nine harness tables are pi-durable 1.3.0's schema (version 1) with the same table, column and index names
(partial index included). What is deliberately different from pi-durable's own DDL:

- no `STRICT` and no `CHECK` constraints at all (pi-durable validates its writes; Rails' DDL has no checks);
- JSON columns (`record`, `content`) are `text`, never `jsonb`: `jsonb` rejects `\u0000` and would turn a model
  output into a fatal commit;
- integer ids and seqs are `bigint`, and harness ids carry no sequence or default (pi-durable mints them);
- no seed rows (above), no foreign keys (pi-durable writes rows in its own order inside one transaction).

The gem's own tables are `durable_agent_reports` (autoincrementing id), `durable_agent_credentials` (encrypted
envelope as JSON text) and `durable_agent_settings` (`device_id`, `schema_version = "2"`).

`sql/schema.sqlite.sql` and `sql/schema.postgres.sql` are hand renderings of that migration for the tests (and for
running the sidecar without Rails: apply the matching file yourself). A Ruby test keeps their table and column
names in step with the migration.

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
npm test               # SQLite: a fresh database file in a temp dir
npm run test:postgres  # Postgres: postgres://localhost/durable_agent_sidecar_test, created when missing
```

Both run the same suites; `DURABLE_AGENT_TEST_DATABASE_URL` selects the database (`test:postgres` only sets a
default for it). `test/helpers.ts` drops any `durable_agent_*` tables left in that database, applies the matching
`sql/schema.*.sql` and empties the tables before each use, so point it at a database of its own. Tests run one file
at a time because they share it. The suites include pi-durable's storage conformance cases
(`createStorageConformance`) against `openHarnessStorage` on the current database.
