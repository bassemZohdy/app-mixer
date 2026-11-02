import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CapabilityRegistry, type InvocationContext} from './capabilities.js';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';

export type StagedStatus='staged'|'submitting'|'uncertain'|'succeeded';
export type StagedOperation={id:string;operationId:string;idempotencyKey:string;payload:Record<string,unknown>;status:StagedStatus};
export type StagedVerificationOutcome='applied'|'not_applied'|'unknown';
export type StagedReconciliationEvidence={principalId:string;reference:string};
export type StagedReconciliationRecord=StagedReconciliationEvidence & {revision:number;outcome:'applied'|'not_applied';recordedAt:number};
export type StagedOutcomeVerifier=(scope:DataScope,operation:StagedOperation)=>StagedVerificationOutcome|Promise<StagedVerificationOutcome>;

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
          request_key TEXT, state_revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id,application_id,id), UNIQUE(idempotency_key)
        );`);
        const columns=this.db.prepare('PRAGMA table_info(staged_business_operations)').all();
        if(!columns.some(column=>column.name==='request_key'))this.db.exec('ALTER TABLE staged_business_operations ADD COLUMN request_key TEXT');
        if(!columns.some(column=>column.name==='state_revision'))this.db.exec('ALTER TABLE staged_business_operations ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0');
        this.db.exec(`CREATE TABLE IF NOT EXISTS staged_reconciliation_evidence (tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,operation_id TEXT NOT NULL,revision INTEGER NOT NULL,principal_id TEXT NOT NULL,reference TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('applied','not_applied')),recorded_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,application_id,operation_id,revision));`);
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS staged_evidence_no_update BEFORE UPDATE ON staged_reconciliation_evidence BEGIN SELECT RAISE(ABORT,'Staged evidence is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS staged_evidence_no_delete BEFORE DELETE ON staged_reconciliation_evidence BEGIN SELECT RAISE(ABORT,'Staged evidence is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS staged_evidence_no_replace BEFORE INSERT ON staged_reconciliation_evidence WHEN EXISTS(SELECT 1 FROM staged_reconciliation_evidence WHERE tenant_id=NEW.tenant_id AND application_id=NEW.application_id AND operation_id=NEW.operation_id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'Staged evidence is immutable'); END;`);
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
    const snapshotScope={tenantId:scope.tenantId,applicationId:scope.applicationId};
    // Reserve one revision each for claim, outcome, and a possible reconciliation.
    const claim=this.db.prepare("UPDATE staged_business_operations SET status='submitting',state_revision=state_revision+1 WHERE tenant_id=? AND application_id=? AND id=? AND status='staged' AND state_revision<=?").run(snapshotScope.tenantId,snapshotScope.applicationId,id,Number.MAX_SAFE_INTEGER-3);
    if(claim.changes!==1)throw Error('Operation not staged or revision exhausted');
    const operation=this.get(snapshotScope,id)!;
    try {
      const result=await registry.invoke(operation.operationId,{idempotencyKey:operation.idempotencyKey,payload:operation.payload},context);
      this.transition(snapshotScope,id,'submitting','succeeded');return result;
    } catch(error) {
      // Even an error can follow an external effect or failed outcome audit; never retry automatically.
      this.transition(snapshotScope,id,'submitting','uncertain');throw error;
    }
  }
  /** Call only after confirming that the process which submitted the operation is no longer running. */
  recoverAbandoned(scope:DataScope,id:string):void {this.transition(scope,id,'submitting','uncertain');}
  /** The authorized host must independently verify the external outcome before resolving uncertainty. */
  reconcile(scope:DataScope,id:string,outcome:'applied'|'not_applied'):void {
    if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid reconciliation');
    this.transition(scope,id,'uncertain',outcome==='applied'?'succeeded':'staged');
  }
  /** Verify externally without dispatching, then apply only if the uncertain state is unchanged. */
  async verifyAndReconcile(scope:DataScope,id:string,verify:StagedOutcomeVerifier,evidence?:StagedReconciliationEvidence):Promise<StagedVerificationOutcome> {
    checkKey(scope,'staged',id);if(typeof verify!=='function')throw Error('Invalid staged verifier');
    const snapshotScope={tenantId:scope.tenantId,applicationId:scope.applicationId};const safeEvidence=evidence===undefined?undefined:this.checkEvidence(snapshotScope,evidence);
    const row=this.db.prepare('SELECT operation_id,idempotency_key,payload,status,state_revision FROM staged_business_operations WHERE tenant_id=? AND application_id=? AND id=?').get(snapshotScope.tenantId,snapshotScope.applicationId,id);
    if(!row||row.status!=='uncertain'||!Number.isSafeInteger(row.state_revision)||Number(row.state_revision)<0)throw Error('Invalid operation state');
    const operation:StagedOperation={id,operationId:row.operation_id as string,idempotencyKey:row.idempotency_key as string,payload:dataCopy(JSON.parse(row.payload as string)),status:'uncertain'};
    const outcome=await verify({...snapshotScope},operation);
    if(outcome!=='applied'&&outcome!=='not_applied'&&outcome!=='unknown')throw Error('Invalid verification outcome');
    if(outcome==='unknown')return outcome;
    this.finishReconciliation(snapshotScope,id,outcome,safeEvidence,row.state_revision as number);return outcome;
  }
  /** Host-authorized manual decision with atomic actor-attributed evidence. */
  reconcileWithEvidence(scope:DataScope,id:string,outcome:'applied'|'not_applied',evidence:StagedReconciliationEvidence):void {
    checkKey(scope,'staged',id);if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid reconciliation');
    this.finishReconciliation(scope,id,outcome,this.checkEvidence(scope,evidence));
  }
  /** Host must authorize access to this tenant/application and protect the returned references. */
  listReconciliationEvidence(scope:DataScope,id:string,options:{after?:number;limit?:number}={}):StagedReconciliationRecord[] {
    checkKey(scope,'staged',id);const after=options?.after??0,limit=options?.limit??100;if(!options||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid reconciliation query');
    return this.db.prepare('SELECT revision,principal_id,reference,outcome,recorded_at FROM staged_reconciliation_evidence WHERE tenant_id=? AND application_id=? AND operation_id=? AND revision>? ORDER BY revision LIMIT ?').all(scope.tenantId,scope.applicationId,id,after,limit).map(row=>({revision:row.revision as number,principalId:row.principal_id as string,reference:row.reference as string,outcome:row.outcome as 'applied'|'not_applied',recordedAt:row.recorded_at as number}));
  }
  private checkEvidence(scope:DataScope,evidence:StagedReconciliationEvidence):StagedReconciliationEvidence {
    if(!evidence||typeof evidence!=='object')throw Error('Invalid reconciliation evidence');checkKey(scope,'evidence',evidence.principalId);checkKey(scope,'evidence',evidence.reference);return {principalId:evidence.principalId,reference:evidence.reference};
  }
  private finishReconciliation(scope:DataScope,id:string,outcome:'applied'|'not_applied',evidence:StagedReconciliationEvidence|undefined,expectedRevision?:number):void {
    this.db.exec('BEGIN IMMEDIATE');try {
      const row=this.db.prepare("UPDATE staged_business_operations SET status=?,state_revision=state_revision+1 WHERE tenant_id=? AND application_id=? AND id=? AND status='uncertain' AND (? IS NULL OR state_revision=?) AND state_revision<9007199254740991 RETURNING state_revision").get(outcome==='applied'?'succeeded':'staged',scope.tenantId,scope.applicationId,id,expectedRevision??null,expectedRevision??null);
      if(!row)throw Error(expectedRevision===undefined?'Invalid operation state':'Stale staged verification');
      if(evidence)this.db.prepare('INSERT INTO staged_reconciliation_evidence (tenant_id,application_id,operation_id,revision,principal_id,reference,outcome,recorded_at) VALUES (?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,id,row.state_revision as number,evidence.principalId,evidence.reference,outcome,Date.now());
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private transition(scope:DataScope,id:string,from:StagedStatus,to:StagedStatus):void {
    checkKey(scope,'staged',id);
    const result=this.db.prepare('UPDATE staged_business_operations SET status=?,state_revision=state_revision+1 WHERE tenant_id=? AND application_id=? AND id=? AND status=? AND state_revision<9007199254740991').run(to,scope.tenantId,scope.applicationId,id,from);
    if(result.changes!==1)throw Error('Invalid operation state');
  }
}
