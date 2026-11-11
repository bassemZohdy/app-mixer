import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {openDatabase} from './sqlite-open.js';
import {AppMixerError} from './errors.js';

export type DataScope = {tenantId:string; applicationId:string};
export type DataRecord = {id:string; revision:number; value:Record<string,unknown>};
export type DataRecordPage = {items:DataRecord[];nextAfter?:string};
export type MigrationPreview={schemaVersion:number;count:number;digest:string};
export type DataMigrationEvidence={principalId:string;reference:string;observedAt:number};
export type DataMigration={fromVersion:number;toVersion:number;digest:string;outputDigest?:string;planDigest?:string;transform:(value:Record<string,unknown>,id:string)=>Record<string,unknown>;validate:(value:Record<string,unknown>,id:string)=>boolean;evidence?:DataMigrationEvidence};
export type DataMigrationRehearsal={fromVersion:number;transform:DataMigration['transform'];validate:DataMigration['validate']};
export type DataRollbackRehearsal=DataMigrationRehearsal&{targetVersion:number};
export type DataMigrationRehearsalResult=MigrationPreview&{outputDigest:string};
export type SqliteDataProviderOptions={migrationLimits?:{maxRecords?:number;maxBytes?:number}};
export type DataRollback={fromVersion:number;targetVersion:number;digest:string;outputDigest?:string;planDigest?:string;transform:DataMigration['transform'];validate:DataMigration['validate'];evidence?:DataMigrationEvidence};
export type DataMigrationAuditEvent={fromVersion:number;toVersion:number;targetVersion:number|null;digest:string;outputDigest?:string;planDigest?:string;recordCount:number;principalId:string;reference:string;observedAt:number};
export type DataRollbackEvent={fromVersion:number;toVersion:number;targetVersion:number;digest:string;recordCount:number};
export interface DataProvider {
  readonly supportsSchemaRead?:boolean;
  readonly supportsReverseList?:boolean;
  readonly supportsIdPrefix?:boolean;
  get(scope:DataScope, collection:string, id:string,expectedSchemaVersion?:number):DataRecord|undefined;
  list?(scope:DataScope,collection:string,options?:{after?:string;limit?:number;expectedSchemaVersion?:number;order?:'asc'|'desc';idPrefix?:string}):DataRecordPage;
  verifyListPage?(scope:DataScope,collection:string,items:DataRecord[],expectedSchemaVersion?:number):boolean;
  put(scope:DataScope, collection:string, id:string, value:Record<string,unknown>, expectedRevision:number|null,expectedSchemaVersion?:number):DataRecord;
  delete(scope:DataScope, collection:string, id:string, expectedRevision:number,expectedSchemaVersion?:number):void;
}
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
export function migrationPlanDigest(scope:DataScope,collection:string,fromVersion:number,toVersion:number,targetVersion:number|undefined,inputDigest:string,outputDigest:string):string{const plan=targetVersion===undefined?{kind:'forward',fromVersion,toVersion}:{kind:'rollback',fromVersion,toVersion,targetVersion};return createHash('sha256').update(JSON.stringify(['app-mixer-migration-plan-v1',scope.tenantId,scope.applicationId,collection,plan,inputDigest,outputDigest])).digest('hex');}
/** SQLite BINARY text ordering follows UTF-8 scalar order; return the first string after a prefix range. */
function prefixSuccessor(prefix:string):string|undefined {
  const points=Array.from(Buffer.from(prefix,'utf8').toString('utf8'),character=>character.codePointAt(0)!);
  for(let i=points.length-1;i>=0;i--){if(points[i]<0x10ffff){let next=points[i]+1;if(next===0xd800)next=0xe000;return String.fromCodePoint(...points.slice(0,i),next);}}
  return undefined;
}
export function checkKey(scope:DataScope,collection:string,id:string):void {
  if(!scope||!identifier(scope.tenantId)||!identifier(scope.applicationId)||!identifier(collection)||!identifier(id))throw Error('Invalid data key');
}
export function dataCopy(value:unknown):Record<string,unknown> {
  let count=0;const ancestors=new Set<object>();
  const visit=(input:unknown,depth:number):unknown=>{
    if(++count>10000||depth>40)throw Error('Data value too large');
    if(input===null||typeof input==='boolean'||typeof input==='string'||(typeof input==='number'&&Number.isFinite(input)))return input;
    if(typeof input!=='object'||input===null||ancestors.has(input))throw Error('Invalid data value');
    ancestors.add(input);
    let output:unknown;
    if(Array.isArray(input)) {
      if(input.length>10000||Object.keys(input).length!==input.length||Array.from({length:input.length},(_,i)=>Object.hasOwn(input,i)).some(present=>!present))throw Error('Invalid data value');
      output=input.map(item=>visit(item,depth+1));
    } else {
      if(Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null)throw Error('Invalid data value');
      const result:Record<string,unknown>={};
      for(const [key,item] of Object.entries(input)) {
        if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid data key');
        result[key]=visit(item,depth+1);
      }
      output=result;
    }
    ancestors.delete(input);return output;
  };
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid data value');
  const result=visit(value,0) as Record<string,unknown>;
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>1024*1024)throw Error('Data value too large');
  return result;
}

