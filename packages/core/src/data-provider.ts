import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';

export type DataScope = {tenantId:string; applicationId:string};
export type DataRecord = {id:string; revision:number; value:Record<string,unknown>};
export type DataRecordPage = {items:DataRecord[];nextAfter?:string};
export type MigrationPreview={schemaVersion:number;count:number;digest:string};
export type DataMigration={fromVersion:number;toVersion:number;digest:string;transform:(value:Record<string,unknown>,id:string)=>Record<string,unknown>;validate:(value:Record<string,unknown>,id:string)=>boolean};
export type DataRollback={fromVersion:number;targetVersion:number;digest:string;transform:DataMigration['transform'];validate:DataMigration['validate']};
export type DataRollbackEvent={fromVersion:number;toVersion:number;targetVersion:number;digest:string;recordCount:number};
export interface DataProvider {
  readonly supportsSchemaRead?:boolean;
  get(scope:DataScope, collection:string, id:string,expectedSchemaVersion?:number):DataRecord|undefined;
  list?(scope:DataScope,collection:string,options?:{after?:string;limit?:number;expectedSchemaVersion?:number}):DataRecordPage;
  put(scope:DataScope, collection:string, id:string, value:Record<string,unknown>, expectedRevision:number|null,expectedSchemaVersion?:number):DataRecord;
  delete(scope:DataScope, collection:string, id:string, expectedRevision:number,expectedSchemaVersion?:number):void;
}
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
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
  private readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
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
      CREATE TRIGGER IF NOT EXISTS business_rollbacks_no_replace BEFORE INSERT ON business_schema_rollbacks
        WHEN EXISTS (SELECT 1 FROM business_schema_rollbacks WHERE tenant_id=NEW.tenant_id AND application_id=NEW.application_id AND collection_id=NEW.collection_id AND to_version=NEW.to_version)
        BEGIN SELECT RAISE(ABORT, 'Rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_rollbacks_no_update BEFORE UPDATE ON business_schema_rollbacks BEGIN SELECT RAISE(ABORT, 'Rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_rollbacks_no_delete BEFORE DELETE ON business_schema_rollbacks BEGIN SELECT RAISE(ABORT, 'Rollback history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migrations_no_replace BEFORE INSERT ON business_schema_migrations
        WHEN EXISTS (SELECT 1 FROM business_schema_migrations WHERE tenant_id=NEW.tenant_id AND application_id=NEW.application_id AND collection_id=NEW.collection_id AND to_version=NEW.to_version)
        BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migrations_no_update BEFORE UPDATE ON business_schema_migrations BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS business_migrations_no_delete BEFORE DELETE ON business_schema_migrations BEGIN SELECT RAISE(ABORT, 'Migration history is immutable'); END;`);} catch(error){this.db.close();throw error;}
  }
  close():void {this.db.close();}
  getSchemaVersion(scope:DataScope,collection:string):number {
    checkKey(scope,collection,'validation');
    const row=this.db.prepare('SELECT version FROM business_collection_schema WHERE tenant_id=? AND application_id=? AND collection_id=?').get(scope.tenantId,scope.applicationId,collection);
    const version=row?Number(row.version):0;if(!Number.isSafeInteger(version)||version<0)throw Error('Invalid schema version');return version;
  }
  private requireSchema(scope:DataScope,collection:string,expected:number|undefined):void {
    if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0))throw Error('Invalid schema version');
    if((expected??0)!==this.getSchemaVersion(scope,collection))throw Error('Data schema version conflict');
  }
  private snapshot(scope:DataScope,collection:string):{preview:MigrationPreview;rows:DataRecord[]} {
    const version=this.getSchemaVersion(scope,collection),rows:DataRecord[]=[];let bytes=0;
    const statement=this.db.prepare('SELECT record_id,revision,value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND deleted=0 ORDER BY record_id LIMIT 1001');
    for(const row of statement.iterate(scope.tenantId,scope.applicationId,collection)){
      if(rows.length===1000)throw Error('Migration collection too large');
      const revision=Number(row.revision);if(!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER||typeof row.record_id!=='string'||typeof row.value!=='string')throw Error('Invalid migration record');
      bytes+=Buffer.byteLength(row.value,'utf8');if(bytes>16*1024*1024)throw Error('Migration collection too large');
      rows.push({id:row.record_id,revision,value:dataCopy(JSON.parse(row.value))});
    }
    const digest=createHash('sha256').update(JSON.stringify([scope.tenantId,scope.applicationId,collection,version,rows])).digest('hex');
    return {preview:{schemaVersion:version,count:rows.length,digest},rows};
  }
  previewMigration(scope:DataScope,collection:string):MigrationPreview {
    checkKey(scope,collection,'validation');this.db.exec('BEGIN');
    try {const {preview}=this.snapshot(scope,collection);this.db.exec('COMMIT');return preview;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Restore a previous schema shape in a new monotonic generation. */
  rollbackCollection(scope:DataScope,collection:string,rollback:DataRollback):MigrationPreview {
    if(!rollback||!Number.isSafeInteger(rollback.fromVersion)||rollback.fromVersion<1||rollback.fromVersion>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(rollback.targetVersion)||rollback.targetVersion<0||rollback.targetVersion>=rollback.fromVersion)throw Error('Invalid data rollback');
    const {fromVersion,targetVersion,digest,transform,validate}=rollback;return this.applyMigration(scope,collection,{fromVersion,toVersion:fromVersion+1,digest,transform,validate},targetVersion);
  }
  rollbackHistory(scope:DataScope,collection:string,options:{after?:number;limit?:number}={}):{items:DataRollbackEvent[];nextAfter?:number}{
    checkKey(scope,collection,'validation');const after=options?.after??0,limit=options?.limit??50;if(!options||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid rollback history');
    const rows=this.db.prepare('SELECT from_version,to_version,target_version,snapshot_digest,record_count FROM business_schema_rollbacks WHERE tenant_id=? AND application_id=? AND collection_id=? AND to_version>? ORDER BY to_version LIMIT ?').all(scope.tenantId,scope.applicationId,collection,after,limit+1),items=rows.slice(0,limit).map(row=>({fromVersion:Number(row.from_version),toVersion:Number(row.to_version),targetVersion:Number(row.target_version),digest:String(row.snapshot_digest),recordCount:Number(row.record_count)}));return {items,...(rows.length>limit?{nextAfter:items.at(-1)!.toVersion}:{})};
  }
  migrateCollection(scope:DataScope,collection:string,migration:DataMigration):MigrationPreview {return this.applyMigration(scope,collection,migration);}
  private applyMigration(scope:DataScope,collection:string,migration:DataMigration,rollbackTarget?:number):MigrationPreview {
    checkKey(scope,collection,'validation');
    if(!migration||!Number.isSafeInteger(migration.fromVersion)||migration.fromVersion<0||!Number.isSafeInteger(migration.toVersion)||migration.toVersion!==migration.fromVersion+1||typeof migration.digest!=='string'||!/^[a-f0-9]{64}$/.test(migration.digest)||typeof migration.transform!=='function'||typeof migration.validate!=='function')throw Error('Invalid data migration');
    scope={tenantId:scope.tenantId,applicationId:scope.applicationId};
    const {fromVersion,toVersion,digest,transform,validate}=migration;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const {preview,rows}=this.snapshot(scope,collection);
      if(preview.schemaVersion!==fromVersion||preview.digest!==digest)throw Error('Migration snapshot conflict');
      if(rollbackTarget!==undefined&&rollbackTarget!==0&&!this.db.prepare('SELECT 1 FROM business_schema_migrations WHERE tenant_id=? AND application_id=? AND collection_id=? AND to_version=?').get(scope.tenantId,scope.applicationId,collection,rollbackTarget))throw Error('Rollback target not found');
      const transformed=rows.map(row=>{const candidate:unknown=transform(dataCopy(row.value),row.id);if(candidate instanceof Promise)candidate.catch(()=>{});const value=dataCopy(candidate);const valid:unknown=validate(dataCopy(value),row.id);if(valid instanceof Promise)valid.catch(()=>{});if(valid!==true)throw Error('Migration validation failed');return {...row,value};});
      const update=this.db.prepare('UPDATE business_records SET revision=?,value=? WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND revision=? AND deleted=0');
      for(const row of transformed){const result=update.run(row.revision+1,JSON.stringify(row.value),scope.tenantId,scope.applicationId,collection,row.id,row.revision);if(result.changes!==1)throw Error('Migration snapshot conflict');}
      this.db.prepare('INSERT INTO business_collection_schema VALUES (?,?,?,?) ON CONFLICT(tenant_id,application_id,collection_id) DO UPDATE SET version=excluded.version').run(scope.tenantId,scope.applicationId,collection,toVersion);
      this.db.prepare('INSERT INTO business_schema_migrations VALUES (?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,collection,fromVersion,toVersion,preview.digest,preview.count);
      if(rollbackTarget!==undefined)this.db.prepare('INSERT INTO business_schema_rollbacks VALUES (?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,collection,fromVersion,toVersion,rollbackTarget,preview.digest,preview.count);
      const result=this.snapshot(scope,collection).preview;this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  get(scope:DataScope,collection:string,id:string,expectedSchemaVersion?:number):DataRecord|undefined {
    checkKey(scope,collection,id);
    const read=()=>{const row=this.db.prepare('SELECT revision,value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND deleted=0').get(scope.tenantId,scope.applicationId,collection,id);return row?{id,revision:Number(row.revision),value:dataCopy(JSON.parse(row.value as string))}:undefined;};
    if(expectedSchemaVersion===undefined)return read();
    this.db.exec('BEGIN');try{this.requireSchema(scope,collection,expectedSchemaVersion);const result=read();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  list(scope:DataScope,collection:string,options:{after?:string;limit?:number;expectedSchemaVersion?:number}={}):DataRecordPage {
    checkKey(scope,collection,'validation');if(!options||typeof options!=='object'||Array.isArray(options)||(options.after!==undefined&&!identifier(options.after))||!Number.isSafeInteger(options.limit??50)||(options.limit??50)<1||(options.limit??50)>100)throw Error('Invalid data listing');
    const limit=options.limit??50,items:DataRecord[]=[];let bytes=0,more=false;
    // Read small metadata first and copy each BLOB separately; Node 22 SQLite text iteration can corrupt large values.
    this.db.exec('BEGIN');try{
      if(options.expectedSchemaVersion!==undefined)this.requireSchema(scope,collection,options.expectedSchemaVersion);
      const rows=this.db.prepare('SELECT record_id,revision,length(CAST(value AS BLOB)) AS byte_size FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND deleted=0 AND record_id>? ORDER BY record_id LIMIT ?').all(scope.tenantId,scope.applicationId,collection,options.after??'',limit+1);
      const read=this.db.prepare('SELECT CAST(value AS BLOB) AS value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND revision=? AND deleted=0');
      for(const row of rows){if(typeof row.record_id!=='string'||!identifier(row.record_id)||!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1||!Number.isSafeInteger(Number(row.byte_size))||Number(row.byte_size)<0)throw Error('Invalid data record');const size=Number(row.byte_size);if(items.length===limit||(items.length>0&&bytes+size>512*1024)){more=true;break;}const data=read.get(scope.tenantId,scope.applicationId,collection,row.record_id,row.revision as number);if(!data||!(data.value instanceof Uint8Array))throw Error('Invalid data record');items.push({id:row.record_id,revision:Number(row.revision),value:dataCopy(JSON.parse(Buffer.from(data.value).toString('utf8')))});bytes+=size;}
      this.db.exec('COMMIT');return {items,...(more&&items.length?{nextAfter:items.at(-1)!.id}:{})};
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
      if((current && Number(current.deleted)===0 ? Number(current.revision) : null)!==expectedRevision)throw Error('Data revision conflict');
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
      if(result.changes!==1)throw Error('Data revision conflict');this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
