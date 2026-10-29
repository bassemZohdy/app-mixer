import { DatabaseSync } from 'node:sqlite';
import { ApplicationStore, validate, enforcePublicationGuard, type ApplicationDefinition, type Patch, type PublicationGuard } from './index.js';

type Published = { version: number; definition: ApplicationDefinition };

/** A synchronous, local definition repository. Open one instance per application. */
export class SqliteApplicationStore {
  private readonly db: DatabaseSync;
  private readonly id: string;

  constructor(path: string, initial: ApplicationDefinition, private readonly publicationGuard?: PublicationGuard) {
    validate(initial);
    if (publicationGuard !== undefined && typeof publicationGuard !== 'function') throw Error('Invalid publication guard');
    this.id = initial.id;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS application_drafts (
          app_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS application_publications (
          app_id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL,
          PRIMARY KEY (app_id, version)
        );
        CREATE TRIGGER IF NOT EXISTS publications_no_replace BEFORE INSERT ON application_publications
          WHEN EXISTS (SELECT 1 FROM application_publications WHERE app_id = NEW.app_id AND version = NEW.version)
          BEGIN SELECT RAISE(ABORT, 'Published versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS publications_no_update BEFORE UPDATE ON application_publications
          BEGIN SELECT RAISE(ABORT, 'Published versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS publications_no_delete BEFORE DELETE ON application_publications
          BEGIN SELECT RAISE(ABORT, 'Published versions are immutable'); END;
      `);
      this.db.prepare('INSERT OR IGNORE INTO application_drafts VALUES (?, ?, ?)')
        .run(this.id, initial.revision, JSON.stringify(initial));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  getDraft(): ApplicationDefinition {
    const row = this.db.prepare('SELECT definition FROM application_drafts WHERE app_id = ?').get(this.id);
    if (!row || typeof row.definition !== 'string') throw Error('Draft not found');
    const definition = JSON.parse(row.definition) as ApplicationDefinition;
    validate(definition);
    return definition;
  }

  getPublished(version?: number): Published | undefined {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw Error('Invalid version');
    const row = version === undefined
      ? this.db.prepare('SELECT version, definition FROM application_publications WHERE app_id = ? ORDER BY version DESC LIMIT 1').get(this.id)
      : this.db.prepare('SELECT version, definition FROM application_publications WHERE app_id = ? AND version = ?').get(this.id, version);
    if (!row) return undefined;
    const definition = JSON.parse(row.definition as string) as ApplicationDefinition;
    validate(definition);
    return { version: Number(row.version), definition };
  }

  apply(baseRevision: number, patches: Patch[]): ApplicationDefinition {
    return this.transaction(() => {
      const store = new ApplicationStore(this.getDraft());
      const draft = store.apply(baseRevision, patches);
      this.db.prepare('UPDATE application_drafts SET revision = ?, definition = ? WHERE app_id = ?')
        .run(draft.revision, JSON.stringify(draft), this.id);
      return draft;
    });
  }

  publish(expectedRevision: number): Published {
    return this.transaction(() => {
      const draft = this.getDraft();
      if (draft.revision !== expectedRevision) throw Error('Revision conflict');
      enforcePublicationGuard(this.publicationGuard, draft);
      const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM application_publications WHERE app_id = ?').get(this.id);
      const version = Number(row!.version) + 1;
      this.db.prepare('INSERT INTO application_publications (app_id, version, definition) VALUES (?, ?, ?)')
        .run(this.id, version, JSON.stringify(draft));
      return { version, definition: draft };
    });
  }

  rollback(sourceVersion: number, expectedVersion: number): Published {
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw Error('Invalid version');
    return this.transaction(() => {
      const latest = this.getPublished();
      if (!latest || latest.version !== expectedVersion) throw Error('Publication version conflict');
      const source = this.getPublished(sourceVersion);
      if (!source) throw Error('Publication not found');
      if (sourceVersion >= expectedVersion) throw Error('Rollback requires an earlier version');
      enforcePublicationGuard(this.publicationGuard, source.definition);
      const version = latest.version + 1;
      if (!Number.isSafeInteger(version)) throw Error('Invalid version');
      this.db.prepare('INSERT INTO application_publications (app_id, version, definition) VALUES (?, ?, ?)')
        .run(this.id, version, JSON.stringify(source.definition));
      return {version, definition: source.definition};
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
