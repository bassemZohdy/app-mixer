import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
import {AgentError} from './errors.js';
import {isIdentifier} from './validation.js';

const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'] as const;
export type AgentRunMetricStatus=typeof statuses[number];
export type AgentRunMetricsActor={tenantId:string;principalId:string};
export type AgentRunMetricsSnapshot={status:AgentRunMetricStatus;archived:boolean;count:number}[];
export type AgentRunOperationalMetric={kind:'queued'|'paused'|'lease';count:number;oldestOverdueSeconds:number};
const actionStatuses=['ready','dispatching','uncertain','succeeded','failed'] as const;
export type AgentActionMetricStatus=typeof actionStatuses[number];
export type AgentScheduleMetric={due:number;oldestDueSeconds:number};
export type AgentActionMetric={status:AgentActionMetricStatus;count:number};
const approvalStatuses=['pending','approved','rejected','cancelled','expired'] as const;
export type AgentApprovalMetricStatus=typeof approvalStatuses[number];
export type AgentApprovalMetric={status:AgentApprovalMetricStatus;count:number};
const deliveryStatuses=['pending','sending','uncertain','delivered'] as const;
export type AgentNoticeDeliveryMetricStatus=typeof deliveryStatuses[number];
export type AgentNoticeDeliveryMetric={status:AgentNoticeDeliveryMetricStatus;count:number};
export type AgentRunMetricsOptions={scope:AgentRunScope;authorize:(actor:AgentRunMetricsActor,scope:AgentRunScope)=>boolean|Promise<boolean>;includeOperational?:boolean;includeSchedules?:boolean;includeActions?:boolean;includeApprovals?:boolean;includeNoticeDeliveries?:boolean;clock?:()=>number};
const valid=isIdentifier;

