import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {type AgentRunScope} from './durable-runs.js';

type ActionStatus='ready'|'dispatching'|'uncertain'|'succeeded'|'failed';
export type AgentAction={actionId:string;operationId:string;idempotencyKey:string;status:ActionStatus;attempts:number;maxAttempts:number};
type Options={scope:AgentRunScope;runId:string;leaseToken:string;clock?:()=>number};
export type ActionVerificationRequest={scope:AgentRunScope;runId:string;action:AgentAction;input:unknown;authority?:string};
export type ActionVerification={outcome:'unknown'|'not_applied'|'failed'}|{outcome:'applied';result:unknown};
export type ActionReconciliationEvidence={principalId:string;reference:string};
export type ActionReconciliationEvent=ActionReconciliationEvidence & {id:number;actionId:string;outcome:'applied'|'not_applied'|'failed';method:'manual'|'verifier';recordedAt:number};
export type AgentActionPage={actions:AgentAction[];next?:string};
export type ActionVerificationPass={results:({actionId:string;outcome:ActionVerification['outcome']}|{actionId:string;error:unknown})[];next?:string};
const valid=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
export function actionJSON(value:unknown):string{
 let count=0;const stack=new Set<object>();
 const visit=(input:unknown,depth:number):unknown=>{
  if(++count>10000||depth>40)throw Error('Invalid action data');
  if(input===null||typeof input==='string'||typeof input==='boolean'||(typeof input==='number'&&Number.isFinite(input)))return input;
  if(!input||typeof input!=='object'||stack.has(input))throw Error('Invalid action data');stack.add(input);let result:unknown;
  if(Array.isArray(input)){if(input.length>10000||Object.keys(input).length!==input.length||Array.from({length:input.length},(_,i)=>Object.hasOwn(input,i)).some(p=>!p))throw Error('Invalid action data');result=input.map(x=>visit(x,depth+1));}
  else{if(![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('Invalid action data');const out:Record<string,unknown>={};for(const key of Object.keys(input).sort()){if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid action data');out[key]=visit((input as Record<string,unknown>)[key],depth+1);}result=out;}
  stack.delete(input);return result;
 };
 const text=JSON.stringify(visit(value,0));if(Buffer.byteLength(text)>1024*1024)throw Error('Invalid action data');return text;
}
/** A host-authorized journal for one agent run, fenced by its SQLite run lease. */
export class SqliteAgentActionJournal {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly runId:string;private readonly token:string;private readonly clock:()=>number;
 constructor(path:string,options:Options){
  if(!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||!valid(options.runId)||!valid(options.leaseToken)||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid action journal configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.runId=options.runId;this.token=options.leaseToken;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS agent_action_journal (
    tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,operation_id TEXT NOT NULL,
    input_json TEXT NOT NULL,input_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,
    attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,result_json TEXT,
    PRIMARY KEY(tenant_id,agent_id,run_id,action_id)
   );
   CREATE TABLE IF NOT EXISTS agent_action_authority (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,authority TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id,action_id));
   CREATE TABLE IF NOT EXISTS agent_action_reconciliations (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,principal_id TEXT NOT NULL,reference TEXT NOT NULL,outcome TEXT NOT NULL,method TEXT NOT NULL,recorded_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS agent_action_reconciliations_scope ON agent_action_reconciliations(tenant_id,agent_id,run_id,id);
   CREATE TRIGGER IF NOT EXISTS agent_action_reconciliations_no_replace BEFORE INSERT ON agent_action_reconciliations WHEN NEW.id>0 AND EXISTS(SELECT 1 FROM agent_action_reconciliations WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Action reconciliation records are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS agent_action_reconciliations_no_update BEFORE UPDATE ON agent_action_reconciliations BEGIN SELECT RAISE(ABORT,'Action reconciliation records are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS agent_action_reconciliations_no_delete BEFORE DELETE ON agent_action_reconciliations BEGIN SELECT RAISE(ABORT,'Action reconciliation records are immutable'); END;`);}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 isBoundTo(scope:AgentRunScope,runId:string):boolean{return !!scope&&this.scope.tenantId===scope.tenantId&&this.scope.agentId===scope.agentId&&this.runId===runId;}
 private args():[string,string,string]{return [this.scope.tenantId,this.scope.agentId,this.runId];}
 private row(actionId:string):Record<string,unknown>|undefined{return this.db.prepare('SELECT * FROM agent_action_journal WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);}
 private fence():void{const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid clock');const row=this.db.prepare('SELECT status,lease_token,lease_until FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(!row||row.status!=='running'||row.lease_token!==this.token||typeof row.lease_until!=='number'||now>=row.lease_until)throw Error('Action lease unavailable');}
 private transaction<T>(callback:()=>T,withLease=true):T{this.db.exec('BEGIN IMMEDIATE');try{if(withLease)this.fence();const result=callback();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private metadata(row:Record<string,unknown>):AgentAction{return {actionId:String(row.action_id),operationId:String(row.operation_id),idempotencyKey:String(row.idempotency_key),status:row.status as ActionStatus,attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts)};}
 get(actionId:string):AgentAction|undefined{if(!valid(actionId))throw Error('Invalid action');const row=this.row(actionId);return row?this.metadata(row):undefined;}
 /** Host-authorized, scope-bound action discovery; results contain no input or outcome payloads. */
 list(options:{after?:string;limit?:number;status?:ActionStatus}={}):AgentActionPage{
  if(!options||typeof options!=='object'||(options.after!==undefined&&!valid(options.after))||!Number.isSafeInteger(options.limit??50)||(options.limit??50)<1||(options.limit??50)>100||(options.status!==undefined&&!['ready','dispatching','uncertain','succeeded','failed'].includes(options.status)))throw Error('Invalid action listing');
  const limit=options.limit??50,rows=this.db.prepare('SELECT action_id,operation_id,idempotency_key,status,attempts,max_attempts FROM agent_action_journal WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id>? AND (? IS NULL OR status=?) ORDER BY action_id LIMIT ?').all(...this.args(),options.after??'',options.status??null,options.status??null,limit+1),hasMore=rows.length>limit,actions=rows.slice(0,limit).map(row=>this.metadata(row));return {actions,...(hasMore?{next:actions[actions.length-1]!.actionId}:{})};
 }
 /** One bounded, sequential pass; the host authorizes and schedules recovery. */
 async reconcilePending(verify:(request:ActionVerificationRequest)=>Promise<ActionVerification>,options:{after?:string;limit?:number}={}):Promise<ActionVerificationPass>{
  if(typeof verify!=='function'||!options||typeof options!=='object')throw Error('Invalid action verification pass');
  this.transaction(()=>this.requireUncertainRun(),false);const page=this.list({...options,status:'uncertain'}),results:ActionVerificationPass['results']=[];
  for(const action of page.actions){try{results.push({actionId:action.actionId,outcome:await this.reconcileWith(action.actionId,verify)});}catch(error){results.push({actionId:action.actionId,error});}}
  return {results,...(page.next?{next:page.next}:{})};
 }
 async invoke(actionId:string,operationId:string,input:unknown,maxAttempts:number,dispatch:(input:unknown,idempotencyKey:string)=>Promise<unknown>,requiresApproval=false,authority?:string):Promise<unknown>{
  if(!valid(actionId)||!valid(operationId)||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>20||typeof dispatch!=='function'||typeof requiresApproval!=='boolean'||(authority!==undefined&&(typeof authority!=='string'||authority.length<1||authority.length>1024)))throw Error('Invalid action');
  const serialized=actionJSON(input),hash=createHash('sha256').update(serialized).digest('hex');
  const prepared=this.transaction(()=>{
   let row=this.row(actionId);
   if(!row){this.db.prepare("INSERT INTO agent_action_journal VALUES (?,?,?,?,?,?,?,?, 'ready',0,?,NULL)").run(...this.args(),actionId,operationId,serialized,hash,randomUUID(),maxAttempts);row=this.row(actionId)!;if(authority!==undefined)this.db.prepare('INSERT INTO agent_action_authority VALUES (?,?,?,?,?)').run(...this.args(),actionId,authority);}
   const bound=this.db.prepare('SELECT authority FROM agent_action_authority WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);if((bound?.authority??undefined)!==authority)throw Error('Action authority conflict');
   if(row.operation_id!==operationId||row.input_hash!==hash||row.input_json!==serialized||Number(row.max_attempts)!==maxAttempts)throw Error('Action identity conflict');
   if(row.status==='succeeded')return {cached:true,result:row.result_json as string,key:String(row.idempotency_key)};
   if(row.status!=='ready'||Number(row.attempts)>=maxAttempts)throw Error('Action requires reconciliation');
   if(requiresApproval){const approvalNow=this.clock();if(!Number.isSafeInteger(approvalNow)||approvalNow<0)throw Error('Invalid clock');const approval=this.db.prepare('SELECT operation_id,input_hash,input_json,definition_version,status,expires_at FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);const run=this.db.prepare('SELECT definition_version FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());const approvalAuthority=this.db.prepare('SELECT authority FROM agent_approval_authority WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);if((approvalAuthority?.authority??undefined)!==authority)throw Error('Approval authority conflict');if(!approval||approval.status!=='approved'||approval.operation_id!==operationId||approval.input_hash!==hash||approval.input_json!==serialized||approval.definition_version!==run?.definition_version||Number(approval.expires_at)<=approvalNow)throw Error('Approval required');}
   this.db.prepare("UPDATE agent_action_journal SET status='dispatching',attempts=attempts+1 WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?").run(...this.args(),actionId);
   return {cached:false,result:null,key:String(row.idempotency_key)};
  });
  if(prepared.cached)return JSON.parse(prepared.result!);
  try{
   const result=actionJSON(await dispatch(JSON.parse(serialized),prepared.key));
   this.transaction(()=>{const row=this.row(actionId);if(!row||row.status!=='dispatching')throw Error('Action state conflict');this.db.prepare("UPDATE agent_action_journal SET status='succeeded',result_json=? WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?").run(result,...this.args(),actionId);});
   return JSON.parse(result);
  }catch(error){
   try{this.transaction(()=>{const row=this.row(actionId);if(row?.status==='dispatching')this.db.prepare("UPDATE agent_action_journal SET status='uncertain' WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?").run(...this.args(),actionId);});}catch{}
   throw Error('Action outcome uncertain',{cause:error});
  }
 }
 /** Host must first stop the old worker and mark its run uncertain. */
 markUncertain(actionId:string):void{
  if(!valid(actionId))throw Error('Invalid action');this.transaction(()=>{this.requireUncertainRun();const row=this.row(actionId);if(!row||row.status!=='dispatching')throw Error('Invalid action state');this.db.prepare("UPDATE agent_action_journal SET status='uncertain' WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?").run(...this.args(),actionId);},false);
 }
 /** Host must verify the external outcome before reconciling an uncertain action. */
 reconcile(actionId:string,outcome:'applied'|'not_applied'|'failed',result?:unknown):void{this.reconcileDecision(actionId,outcome,result);}
 /** A host-authorized manual decision with an atomic actor-attributed record. */
 reconcileWithEvidence(actionId:string,outcome:'applied'|'not_applied'|'failed',result:unknown,evidence:ActionReconciliationEvidence):void{this.reconcileDecision(actionId,outcome,result,this.checkEvidence(evidence));}
 private reconcileDecision(actionId:string,outcome:'applied'|'not_applied'|'failed',result?:unknown,evidence?:ActionReconciliationEvidence):void{
  if(!valid(actionId)||!['applied','not_applied','failed'].includes(outcome)||(outcome!=='applied'&&result!==undefined))throw Error('Invalid reconciliation');
  const serialized=outcome==='applied'?actionJSON(result):null;
  this.transaction(()=>{this.requireUncertainRun();const row=this.row(actionId);if(!row||row.status!=='uncertain')throw Error('Invalid action state');
   if(outcome==='not_applied'&&Number(row.attempts)>=Number(row.max_attempts))throw Error('Action attempts exhausted');
   this.db.prepare('UPDATE agent_action_journal SET status=?,result_json=? WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').run(outcome==='applied'?'succeeded':outcome==='not_applied'?'ready':'failed',serialized,...this.args(),actionId);
   if(evidence)this.recordReconciliation(actionId,outcome,'manual',evidence);
  },false);
 }
 /** Host must authorize access to the whole run and protect evidence references. */
 listReconciliations(options:{after?:number;limit?:number}={}):ActionReconciliationEvent[]{
  const after=options?.after??0,limit=options?.limit??100;if(!options||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid action reconciliation listing');
  return this.db.prepare('SELECT id,action_id,principal_id,reference,outcome,method,recorded_at FROM agent_action_reconciliations WHERE tenant_id=? AND agent_id=? AND run_id=? AND id>? ORDER BY id LIMIT ?').all(...this.args(),after,limit).map(row=>({id:Number(row.id),actionId:String(row.action_id),principalId:String(row.principal_id),reference:String(row.reference),outcome:row.outcome as ActionReconciliationEvent['outcome'],method:row.method as ActionReconciliationEvent['method'],recordedAt:Number(row.recorded_at)}));
 }
 private checkEvidence(evidence:ActionReconciliationEvidence):ActionReconciliationEvidence{if(!evidence||!valid(evidence.principalId)||!valid(evidence.reference))throw Error('Invalid action reconciliation evidence');return {principalId:evidence.principalId,reference:evidence.reference};}
 private recordReconciliation(actionId:string,outcome:'applied'|'not_applied'|'failed',method:'manual'|'verifier',evidence:ActionReconciliationEvidence):void{const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid clock');this.db.prepare('INSERT INTO agent_action_reconciliations (tenant_id,agent_id,run_id,action_id,principal_id,reference,outcome,method,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...this.args(),actionId,evidence.principalId,evidence.reference,outcome,method,now);}
 /** Verify externally without replaying; the host authorizes the verifier and stops the old worker. */
 async reconcileWith(actionId:string,verify:(request:ActionVerificationRequest)=>Promise<ActionVerification>,evidence?:ActionReconciliationEvidence):Promise<ActionVerification['outcome']>{
  if(!valid(actionId)||typeof verify!=='function')throw Error('Invalid action verification');const safeEvidence=evidence===undefined?undefined:this.checkEvidence(evidence);
  const snapshot=this.transaction(()=>{this.requireUncertainRun();const run=this.db.prepare('SELECT revision FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args()),row=this.row(actionId);if(!run||!row||row.status!=='uncertain')throw Error('Invalid action state');const authority=this.db.prepare('SELECT authority FROM agent_action_authority WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);return {revision:Number(run.revision),action:this.metadata(row),input:String(row.input_json),authority:authority?.authority as string|undefined};},false);
  const request:ActionVerificationRequest={scope:{...this.scope},runId:this.runId,action:{...snapshot.action},input:JSON.parse(snapshot.input),...(snapshot.authority===undefined?{}:{authority:snapshot.authority})};
  const decision:unknown=await verify(request);if(!decision||typeof decision!=='object'||Array.isArray(decision))throw Error('Invalid action verification');const d=decision as Record<string,unknown>,outcome=d.outcome;
  if(typeof outcome!=='string'||!['unknown','applied','not_applied','failed'].includes(outcome)||Object.keys(d).some(k=>k!=='outcome'&&k!=='result')||(outcome==='applied'?!Object.hasOwn(d,'result'):Object.hasOwn(d,'result')))throw Error('Invalid action verification');
  const serialized=outcome==='applied'?actionJSON(d.result):null;
  return this.transaction(()=>{this.requireUncertainRun();const run=this.db.prepare('SELECT revision FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args()),row=this.row(actionId);if(!run||Number(run.revision)!==snapshot.revision||!row||row.status!=='uncertain'||Number(row.attempts)!==snapshot.action.attempts||row.idempotency_key!==snapshot.action.idempotencyKey||row.input_json!==snapshot.input)throw Error('Action verification stale');
   if(outcome==='not_applied'&&Number(row.attempts)>=Number(row.max_attempts))throw Error('Action attempts exhausted');
   if(outcome!=='unknown'){this.db.prepare('UPDATE agent_action_journal SET status=?,result_json=? WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').run(outcome==='applied'?'succeeded':outcome==='not_applied'?'ready':'failed',serialized,...this.args(),actionId);if(safeEvidence)this.recordReconciliation(actionId,outcome as 'applied'|'not_applied'|'failed','verifier',safeEvidence);}
   return outcome as ActionVerification['outcome'];
  },false);
 }
 private requireUncertainRun():void{const run=this.db.prepare('SELECT status FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(!run||run.status!=='uncertain')throw Error('Run is not uncertain');}
}
export type {Options as AgentActionJournalOptions,ActionStatus as AgentActionStatus};
