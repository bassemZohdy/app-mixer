import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
import type {AgentRunMetricStatus} from './agent-run-metrics.js';

type Actor={tenantId:string;principalId:string};
type Options={scope:AgentRunScope;authorize:(actor:Actor,scope:AgentRunScope)=>boolean|Promise<boolean>};
export type AgentActionRecoveryCandidate={runId:string;runStatus:AgentRunMetricStatus;dispatching:number;uncertain:number};
export type AgentActionRecoveryPage={items:AgentActionRecoveryCandidate[];nextAfter?:string};
const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'];
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
/** Authorized, bounded discovery of runs with unresolved action journal entries. */
export class SqliteAgentActionRecoveryDiscovery {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){
  if(typeof path!=='string'||!path||!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid action recovery discovery');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path,{readOnly:true});
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');for(const table of ['agent_runs','agent_action_journal'])if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Action recovery discovery unavailable');}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private async permit(actor:Actor):Promise<void>{try{if(await this.authorize({...actor},{...this.scope})===true)return;}catch{}throw Error('Action recovery discovery denied');}
 async list(actor:Actor,options:{after?:string;limit?:number}={}):Promise<AgentActionRecoveryPage>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId)||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='after'&&key!=='limit')||(options.after!==undefined&&!id(options.after))||(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100)))throw Error('Invalid action recovery discovery request');
  const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options.after??'',limit=options.limit??50;await this.permit(who);
  const rows=this.db.prepare("SELECT a.run_id,r.status AS run_status,SUM(CASE WHEN a.status='dispatching' THEN 1 ELSE 0 END) AS dispatching,SUM(CASE WHEN a.status='uncertain' THEN 1 ELSE 0 END) AS uncertain FROM agent_action_journal a LEFT JOIN agent_runs r ON r.tenant_id=a.tenant_id AND r.agent_id=a.agent_id AND r.run_id=a.run_id WHERE a.tenant_id=? AND a.agent_id=? AND a.run_id>? AND a.status IN ('dispatching','uncertain') GROUP BY a.run_id,r.status ORDER BY a.run_id LIMIT ?").all(this.scope.tenantId,this.scope.agentId,after,limit+1);
  const checked=rows.map(row=>{if(!id(row.run_id)||typeof row.run_status!=='string'||!statuses.includes(row.run_status)||!Number.isSafeInteger(row.dispatching)||Number(row.dispatching)<0||!Number.isSafeInteger(row.uncertain)||Number(row.uncertain)<0||Number(row.dispatching)+Number(row.uncertain)<1)throw Error('Invalid action recovery discovery data');return {runId:row.run_id,runStatus:row.run_status as AgentRunMetricStatus,dispatching:Number(row.dispatching),uncertain:Number(row.uncertain)};});
  await this.permit(who);const items=checked.slice(0,limit);return {items,...(checked.length>limit?{nextAfter:items[items.length-1]!.runId}:{})};
 }
}
export type {Actor as AgentActionRecoveryDiscoveryActor,Options as AgentActionRecoveryDiscoveryOptions};
