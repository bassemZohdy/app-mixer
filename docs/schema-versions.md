# Store schema versions

Stores create their tables when they open (`CREATE TABLE IF NOT EXISTS`), and a store whose layout changed adds the new columns, indexes and triggers in the same step. To make those changes explicit, each migrating store records the layout it wrote in a small table, `app_mixer_schema (component, version)`, in the same database:

- a database without a record for a component is the original layout (version 1);
- opening a store runs its migration in one transaction (SQLite `BEGIN IMMEDIATE`) and records its version afterwards; a version is never lowered;
- a database written by a newer release (a recorded version above what the running code supports) is refused with `The <component> database schema is version N, newer than this release supports (M); upgrade the software before opening it`, so an old binary cannot misread or corrupt a newer layout after a rollback of the software.

Recorded today: `agent_runs` (version 2 adds the creation sequence used to dispatch queued runs in order; SQLite and PostgreSQL) and `staged_operations` (version 2 adds the request key and state revision columns). SQLite helpers are `assertSchemaSupported` and `recordSchemaVersion` in `schema-version.ts` of each package (the agent package does not import core); PostgreSQL stores do the same with queries in `initialize()`.

## Adding a migration

1. Raise the component's supported version and write the migration so it can run on every older layout (guard with `PRAGMA table_info` or `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`).
2. Call `assertSchemaSupported` at the start of the transaction and `recordSchemaVersion` just before `COMMIT` (PostgreSQL: check, migrate, then upsert with `GREATEST`).
3. Add a test that opens a database written by the previous layout (see `queued runs are dispatched in creation order ...` in `durable-runs.test.mjs`) and `schema-version.test.mjs` for the refusal.

PostgreSQL stores still need DDL privileges when they initialize; run `initialize()` with a migration role and give the runtime role only table access.
