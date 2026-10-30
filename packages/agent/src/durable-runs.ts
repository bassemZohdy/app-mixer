import {ensureAgentRunHistory} from './agent-run-history.js';
import {ensureAgentTraceSchema,insertAgentTraceParent,parseAgentTraceParent} from './agent-trace-context.js';
import {ensureAgentNoticeSchema,insertAgentNotice} from './agent-notices.js';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

type RunScope={tenantId:string;agentId:string};
type RunStatus='queued'|'running'|'pause_requested'|'cancel_requested'|'paused'|'uncertain'|'succeeded'|'failed'|'cancelled';
export type DurableAgentRun={tenantId:string;agentId:string;runId:string;definitionVersion:number;revision:number;status:RunStatus;attempts:number;maxAttempts:number;deadline:number;leaseOwner:string|null;leaseToken:string|null;leaseUntil:number|null;archived:boolean;delegationWait:{grantId:string;revision:number;principalId:string}|null;approvalWait:{actionId:string}|null};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const number=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function scopeKey(scope:RunScope,runId:string):void{if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(runId))throw Error('Invalid run scope');}

/** Local lifecycle registry. Host must authenticate, authorize, and reconcile external effects. */
export class SqliteAgentRuns {
 private readonly db:DatabaseSync;
 constructor(path:string){this.db=new DatabaseSync(path);try{this.db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS agent_runs (
   tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,definition_version INTEGER NOT NULL,
   revision INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,deadline INTEGER NOT NULL,
   lease_owner TEXT,lease_token TEXT,lease_until INTEGER,archived INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY(tenant_id,agent_id,run_id)
  );
  CREATE INDEX IF NOT EXISTS agent_runs_queued ON agent_runs(tenant_id,agent_id,status,archived,run_id);
  CREATE TABLE IF NOT EXISTS agent_run_starts (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,started_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));
  CREATE INDEX IF NOT EXISTS agent_run_starts_by_day ON agent_run_starts(tenant_id,agent_id,started_at);
  CREATE TABLE IF NOT EXISTS agent_delegation_waits (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,grant_id TEXT NOT NULL,grant_revision INTEGER NOT NULL,principal_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));
  CREATE TABLE IF NOT EXISTS agent_approval_waits (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));`);ensureAgentNoticeSchema(this.db);ensureAgentRunHistory(this.db);ensureAgentTraceSchema(this.db);}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 get(scope:RunScope,runId:string):DurableAgentRun|undefined {
  scopeKey(scope,runId);const row=this.db.prepare('SELECT * FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);
  if(!row)return undefined;
  const wait=this.db.prepare('SELECT grant_id,grant_revision,principal_id FROM agent_delegation_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);
  const approvalWait=this.db.prepare('SELECT action_id FROM agent_approval_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);
  return {approvalWait:approvalWait?{actionId:String(approvalWait.action_id)}:null,delegationWait:wait?{grantId:String(wait.grant_id),revision:Number(wait.grant_revision),principalId:String(wait.principal_id)}:null,tenantId:scope.tenantId,agentId:scope.agentId,runId,definitionVersion:Number(row.definition_version),revision:Number(row.revision),status:row.status as RunStatus,attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts),deadline:Number(row.deadline),leaseOwner:row.lease_owner as string|null,leaseToken:row.lease_token as string|null,leaseUntil:row.lease_until===null?null:Number(row.lease_until),archived:row.archived===1};
 }
 list(scope:RunScope,options:{after?:string;limit?:number;includeArchived?:boolean}={}):DurableAgentRun[] {
  scopeKey(scope,'validation');if(!options||typeof options!=='object'||(options.after!==undefined&&!id(options.after))||!number(options.limit??100)||(options.limit??100)<1||(options.limit??100)>100||(options.includeArchived!==undefined&&typeof options.includeArchived!=='boolean'))throw Error('Invalid run listing');
  const rows=this.db.prepare('SELECT run_id FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id>? AND (?=1 OR archived=0) ORDER BY run_id LIMIT ?').all(scope.tenantId,scope.agentId,options.after??'',options.includeArchived?1:0,options.limit??100);
  return rows.map(row=>this.get(scope,String(row.run_id))!);
 }
 /** Return a bounded page of queued run IDs; host authorization remains required. */
 queuedPage(scope:RunScope,options:{after?:string;limit?:number}={}):{runIds:string[];next?:string}{
  scopeKey(scope,'validation');if(!options||typeof options!=='object'||(options.after!==undefined&&!id(options.after))||!number(options.limit??50)||(options.limit??50)<1||(options.limit??50)>100)throw Error('Invalid queued run query');
  const limit=options.limit??50,rows=this.db.prepare("SELECT run_id FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status='queued' AND archived=0 AND run_id>? ORDER BY run_id LIMIT ?").all(scope.tenantId,scope.agentId,options.after??'',limit+1),runIds=rows.slice(0,limit).map(row=>String(row.run_id));return {runIds,...(rows.length>limit?{next:runIds[runIds.length-1]!}:{})};
 }
 getTraceParent(scope:RunScope,runId:string):string|undefined{scopeKey(scope,runId);const row=this.db.prepare('SELECT trace_parent FROM agent_run_trace_context WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);if(!row)return undefined;if(!parseAgentTraceParent(row.trace_parent))throw Error('Invalid agent trace context');return String(row.trace_parent);}
 create(scope:RunScope,runId:string,config:{definitionVersion:number;maxAttempts:number;deadline:number;traceParent?:string},now=Date.now()):DurableAgentRun {
  scopeKey(scope,runId);if(!config||!number(config.definitionVersion)||config.definitionVersion<1||!number(config.maxAttempts)||config.maxAttempts<1||config.maxAttempts>100||!number(config.deadline)||!number(now)||config.deadline<=now||(config.traceParent!==undefined&&!parseAgentTraceParent(config.traceParent)))throw Error('Invalid run configuration');
  if(config.traceParent!==undefined){this.db.exec('BEGIN IMMEDIATE');try{const result=this.db.prepare("INSERT OR IGNORE INTO agent_runs VALUES (?,?,?,?,1,'queued',0,?,?,NULL,NULL,NULL,0)").run(scope.tenantId,scope.agentId,runId,config.definitionVersion,config.maxAttempts,config.deadline);if(result.changes!==1)throw Error('Run already exists');insertAgentTraceParent(this.db,scope,runId,config.traceParent);const run=this.get(scope,runId)!;this.db.exec('COMMIT');return run;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  const result=this.db.prepare("INSERT OR IGNORE INTO agent_runs VALUES (?,?,?,?,1,'queued',0,?,?,NULL,NULL,NULL,0)").run(scope.tenantId,scope.agentId,runId,config.definitionVersion,config.maxAttempts,config.deadline);
  if(result.changes!==1)throw Error('Run already exists');return this.get(scope,runId)!;
 }
 private transition(scope:RunScope,runId:string,expectedRevision:number,fn:(run:DurableAgentRun)=>void):DurableAgentRun {
  scopeKey(scope,runId);if(!number(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid run revision');
  this.db.exec('BEGIN IMMEDIATE');try{
   const run=this.get(scope,runId);if(!run)throw Error('Run not found');if(run.revision!==expectedRevision)throw Error('Run revision conflict');
   if(run.archived)throw Error('Run is archived');fn(run);run.revision++;
   this.db.prepare('UPDATE agent_runs SET revision=?,status=?,attempts=?,lease_owner=?,lease_token=?,lease_until=?,archived=? WHERE tenant_id=? AND agent_id=? AND run_id=?').run(run.revision,run.status,run.attempts,run.leaseOwner,run.leaseToken,run.leaseUntil,run.archived?1:0,scope.tenantId,scope.agentId,runId);
   this.db.exec('COMMIT');return run;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private hasUnresolvedTokenUsage(scope:RunScope,runId:string):boolean {
  const table=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_token_calls'").get();
  return !!table&&!!this.db.prepare("SELECT 1 FROM agent_token_calls WHERE tenant_id=? AND agent_id=? AND run_id=? AND status='reserved' LIMIT 1").get(scope.tenantId,scope.agentId,runId);
 }
 claim(scope:RunScope,runId:string,revision:number,workerId:string,leaseMs:number,now=Date.now(),maxConcurrentRuns=1,maxRunsPerDay?:number):DurableAgentRun {
  if(!id(workerId)||!number(leaseMs)||leaseMs<1||leaseMs>3600000||!number(now)||now>Number.MAX_SAFE_INTEGER-leaseMs||!number(maxConcurrentRuns)||maxConcurrentRuns<1||maxConcurrentRuns>100||(maxRunsPerDay!==undefined&&(!number(maxRunsPerDay)||maxRunsPerDay<1||maxRunsPerDay>1000000)))throw Error('Invalid lease');
  return this.transition(scope,runId,revision,run=>{if(run.status!=='queued'||run.attempts>=run.maxAttempts||now>=run.deadline)throw Error('Run cannot be claimed');const active=this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status IN ('running','pause_requested','cancel_requested')").get(scope.tenantId,scope.agentId);if(Number(active?.n)>=maxConcurrentRuns)throw Error('Agent concurrency limit');const start=this.db.prepare('SELECT started_at FROM agent_run_starts WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);if(!start){const day=Math.floor(now/86400000)*86400000;if(maxRunsPerDay!==undefined){const count=this.db.prepare('SELECT COUNT(*) AS n FROM agent_run_starts WHERE tenant_id=? AND agent_id=? AND started_at>=? AND started_at<=?').get(scope.tenantId,scope.agentId,day,Math.min(day+86399999,Number.MAX_SAFE_INTEGER));if(Number(count?.n)>=maxRunsPerDay)throw Error('Agent daily run limit');}this.db.prepare('INSERT INTO agent_run_starts VALUES (?,?,?,?)').run(scope.tenantId,scope.agentId,runId,now);}run.status='running';run.attempts++;run.leaseOwner=workerId;run.leaseToken=randomUUID();run.leaseUntil=Math.min(now+leaseMs,run.deadline);});
 }
 renew(scope:RunScope,runId:string,revision:number,token:string,leaseMs:number,now=Date.now()):DurableAgentRun {
  if(!id(token)||!number(leaseMs)||leaseMs<1||leaseMs>3600000||!number(now)||now>Number.MAX_SAFE_INTEGER-leaseMs)throw Error('Invalid lease');
  return this.transition(scope,runId,revision,run=>{this.checkLease(run,token,now);if(run.status!=='running')throw Error('Run cannot be renewed');run.leaseUntil=Math.min(now+leaseMs,run.deadline);});
 }
 request(scope:RunScope,runId:string,revision:number,action:'pause'|'resume'|'cancel',now=Date.now()):DurableAgentRun {
  if(!['pause','resume','cancel'].includes(action)||!number(now))throw Error('Invalid run action');
  return this.transition(scope,runId,revision,run=>{
   if(action==='pause'&&run.status==='queued')run.status='paused';
   else if(action==='pause'&&run.status==='running')run.status='pause_requested';
   else if(action==='resume'&&run.status==='paused'&&run.attempts<run.maxAttempts){if(run.approvalWait){const approval=this.db.prepare('SELECT status,expires_at,definition_version FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(scope.tenantId,scope.agentId,runId,run.approvalWait.actionId);if(!approval||approval.status!=='approved'||Number(approval.expires_at)<=now||Number(approval.definition_version)!==run.definitionVersion||run.deadline<=now)throw Error('Approval required');this.db.prepare('DELETE FROM agent_approval_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').run(scope.tenantId,scope.agentId,runId);run.approvalWait=null;}if(run.delegationWait){const wait=run.delegationWait;const grant=this.db.prepare('SELECT principal_id,revision,revoked,expires_at FROM agent_delegations WHERE tenant_id=? AND agent_id=? AND run_id=? AND grant_id=?').get(scope.tenantId,scope.agentId,runId,wait.grantId);if(!grant||grant.principal_id!==wait.principalId||Number(grant.revision)<=wait.revision||grant.revoked===1||Number(grant.expires_at)<=now||run.deadline<=now)throw Error('Delegation renewal required');this.db.prepare('DELETE FROM agent_delegation_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').run(scope.tenantId,scope.agentId,runId);run.delegationWait=null;}run.status='queued';}
   else if(action==='cancel'&&(run.status==='queued'||run.status==='paused')){run.status='cancelled';this.db.prepare('DELETE FROM agent_delegation_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').run(scope.tenantId,scope.agentId,runId);run.delegationWait=null;this.db.prepare('DELETE FROM agent_approval_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').run(scope.tenantId,scope.agentId,runId);run.approvalWait=null;}
   else if(action==='cancel'&&(run.status==='running'||run.status==='pause_requested'))run.status='cancel_requested';
   else throw Error('Invalid run state');
  });
 }
 settle(scope:RunScope,runId:string,revision:number,token:string,outcome:'succeeded'|'failed'|'stopped'|'uncertain',now=Date.now()):DurableAgentRun {
  if(!id(token)||!number(now)||!['succeeded','failed','stopped','uncertain'].includes(outcome))throw Error('Invalid run outcome');
  return this.transition(scope,runId,revision,run=>{this.checkLease(run,token,now);
   if(outcome==='stopped'&&!['pause_requested','cancel_requested'].includes(run.status))throw Error('Invalid run state');
   if(this.hasUnresolvedTokenUsage(scope,runId))run.status='uncertain';
   else if(outcome==='stopped'){if(run.status==='pause_requested')run.status='paused';else run.status='cancelled';}
   else run.status=outcome;
   run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;
  });
 }
 /** Pause only after execution stopped and no journaled action has an uncertain outcome. */
 pauseForApproval(scope:RunScope,runId:string,revision:number,token:string,actionId:string,now=Date.now()):DurableAgentRun {
  if(!id(token)||!id(actionId)||!number(now))throw Error('Invalid approval wait');
  return this.transition(scope,runId,revision,run=>{this.checkLease(run,token,now);if(run.status!=='running')throw Error('Invalid run state');
   const approval=this.db.prepare('SELECT status,expires_at,definition_version FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(scope.tenantId,scope.agentId,runId,actionId);
   if(!approval||!['pending','approved'].includes(String(approval.status))||Number(approval.expires_at)<=now||Number(approval.definition_version)!==run.definitionVersion)throw Error('Approval unavailable');
   const table=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_action_journal'").get();if(!table)throw Error('Action journal required');const action=this.db.prepare("SELECT 1 AS found FROM agent_action_journal WHERE tenant_id=? AND agent_id=? AND run_id=? AND status IN ('dispatching','uncertain') LIMIT 1").get(scope.tenantId,scope.agentId,runId);if(action)throw Error('Action requires reconciliation');if(this.hasUnresolvedTokenUsage(scope,runId))throw Error('Token usage requires reconciliation');
   this.db.prepare('INSERT INTO agent_approval_waits VALUES (?,?,?,?)').run(scope.tenantId,scope.agentId,runId,actionId);run.approvalWait={actionId};run.status='paused';run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;
  });
 }
 /** The worker has stopped before dispatch; a live lease and expired persisted grant are required. */
 pauseForDelegation(scope:RunScope,runId:string,revision:number,token:string,grantId:string,grantRevision:number,now=Date.now()):DurableAgentRun {
  if(!id(token)||!id(grantId)||!number(grantRevision)||grantRevision<1||!number(now))throw Error('Invalid delegation wait');
  return this.transition(scope,runId,revision,run=>{this.checkLease(run,token,now);if(run.status!=='running')throw Error('Invalid run state');
   const grant=this.db.prepare('SELECT principal_id,revision,revoked,expires_at FROM agent_delegations WHERE tenant_id=? AND agent_id=? AND run_id=? AND grant_id=?').get(scope.tenantId,scope.agentId,runId,grantId);
   if(!grant||grant.revoked===1||Number(grant.revision)!==grantRevision||Number(grant.expires_at)>now)throw Error('Delegation is not expired');
   const table=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_action_journal'").get();if(!table)throw Error('Action journal required');{const action=this.db.prepare("SELECT 1 AS found FROM agent_action_journal WHERE tenant_id=? AND agent_id=? AND run_id=? AND status IN ('dispatching','uncertain') LIMIT 1").get(scope.tenantId,scope.agentId,runId);if(action)throw Error('Action requires reconciliation');}if(this.hasUnresolvedTokenUsage(scope,runId))throw Error('Token usage requires reconciliation');
   this.db.prepare('INSERT INTO agent_delegation_waits VALUES (?,?,?,?,?,?)').run(scope.tenantId,scope.agentId,runId,grantId,grantRevision,String(grant.principal_id));insertAgentNotice(this.db,scope,runId,'delegation_renewal_required',grantId,grantRevision,now);run.delegationWait={grantId,revision:grantRevision,principalId:String(grant.principal_id)};run.status='paused';run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;
  });
 }
 recoverExpired(scope:RunScope,runId:string,revision:number,now=Date.now()):DurableAgentRun {
  if(!number(now))throw Error('Invalid time');return this.transition(scope,runId,revision,run=>{if(!['running','pause_requested','cancel_requested'].includes(run.status)||run.leaseUntil===null||now<run.leaseUntil)throw Error('Lease is active');run.status='uncertain';run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;});
 }
 reconcile(scope:RunScope,runId:string,revision:number,outcome:'retry'|'succeeded'|'failed'|'cancelled'|'paused',now=Date.now()):DurableAgentRun {
  if(!number(now)||!['retry','succeeded','failed','cancelled','paused'].includes(outcome))throw Error('Invalid reconciliation');
  return this.transition(scope,runId,revision,run=>{if(run.status!=='uncertain')throw Error('Invalid run state');if(this.hasUnresolvedTokenUsage(scope,runId))throw Error('Token usage requires reconciliation');if(outcome==='retry'){if(run.attempts>=run.maxAttempts||now>=run.deadline)throw Error('Run cannot be retried');run.status='queued';}else run.status=outcome;});
 }
 archive(scope:RunScope,runId:string,revision:number):DurableAgentRun{return this.transition(scope,runId,revision,run=>{if(!['succeeded','failed','cancelled'].includes(run.status))throw Error('Invalid run state');run.archived=true;});}
 private checkLease(run:DurableAgentRun,token:string,now:number):void{if(!['running','pause_requested','cancel_requested'].includes(run.status)||run.leaseToken!==token||run.leaseUntil===null||now>=run.leaseUntil)throw Error('Invalid or expired lease');}
}
export type {RunScope as AgentRunScope,RunStatus as AgentRunStatus};
