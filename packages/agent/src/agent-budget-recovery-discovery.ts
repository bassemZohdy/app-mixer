import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
import type {AgentRunMetricStatus} from './agent-run-metrics.js';
import {isIdentifier} from './validation.js';

type Actor={tenantId:string;principalId:string};
type Options={scope:AgentRunScope;authorize:(actor:Actor,scope:AgentRunScope,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
export type AgentBudgetRecoveryCandidate={runId:string;runStatus:AgentRunMetricStatus;reserved:number};
export type AgentBudgetRecoveryPage={items:AgentBudgetRecoveryCandidate[];nextAfter?:string};
const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'];
const id=isIdentifier;
/** Authorized, bounded discovery of runs with unresolved token reservations. */
export class SqliteAgentBudgetRecoveryDiscovery {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];private readonly timeoutMs?:number;private readonly maxPending?:number;private pending=0;
 constructor(path:string,options:Options){
  if(typeof path!=='string'||!path||!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function'||(options.timeoutMs===undefined)!==(options.maxPending===undefined)||(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000))||(options.maxPending!==undefined&&(!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>100)))throw Error('Invalid budget recovery discovery');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.timeoutMs=options.timeoutMs;this.maxPending=options.maxPending;this.db=new DatabaseSync(path,{readOnly:true});
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');for(const table of ['agent_runs','agent_token_calls'])if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Budget recovery discovery unavailable');}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 isBoundTo(scope:AgentRunScope):boolean{return !!scope&&scope.tenantId===this.scope.tenantId&&scope.agentId===this.scope.agentId;}
 private active(signal:AbortSignal):void{if(signal.aborted)throw Error('Budget recovery discovery unavailable');}
 private async permit(actor:Actor,signal:AbortSignal):Promise<void>{this.active(signal);let allowed=false;try{allowed=await this.authorize({...actor},{...this.scope},signal)===true;}catch{}this.active(signal);if(!allowed)throw Error('Budget recovery discovery denied');}
 private async bounded<T>(operation:(signal:AbortSignal)=>Promise<T>,callerSignal?:AbortSignal):Promise<T>{
  if(callerSignal!==undefined&&!(callerSignal instanceof AbortSignal))throw Error('Invalid budget recovery discovery signal');const controller=new AbortController(),signal=callerSignal?AbortSignal.any([callerSignal,controller.signal]):controller.signal;this.active(signal);if(this.timeoutMs===undefined&&!callerSignal)return operation(signal);if(this.timeoutMs!==undefined&&this.pending>=this.maxPending!)throw Error('Budget recovery discovery unavailable');if(this.timeoutMs!==undefined)this.pending++;const task=Promise.resolve().then(()=>operation(signal));if(this.timeoutMs!==undefined)void task.then(()=>{this.pending--;},()=>{this.pending--;});let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('Budget recovery discovery unavailable'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});if(this.timeoutMs!==undefined)timer=setTimeout(()=>controller.abort(),this.timeoutMs);try{return await Promise.race([task,cancelled]);}finally{if(timer!==undefined)clearTimeout(timer);signal.removeEventListener('abort',abort);}
 }
 async list(actor:Actor,options:{after?:string;limit?:number}={},callerSignal?:AbortSignal):Promise<AgentBudgetRecoveryPage>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId)||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='after'&&key!=='limit')||(options.after!==undefined&&!id(options.after))||(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100)))throw Error('Invalid budget recovery discovery request');
  const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options.after??'',limit=options.limit??50;return this.bounded(async signal=>{await this.permit(who,signal);
  const rows=this.db.prepare("SELECT c.run_id,r.status AS run_status,COUNT(*) AS reserved FROM agent_token_calls c LEFT JOIN agent_runs r ON r.tenant_id=c.tenant_id AND r.agent_id=c.agent_id AND r.run_id=c.run_id WHERE c.tenant_id=? AND c.agent_id=? AND c.run_id>? AND c.status='reserved' GROUP BY c.run_id,r.status ORDER BY c.run_id LIMIT ?").all(this.scope.tenantId,this.scope.agentId,after,limit+1);
  const checked=rows.map(row=>{if(!id(row.run_id)||typeof row.run_status!=='string'||!statuses.includes(row.run_status)||!Number.isSafeInteger(row.reserved)||Number(row.reserved)<1)throw Error('Invalid budget recovery discovery data');return {runId:row.run_id,runStatus:row.run_status as AgentRunMetricStatus,reserved:Number(row.reserved)};});
  await this.permit(who,signal);const items=checked.slice(0,limit);return {items,...(checked.length>limit?{nextAfter:items[items.length-1]!.runId}:{})};},callerSignal);
 }
}
export type {Actor as AgentBudgetRecoveryDiscoveryActor,Options as AgentBudgetRecoveryDiscoveryOptions};