/** Local business records. Callers must authenticate and authorize every operation. */
export class SqliteDataProvider implements DataProvider {
  readonly supportsSchemaRead=true;
  readonly supportsReverseList=true;
  readonly supportsIdPrefix=true;
  private readonly db:DatabaseSync;
  private readonly migrationMaxRecords:number;
  private readonly migrationMaxBytes:number;
  constructor(path:string,options:SqliteDataProviderOptions={}){
    const limits=options?.migrationLimits;if(!options||typeof options!=='object'||Array.isArray(options)||(limits!==undefined&&(!limits||typeof limits!=='object'||Array.isArray(limits)))||(limits?.maxRecords!==undefined&&(!Number.isSafeInteger(limits.maxRecords)||limits.maxRecords<1||limits.maxRecords>10000))||(limits?.maxBytes!==undefined&&(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1||limits.maxBytes>128*1024*1024)))throw Error('Invalid migration limits');
    this.migrationMaxRecords=limits?.maxRecords??1000;this.migrationMaxBytes=limits?.maxBytes??16*1024*1024;
    this.db=openDatabase(path);
    try {this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS business_records (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, collection_id TEXT NOT NULL,
        record_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant_id,application_id,collection_id,record_id)
      );
      CREATE TABLE IF NOT EXISTS business_collection_schema (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, collection_id TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,application_id,collection_id)
      );
      CREATE TABLE IF NOT EXISTS business_schema_migrations (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, collection_id TEXT NOT NULL, from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL, snapshot_digest TEXT NOT NULL, record_count INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,application_id,collection_id,to_version)
      );
      CREATE TABLE IF NOT EXISTS business_schema_rollbacks (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, collection_id TEXT NOT NULL, from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL, target_version INTEGER NOT NULL, snapshot_digest TEXT NOT NULL, record_count INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,application_id,collection_id,to_version)
      );
      CREATE TABLE IF NOT EXISTS business_schema_migration_audit (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, collection_id TEXT NOT NULL, from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL, target_version INTEGER, snapshot_digest TEXT NOT NULL, record_count INTEGER NOT NULL,
        actor_id TEXT NOT NULL, evidence TEXT NOT NULL, observed_at INTEGER NOT NULL, output_digest TEXT, plan_digest TEXT,
        PRIMARY KEY(tenant_id,application_id,collection_id,to_version)
      );
      CREATE TRIGGER IF NOT EXISTS business_migration_audit_no_replace BEFORE INSERT ON business_schema_migration_audit
        WHEN EXISTS (SELECT 1 FROM business_schema_migration_audit WHERE tenant_id=NEW.tenant_id AND application_id=NEW.application_id AND collection_id=NEW.collection_id AND to_version=NEW.to_version)
        BEGIN SELECT RAISE(ABORT, 'Migration audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migration_audit_no_update BEFORE UPDATE ON business_schema_migration_audit BEGIN SELECT RAISE(ABORT, 'Migration audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migration_audit_no_delete BEFORE DELETE ON business_schema_migration_audit BEGIN SELECT RAISE(ABORT, 'Migration audit is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_rollbacks_no_replace BEFORE INSERT ON business_schema_rollbacks
        WHEN EXISTS (SELECT 1 FROM business_schema_rollbacks WHERE tenant_id=NEW.tenant_id AND application_id=NEW.application_id AND collection_id=NEW.collection_id AND to_version=NEW.to_version)
        BEGIN SELECT RAISE(ABORT, 'Rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_rollbacks_no_update BEFORE UPDATE ON business_schema_rollbacks BEGIN SELECT RAISE(ABORT, 'Rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_rollbacks_no_delete BEFORE DELETE ON business_schema_rollbacks BEGIN SELECT RAISE(ABORT, 'Rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migrations_no_replace BEFORE INSERT ON business_schema_migrations
        WHEN EXISTS (SELECT 1 FROM business_schema_migrations WHERE tenant_id=NEW.tenant_id AND application_id=NEW.application_id AND collection_id=NEW.collection_id AND to_version=NEW.to_version)
        BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migrations_no_update BEFORE UPDATE ON business_schema_migrations BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migrations_no_delete BEFORE DELETE ON business_schema_migrations BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;`);
      this.db.exec('BEGIN IMMEDIATE');try{const columns=this.db.prepare('PRAGMA table_info(business_schema_migration_audit)').all();if(!columns.some(column=>column.name==='output_digest'))this.db.exec('ALTER TABLE business_schema_migration_audit ADD COLUMN output_digest TEXT');if(!columns.some(column=>column.name==='plan_digest'))this.db.exec('ALTER TABLE business_schema_migration_audit ADD COLUMN plan_digest TEXT');this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    } catch(error){this.db.close();throw error;}
  }
  close():void {this.db.close();}
  getSchemaVersion(scope:DataScope,collection:string):number {
    checkKey(scope,collection,'validation');
    const row=this.db.prepare('SELECT version FROM business_collection_schema WHERE tenant_id=? AND application_id=? AND collection_id=?').get(scope.tenantId,scope.applicationId,collection);
    const version=row?Number(row.version):0;if(!Number.isSafeInteger(version)||version<0)throw Error('Invalid schema version');return version;
  }
  private requireSchema(scope:DataScope,collection:string,expected:number|undefined):void {
    if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0))throw Error('Invalid schema version');
    if((expected??0)!==this.getSchemaVersion(scope,collection))throw new AppMixerError('conflict','Data schema version conflict');
  }
  private snapshot(scope:DataScope,collection:string):{preview:MigrationPreview;rows:DataRecord[]} {
    const version=this.getSchemaVersion(scope,collection),rows:DataRecord[]=[];let bytes=0;
    const statement=this.db.prepare('SELECT record_id,revision,value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND deleted=0 ORDER BY record_id LIMIT ?');
    for(const row of statement.iterate(scope.tenantId,scope.applicationId,collection,this.migrationMaxRecords+1)){
      if(rows.length===this.migrationMaxRecords)throw Error('Migration collection too large');
      const revision=Number(row.revision);if(!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER||typeof row.record_id!=='string'||typeof row.value!=='string')throw Error('Invalid migration record');
      bytes+=Buffer.byteLength(row.value,'utf8');if(bytes>this.migrationMaxBytes)throw Error('Migration collection too large');
      rows.push({id:row.record_id,revision,value:dataCopy(JSON.parse(row.value))});
    }
    const digest=createHash('sha256').update(JSON.stringify([scope.tenantId,scope.applicationId,collection,version,rows])).digest('hex');
    return {preview:{schemaVersion:version,count:rows.length,digest},rows};
  }
  previewMigration(scope:DataScope,collection:string):MigrationPreview {
    checkKey(scope,collection,'validation');this.db.exec('BEGIN');
    try {const {preview}=this.snapshot(scope,collection);this.db.exec('COMMIT');return preview;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Exercise a trusted plan against a consistent snapshot without changing records. */
  rehearseMigration(scope:DataScope,collection:string,plan:DataMigrationRehearsal):DataMigrationRehearsalResult {
    return this.rehearsePlan(scope,collection,plan);
  }
  /** Rehearse a compensating rollback and verify its target history in the same snapshot. */
  rehearseRollback(scope:DataScope,collection:string,plan:DataRollbackRehearsal):DataMigrationRehearsalResult {
    if(!plan||!Number.isSafeInteger(plan.fromVersion)||plan.fromVersion<1||plan.fromVersion>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(plan.targetVersion)||plan.targetVersion<0||plan.targetVersion>=plan.fromVersion)throw Error('Invalid data rollback');return this.rehearsePlan(scope,collection,plan,plan.targetVersion);
  }
  private rehearsePlan(scope:DataScope,collection:string,plan:DataMigrationRehearsal,rollbackTarget?:number):DataMigrationRehearsalResult {
    checkKey(scope,collection,'validation');if(!plan||!Number.isSafeInteger(plan.fromVersion)||plan.fromVersion<0||plan.fromVersion>=Number.MAX_SAFE_INTEGER||typeof plan.transform!=='function'||typeof plan.validate!=='function')throw Error('Invalid data migration rehearsal');
    const {fromVersion,transform,validate}=plan;scope={tenantId:scope.tenantId,applicationId:scope.applicationId};this.db.exec('BEGIN');try{const {preview,rows}=this.snapshot(scope,collection);if(preview.schemaVersion!==fromVersion)throw new AppMixerError('conflict','Migration snapshot conflict');if(rollbackTarget!==undefined)this.checkRollbackTarget(scope,collection,rollbackTarget);const transformed=this.transformMigrationRows(rows,transform,validate),outputDigest=this.migrationOutputDigest(preview.digest,transformed);this.db.exec('ROLLBACK');return {...preview,outputDigest};}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  private checkRollbackTarget(scope:DataScope,collection:string,targetVersion:number):void{if(targetVersion!==0&&!this.db.prepare('SELECT 1 FROM business_schema_migrations WHERE tenant_id=? AND application_id=? AND collection_id=? AND to_version=?').get(scope.tenantId,scope.applicationId,collection,targetVersion))throw Error('Rollback target not found');}
  private migrationOutputDigest(inputDigest:string,rows:DataRecord[]):string{return createHash('sha256').update(JSON.stringify(['app-mixer-migration-output-v1',inputDigest,rows])).digest('hex');}
  private transformMigrationRows(rows:DataRecord[],transform:DataMigration['transform'],validate:DataMigration['validate']):DataRecord[]{
    let bytes=0;return rows.map(row=>{const candidate:unknown=transform(dataCopy(row.value),row.id);if(candidate instanceof Promise)candidate.catch(()=>{});const value=dataCopy(candidate);const valid:unknown=validate(dataCopy(value),row.id);if(valid instanceof Promise)valid.catch(()=>{});if(valid!==true)throw Error('Migration validation failed');bytes+=Buffer.byteLength(JSON.stringify(value),'utf8');if(bytes>this.migrationMaxBytes)throw Error('Migration collection too large');return {...row,value};});
  }
  /** Restore a previous schema shape in a new monotonic generation. */
  rollbackCollection(scope:DataScope,collection:string,rollback:DataRollback):MigrationPreview {
    if(!rollback||!Number.isSafeInteger(rollback.fromVersion)||rollback.fromVersion<1||rollback.fromVersion>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(rollback.targetVersion)||rollback.targetVersion<0||rollback.targetVersion>=rollback.fromVersion)throw Error('Invalid data rollback');
    const {fromVersion,targetVersion,digest,outputDigest,planDigest,transform,validate,evidence}=rollback;return this.applyMigration(scope,collection,{fromVersion,toVersion:fromVersion+1,digest,outputDigest,planDigest,transform,validate,evidence},targetVersion);
  }
  rollbackHistory(scope:DataScope,collection:string,options:{after?:number;limit?:number}={}):{items:DataRollbackEvent[];nextAfter?:number}{
    checkKey(scope,collection,'validation');const after=options?.after??0,limit=options?.limit??50;if(!options||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid rollback history');
    const rows=this.db.prepare('SELECT from_version,to_version,target_version,snapshot_digest,record_count FROM business_schema_rollbacks WHERE tenant_id=? AND application_id=? AND collection_id=? AND to_version>? ORDER BY to_version LIMIT ?').all(scope.tenantId,scope.applicationId,collection,after,limit+1),items=rows.slice(0,limit).map(row=>({fromVersion:Number(row.from_version),toVersion:Number(row.to_version),targetVersion:Number(row.target_version),digest:String(row.snapshot_digest),recordCount:Number(row.record_count)}));return {items,...(rows.length>limit?{nextAfter:items.at(-1)!.toVersion}:{})};
  }
  /** Bounded actor-attributed history; the caller must separately authorize access. */
  migrationAudit(scope:DataScope,collection:string,options:{after?:number;before?:number;order?:'asc'|'desc';limit?:number}={}):{items:DataMigrationAuditEvent[];nextAfter?:number;nextBefore?:number}{
    checkKey(scope,collection,'validation');const order=options?.order??'asc',limit=options?.limit??50,after=options?.after??0,before=options?.before;if(!options||!['asc','desc'].includes(order)||!Number.isSafeInteger(after)||after<0||(before!==undefined&&(!Number.isSafeInteger(before)||before<1))||(order==='asc'&&before!==undefined)||(order==='desc'&&options.after!==undefined)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid migration audit');
    const sql='SELECT from_version,to_version,target_version,snapshot_digest,output_digest,plan_digest,record_count,actor_id,evidence,observed_at FROM business_schema_migration_audit WHERE tenant_id=? AND application_id=? AND collection_id=? AND '+(order==='asc'?'to_version>?':'(? IS NULL OR to_version<?)')+' ORDER BY to_version '+(order==='asc'?'ASC':'DESC')+' LIMIT ?',args=order==='asc'?[scope.tenantId,scope.applicationId,collection,after,limit+1]:[scope.tenantId,scope.applicationId,collection,before??null,before??null,limit+1];
    const rows=this.db.prepare(sql).all(...args),items=rows.slice(0,limit).map(row=>({fromVersion:Number(row.from_version),toVersion:Number(row.to_version),targetVersion:row.target_version===null?null:Number(row.target_version),digest:String(row.snapshot_digest),...(row.output_digest===null?{}:{outputDigest:String(row.output_digest)}),...(row.plan_digest===null?{}:{planDigest:String(row.plan_digest)}),recordCount:Number(row.record_count),principalId:String(row.actor_id),reference:String(row.evidence),observedAt:Number(row.observed_at)}));return {items,...(rows.length>limit?(order==='asc'?{nextAfter:items.at(-1)!.toVersion}:{nextBefore:items.at(-1)!.toVersion}):{})};
  }
  migrateCollection(scope:DataScope,collection:string,migration:DataMigration):MigrationPreview {return this.applyMigration(scope,collection,migration);}
  private applyMigration(scope:DataScope,collection:string,migration:DataMigration,rollbackTarget?:number):MigrationPreview {
    checkKey(scope,collection,'validation');
    if(!migration||!Number.isSafeInteger(migration.fromVersion)||migration.fromVersion<0||!Number.isSafeInteger(migration.toVersion)||migration.toVersion!==migration.fromVersion+1||typeof migration.digest!=='string'||!/^[a-f0-9]{64}$/.test(migration.digest)||(migration.outputDigest!==undefined&&(typeof migration.outputDigest!=='string'||!/^[a-f0-9]{64}$/.test(migration.outputDigest)))||(migration.planDigest!==undefined&&(typeof migration.planDigest!=='string'||!/^[a-f0-9]{64}$/.test(migration.planDigest)||migration.outputDigest===undefined))||typeof migration.transform!=='function'||typeof migration.validate!=='function')throw Error('Invalid data migration');
    const evidence=migration.evidence;if(evidence!==undefined&&(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||Object.keys(evidence).length!==3||!['principalId','reference','observedAt'].every(key=>Object.hasOwn(evidence,key))||!identifier(evidence.principalId)||typeof evidence.reference!=='string'||!evidence.reference.trim()||evidence.reference.length>512||/[\u0000-\u001f\u007f]/.test(evidence.reference)||!Number.isSafeInteger(evidence.observedAt)||evidence.observedAt<0))throw Error('Invalid migration evidence');
    const safeEvidence=evidence===undefined?undefined:{principalId:evidence.principalId,reference:evidence.reference,observedAt:evidence.observedAt};scope={tenantId:scope.tenantId,applicationId:scope.applicationId};
    const {fromVersion,toVersion,digest,outputDigest,planDigest,transform,validate}=migration;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const {preview,rows}=this.snapshot(scope,collection);
      if(preview.schemaVersion!==fromVersion||preview.digest!==digest)throw new AppMixerError('conflict','Migration snapshot conflict');
      if(rollbackTarget!==undefined)this.checkRollbackTarget(scope,collection,rollbackTarget);
      const transformed=this.transformMigrationRows(rows,transform,validate);
      if(outputDigest!==undefined&&this.migrationOutputDigest(preview.digest,transformed)!==outputDigest)throw new AppMixerError('conflict','Migration output conflict');
      if(planDigest!==undefined&&migrationPlanDigest(scope,collection,fromVersion,toVersion,rollbackTarget,preview.digest,outputDigest!)!==planDigest)throw new AppMixerError('conflict','Migration plan conflict');
      const update=this.db.prepare('UPDATE business_records SET revision=?,value=? WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND revision=? AND deleted=0');
      for(const row of transformed){const result=update.run(row.revision+1,JSON.stringify(row.value),scope.tenantId,scope.applicationId,collection,row.id,row.revision);if(result.changes!==1)throw new AppMixerError('conflict','Migration snapshot conflict');}
      this.db.prepare('INSERT INTO business_collection_schema VALUES (?,?,?,?) ON CONFLICT(tenant_id,application_id,collection_id) DO UPDATE SET version=excluded.version').run(scope.tenantId,scope.applicationId,collection,toVersion);
      this.db.prepare('INSERT INTO business_schema_migrations VALUES (?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,collection,fromVersion,toVersion,preview.digest,preview.count);
      if(rollbackTarget!==undefined)this.db.prepare('INSERT INTO business_schema_rollbacks VALUES (?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,collection,fromVersion,toVersion,rollbackTarget,preview.digest,preview.count);
      if(safeEvidence)this.db.prepare('INSERT INTO business_schema_migration_audit (tenant_id,application_id,collection_id,from_version,to_version,target_version,snapshot_digest,record_count,actor_id,evidence,observed_at,output_digest,plan_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,collection,fromVersion,toVersion,rollbackTarget??null,preview.digest,preview.count,safeEvidence.principalId,safeEvidence.reference,safeEvidence.observedAt,outputDigest??null,planDigest??null);
      const result=this.snapshot(scope,collection).preview;this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  get(scope:DataScope,collection:string,id:string,expectedSchemaVersion?:number):DataRecord|undefined {
    checkKey(scope,collection,id);
    const read=()=>{const row=this.db.prepare('SELECT revision,value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND deleted=0').get(scope.tenantId,scope.applicationId,collection,id);return row?{id,revision:Number(row.revision),value:dataCopy(JSON.parse(row.value as string))}:undefined;};
    if(expectedSchemaVersion===undefined)return read();
    this.db.exec('BEGIN');try{this.requireSchema(scope,collection,expectedSchemaVersion);const result=read();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  list(scope:DataScope,collection:string,options:{after?:string;limit?:number;expectedSchemaVersion?:number;order?:'asc'|'desc';idPrefix?:string}={}):DataRecordPage {
    checkKey(scope,collection,'validation');if(!options||typeof options!=='object'||Array.isArray(options)||(options.after!==undefined&&!identifier(options.after))||(options.order!==undefined&&options.order!=='asc'&&options.order!=='desc')||(options.idPrefix!==undefined&&(typeof options.idPrefix!=='string'||options.idPrefix.length>256||/[\u0000-\u001f]/.test(options.idPrefix)))||!Number.isSafeInteger(options.limit??50)||(options.limit??50)<1||(options.limit??50)>100)throw Error('Invalid data listing');
    const limit=options.limit??50,items:DataRecord[]=[];let bytes=0,more=false;
    // Read small metadata first and copy each BLOB separately; Node 22 SQLite text iteration can corrupt large values.
    this.db.exec('BEGIN');try{
      if(options.expectedSchemaVersion!==undefined)this.requireSchema(scope,collection,options.expectedSchemaVersion);
      const order=options.order??'asc',comparison=order==='desc'?'<':'>',sort=order==='desc'?'DESC':'ASC',prefix=options.idPrefix,upper=prefix===undefined?undefined:prefixSuccessor(prefix);const rows=this.db.prepare(`SELECT record_id,revision,length(CAST(value AS BLOB)) AS byte_size FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND deleted=0 ${prefix===undefined?'':'AND record_id>=? AND substr(record_id,1,length(?))=?'} ${upper===undefined?'':'AND record_id<?'} ${options.after===undefined?'':`AND record_id${comparison}?`} ORDER BY record_id ${sort} LIMIT ?`).all(scope.tenantId,scope.applicationId,collection,...(prefix===undefined?[]:[prefix,prefix,prefix]),...(upper===undefined?[]:[upper]),...(options.after===undefined?[]:[options.after]),limit+1);
      const read=this.db.prepare('SELECT CAST(value AS BLOB) AS value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND revision=? AND deleted=0');
      for(const row of rows){if(typeof row.record_id!=='string'||!identifier(row.record_id)||!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1||!Number.isSafeInteger(Number(row.byte_size))||Number(row.byte_size)<0)throw Error('Invalid data record');const size=Number(row.byte_size);if(items.length===limit||(items.length>0&&bytes+size>512*1024)){more=true;break;}const data=read.get(scope.tenantId,scope.applicationId,collection,row.record_id,row.revision as number);if(!data||!(data.value instanceof Uint8Array))throw Error('Invalid data record');items.push({id:row.record_id,revision:Number(row.revision),value:dataCopy(JSON.parse(Buffer.from(data.value).toString('utf8')))});bytes+=size;}
      this.db.exec('COMMIT');return {items,...(more&&items.length?{nextAfter:items.at(-1)!.id}:{})};
    }catch(error){this.db.exec('ROLLBACK');throw error;}

  }
  /** Verify returned records in one read snapshot after asynchronous policies finish. */
  verifyListPage(scope:DataScope,collection:string,items:DataRecord[],expectedSchemaVersion?:number):boolean {
    checkKey(scope,collection,'validation');scope={tenantId:scope.tenantId,applicationId:scope.applicationId};
    if(!Array.isArray(items)||items.length>100)throw Error('Invalid data listing');
    const ids=new Set<string>();let bytes=0;
    const safe=items.map(item=>{if(!item||!identifier(item.id)||ids.has(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1)throw Error('Invalid data listing');ids.add(item.id);const value=dataCopy(item.value);bytes+=Buffer.byteLength(JSON.stringify(value),'utf8');if(bytes>1024*1024)throw Error('Invalid data listing');return {id:item.id,revision:item.revision,value};});
    this.db.exec('BEGIN');try{
      if(expectedSchemaVersion!==undefined)this.requireSchema(scope,collection,expectedSchemaVersion);
      const read=this.db.prepare('SELECT revision,CAST(value AS BLOB) AS value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND deleted=0');
      let valid=true;for(const item of safe){const row=read.get(scope.tenantId,scope.applicationId,collection,item.id);if(!row||Number(row.revision)!==item.revision||!(row.value instanceof Uint8Array)||!isDeepStrictEqual(dataCopy(JSON.parse(Buffer.from(row.value).toString('utf8'))),item.value)){valid=false;break;}}
      this.db.exec('COMMIT');return valid;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  put(scope:DataScope,collection:string,id:string,value:Record<string,unknown>,expectedRevision:number|null,expectedSchemaVersion?:number):DataRecord {
    checkKey(scope,collection,id);
    if(expectedRevision!==null&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER))throw Error('Invalid revision');
    const safe=dataCopy(value),serialized=JSON.stringify(safe);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireSchema(scope,collection,expectedSchemaVersion);
      const current=this.db.prepare('SELECT revision,deleted FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=?').get(scope.tenantId,scope.applicationId,collection,id);
      if((current && Number(current.deleted)===0 ? Number(current.revision) : null)!==expectedRevision)throw new AppMixerError('conflict','Data revision conflict');
      const prior=current ? Number(current.revision) : 0;
      if(!Number.isSafeInteger(prior)||prior>=Number.MAX_SAFE_INTEGER)throw Error('Invalid revision');
      const revision=prior+1;
      this.db.prepare('INSERT INTO business_records VALUES (?,?,?,?,?,?,0) ON CONFLICT(tenant_id,application_id,collection_id,record_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,deleted=0').run(scope.tenantId,scope.applicationId,collection,id,revision,serialized);
      this.db.exec('COMMIT');return {id,revision,value:dataCopy(safe)};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  delete(scope:DataScope,collection:string,id:string,expectedRevision:number,expectedSchemaVersion?:number):void {
    checkKey(scope,collection,id);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid revision');
    this.db.exec('BEGIN IMMEDIATE');
    try {this.requireSchema(scope,collection,expectedSchemaVersion);
      const result=this.db.prepare("UPDATE business_records SET revision=revision+1,deleted=1,value='{}' WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND revision=? AND deleted=0").run(scope.tenantId,scope.applicationId,collection,id,expectedRevision);
      if(result.changes!==1)throw new AppMixerError('conflict','Data revision conflict');this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /**
   * Host-authorized retention: physically delete up to `limit` (1 to 1,000) deleted-record tombstones of one collection, lowest id first, and return the count.
   * A tombstone keeps the record ID's revision counter, so a compacted ID restarts at revision 1 when written again; compact only IDs no client can still hold a revision for.
   */
  compactTombstones(scope:DataScope,collection:string,options:{limit:number}):number {
    checkKey(scope,collection,'tombstones');
    if(!options||typeof options!=='object'||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>1000)throw Error('Invalid tombstone compaction');
    return Number(this.db.prepare('DELETE FROM business_records WHERE rowid IN (SELECT rowid FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND deleted=1 ORDER BY record_id LIMIT ?)').run(scope.tenantId,scope.applicationId,collection,options.limit).changes);
  }
}