/** Authorized current-state aggregates for one tenant and agent; no run identifiers are returned. */
export class SqliteAgentRunMetrics {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:AgentRunMetricsOptions['authorize'];private readonly includeOperational:boolean;private readonly includeSchedules:boolean;private readonly includeActions:boolean;private readonly includeApprovals:boolean;private readonly includeNoticeDeliveries:boolean;private readonly clock:()=>number;
 constructor(path:string,options:AgentRunMetricsOptions){
  if(typeof path!=='string'||!path||!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||typeof options.authorize!=='function'||(options.includeOperational!==undefined&&typeof options.includeOperational!=='boolean')||(options.includeSchedules!==undefined&&typeof options.includeSchedules!=='boolean')||(options.includeActions!==undefined&&typeof options.includeActions!=='boolean')||(options.includeApprovals!==undefined&&typeof options.includeApprovals!=='boolean')||(options.includeNoticeDeliveries!==undefined&&typeof options.includeNoticeDeliveries!=='boolean')||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid agent metrics configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.includeOperational=options.includeOperational===true;this.includeSchedules=options.includeSchedules===true;this.includeActions=options.includeActions===true;this.includeApprovals=options.includeApprovals===true;this.includeNoticeDeliveries=options.includeNoticeDeliveries===true;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path,{readOnly:true});
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA query_only=ON');const table=(name:string)=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);if(!table('agent_runs')||(this.includeSchedules&&!table('agent_schedules'))||(this.includeActions&&!table('agent_action_journal'))||(this.includeApprovals&&!table('agent_approvals'))||(this.includeNoticeDeliveries&&!table('agent_notice_deliveries')))throw Error('Agent metrics unavailable');}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 async snapshot(actor:AgentRunMetricsActor):Promise<AgentRunMetricsSnapshot>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw new AgentError('denied','Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},scope={...this.scope};
  const permitted=async()=>{try{return await this.authorize({...who},{...scope})===true;}catch{return false;}};
  if(!await permitted())throw new AgentError('denied','Agent metrics access denied');
  const rows=this.db.prepare('SELECT status,archived,COUNT(*) AS count FROM agent_runs WHERE tenant_id=? AND agent_id=? GROUP BY status,archived').all(scope.tenantId,scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if(typeof row.status!=='string'||!statuses.includes(row.status as AgentRunMetricStatus)||(row.archived!==0&&row.archived!==1)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent metrics data');counts.set(`${row.status}:${row.archived}`,Number(row.count));}
  if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return statuses.flatMap(status=>[false,true].map(archived=>({status,archived,count:counts.get(`${status}:${Number(archived)}`)??0})));
 }
 /** Current overdue backlog and expired leases, with a bounded fixed set of labels. */
 async operational(actor:AgentRunMetricsActor):Promise<AgentRunOperationalMetric[]>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw new AgentError('denied','Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},scope={...this.scope},permitted=async()=>{try{return await this.authorize({...who},{...scope})===true;}catch{return false;}};if(!await permitted())throw new AgentError('denied','Agent metrics access denied');const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid agent metrics clock');
  const rows=this.db.prepare("SELECT CASE WHEN status IN ('queued','paused') THEN status ELSE 'lease' END AS kind, COUNT(*) AS count, MIN(CASE WHEN status IN ('queued','paused') THEN deadline ELSE lease_until END) AS earliest, SUM(CASE WHEN status IN ('running','pause_requested','cancel_requested') AND lease_until IS NULL THEN 1 ELSE 0 END) AS invalid FROM agent_runs WHERE tenant_id=? AND agent_id=? AND archived=0 AND ((status IN ('queued','paused') AND deadline<=?) OR (status IN ('running','pause_requested','cancel_requested') AND (lease_until<=? OR lease_until IS NULL))) GROUP BY kind").all(scope.tenantId,scope.agentId,now,now),metrics:AgentRunOperationalMetric[]=[{kind:'queued',count:0,oldestOverdueSeconds:0},{kind:'paused',count:0,oldestOverdueSeconds:0},{kind:'lease',count:0,oldestOverdueSeconds:0}];
  for(const row of rows){const metric=metrics.find(item=>item.kind===row.kind);if(!metric||row.invalid!==0||!Number.isSafeInteger(row.count)||Number(row.count)<0||!Number.isSafeInteger(row.earliest)||Number(row.earliest)<0||Number(row.earliest)>now)throw Error('Invalid agent metrics data');metric.count=Number(row.count);metric.oldestOverdueSeconds=(now-Number(row.earliest))/1000;}
  if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return metrics;
 }
 private async permittedFor(actor:AgentRunMetricsActor):Promise<()=>Promise<boolean>>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw new AgentError('denied','Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},scope={...this.scope};
  const permitted=async()=>{try{return await this.authorize({...who},{...scope})===true;}catch{return false;}};if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return permitted;
 }
 /** Enabled schedules whose next occurrence is due but not yet fired, and the age of the oldest; a growing value means no schedule worker is keeping up. */
 async schedules(actor:AgentRunMetricsActor):Promise<AgentScheduleMetric>{
  if(!this.includeSchedules)throw Error('Agent schedule metrics not enabled');const permitted=await this.permittedFor(actor),now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid agent metrics clock');
  const row=this.db.prepare('SELECT COUNT(*) AS count, MIN(next_at) AS earliest FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND enabled=1 AND next_at<=?').get(this.scope.tenantId,this.scope.agentId,now);
  const count=Number(row?.count);if(!Number.isSafeInteger(count)||count<0||(count>0&&(!Number.isSafeInteger(row?.earliest)||Number(row?.earliest)>now))||(count===0&&row?.earliest!==null))throw Error('Invalid agent metrics data');
  const result={due:count,oldestDueSeconds:count?(now-Number(row?.earliest))/1000:0};if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return result;
 }
 /** Journaled actions by state; `dispatching` and `uncertain` are the ones a recovery worker or reviewer must resolve. */
 async actions(actor:AgentRunMetricsActor):Promise<AgentActionMetric[]>{
  if(!this.includeActions)throw Error('Agent action metrics not enabled');const permitted=await this.permittedFor(actor);
  const rows=this.db.prepare('SELECT status,COUNT(*) AS count FROM agent_action_journal WHERE tenant_id=? AND agent_id=? GROUP BY status').all(this.scope.tenantId,this.scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if(typeof row.status!=='string'||!actionStatuses.includes(row.status as AgentActionMetricStatus)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent metrics data');counts.set(row.status,Number(row.count));}
  if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return actionStatuses.map(status=>({status,count:counts.get(status)??0}));
 }
 /** Approvals by state, with `pending` and `approved` past their expiry counted as `expired` as the approval store reports them; a growing `pending` count means reviewers are not keeping up. */
 async approvals(actor:AgentRunMetricsActor):Promise<AgentApprovalMetric[]>{
  if(!this.includeApprovals)throw Error('Agent approval metrics not enabled');const permitted=await this.permittedFor(actor),now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid agent metrics clock');
  const rows=this.db.prepare("SELECT CASE WHEN status IN ('pending','approved') AND expires_at<=? THEN 'expired' ELSE status END AS state,COUNT(*) AS count FROM agent_approvals WHERE tenant_id=? AND agent_id=? GROUP BY state").all(now,this.scope.tenantId,this.scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if(typeof row.state!=='string'||!approvalStatuses.includes(row.state as AgentApprovalMetricStatus)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent metrics data');counts.set(row.state,Number(row.count));}
  if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return approvalStatuses.map(status=>({status,count:counts.get(status)??0}));
 }
 /** Notice deliveries by state; `sending` that never finishes and `uncertain` need an operator, and a growing `pending` count means the delivery worker is not keeping up. */
 async noticeDeliveries(actor:AgentRunMetricsActor):Promise<AgentNoticeDeliveryMetric[]>{
  if(!this.includeNoticeDeliveries)throw Error('Agent notice delivery metrics not enabled');const permitted=await this.permittedFor(actor);
  const rows=this.db.prepare('SELECT status,COUNT(*) AS count FROM agent_notice_deliveries WHERE tenant_id=? AND agent_id=? GROUP BY status').all(this.scope.tenantId,this.scope.agentId),counts=new Map<string,number>();
  for(const row of rows){if(typeof row.status!=='string'||!deliveryStatuses.includes(row.status as AgentNoticeDeliveryMetricStatus)||!Number.isSafeInteger(row.count)||Number(row.count)<0)throw Error('Invalid agent metrics data');counts.set(row.status,Number(row.count));}
  if(!await permitted())throw new AgentError('denied','Agent metrics access denied');return deliveryStatuses.map(status=>({status,count:counts.get(status)??0}));
 }
 async render(actor:AgentRunMetricsActor):Promise<string>{const rows=await this.snapshot(actor),operational=this.includeOperational?await this.operational(actor):undefined,schedules=this.includeSchedules?await this.schedules(actor):undefined,actions=this.includeActions?await this.actions(actor):undefined,approvals=this.includeApprovals?await this.approvals(actor):undefined,deliveries=this.includeNoticeDeliveries?await this.noticeDeliveries(actor):undefined;return ['# HELP app_mixer_agent_runs Current durable agent runs by state and archive flag.','# TYPE app_mixer_agent_runs gauge',...rows.map(row=>`app_mixer_agent_runs{status="${row.status}",archived="${row.archived}"} ${row.count}`),...(operational?['# HELP app_mixer_agent_overdue_runs Current runs past their deadline or lease expiry.','# TYPE app_mixer_agent_overdue_runs gauge',...operational.map(row=>`app_mixer_agent_overdue_runs{kind="${row.kind}"} ${row.count}`),'# HELP app_mixer_agent_oldest_overdue_seconds Age of the oldest overdue deadline or lease.','# TYPE app_mixer_agent_oldest_overdue_seconds gauge',...operational.map(row=>`app_mixer_agent_oldest_overdue_seconds{kind="${row.kind}"} ${row.oldestOverdueSeconds}`)]:[]),...(schedules?['# HELP app_mixer_agent_due_schedules Enabled schedules with a due occurrence not yet fired.','# TYPE app_mixer_agent_due_schedules gauge',`app_mixer_agent_due_schedules ${schedules.due}`,'# HELP app_mixer_agent_oldest_due_schedule_seconds Age of the oldest due, unfired schedule occurrence.','# TYPE app_mixer_agent_oldest_due_schedule_seconds gauge',`app_mixer_agent_oldest_due_schedule_seconds ${schedules.oldestDueSeconds}`]:[]),...(actions?['# HELP app_mixer_agent_actions Journaled agent actions by state.','# TYPE app_mixer_agent_actions gauge',...actions.map(row=>`app_mixer_agent_actions{status="${row.status}"} ${row.count}`)]:[]),...(deliveries?['# HELP app_mixer_agent_notice_deliveries Notice deliveries by state.','# TYPE app_mixer_agent_notice_deliveries gauge',...deliveries.map(row=>`app_mixer_agent_notice_deliveries{status="${row.status}"} ${row.count}`)]:[]),...(approvals?['# HELP app_mixer_agent_approvals Human approvals by state; pending ones await a reviewer.','# TYPE app_mixer_agent_approvals gauge',...approvals.map(row=>`app_mixer_agent_approvals{status="${row.status}"} ${row.count}`)]:[]),''].join('\n');}
}
