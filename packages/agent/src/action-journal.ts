import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {type AgentRunScope} from './durable-runs.js';

type ActionStatus='ready'|'dispatching'|'uncertain'|'succeeded'|'failed';
export type AgentAction={actionId:string;operationId:string;idempotencyKey:string;status:ActionStatus;attempts:number;maxAttempts:number};
type Options={scope:AgentRunScope;runId:string;leaseToken:string;clock?:()=>number};
const valid=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
function safeJSON(value:unknown):string{
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
   );`);}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 isBoundTo(scope:AgentRunScope,runId:string):boolean{return !!scope&&this.scope.tenantId===scope.tenantId&&this.scope.agentId===scope.agentId&&this.runId===runId;}
 private args():[string,string,string]{return [this.scope.tenantId,this.scope.agentId,this.runId];}
 private row(actionId:string):Record<string,unknown>|undefined{return this.db.prepare('SELECT * FROM agent_action_journal WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);}
 private fence():void{const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid clock');const row=this.db.prepare('SELECT status,lease_token,lease_until FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(!row||row.status!=='running'||row.lease_token!==this.token||typeof row.lease_until!=='number'||now>=row.lease_until)throw Error('Action lease unavailable');}
 private transaction<T>(callback:()=>T,withLease=true):T{this.db.exec('BEGIN IMMEDIATE');try{if(withLease)this.fence();const result=callback();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private metadata(row:Record<string,unknown>):AgentAction{return {actionId:String(row.action_id),operationId:String(row.operation_id),idempotencyKey:String(row.idempotency_key),status:row.status as ActionStatus,attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts)};}
 get(actionId:string):AgentAction|undefined{if(!valid(actionId))throw Error('Invalid action');const row=this.row(actionId);return row?this.metadata(row):undefined;}
 async invoke(actionId:string,operationId:string,input:unknown,maxAttempts:number,dispatch:(input:unknown,idempotencyKey:string)=>Promise<unknown>):Promise<unknown>{
  if(!valid(actionId)||!valid(operationId)||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>20||typeof dispatch!=='function')throw Error('Invalid action');
  const serialized=safeJSON(input),hash=createHash('sha256').update(serialized).digest('hex');
  const prepared=this.transaction(()=>{
   let row=this.row(actionId);
   if(!row){this.db.prepare("INSERT INTO agent_action_journal VALUES (?,?,?,?,?,?,?,?, 'ready',0,?,NULL)").run(...this.args(),actionId,operationId,serialized,hash,randomUUID(),maxAttempts);row=this.row(actionId)!;}
   if(row.operation_id!==operationId||row.input_hash!==hash||row.input_json!==serialized||Number(row.max_attempts)!==maxAttempts)throw Error('Action identity conflict');
   if(row.status==='succeeded')return {cached:true,result:row.result_json as string,key:String(row.idempotency_key)};
   if(row.status!=='ready'||Number(row.attempts)>=maxAttempts)throw Error('Action requires reconciliation');
   this.db.prepare("UPDATE agent_action_journal SET status='dispatching',attempts=attempts+1 WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?").run(...this.args(),actionId);
   return {cached:false,result:null,key:String(row.idempotency_key)};
  });
  if(prepared.cached)return JSON.parse(prepared.result!);
  try{
   const result=safeJSON(await dispatch(JSON.parse(serialized),prepared.key));
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
 reconcile(actionId:string,outcome:'applied'|'not_applied'|'failed',result?:unknown):void{
  if(!valid(actionId)||!['applied','not_applied','failed'].includes(outcome)||(outcome!=='applied'&&result!==undefined))throw Error('Invalid reconciliation');
  const serialized=outcome==='applied'?safeJSON(result):null;
  this.transaction(()=>{this.requireUncertainRun();const row=this.row(actionId);if(!row||row.status!=='uncertain')throw Error('Invalid action state');
   if(outcome==='not_applied'&&Number(row.attempts)>=Number(row.max_attempts))throw Error('Action attempts exhausted');
   this.db.prepare('UPDATE agent_action_journal SET status=?,result_json=? WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').run(outcome==='applied'?'succeeded':outcome==='not_applied'?'ready':'failed',serialized,...this.args(),actionId);
  },false);
 }
 private requireUncertainRun():void{const run=this.db.prepare('SELECT status FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(!run||run.status!=='uncertain')throw Error('Run is not uncertain');}
}
export type {Options as AgentActionJournalOptions,ActionStatus as AgentActionStatus};
