import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';

const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'] as const;
export type AgentRunMetricStatus=typeof statuses[number];
export type AgentRunMetricsActor={tenantId:string;principalId:string};
export type AgentRunMetricsSnapshot={status:AgentRunMetricStatus;archived:boolean;count:number}[];
export type AgentRunOperationalMetric={kind:'queued'|'paused'|'lease';count:number;oldestOverdueSeconds:number};
export type AgentActionBacklogMetric={actionStatus:'dispatching'|'uncertain';runStatus:AgentRunMetricStatus;count:number};
export type AgentRunMetricsOptions={includeActionBacklog?:boolean;scope:AgentRunScope;authorize:(actor:AgentRunMetricsActor,scope:AgentRunScope)=>boolean|Promise<boolean>;includeOperational?:boolean;clock?:()=>number};
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);

/** Authorized current-state aggregates for one tenant and agent; no run identifiers are returned. */
export class SqliteAgentRunMetrics {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:AgentRunMetricsOptions['authorize'];private readonly includeOperational:boolean;private readonly includeActionBacklog:boolean;private readonly clock:()=>number;
 constructor(path:string,options:AgentRunMetricsOptions){
  if(typeof path!=='string'||!path||!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||typeof options.authorize!=='function'||(options.includeOperational!==undefined&&typeof options.includeOperational!=='boolean')||(options.includeActionBacklog!==undefined&&typeof options.includeActionBacklog!=='boolean')||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid agent metrics configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.includeOperational=options.includeOperational===true;this.includeActionBacklog=options.includeActionBacklog===true;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path,{readOnly:true});
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs'").get())throw Error('Agent metrics unavailable');if(this.includeActionBacklog&&!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_action_journal'").get())throw Error('Agent action metrics unavailable');}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private actor(actor:AgentRunMetricsActor):AgentRunMetricsActor{if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw Error('Invalid agent metrics actor');return {tenantId:actor.tenantId,principalId:actor.principalId};}
 private async permitted(actor:AgentRunMetricsActor):Promise<void>{try{if(await this.authorize({...actor},{...this.scope})===true)return;}catch{}throw Error('Agent metrics access denied');}
 private readSnapshot():AgentRunMetricsSnapshot{
  const rows=this.db.prepare('SELECT status,archived,COUNT(*) AS count FROM agent_runs WHERE tenant_id=? AND agent_id=? GROUP BY status,archived').all(this.scope.tenantId,this.scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if(typeof row.status!=='string'||!statuses.includes(row.status as AgentRunMetricStatus)||(row.archived!==0&&row.archived!==1)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent metrics data');counts.set(`${row.status}:${row.archived}`,Number(row.count));}
  return statuses.flatMap(status=>[false,true].map(archived=>({status,archived,count:counts.get(`${status}:${Number(archived)}`)??0})));
 }
 private readOperational():AgentRunOperationalMetric[]{
  const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid agent metrics clock');
  const rows=this.db.prepare("SELECT CASE WHEN status IN ('queued','paused') THEN status ELSE 'lease' END AS kind, COUNT(*) AS count, MIN(CASE WHEN status IN ('queued','paused') THEN deadline ELSE lease_until END) AS earliest, SUM(CASE WHEN status IN ('running','pause_requested','cancel_requested') AND lease_until IS NULL THEN 1 ELSE 0 END) AS invalid FROM agent_runs WHERE tenant_id=? AND agent_id=? AND archived=0 AND ((status IN ('queued','paused') AND deadline<=?) OR (status IN ('running','pause_requested','cancel_requested') AND (lease_until<=? OR lease_until IS NULL))) GROUP BY kind").all(this.scope.tenantId,this.scope.agentId,now,now),metrics:AgentRunOperationalMetric[]=[{kind:'queued',count:0,oldestOverdueSeconds:0},{kind:'paused',count:0,oldestOverdueSeconds:0},{kind:'lease',count:0,oldestOverdueSeconds:0}];
  for(const row of rows){const metric=metrics.find(item=>item.kind===row.kind);if(!metric||row.invalid!==0||!Number.isSafeInteger(row.count)||Number(row.count)<0||!Number.isSafeInteger(row.earliest)||Number(row.earliest)<0||Number(row.earliest)>now)throw Error('Invalid agent metrics data');metric.count=Number(row.count);metric.oldestOverdueSeconds=(now-Number(row.earliest))/1000;}
  return metrics;
 }
 private readActionBacklog():AgentActionBacklogMetric[]{
  const rows=this.db.prepare("SELECT a.status AS action_status,r.status AS run_status,COUNT(*) AS count FROM agent_action_journal a LEFT JOIN agent_runs r ON r.tenant_id=a.tenant_id AND r.agent_id=a.agent_id AND r.run_id=a.run_id WHERE a.tenant_id=? AND a.agent_id=? AND a.status IN ('dispatching','uncertain') GROUP BY a.status,r.status").all(this.scope.tenantId,this.scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if((row.action_status!=='dispatching'&&row.action_status!=='uncertain')||typeof row.run_status!=='string'||!statuses.includes(row.run_status as AgentRunMetricStatus)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent action metrics data');counts.set(`${row.action_status}:${row.run_status}`,Number(row.count));}
  return (['dispatching','uncertain'] as const).flatMap(actionStatus=>statuses.map(runStatus=>({actionStatus,runStatus,count:counts.get(`${actionStatus}:${runStatus}`)??0})));
 }
 /** Current unresolved journal entries by action and run state, including archived runs. */
 async actionBacklog(actor:AgentRunMetricsActor):Promise<AgentActionBacklogMetric[]>{if(!this.includeActionBacklog)throw Error('Agent action metrics disabled');const who=this.actor(actor);await this.permitted(who);const rows=this.readActionBacklog();await this.permitted(who);return rows;}
 async snapshot(actor:AgentRunMetricsActor):Promise<AgentRunMetricsSnapshot>{const who=this.actor(actor);await this.permitted(who);const rows=this.readSnapshot();await this.permitted(who);return rows;}
 /** Current overdue backlog and expired leases, with a bounded fixed set of labels. */
 async operational(actor:AgentRunMetricsActor):Promise<AgentRunOperationalMetric[]>{const who=this.actor(actor);await this.permitted(who);const rows=this.readOperational();await this.permitted(who);return rows;}
 async render(actor:AgentRunMetricsActor):Promise<string>{const who=this.actor(actor);await this.permitted(who);let rows:AgentRunMetricsSnapshot,operational:AgentRunOperationalMetric[]|undefined,actions:AgentActionBacklogMetric[]|undefined;this.db.exec('BEGIN');try{rows=this.readSnapshot();operational=this.includeOperational?this.readOperational():undefined;actions=this.includeActionBacklog?this.readActionBacklog():undefined;this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}await this.permitted(who);return ['# HELP app_mixer_agent_runs Current durable agent runs by state and archive flag.','# TYPE app_mixer_agent_runs gauge',...rows.map(row=>`app_mixer_agent_runs{status="${row.status}",archived="${row.archived}"} ${row.count}`),...(operational?['# HELP app_mixer_agent_overdue_runs Current runs past their deadline or lease expiry.','# TYPE app_mixer_agent_overdue_runs gauge',...operational.map(row=>`app_mixer_agent_overdue_runs{kind="${row.kind}"} ${row.count}`),'# HELP app_mixer_agent_oldest_overdue_seconds Age of the oldest overdue deadline or lease.','# TYPE app_mixer_agent_oldest_overdue_seconds gauge',...operational.map(row=>`app_mixer_agent_oldest_overdue_seconds{kind="${row.kind}"} ${row.oldestOverdueSeconds}`)]:[]),...(actions?['# HELP app_mixer_agent_action_backlog Unresolved journal entries by action and run state.','# TYPE app_mixer_agent_action_backlog gauge',...actions.map(row=>`app_mixer_agent_action_backlog{action_status="${row.actionStatus}",run_status="${row.runStatus}"} ${row.count}`)]:[]),''].join('\n');}
}
