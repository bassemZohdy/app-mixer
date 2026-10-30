import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CapabilityRegistry, type InvocationContext} from './capabilities.js';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';

export type OfflineStatus='pending'|'running'|'conflict'|'uncertain'|'exhausted'|'succeeded'|'discarded';
export type OfflineOperation={id:string;operationId:string;requestKey:string;idempotencyKey:string;payload:Record<string,unknown>;status:OfflineStatus;attempts:number;nextAttemptAt:number};
export type OfflineQueueOptions={enabled:true;maxAttempts:number;retryDelayMs:number};
export type OfflineFailure='retry'|'conflict'|'uncertain';

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
      );`);}catch(error){this.db.close();throw error;}
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
      this.transition(scope,context.principalId,id,'running','succeeded',0);
    }catch(error){
      let classification:OfflineFailure='uncertain';
      try{const candidate=classify(error);if(candidate==='retry'||candidate==='conflict')classification=candidate;}catch{}
      const status=classification==='retry'?(operation.attempts>=this.maxAttempts?'exhausted':'pending'):classification;
      this.transition(scope,context.principalId,id,'running',status,status==='pending'?now+this.retryDelayMs:0);
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
