import { DatabaseSync } from 'node:sqlite';

const sleep = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const busy = (error: unknown) => /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String((error as { message?: unknown })?.message ?? error));

/**
 * Run a synchronous, idempotent database step again when it fails because the database is locked, at most `retries` more
 * times with a short pause. Each pass already waits for the connection's busy timeout, so the total wait stays bounded.
 */
export function retryWhenBusy<T>(step: () => T, retries = 2): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return step();
    } catch (error) {
      if (!busy(error) || attempt >= retries) throw error;
      sleep(25 + 25 * attempt);
    }
  }
}

/**
 * Open a database file with the busy timeout set and WAL mode switched on. Switching a new file to WAL mode can fail with
 * "database is locked" at once, without waiting for the busy timeout, when other processes open the same new file at the
 * same moment (workers started together). This retries only that switch, for about as long as the busy timeout, so every
 * opener ends up with the same journal mode. Later statements use the busy timeout as before.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (path === ':memory:') return db;
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec('PRAGMA journal_mode=WAL');
        break;
      } catch (error) {
        if (!busy(error) || attempt >= 100) throw error;
        sleep(10 + Math.min(attempt, 40));
      }
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}
