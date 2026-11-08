# SQLite stores: journal mode, files and backups

Every SQLite-backed store in `@app-mixer/core` and `@app-mixer/agent` opens its database with `PRAGMA busy_timeout=5000` and `PRAGMA journal_mode=WAL`. Write-ahead logging lets several readers and one writer proceed at the same time, so a run registry, action journal, approvals, budgets and notices that share one file no longer queue behind each other's reads. `synchronous` stays at its default (`FULL`), so a committed transaction, including the journal's `dispatching` record, survives a power loss; durability was not traded for speed. `:memory:` databases are unaffected.

## Files

A WAL database consists of three files: `name.sqlite`, `name.sqlite-wal` (committed transactions not yet copied into the main file) and `name.sqlite-shm` (shared memory index). The last connection to close checkpoints and removes the last two. After a crash they remain and the next open recovers from them, which is why the kill tests can restart workers on the same file. Never delete a `-wal` file next to a database that was not closed cleanly: it holds committed data.

## Backups

Copying only `name.sqlite` while a process is running can miss committed transactions. Use one of:

- `sqlite3 name.sqlite ".backup backup.sqlite"` or `VACUUM INTO 'backup.sqlite'`, which produce a consistent single-file copy while the stores are in use;
- stop every process that has the database open and copy the file together with its `-wal` file (if present).

Keep a database on a local disk: WAL needs shared memory between processes on one host and is not safe on network file systems. Use the PostgreSQL stores for several hosts.

## Adding a store

Open the database with `PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;`. `packages/core/test/sqlite-wal.test.mjs` fails for any source file that calls `new DatabaseSync(` without the WAL pragma.

## Contention benchmark

`node scripts/bench-sqlite.mjs [workers] [writesPerWorker]` runs several worker processes that each append rows to one shared database the way the run registry, journal and approvals do, once with the rollback journal and once with WAL. On the Windows development machine (4 workers, 300 write transactions each, `synchronous=FULL`) the rollback journal managed 144 transactions per second and WAL 436 (about 3 times), with no lock errors either way thanks to `busy_timeout`. Each store keeps its own connection; a shared-connection constructor was not added because WAL removes most of the contention it would address and sharing would couple the stores' lifecycles.
