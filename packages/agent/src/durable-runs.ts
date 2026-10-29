import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

type RunScope={tenantId:string;agentId:string};
type RunStatus='queued'|'running'|'pause_requested'|'cancel_requested'|'paused'|'uncertain'|'succeeded'|'failed'|'cancelled';
export type DurableAgentRun={tenantId:string;agentId:string;runId:string;definitionVersion:number;revision:number;status:RunStatus;attempts:number;maxAttempts:number;deadline:number;leaseOwner:string|null;leaseToken:string|null;leaseUntil:number|null;archived:boolean};
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
  );`);}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 get(scope:RunScope,runId:string):DurableAgentRun|undefined {
  scopeKey(scope,runId);const row=this.db.prepare('SELECT * FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);
  if(!row)return undefined;
  return {tenantId:scope.tenantId,agentId:scope.agentId,runId,definitionVersion:Number(row.definition_version),revision:Number(row.revision),status:row.status as RunStatus,attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts),deadline:Number(row.deadline),leaseOwner:row.lease_owner as string|null,leaseToken:row.lease_token as string|null,leaseUntil:row.lease_until===null?null:Number(row.lease_until),archived:row.archived===1};
 }
 list(scope:RunScope,options:{after?:string;limit?:number;includeArchived?:boolean}={}):DurableAgentRun[] {
  scopeKey(scope,'validation');if(!options||typeof options!=='object'||(options.after!==undefined&&!id(options.after))||!number(options.limit??100)||(options.limit??100)<1||(options.limit??100)>100||(options.includeArchived!==undefined&&typeof options.includeArchived!=='boolean'))throw Error('Invalid run listing');
  const rows=this.db.prepare('SELECT run_id FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id>? AND (?=1 OR archived=0) ORDER BY run_id LIMIT ?').all(scope.tenantId,scope.agentId,options.after??'',options.includeArchived?1:0,options.limit??100);
  return rows.map(row=>this.get(scope,String(row.run_id))!);
 }
 create(scope:RunScope,runId:string,config:{definitionVersion:number;maxAttempts:number;deadline:number},now=Date.now()):DurableAgentRun {
  scopeKey(scope,runId);if(!config||!number(config.definitionVersion)||config.definitionVersion<1||!number(config.maxAttempts)||config.maxAttempts<1||config.maxAttempts>100||!number(config.deadline)||!number(now)||config.deadline<=now)throw Error('Invalid run configuration');
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
 claim(scope:RunScope,runId:string,revision:number,workerId:string,leaseMs:number,now=Date.now()):DurableAgentRun {
  if(!id(workerId)||!number(leaseMs)||leaseMs<1||leaseMs>3600000||!number(now)||now>Number.MAX_SAFE_INTEGER-leaseMs)throw Error('Invalid lease');
  return this.transition(scope,runId,revision,run=>{if(run.status!=='queued'||run.attempts>=run.maxAttempts||now>=run.deadline)throw Error('Run cannot be claimed');run.status='running';run.attempts++;run.leaseOwner=workerId;run.leaseToken=randomUUID();run.leaseUntil=Math.min(now+leaseMs,run.deadline);});
 }
 renew(scope:RunScope,runId:string,revision:number,token:string,leaseMs:number,now=Date.now()):DurableAgentRun {
  if(!id(token)||!number(leaseMs)||leaseMs<1||leaseMs>3600000||!number(now)||now>Number.MAX_SAFE_INTEGER-leaseMs)throw Error('Invalid lease');
  return this.transition(scope,runId,revision,run=>{this.checkLease(run,token,now);if(run.status!=='running')throw Error('Run cannot be renewed');run.leaseUntil=Math.min(now+leaseMs,run.deadline);});
 }
 request(scope:RunScope,runId:string,revision:number,action:'pause'|'resume'|'cancel'):DurableAgentRun {
  if(!['pause','resume','cancel'].includes(action))throw Error('Invalid run action');
  return this.transition(scope,runId,revision,run=>{
   if(action==='pause'&&run.status==='queued')run.status='paused';
   else if(action==='pause'&&run.status==='running')run.status='pause_requested';
   else if(action==='resume'&&run.status==='paused'&&run.attempts<run.maxAttempts)run.status='queued';
   else if(action==='cancel'&&(run.status==='queued'||run.status==='paused'))run.status='cancelled';
   else if(action==='cancel'&&(run.status==='running'||run.status==='pause_requested'))run.status='cancel_requested';
   else throw Error('Invalid run state');
  });
 }
 settle(scope:RunScope,runId:string,revision:number,token:string,outcome:'succeeded'|'failed'|'stopped'|'uncertain',now=Date.now()):DurableAgentRun {
  if(!id(token)||!number(now)||!['succeeded','failed','stopped','uncertain'].includes(outcome))throw Error('Invalid run outcome');
  return this.transition(scope,runId,revision,run=>{this.checkLease(run,token,now);
   if(outcome==='stopped'){if(run.status==='pause_requested')run.status='paused';else if(run.status==='cancel_requested')run.status='cancelled';else throw Error('Invalid run state');}
   else run.status=outcome;
   run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;
  });
 }
 recoverExpired(scope:RunScope,runId:string,revision:number,now=Date.now()):DurableAgentRun {
  if(!number(now))throw Error('Invalid time');return this.transition(scope,runId,revision,run=>{if(!['running','pause_requested','cancel_requested'].includes(run.status)||run.leaseUntil===null||now<run.leaseUntil)throw Error('Lease is active');run.status='uncertain';run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;});
 }
 reconcile(scope:RunScope,runId:string,revision:number,outcome:'retry'|'succeeded'|'failed'|'cancelled'|'paused',now=Date.now()):DurableAgentRun {
  if(!number(now)||!['retry','succeeded','failed','cancelled','paused'].includes(outcome))throw Error('Invalid reconciliation');
  return this.transition(scope,runId,revision,run=>{if(run.status!=='uncertain')throw Error('Invalid run state');if(outcome==='retry'){if(run.attempts>=run.maxAttempts||now>=run.deadline)throw Error('Run cannot be retried');run.status='queued';}else run.status=outcome;});
 }
 archive(scope:RunScope,runId:string,revision:number):DurableAgentRun{return this.transition(scope,runId,revision,run=>{if(!['succeeded','failed','cancelled'].includes(run.status))throw Error('Invalid run state');run.archived=true;});}
 private checkLease(run:DurableAgentRun,token:string,now:number):void{if(!['running','pause_requested','cancel_requested'].includes(run.status)||run.leaseToken!==token||run.leaseUntil===null||now>=run.leaseUntil)throw Error('Invalid or expired lease');}
}
export type {RunScope as AgentRunScope,RunStatus as AgentRunStatus};
