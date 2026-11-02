import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
import type {AgentRunMetricStatus} from './agent-run-metrics.js';

type Actor={tenantId:string;principalId:string};
type Options={scope:AgentRunScope;authorize:(actor:Actor,scope:AgentRunScope)=>boolean|Promise<boolean>};
export type AgentBudgetRecoveryCandidate={runId:string;runStatus:AgentRunMetricStatus;reserved:number};
export type AgentBudgetRecoveryPage={items:AgentBudgetRecoveryCandidate[];nextAfter?:string};
const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'];
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
/** Authorized, bounded discovery of runs with unresolved token reservations. */
export class SqliteAgentBudgetRecoveryDiscovery {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){
  if(typeof path!=='string'||!path||!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid budget recovery discovery');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path,{readOnly:true});
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');for(const table of ['agent_runs','agent_token_calls'])if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Budget recovery discovery unavailable');}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 isBoundTo(scope:AgentRunScope):boolean{return !!scope&&scope.tenantId===this.scope.tenantId&&scope.agentId===this.scope.agentId;}
 private async permit(actor:Actor):Promise<void>{try{if(await this.authorize({...actor},{...this.scope})===true)return;}catch{}throw Error('Budget recovery discovery denied');}
 async list(actor:Actor,options:{after?:string;limit?:number}={}):Promise<AgentBudgetRecoveryPage>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId)||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='after'&&key!=='limit')||(options.after!==undefined&&!id(options.after))||(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100)))throw Error('Invalid budget recovery discovery request');
  const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options.after??'',limit=options.limit??50;await this.permit(who);
  const rows=this.db.prepare("SELECT c.run_id,r.status AS run_status,COUNT(*) AS reserved FROM agent_token_calls c LEFT JOIN agent_runs r ON r.tenant_id=c.tenant_id AND r.agent_id=c.agent_id AND r.run_id=c.run_id WHERE c.tenant_id=? AND c.agent_id=? AND c.run_id>? AND c.status='reserved' GROUP BY c.run_id,r.status ORDER BY c.run_id LIMIT ?").all(this.scope.tenantId,this.scope.agentId,after,limit+1);
  const checked=rows.map(row=>{if(!id(row.run_id)||typeof row.run_status!=='string'||!statuses.includes(row.run_status)||!Number.isSafeInteger(row.reserved)||Number(row.reserved)<1)throw Error('Invalid budget recovery discovery data');return {runId:row.run_id,runStatus:row.run_status as AgentRunMetricStatus,reserved:Number(row.reserved)};});
  await this.permit(who);const items=checked.slice(0,limit);return {items,...(checked.length>limit?{nextAfter:items[items.length-1]!.runId}:{})};
 }
}
export type {Actor as AgentBudgetRecoveryDiscoveryActor,Options as AgentBudgetRecoveryDiscoveryOptions};
