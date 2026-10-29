import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {CapabilityRegistry, type InvocationContext} from './capabilities.js';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';

export type StagedStatus='staged'|'submitting'|'uncertain'|'succeeded';
export type StagedOperation={id:string;operationId:string;idempotencyKey:string;payload:Record<string,unknown>;status:StagedStatus};

/** Durable staging; the host authorizes stage/read/recovery and the capability authorizes submission. */
export class SqliteStagedOperations {
  private readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    try {this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS staged_business_operations (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, id TEXT NOT NULL,
        operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('staged','submitting','uncertain','succeeded')),
        PRIMARY KEY(tenant_id,application_id,id), UNIQUE(idempotency_key)
      );`);}catch(error){this.db.close();throw error;}
  }
  close():void {this.db.close();}
  stage(scope:DataScope,operationId:string,payload:Record<string,unknown>):StagedOperation {
    checkKey(scope,operationId,'stage');
    const id=randomUUID(),idempotencyKey=randomUUID(),safe=dataCopy(payload);
    this.db.prepare('INSERT INTO staged_business_operations VALUES (?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,id,operationId,idempotencyKey,JSON.stringify(safe),'staged');
    return {id,operationId,idempotencyKey,payload:dataCopy(safe),status:'staged'};
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
