import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CapabilityRegistry, type InvocationContext} from './capabilities.js';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';

export type StagedStatus='staged'|'submitting'|'uncertain'|'succeeded';
export type StagedOperation={id:string;operationId:string;idempotencyKey:string;payload:Record<string,unknown>;status:StagedStatus};

/** Durable staging; the host authorizes stage/read/recovery and the capability authorizes submission. */
export class SqliteStagedOperations {
  private readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS staged_business_operations (
          tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, id TEXT NOT NULL,
          operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('staged','submitting','uncertain','succeeded')),
          request_key TEXT, PRIMARY KEY(tenant_id,application_id,id), UNIQUE(idempotency_key)
        );`);
        const columns=this.db.prepare('PRAGMA table_info(staged_business_operations)').all();
        if(!columns.some(column=>column.name==='request_key'))this.db.exec('ALTER TABLE staged_business_operations ADD COLUMN request_key TEXT');
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS staged_request_keys ON staged_business_operations(tenant_id,application_id,request_key) WHERE request_key IS NOT NULL');
        this.db.exec('COMMIT');
      } catch(error){this.db.exec('ROLLBACK');throw error;}
    }catch(error){this.db.close();throw error;}
  }
  close():void {this.db.close();}
  stage(scope:DataScope,operationId:string,payload:Record<string,unknown>,requestKey?:string):StagedOperation {
    checkKey(scope,operationId,'stage');
    if(requestKey!==undefined)checkKey(scope,'request',requestKey);
    const safe=dataCopy(payload),serialized=JSON.stringify(safe),normalized=JSON.parse(serialized) as Record<string,unknown>;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(requestKey!==undefined){
        const existing=this.db.prepare('SELECT id,operation_id,payload FROM staged_business_operations WHERE tenant_id=? AND application_id=? AND request_key=?').get(scope.tenantId,scope.applicationId,requestKey);
        if(existing){
          if(existing.operation_id!==operationId||!isDeepStrictEqual(JSON.parse(existing.payload as string),normalized))throw Error('Staging request conflict');
          const result=this.get(scope,existing.id as string)!;this.db.exec('COMMIT');return result;
        }
      }
      const id=randomUUID(),idempotencyKey=randomUUID();
      this.db.prepare('INSERT INTO staged_business_operations (tenant_id,application_id,id,operation_id,idempotency_key,payload,status,request_key) VALUES (?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,id,operationId,idempotencyKey,serialized,'staged',requestKey??null);
      this.db.exec('COMMIT');return {id,operationId,idempotencyKey,payload:dataCopy(normalized),status:'staged'};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  get(scope:DataScope,id:string):StagedOperation|undefined {
    checkKey(scope,'staged',id);
    const row=this.db.prepare('SELECT operation_id,idempotency_key,payload,status FROM staged_business_operations WHERE tenant_id=? AND application_id=? AND id=?').get(scope.tenantId,scope.applicationId,id);
    if(!row)return undefined;
    return {id,operationId:row.operation_id as string,idempotencyKey:row.idempotency_key as string,payload:dataCopy(JSON.parse(row.payload as string)),status:row.status as StagedStatus};
  }
  async submit(scope:DataScope,id:string,registry:CapabilityRegistry,context:InvocationContext):Promise<unknown> {
    checkKey(scope,'staged',id);
    if(!(registry instanceof CapabilityRegistry)||!context||context.tenantId!==scope.tenantId)throw Error('Invalid submission context');
    const claim=this.db.prepare("UPDATE staged_business_operations SET status='submitting' WHERE tenant_id=? AND application_id=? AND id=? AND status='staged'").run(scope.tenantId,scope.applicationId,id);
    if(claim.changes!==1)throw Error('Operation not staged');
    const operation=this.get(scope,id)!;
    try {
      const result=await registry.invoke(operation.operationId,{idempotencyKey:operation.idempotencyKey,payload:operation.payload},context);
      this.transition(scope,id,'submitting','succeeded');return result;
    } catch(error) {
      // Even an error can follow an external effect or failed outcome audit; never retry automatically.
      this.transition(scope,id,'submitting','uncertain');throw error;
    }
  }
  /** Call only after confirming that the process which submitted the operation is no longer running. */
  recoverAbandoned(scope:DataScope,id:string):void {this.transition(scope,id,'submitting','uncertain');}
  /** The authorized host must independently verify the external outcome before resolving uncertainty. */
  reconcile(scope:DataScope,id:string,outcome:'applied'|'not_applied'):void {
    if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid reconciliation');
    this.transition(scope,id,'uncertain',outcome==='applied'?'succeeded':'staged');
  }
  private transition(scope:DataScope,id:string,from:StagedStatus,to:StagedStatus):void {
    checkKey(scope,'staged',id);
    const result=this.db.prepare('UPDATE staged_business_operations SET status=? WHERE tenant_id=? AND application_id=? AND id=? AND status=?').run(to,scope.tenantId,scope.applicationId,id,from);
    if(result.changes!==1)throw Error('Invalid operation state');
  }
}
