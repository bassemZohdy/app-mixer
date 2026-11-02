import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CapabilityRegistry,CapabilityOutcomeUncertainError, type InvocationContext} from './capabilities.js';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';

export type OfflineStatus='pending'|'running'|'conflict'|'uncertain'|'exhausted'|'succeeded'|'discarded';
export type OfflineOperation={id:string;operationId:string;requestKey:string;idempotencyKey:string;payload:Record<string,unknown>;status:OfflineStatus;attempts:number;nextAttemptAt:number};
export type OfflineQueueOptions={enabled:true;maxAttempts:number;retryDelayMs:number};
export type OfflineFailure='retry'|'conflict'|'uncertain';
export type OfflineRecoveryCandidate={id:string;status:'running'|'uncertain';attempts:number};
export type OfflineRecoveryCandidatePage={items:OfflineRecoveryCandidate[];nextAfter?:string};
export type SqliteOfflineRecoveryEvidence={operatorId:string;reference:string};
export type SqliteOfflineRecoveryEvent=SqliteOfflineRecoveryEvidence & {id:number;action:'recover'|'applied'|'not_applied';recordedAt:number};

/** Local durable queue. The host owns secure storage, access control, and safe retry classification. */
export class SqliteOfflineQueue {
  private readonly db:DatabaseSync;
  private readonly maxAttempts:number;
  private readonly retryDelayMs:number;
  constructor(path:string,options:OfflineQueueOptions){
    if(!options||options.enabled!==true||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>20||!Number.isSafeInteger(options.retryDelayMs)||options.retryDelayMs<0||options.retryDelayMs>86400000)throw Error('Invalid offline queue policy');
    this.maxAttempts=options.maxAttempts;this.retryDelayMs=options.retryDelayMs;this.db=new DatabaseSync(path);
    try{this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS offline_operations (
        tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        id TEXT NOT NULL, operation_id TEXT NOT NULL, request_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','conflict','uncertain','exhausted','succeeded','discarded')),
        attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,application_id,principal_id,id),
        UNIQUE(tenant_id,application_id,principal_id,request_key)
      );
      CREATE INDEX IF NOT EXISTS offline_operations_recovery ON offline_operations(tenant_id,application_id,principal_id,operation_id,id) WHERE status IN ('running','uncertain');
      CREATE TABLE IF NOT EXISTS offline_recovery_events (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,principal_id TEXT NOT NULL,queue_id TEXT NOT NULL,operator_id TEXT NOT NULL,reference TEXT NOT NULL,action TEXT NOT NULL,recorded_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS offline_recovery_events_scope ON offline_recovery_events(tenant_id,application_id,principal_id,queue_id,id);
      CREATE TRIGGER IF NOT EXISTS offline_recovery_events_no_replace BEFORE INSERT ON offline_recovery_events WHEN NEW.id>0 AND EXISTS(SELECT 1 FROM offline_recovery_events WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Offline recovery evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS offline_recovery_events_no_update BEFORE UPDATE ON offline_recovery_events BEGIN SELECT RAISE(ABORT,'Offline recovery evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS offline_recovery_events_no_delete BEFORE DELETE ON offline_recovery_events BEGIN SELECT RAISE(ABORT,'Offline recovery evidence is immutable'); END;`);}catch(error){this.db.close();throw error;}
  }
  close():void{this.db.close();}
  enqueue(scope:DataScope,principalId:string,operationId:string,requestKey:string,payload:Record<string,unknown>,options?:{idempotencyKey:string}):OfflineOperation {
    checkKey(scope,operationId,requestKey);checkKey(scope,'principal',principalId);
    if(options!==undefined){if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length!==1)throw Error('Invalid shared offline key');checkKey(scope,'idempotency',options.idempotencyKey);}
    const sharedKey=options?.idempotencyKey;
    const serialized=JSON.stringify(dataCopy(payload)),normalized=JSON.parse(serialized) as Record<string,unknown>;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare('SELECT id,operation_id,payload FROM offline_operations WHERE tenant_id=? AND application_id=? AND principal_id=? AND request_key=?').get(scope.tenantId,scope.applicationId,principalId,requestKey);
      if(row){
        if(row.operation_id!==operationId||!isDeepStrictEqual(JSON.parse(row.payload as string),normalized))throw Error('Offline request conflict');
        const previous=this.get(scope,principalId,row.id as string)!;if(sharedKey!==undefined&&previous.idempotencyKey!==sharedKey)throw Error('Offline request conflict');this.db.exec('COMMIT');return previous;
      }
      const total=this.db.prepare('SELECT COUNT(*) AS count FROM offline_operations WHERE tenant_id=? AND application_id=? AND principal_id=?').get(scope.tenantId,scope.applicationId,principalId);
      if(Number(total?.count)>=1000)throw Error('Offline queue full');
      const id=randomUUID(),idempotencyKey=sharedKey??randomUUID();
      this.db.prepare('INSERT INTO offline_operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,principalId,id,operationId,requestKey,idempotencyKey,serialized,'pending',0,0);
      this.db.exec('COMMIT');return {id,operationId,requestKey,idempotencyKey,payload:dataCopy(normalized),status:'pending',attempts:0,nextAttemptAt:0};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  get(scope:DataScope,principalId:string,id:string):OfflineOperation|undefined {
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);
    const row=this.db.prepare('SELECT * FROM offline_operations WHERE tenant_id=? AND application_id=? AND principal_id=? AND id=?').get(scope.tenantId,scope.applicationId,principalId,id);
    if(!row)return undefined;
    return {id,operationId:row.operation_id as string,requestKey:row.request_key as string,idempotencyKey:row.idempotency_key as string,payload:dataCopy(JSON.parse(row.payload as string)),status:row.status as OfflineStatus,attempts:Number(row.attempts),nextAttemptAt:Number(row.next_attempt_at)};
  }
  list(scope:DataScope,principalId:string):OfflineOperation[] {
    checkKey(scope,'principal',principalId);
    const ids=this.db.prepare('SELECT id FROM offline_operations WHERE tenant_id=? AND application_id=? AND principal_id=? ORDER BY rowid').all(scope.tenantId,scope.applicationId,principalId);
    return ids.map(row=>this.get(scope,principalId,row.id as string)!);
  }
  /** Bounded metadata-only listing; the caller must authorize the entire selected scope. */
  listRecoveryCandidates(scope:DataScope,principalId:string,operationId:string,options:{after?:string;limit?:number}={}):OfflineRecoveryCandidatePage{
    checkKey(scope,'principal',principalId);checkKey(scope,'operation',operationId);if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='after'&&key!=='limit')||!Number.isSafeInteger(options.limit??50)||(options.limit??50)<1||(options.limit??50)>100)throw Error('Invalid offline recovery query');if(options.after!==undefined)checkKey(scope,'offline',options.after);
    const limit=options.limit??50,rows=this.db.prepare("SELECT id,status,attempts FROM offline_operations WHERE tenant_id=? AND application_id=? AND principal_id=? AND operation_id=? AND status IN ('running','uncertain') AND id>? ORDER BY id LIMIT ?").all(scope.tenantId,scope.applicationId,principalId,operationId,options.after??'',limit+1);
    const checked:OfflineRecoveryCandidate[]=rows.map(row=>{if(typeof row.id!=='string'||(row.status!=='running'&&row.status!=='uncertain')||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<1)throw Error('Invalid offline recovery candidate');checkKey(scope,'offline',row.id);return {id:row.id,status:row.status,attempts:Number(row.attempts)};});const items=checked.slice(0,limit);return {items,...(checked.length>limit?{nextAfter:items[items.length-1]!.id}:{})};
  }
  /** Process one due item; only a host-confirmed pre-effect failure may be retried automatically. */
  async processOne(scope:DataScope,context:InvocationContext,registry:CapabilityRegistry,classify:(error:unknown)=>OfflineFailure,now=Date.now()):Promise<OfflineOperation|undefined> {
    if(!context||context.tenantId!==scope?.tenantId||typeof context.principalId!=='string'||!['ui','agent','service'].includes(context.origin)||!(registry instanceof CapabilityRegistry)||typeof classify!=='function'||!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-this.retryDelayMs)throw Error('Invalid offline processing context');
    checkKey(scope,'principal',context.principalId);scope={tenantId:scope.tenantId,applicationId:scope.applicationId};context={tenantId:context.tenantId,principalId:context.principalId,origin:context.origin};let id:string|undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("UPDATE offline_operations SET status='exhausted' WHERE tenant_id=? AND application_id=? AND principal_id=? AND status='pending' AND attempts>=?").run(scope.tenantId,scope.applicationId,context.principalId,this.maxAttempts);
      const row=this.db.prepare("SELECT id FROM offline_operations WHERE tenant_id=? AND application_id=? AND principal_id=? AND status='pending' AND next_attempt_at<=? ORDER BY rowid LIMIT 1").get(scope.tenantId,scope.applicationId,context.principalId,now);
      if(row){id=row.id as string;this.db.prepare("UPDATE offline_operations SET status='running',attempts=attempts+1 WHERE tenant_id=? AND application_id=? AND principal_id=? AND id=? AND status='pending'").run(scope.tenantId,scope.applicationId,context.principalId,id);}
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(!id)return undefined;
    const operation=this.get(scope,context.principalId,id)!;
    try{
      await registry.invoke(operation.operationId,{idempotencyKey:operation.idempotencyKey,payload:operation.payload},context);
    }catch(error){
      let classification:OfflineFailure='uncertain';
      if(!(error instanceof CapabilityOutcomeUncertainError))try{const candidate=classify(error);if(candidate==='retry'||candidate==='conflict')classification=candidate;}catch{}
      const status=classification==='retry'?(operation.attempts>=this.maxAttempts?'exhausted':'pending'):classification;
      this.transition(scope,context.principalId,id,'running',status,status==='pending'?now+this.retryDelayMs:0);
      return this.get(scope,context.principalId,id);
    }
    try{this.transition(scope,context.principalId,id,'running','succeeded',0);}catch{
      // A local write failure after dispatch is never evidence that a replay is safe.
      try{this.transition(scope,context.principalId,id,'running','uncertain',0);}catch{}
      throw Error('Offline outcome uncertain');
    }
    return this.get(scope,context.principalId,id);
  }
  /** Only after confirming the submitting process is no longer active. */
  recoverAbandoned(scope:DataScope,principalId:string,id:string):void{this.transition(scope,principalId,id,'running','uncertain',0);}
  /** The host must verify the remote outcome before resolving an uncertain operation. */
  reconcile(scope:DataScope,principalId:string,id:string,outcome:'applied'|'not_applied'):void {
    if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid reconciliation');
    this.transition(scope,principalId,id,'uncertain',outcome==='applied'?'succeeded':'pending',0);
  }
  /** Host-authorized, evidence-bearing recovery after the submitter is confirmed stopped. */
  recoverAbandonedWithEvidence(scope:DataScope,principalId:string,id:string,evidence:SqliteOfflineRecoveryEvidence,recordedAt=Date.now()):void{
    this.evidenceTransition(scope,principalId,id,'running','uncertain','recover',evidence,recordedAt);
  }
  /** Host-verified outcome and evidence commit atomically with the state change. */
  reconcileWithEvidence(scope:DataScope,principalId:string,id:string,outcome:'applied'|'not_applied',evidence:SqliteOfflineRecoveryEvidence,recordedAt=Date.now()):void{
    if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid reconciliation');
    this.evidenceTransition(scope,principalId,id,'uncertain',outcome==='applied'?'succeeded':'pending',outcome,evidence,recordedAt);
  }
  private evidenceTransition(scope:DataScope,principalId:string,id:string,from:OfflineStatus,to:OfflineStatus,action:SqliteOfflineRecoveryEvent['action'],evidence:SqliteOfflineRecoveryEvidence,recordedAt:number,expected?:OfflineOperation):void{
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);
    this.checkRecoveryEvidence(scope,evidence,recordedAt);
    this.db.exec('BEGIN IMMEDIATE');try{if(expected&&!isDeepStrictEqual(this.get(scope,principalId,id),expected))throw Error('Stale offline recovery');this.transition(scope,principalId,id,from,to,0);this.db.prepare('INSERT INTO offline_recovery_events (tenant_id,application_id,principal_id,queue_id,operator_id,reference,action,recorded_at) VALUES (?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.applicationId,principalId,id,evidence.operatorId,evidence.reference,action,recordedAt);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private checkRecoveryEvidence(scope:DataScope,evidence:SqliteOfflineRecoveryEvidence,recordedAt:number):void{
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||Object.keys(evidence).length!==2||!Object.hasOwn(evidence,'operatorId')||!Object.hasOwn(evidence,'reference')||!Number.isSafeInteger(recordedAt)||recordedAt<0)throw Error('Invalid offline recovery evidence');
    checkKey(scope,'operator',evidence.operatorId);checkKey(scope,'reference',evidence.reference);
  }
  /** Recheck the exact observed claim after the host confirms its submitter has stopped. */
  async verifyAndRecoverAbandoned(scope:DataScope,principalId:string,id:string,verify:(scope:DataScope,operation:OfflineOperation)=>boolean|Promise<boolean>,evidence:SqliteOfflineRecoveryEvidence,recordedAt=Date.now()):Promise<boolean>{
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);if(typeof verify!=='function')throw Error('Invalid offline recovery verifier');const selected={tenantId:scope.tenantId,applicationId:scope.applicationId};this.checkRecoveryEvidence(selected,evidence,recordedAt);const proof={operatorId:evidence.operatorId,reference:evidence.reference},snapshot=this.get(selected,principalId,id);if(!snapshot||snapshot.status!=='running')throw Error('Invalid offline operation state');
    const confirmed=await verify({...selected},structuredClone(snapshot));if(confirmed!==true)return false;this.evidenceTransition(selected,principalId,id,'running','uncertain','recover',proof,recordedAt,snapshot);return true;
  }
  /** Unknown results leave the operation uncertain; changed claims reject stale decisions. */
  async verifyAndReconcile(scope:DataScope,principalId:string,id:string,verify:(scope:DataScope,operation:OfflineOperation)=>'applied'|'not_applied'|'unknown'|Promise<'applied'|'not_applied'|'unknown'>,evidence:SqliteOfflineRecoveryEvidence,recordedAt=Date.now()):Promise<'applied'|'not_applied'|'unknown'>{
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);if(typeof verify!=='function')throw Error('Invalid offline recovery verifier');const selected={tenantId:scope.tenantId,applicationId:scope.applicationId};this.checkRecoveryEvidence(selected,evidence,recordedAt);const proof={operatorId:evidence.operatorId,reference:evidence.reference},snapshot=this.get(selected,principalId,id);if(!snapshot||snapshot.status!=='uncertain')throw Error('Invalid offline operation state');
    const outcome=await verify({...selected},structuredClone(snapshot));if(outcome==='unknown')return outcome;if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid offline verification outcome');this.evidenceTransition(selected,principalId,id,'uncertain',outcome==='applied'?'succeeded':'pending',outcome,proof,recordedAt,snapshot);return outcome;
  }
  /** Scoped recovery evidence; the caller must authorize access before exposing it. */
  listRecoveryEvidence(scope:DataScope,principalId:string,id:string,options:{after?:number;limit?:number}={}):SqliteOfflineRecoveryEvent[]{
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='after'&&key!=='limit')||!Number.isSafeInteger(options.after??0)||(options.after??0)<0||!Number.isSafeInteger(options.limit??50)||(options.limit??50)<1||(options.limit??50)>100)throw Error('Invalid offline recovery evidence query');
    const rows=this.db.prepare('SELECT id,operator_id,reference,action,recorded_at FROM offline_recovery_events WHERE tenant_id=? AND application_id=? AND principal_id=? AND queue_id=? AND id>? ORDER BY id LIMIT ?').all(scope.tenantId,scope.applicationId,principalId,id,options.after??0,options.limit??50);
    return rows.map(row=>{if(!Number.isSafeInteger(row.id)||Number(row.id)<1||typeof row.operator_id!=='string'||typeof row.reference!=='string'||!['recover','applied','not_applied'].includes(String(row.action))||!Number.isSafeInteger(row.recorded_at)||Number(row.recorded_at)<0)throw Error('Invalid offline recovery evidence data');checkKey(scope,'operator',row.operator_id);checkKey(scope,'reference',row.reference);return {id:Number(row.id),operatorId:row.operator_id,reference:row.reference,action:row.action as SqliteOfflineRecoveryEvent['action'],recordedAt:Number(row.recorded_at)};});
  }
  /** Discard a pending or conflicting intent; it never changes external data. */
  discard(scope:DataScope,principalId:string,id:string):void {
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);
    const result=this.db.prepare("UPDATE offline_operations SET status='discarded',next_attempt_at=0 WHERE tenant_id=? AND application_id=? AND principal_id=? AND id=? AND status IN ('pending','conflict','exhausted')").run(scope.tenantId,scope.applicationId,principalId,id);
    if(result.changes!==1)throw Error('Invalid offline operation state');
  }
  private transition(scope:DataScope,principalId:string,id:string,from:OfflineStatus,to:OfflineStatus,next:number):void {
    checkKey(scope,'principal',principalId);checkKey(scope,'offline',id);
    const result=this.db.prepare('UPDATE offline_operations SET status=?,next_attempt_at=? WHERE tenant_id=? AND application_id=? AND principal_id=? AND id=? AND status=?').run(to,next,scope.tenantId,scope.applicationId,principalId,id,from);
    if(result.changes!==1)throw Error('Invalid offline operation state');
  }
}
