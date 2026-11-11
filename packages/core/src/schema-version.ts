import type {DatabaseSync} from 'node:sqlite';

/**
 * Schema versions of the SQLite stores, kept in one table per database (`app_mixer_schema`, one row per component), so a database written by a newer
 * release is refused instead of being silently misread, and a migration is recorded. Call both helpers inside the store's own `BEGIN IMMEDIATE` migration:
 * `assertSchemaSupported` first, `recordSchemaVersion` just before `COMMIT`. A component's version starts at 1 (the original layout, never recorded).
 */
const TABLE='CREATE TABLE IF NOT EXISTS app_mixer_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL)';

/** Recorded version of `component`, or 1 when the database predates version records. */
export function schemaVersion(db:DatabaseSync,component:string):number{
  db.exec(TABLE);
  const row=db.prepare('SELECT version FROM app_mixer_schema WHERE component=?').get(component);
  return row===undefined?1:Number(row.version);
}
/** Throw when the database was written by a release with a newer layout of `component` than this one supports. */
export function assertSchemaSupported(db:DatabaseSync,component:string,supported:number):void{
  const stored=schemaVersion(db,component);
  if(stored>supported)throw Error(`The ${component} database schema is version ${stored}, newer than this release supports (${supported}); upgrade the software before opening it`);
}
/** Record `version` for `component` (never lowers a recorded version). */
export function recordSchemaVersion(db:DatabaseSync,component:string,version:number):void{
  db.exec(TABLE);
  db.prepare('INSERT INTO app_mixer_schema (component,version) VALUES (?,?) ON CONFLICT(component) DO UPDATE SET version=MAX(version,excluded.version)').run(component,version);
}
