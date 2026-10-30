import { DatabaseSync } from 'node:sqlite';
import {checkPromotionPackage, createPromotionPackage} from './promotion.js';
import {checkPromotionEvidence,type PromotionSignatureEvidence} from './signed-promotion.js';
import { ApplicationStore, validate, enforcePublicationGuard, definitionSha256, type ApplicationDefinition, type Patch, type PublicationGuard, type PublicationProvenance } from './index.js';

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
        CREATE TABLE IF NOT EXISTS application_publication_provenance (
          app_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('publish','rollback')),
          previous_version INTEGER NOT NULL, source_version INTEGER, definition_sha256 TEXT NOT NULL,
          PRIMARY KEY (app_id, version),
          CHECK(previous_version = version - 1),
          CHECK((kind = 'publish' AND source_version IS NULL) OR (kind = 'rollback' AND source_version > 0 AND source_version < previous_version)),
          CHECK(length(definition_sha256) = 64)
        );
        CREATE TABLE IF NOT EXISTS application_promotions (
          app_id TEXT NOT NULL, version INTEGER NOT NULL, source_environment TEXT NOT NULL,
          target_environment TEXT NOT NULL, source_version INTEGER NOT NULL, package_digest TEXT NOT NULL,
          PRIMARY KEY (app_id,version)
        );
        CREATE TABLE IF NOT EXISTS application_promotion_signatures (app_id TEXT NOT NULL,version INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(app_id,version));
        CREATE TRIGGER IF NOT EXISTS promotion_signature_no_replace BEFORE INSERT ON application_promotion_signatures WHEN EXISTS (SELECT 1 FROM application_promotion_signatures WHERE app_id=NEW.app_id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'Promotion signature is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS promotion_signature_no_update BEFORE UPDATE ON application_promotion_signatures BEGIN SELECT RAISE(ABORT,'Promotion signature is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS promotion_signature_no_delete BEFORE DELETE ON application_promotion_signatures BEGIN SELECT RAISE(ABORT,'Promotion signature is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS promotion_no_replace BEFORE INSERT ON application_promotions
          WHEN EXISTS (SELECT 1 FROM application_promotions WHERE app_id=NEW.app_id AND version=NEW.version)
          BEGIN SELECT RAISE(ABORT, 'Promotion provenance is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS promotion_no_update BEFORE UPDATE ON application_promotions
          BEGIN SELECT RAISE(ABORT, 'Promotion provenance is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS promotion_no_delete BEFORE DELETE ON application_promotions
          BEGIN SELECT RAISE(ABORT, 'Promotion provenance is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS provenance_no_replace BEFORE INSERT ON application_publication_provenance
          WHEN EXISTS (SELECT 1 FROM application_publication_provenance WHERE app_id = NEW.app_id AND version = NEW.version)
          BEGIN SELECT RAISE(ABORT, 'Publication provenance is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS provenance_no_update BEFORE UPDATE ON application_publication_provenance
          BEGIN SELECT RAISE(ABORT, 'Publication provenance is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS provenance_no_delete BEFORE DELETE ON application_publication_provenance
          BEGIN SELECT RAISE(ABORT, 'Publication provenance is immutable'); END;
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

  getPublicationProvenance(version: number): PublicationProvenance | undefined {
    const publication = this.getPublished(version);
    if (!publication) return undefined;
    const row = this.db.prepare('SELECT kind, previous_version, source_version, definition_sha256 FROM application_publication_provenance WHERE app_id = ? AND version = ?').get(this.id, version);
    if (!row) return {version,kind:'unknown'};
    const previousVersion = Number(row.previous_version), hash = row.definition_sha256;
    if (previousVersion !== version - 1 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || hash !== definitionSha256(publication.definition)) throw Error('Invalid publication provenance');
    const promotion=this.db.prepare('SELECT source_environment,target_environment,source_version,package_digest FROM application_promotions WHERE app_id=? AND version=?').get(this.id,version);
    if (promotion) {
      if(row.kind!=='publish'||row.source_version!==null||typeof promotion.source_environment!=='string'||typeof promotion.target_environment!=='string'||typeof promotion.package_digest!=='string')throw Error('Invalid publication provenance');
      const sourceVersion=Number(promotion.source_version);
      const item=createPromotionPackage(promotion.source_environment,{version:sourceVersion,definition:publication.definition});
      checkPromotionPackage(item,promotion.target_environment,this.id);
      if(item.digest!==promotion.package_digest)throw Error('Invalid publication provenance');
      const stored=this.db.prepare('SELECT evidence FROM application_promotion_signatures WHERE app_id=? AND version=?').get(this.id,version);let signature:PromotionSignatureEvidence|undefined;if(stored){try{signature=checkPromotionEvidence(item,promotion.target_environment,JSON.parse(String(stored.evidence)),previousVersion);}catch{throw Error('Invalid publication provenance');}}
      return {version,kind:'promotion',previousVersion,sourceEnvironment:item.sourceEnvironment,targetEnvironment:promotion.target_environment,sourceVersion,packageDigest:item.digest,definitionSha256:hash,...(signature?{signature}:{})};
    }
    if (row.kind === 'publish' && row.source_version === null) return {version,kind:'publish',previousVersion,definitionSha256:hash};
    if (row.kind === 'rollback') {
      const sourceVersion=Number(row.source_version);
      if (!Number.isSafeInteger(sourceVersion) || sourceVersion<1 || sourceVersion>=previousVersion) throw Error('Invalid publication provenance');
      const source=this.getPublished(sourceVersion);
      if (!source || definitionSha256(source.definition)!==hash) throw Error('Invalid publication provenance');
      return {version,kind:'rollback',previousVersion,sourceVersion,definitionSha256:hash};
    }
    throw Error('Invalid publication provenance');
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

  migrateDraft(expectedRevision: number, targetVersion: number): ApplicationDefinition {
    return this.transaction(() => {
      const store=new ApplicationStore(this.getDraft());
      const draft=store.migrateDraft(expectedRevision,targetVersion);
      this.db.prepare('UPDATE application_drafts SET revision = ?, definition = ? WHERE app_id = ?').run(draft.revision,JSON.stringify(draft),this.id);
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
      this.db.prepare("INSERT INTO application_publication_provenance VALUES (?, ?, 'publish', ?, NULL, ?)").run(this.id, version, version-1, definitionSha256(draft));
      return { version, definition: draft };
    });
  }

  promote(input: unknown, expectedVersion: number, targetEnvironment: string, evidence?:PromotionSignatureEvidence): Published {
    return this.promoteInternal(input,expectedVersion,targetEnvironment,evidence,false);
  }

  promoteAdvancing(input:unknown,expectedVersion:number,targetEnvironment:string,evidence?:PromotionSignatureEvidence):Published {
    return this.promoteInternal(input,expectedVersion,targetEnvironment,evidence,true);
  }

  private promoteInternal(input: unknown, expectedVersion: number, targetEnvironment: string, evidence:PromotionSignatureEvidence|undefined, advancing:boolean): Published {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw Error('Invalid version');
    const item=checkPromotionPackage(input,targetEnvironment,this.id),signature=evidence===undefined?undefined:checkPromotionEvidence(item,targetEnvironment,evidence,expectedVersion);
    return this.transaction(() => {
      const latest=this.getPublished()?.version ?? 0;
      if(latest!==expectedVersion)throw Error('Publication version conflict');
      if(advancing){const row=this.db.prepare('SELECT MAX(source_version) AS version FROM application_promotions WHERE app_id=? AND source_environment=? AND target_environment=?').get(this.id,item.sourceEnvironment,targetEnvironment);if(row?.version!==null&&row?.version!==undefined&&item.sourceVersion<=Number(row.version))throw Error('Source publication did not advance');}
      enforcePublicationGuard(this.publicationGuard,item.definition);
      const version=latest+1;if(!Number.isSafeInteger(version))throw Error('Invalid version');
      this.db.prepare('INSERT INTO application_publications (app_id,version,definition) VALUES (?,?,?)').run(this.id,version,JSON.stringify(item.definition));
      this.db.prepare("INSERT INTO application_publication_provenance VALUES (?, ?, 'publish', ?, NULL, ?)").run(this.id,version,latest,definitionSha256(item.definition));
      this.db.prepare('INSERT INTO application_promotions VALUES (?,?,?,?,?,?)').run(this.id,version,item.sourceEnvironment,targetEnvironment,item.sourceVersion,item.digest);
      if(signature)this.db.prepare('INSERT INTO application_promotion_signatures VALUES (?,?,?)').run(this.id,version,JSON.stringify(signature));
      return {version,definition:item.definition};
    });
  }

  promoteVerified(input:unknown,expectedVersion:number,targetEnvironment:string,evidence:PromotionSignatureEvidence):Published{if(evidence===undefined)throw Error('Invalid promotion evidence');return this.promote(input,expectedVersion,targetEnvironment,evidence);}

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
      this.db.prepare("INSERT INTO application_publication_provenance VALUES (?, ?, 'rollback', ?, ?, ?)").run(this.id, version, expectedVersion, sourceVersion, definitionSha256(source.definition));
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
