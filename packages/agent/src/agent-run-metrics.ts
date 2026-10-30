import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';

const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'] as const;
export type AgentRunMetricStatus=typeof statuses[number];
export type AgentRunMetricsActor={tenantId:string;principalId:string};
export type AgentRunMetricsSnapshot={status:AgentRunMetricStatus;archived:boolean;count:number}[];
export type AgentRunMetricsOptions={scope:AgentRunScope;authorize:(actor:AgentRunMetricsActor,scope:AgentRunScope)=>boolean|Promise<boolean>};
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);

/** Authorized current-state aggregates for one tenant and agent; no run identifiers are returned. */
export class SqliteAgentRunMetrics {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:AgentRunMetricsOptions['authorize'];
 constructor(path:string,options:AgentRunMetricsOptions){
  if(typeof path!=='string'||!path||!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid agent metrics configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path,{readOnly:true});
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs'").get())throw Error('Agent metrics unavailable');}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 async snapshot(actor:AgentRunMetricsActor):Promise<AgentRunMetricsSnapshot>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw Error('Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},scope={...this.scope};
  const permitted=async()=>{try{return await this.authorize({...who},{...scope})===true;}catch{return false;}};
  if(!await permitted())throw Error('Agent metrics access denied');
  const rows=this.db.prepare('SELECT status,archived,COUNT(*) AS count FROM agent_runs WHERE tenant_id=? AND agent_id=? GROUP BY status,archived').all(scope.tenantId,scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if(typeof row.status!=='string'||!statuses.includes(row.status as AgentRunMetricStatus)||(row.archived!==0&&row.archived!==1)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent metrics data');counts.set(`${row.status}:${row.archived}`,Number(row.count));}
  if(!await permitted())throw Error('Agent metrics access denied');return statuses.flatMap(status=>[false,true].map(archived=>({status,archived,count:counts.get(`${status}:${Number(archived)}`)??0})));
 }
 async render(actor:AgentRunMetricsActor):Promise<string>{const rows=await this.snapshot(actor);return ['# HELP app_mixer_agent_runs Current durable agent runs by state and archive flag.','# TYPE app_mixer_agent_runs gauge',...rows.map(row=>`app_mixer_agent_runs{status="${row.status}",archived="${row.archived}"} ${row.count}`),''].join('\n');}
}
