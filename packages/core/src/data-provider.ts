import {DatabaseSync} from 'node:sqlite';

export type DataScope = {tenantId:string; applicationId:string};
export type DataRecord = {id:string; revision:number; value:Record<string,unknown>};
export interface DataProvider {
  get(scope:DataScope, collection:string, id:string):DataRecord|undefined;
  put(scope:DataScope, collection:string, id:string, value:Record<string,unknown>, expectedRevision:number|null):DataRecord;
  delete(scope:DataScope, collection:string, id:string, expectedRevision:number):void;
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
  private readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    try {this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS business_records (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, collection_id TEXT NOT NULL,
        record_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant_id,application_id,collection_id,record_id)
      );`);} catch(error){this.db.close();throw error;}
  }
  close():void {this.db.close();}
  get(scope:DataScope,collection:string,id:string):DataRecord|undefined {
    checkKey(scope,collection,id);
    const row=this.db.prepare('SELECT revision,value FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND deleted=0').get(scope.tenantId,scope.applicationId,collection,id);
    if(!row)return undefined;
    return {id,revision:Number(row.revision),value:dataCopy(JSON.parse(row.value as string))};
  }
  put(scope:DataScope,collection:string,id:string,value:Record<string,unknown>,expectedRevision:number|null):DataRecord {
    checkKey(scope,collection,id);
    if(expectedRevision!==null&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER))throw Error('Invalid revision');
    const safe=dataCopy(value),serialized=JSON.stringify(safe);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.db.prepare('SELECT revision,deleted FROM business_records WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=?').get(scope.tenantId,scope.applicationId,collection,id);
      if((current && Number(current.deleted)===0 ? Number(current.revision) : null)!==expectedRevision)throw Error('Data revision conflict');
      const prior=current ? Number(current.revision) : 0;
      if(!Number.isSafeInteger(prior)||prior>=Number.MAX_SAFE_INTEGER)throw Error('Invalid revision');
      const revision=prior+1;
      this.db.prepare('INSERT INTO business_records VALUES (?,?,?,?,?,?,0) ON CONFLICT(tenant_id,application_id,collection_id,record_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,deleted=0').run(scope.tenantId,scope.applicationId,collection,id,revision,serialized);
      this.db.exec('COMMIT');return {id,revision,value:dataCopy(safe)};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  delete(scope:DataScope,collection:string,id:string,expectedRevision:number):void {
    checkKey(scope,collection,id);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid revision');
    const result=this.db.prepare("UPDATE business_records SET revision=revision+1,deleted=1,value='{}' WHERE tenant_id=? AND application_id=? AND collection_id=? AND record_id=? AND revision=? AND deleted=0").run(scope.tenantId,scope.applicationId,collection,id,expectedRevision);
    if(result.changes!==1)throw Error('Data revision conflict');
  }
}
