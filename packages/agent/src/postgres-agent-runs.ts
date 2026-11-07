import {createHash,randomUUID} from 'node:crypto';
import {actionJSON,hadNoEffect,type AgentAction,type ActionVerification,type ActionVerificationRequest} from './action-journal.js';
import type {AgentRunScope,AgentRunStatus,DurableAgentRun} from './durable-runs.js';
import {AgentError} from './errors.js';
import {isIdentifier,isNonNegativeInteger} from './validation.js';

type Query=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
export type PostgresAgentRunsOptions={enabled:true;query:Query;transaction:<T>(operation:(query:Query)=>Promise<T>)=>Promise<T>};
export type PostgresAgentRun=Omit<DurableAgentRun,'delegationWait'|'approvalWait'>;
export type PostgresRunClaimLimits={maxConcurrentRuns?:number;maxRunsPerDay?:number};

const id=isIdentifier;
const number=isNonNegativeInteger;
const NOW='(extract(epoch from clock_timestamp())*1000)::bigint';
const LEASED=['running','pause_requested','cancel_requested'];
function scopeKey(scope:AgentRunScope,runId:string):AgentRunScope{if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(runId))throw Error('Invalid run scope');return {tenantId:scope.tenantId,agentId:scope.agentId};}
async function databaseNow(query:Query):Promise<number>{const now=Number((await query(`SELECT ${NOW} AS now`,[])).rows[0]?.now);if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid database clock');return now;}
function parse(row:Record<string,unknown>):PostgresAgentRun{return {tenantId:String(row.tenant_id),agentId:String(row.agent_id),runId:String(row.run_id),definitionVersion:Number(row.definition_version),revision:Number(row.revision),status:String(row.status) as AgentRunStatus,attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts),deadline:Number(row.deadline),leaseOwner:row.lease_owner==null?null:String(row.lease_owner),leaseToken:row.lease_token==null?null:String(row.lease_token),leaseUntil:row.lease_until==null?null:Number(row.lease_until),archived:row.archived===true};}

/**
 * A run registry shared by every node through one PostgreSQL primary, with the same lifecycle, leases and fencing as
 * SqliteAgentRuns. Time is the database clock. It keeps runs and their action journal in one database, so settling
 * and reconciliation see unresolved actions. Approval and delegation waits, token budgets, traces and expiry audit
 * are not part of this registry. The host authenticates and authorizes every call.
 */
export {NOW as POSTGRES_NOW};
export type {Query as PostgresRunQuery};
export class PostgresAgentRuns {
 private readonly query:Query;private readonly transaction:PostgresAgentRunsOptions['transaction'];
 constructor(options:PostgresAgentRunsOptions){if(!options||options.enabled!==true||typeof options.query!=='function'||typeof options.transaction!=='function')throw Error('Invalid agent run registry configuration');this.query=options.query;this.transaction=options.transaction;}
 async initialize():Promise<void>{
  // Schema version of this component: refuse a database written by a newer release, record this layout (2: queue order sequence) once migrated.
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL)',[]);
  const recorded=(await this.query("SELECT version FROM app_mixer_schema WHERE component='agent_runs'",[])).rows[0];
  if(recorded!==undefined&&Number(recorded.version)>2)throw Error(`The agent_runs database schema is version ${Number(recorded.version)}, newer than this release supports (2); upgrade the software before opening it`);
  await this.query("CREATE TABLE IF NOT EXISTS app_mixer_agent_runs (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,definition_version INTEGER NOT NULL,revision BIGINT NOT NULL,status TEXT NOT NULL CHECK (status IN ('queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled')),attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,deadline BIGINT NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until BIGINT,archived BOOLEAN NOT NULL DEFAULT false,PRIMARY KEY(tenant_id,agent_id,run_id))",[]);
  // Runs start in creation order: an identity column numbers every run (existing rows are numbered when the column is added).
  await this.query('ALTER TABLE app_mixer_agent_runs ADD COLUMN IF NOT EXISTS sequence BIGINT GENERATED ALWAYS AS IDENTITY',[]);
  await this.query("CREATE INDEX IF NOT EXISTS app_mixer_agent_runs_queue ON app_mixer_agent_runs(tenant_id,agent_id,sequence) WHERE status='queued' AND NOT archived",[]);
  await this.query('CREATE INDEX IF NOT EXISTS app_mixer_agent_runs_status ON app_mixer_agent_runs(tenant_id,agent_id,status,archived,run_id)',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_run_scopes (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id))',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_run_first_starts (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,started_at BIGINT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id))',[]);
  await this.query("CREATE TABLE IF NOT EXISTS app_mixer_agent_actions (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,operation_id TEXT NOT NULL,input_json TEXT NOT NULL,input_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK (status IN ('ready','dispatching','uncertain','succeeded','failed')),attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,result_json TEXT,PRIMARY KEY(tenant_id,agent_id,run_id,action_id))",[]);
  await this.query("CREATE TABLE IF NOT EXISTS app_mixer_agent_cost_calls (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,day BIGINT NOT NULL,reserved BIGINT NOT NULL,used BIGINT,status TEXT NOT NULL CHECK (status IN ('reserved','settled')),PRIMARY KEY(tenant_id,agent_id,run_id,call_id))",[]);
  await this.query('CREATE INDEX IF NOT EXISTS app_mixer_agent_cost_calls_day ON app_mixer_agent_cost_calls(tenant_id,agent_id,day)',[]);
  await this.query("INSERT INTO app_mixer_schema (component,version) VALUES ('agent_runs',2) ON CONFLICT (component) DO UPDATE SET version=GREATEST(app_mixer_schema.version,2)",[]);
 }
 async get(scope:AgentRunScope,runId:string):Promise<PostgresAgentRun|undefined>{const {tenantId,agentId}=scopeKey(scope,runId);const row=(await this.query('SELECT * FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[tenantId,agentId,runId])).rows[0];return row?parse(row):undefined;}
 /** Create a queued run. A run ID is created once: a second create fails with `Run already exists`. */
 async create(scope:AgentRunScope,runId:string,config:{definitionVersion:number;maxAttempts:number;deadline:number}):Promise<PostgresAgentRun>{
  const {tenantId,agentId}=scopeKey(scope,runId);if(!config||!number(config.definitionVersion)||config.definitionVersion<1||!number(config.maxAttempts)||config.maxAttempts<1||config.maxAttempts>100||!number(config.deadline))throw Error('Invalid run configuration');
  return this.transaction(async query=>{
   if(config.deadline<=await databaseNow(query))throw Error('Invalid run configuration');
   const inserted=await query("INSERT INTO app_mixer_agent_runs VALUES ($1,$2,$3,$4,1,'queued',0,$5,$6,NULL,NULL,NULL,false) ON CONFLICT DO NOTHING",[tenantId,agentId,runId,config.definitionVersion,config.maxAttempts,config.deadline]);
   if(inserted.rowCount!==1)throw Error('Run already exists');return parse((await query('SELECT * FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[tenantId,agentId,runId])).rows[0]);
  });
 }
 /** Queued runs, oldest ID first (bounded). */
 async queued(scope:AgentRunScope,limit=50):Promise<PostgresAgentRun[]>{const {tenantId,agentId}=scopeKey(scope,'validation');if(!number(limit)||limit<1||limit>100)throw Error('Invalid run query');return (await this.query("SELECT * FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND status='queued' AND NOT archived ORDER BY sequence LIMIT $3",[tenantId,agentId,limit])).rows.map(parse);}
 /** Leased runs whose lease expired by database time at least `graceMs` ago: candidates for recoverExpired once their worker has stopped. */
 async expiredLeases(scope:AgentRunScope,limit=50,graceMs=0):Promise<PostgresAgentRun[]>{const {tenantId,agentId}=scopeKey(scope,'validation');if(!number(limit)||limit<1||limit>100||!number(graceMs)||graceMs>86400000)throw Error('Invalid run query');return (await this.query(`SELECT * FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('running','pause_requested','cancel_requested') AND lease_until<=${NOW}-$4 ORDER BY run_id LIMIT $3`,[tenantId,agentId,limit,graceMs])).rows.map(parse);}
 /** Unarchived uncertain runs awaiting reconciliation (bounded). */
 /** Uncertain runs in run ID order; pass the last run ID of a page as `after` to read the next page. */
 async uncertain(scope:AgentRunScope,limit=50,after?:string):Promise<PostgresAgentRun[]>{const {tenantId,agentId}=scopeKey(scope,'validation');if(!number(limit)||limit<1||limit>100||(after!==undefined&&!id(after)))throw Error('Invalid run query');return (await this.query("SELECT * FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND status='uncertain' AND NOT archived AND ($4::text IS NULL OR run_id>$4) ORDER BY run_id LIMIT $3",[tenantId,agentId,limit,after??null])).rows.map(parse);}
 private async transition(scope:AgentRunScope,runId:string,expectedRevision:number,change:(run:PostgresAgentRun,now:number,query:Query)=>Promise<void>|void):Promise<PostgresAgentRun>{
  const {tenantId,agentId}=scopeKey(scope,runId);if(!number(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid run revision');
  return this.transaction(async query=>{
   const row=(await query('SELECT * FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 FOR UPDATE',[tenantId,agentId,runId])).rows[0];if(!row)throw Error('Run not found');
   const run=parse(row);if(run.revision!==expectedRevision)throw new AgentError('lost_race','Run revision conflict');if(run.archived)throw Error('Run is archived');
   await change(run,await databaseNow(query),query);run.revision++;
   await query('UPDATE app_mixer_agent_runs SET revision=$4,status=$5,attempts=$6,lease_owner=$7,lease_token=$8,lease_until=$9,archived=$10 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[tenantId,agentId,runId,run.revision,run.status,run.attempts,run.leaseOwner,run.leaseToken,run.leaseUntil,run.archived]);
   return run;
  });
 }
 private async unresolvedActions(query:Query,run:PostgresAgentRun):Promise<boolean>{return (await query("SELECT 1 FROM app_mixer_agent_actions WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND status IN ('dispatching','uncertain') UNION ALL SELECT 1 FROM app_mixer_agent_cost_calls WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND status='reserved' LIMIT 1",[run.tenantId,run.agentId,run.runId])).rows.length>0;}
 private checkLease(run:PostgresAgentRun,token:string,now:number):void{if(!LEASED.includes(run.status)||run.leaseToken!==token||run.leaseUntil===null||now>=run.leaseUntil)throw Error('Invalid or expired lease');}
 /** Lease a queued run. Concurrency and daily limits are counted across all nodes under one per-agent lock. */
 async claim(scope:AgentRunScope,runId:string,revision:number,workerId:string,leaseMs:number,limits:PostgresRunClaimLimits={}):Promise<PostgresAgentRun>{
  const maxConcurrentRuns=limits?.maxConcurrentRuns??1,maxRunsPerDay=limits?.maxRunsPerDay;
  if(!id(workerId)||!number(leaseMs)||leaseMs<1||leaseMs>3600000||!number(maxConcurrentRuns)||maxConcurrentRuns<1||maxConcurrentRuns>100||(maxRunsPerDay!==undefined&&(!number(maxRunsPerDay)||maxRunsPerDay<1||maxRunsPerDay>1000000)))throw Error('Invalid lease');
  const {tenantId,agentId}=scopeKey(scope,runId);
  await this.query('INSERT INTO app_mixer_agent_run_scopes VALUES ($1,$2) ON CONFLICT DO NOTHING',[tenantId,agentId]);
  return this.transition(scope,runId,revision,async(run,now,query)=>{
   if(run.status!=='queued'||run.attempts>=run.maxAttempts||now>=run.deadline)throw new AgentError('lost_race','Run cannot be claimed');
   await query('SELECT 1 FROM app_mixer_agent_run_scopes WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',[tenantId,agentId]);
   const active=Number((await query("SELECT COUNT(*)::int AS n FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('running','pause_requested','cancel_requested')",[tenantId,agentId])).rows[0]?.n);if(active>=maxConcurrentRuns)throw new AgentError('lost_race','Agent concurrency limit');
   const started=(await query('SELECT 1 FROM app_mixer_agent_run_first_starts WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3',[tenantId,agentId,runId])).rows.length>0;
   if(!started){const day=Math.floor(now/86400000)*86400000;if(maxRunsPerDay!==undefined){const count=Number((await query('SELECT COUNT(*)::int AS n FROM app_mixer_agent_run_first_starts WHERE tenant_id=$1 AND agent_id=$2 AND started_at>=$3 AND started_at<$4',[tenantId,agentId,day,day+86400000])).rows[0]?.n);if(count>=maxRunsPerDay)throw new AgentError('lost_race','Agent daily run limit');}await query('INSERT INTO app_mixer_agent_run_first_starts VALUES ($1,$2,$3,$4)',[tenantId,agentId,runId,now]);}
   run.status='running';run.attempts++;run.leaseOwner=workerId;run.leaseToken=randomUUID();run.leaseUntil=Math.min(now+leaseMs,run.deadline);
  });
 }
 async renew(scope:AgentRunScope,runId:string,revision:number,token:string,leaseMs:number):Promise<PostgresAgentRun>{
  if(!id(token)||!number(leaseMs)||leaseMs<1||leaseMs>3600000)throw Error('Invalid lease');
  return this.transition(scope,runId,revision,(run,now)=>{this.checkLease(run,token,now);if(run.status!=='running')throw Error('Run cannot be renewed');run.leaseUntil=Math.min(now+leaseMs,run.deadline);});
 }
 async request(scope:AgentRunScope,runId:string,revision:number,action:'pause'|'resume'|'cancel'):Promise<PostgresAgentRun>{
  if(!['pause','resume','cancel'].includes(action))throw Error('Invalid run action');
  return this.transition(scope,runId,revision,(run,now)=>{
   if(action==='pause'&&run.status==='queued')run.status='paused';
   else if(action==='pause'&&run.status==='running')run.status='pause_requested';
   else if(action==='resume'&&run.status==='paused'&&run.attempts<run.maxAttempts){if(now>=run.deadline)throw Error('Run deadline expired');run.status='queued';}
   else if(action==='cancel'&&(run.status==='queued'||run.status==='paused'))run.status='cancelled';
   else if(action==='cancel'&&(run.status==='running'||run.status==='pause_requested'))run.status='cancel_requested';
   else throw new AgentError('lost_race','Invalid run state');
  });
 }
 /** Release the lease with an outcome; unresolved journaled actions make the run uncertain instead. */
 async settle(scope:AgentRunScope,runId:string,revision:number,token:string,outcome:'succeeded'|'failed'|'stopped'|'uncertain'):Promise<PostgresAgentRun>{
  if(!id(token)||!['succeeded','failed','stopped','uncertain'].includes(outcome))throw Error('Invalid run outcome');
  return this.transition(scope,runId,revision,async(run,now,query)=>{this.checkLease(run,token,now);
   if(outcome==='stopped'&&!['pause_requested','cancel_requested'].includes(run.status))throw new AgentError('lost_race','Invalid run state');
   if(await this.unresolvedActions(query,run))run.status='uncertain';else if(outcome==='stopped')run.status=run.status==='pause_requested'?'paused':'cancelled';else run.status=outcome;
   run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;
  });
 }
 /** Mark a run whose lease expired as uncertain. Call only once its worker can no longer act. */
 async recoverExpired(scope:AgentRunScope,runId:string,revision:number):Promise<PostgresAgentRun>{
  return this.transition(scope,runId,revision,(run,now)=>{if(!LEASED.includes(run.status)||run.leaseUntil===null||now<run.leaseUntil)throw new AgentError('lost_race','Lease is active');run.status='uncertain';run.leaseOwner=null;run.leaseToken=null;run.leaseUntil=null;});
 }
 async reconcile(scope:AgentRunScope,runId:string,revision:number,outcome:'retry'|'succeeded'|'failed'|'cancelled'|'paused'):Promise<PostgresAgentRun>{
  if(!['retry','succeeded','failed','cancelled','paused'].includes(outcome))throw Error('Invalid reconciliation');
  return this.transition(scope,runId,revision,async(run,now,query)=>{if(run.status!=='uncertain')throw new AgentError('lost_race','Invalid run state');if(await this.unresolvedActions(query,run))throw Error('Action requires reconciliation');if(outcome==='retry'){if(run.attempts>=run.maxAttempts||now>=run.deadline)throw Error('Run cannot be retried');run.status='queued';}else run.status=outcome;});
 }
 async archive(scope:AgentRunScope,runId:string,revision:number):Promise<PostgresAgentRun>{return this.transition(scope,runId,revision,run=>{if(!['succeeded','failed','cancelled'].includes(run.status))throw new AgentError('lost_race','Invalid run state');run.archived=true;});}
 /** The action journal for one leased (or, for reconciliation, uncertain) run in this registry. */
 journal(scope:AgentRunScope,runId:string,leaseToken:string):PostgresAgentActionJournal{return new PostgresAgentActionJournal(this.query,this.transaction,scope,runId,leaseToken);}
}

/** Lease-fenced action journal with the semantics of SqliteAgentActionJournal (without approvals or evidence). */
export class PostgresAgentActionJournal {
 private readonly scope:AgentRunScope;
 constructor(private readonly query:Query,private readonly transaction:PostgresAgentRunsOptions['transaction'],scope:AgentRunScope,private readonly runId:string,private readonly token:string){this.scope=scopeKey(scope,runId);if(!id(token))throw Error('Invalid action journal configuration');}
 private args():[string,string,string]{return [this.scope.tenantId,this.scope.agentId,this.runId];}
 private async row(query:Query,actionId:string,lock=false):Promise<Record<string,unknown>|undefined>{return (await query(`SELECT * FROM app_mixer_agent_actions WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4${lock?' FOR UPDATE':''}`,[...this.args(),actionId])).rows[0];}
 private metadata(row:Record<string,unknown>):AgentAction{return {actionId:String(row.action_id),operationId:String(row.operation_id),idempotencyKey:String(row.idempotency_key),status:String(row.status) as AgentAction['status'],attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts)};}
 /** Lock the run and require this journal's live lease (fence) or an uncertain run (reconciliation). */
 private async lockRun(query:Query,require:'lease'|'uncertain'):Promise<Record<string,unknown>>{
  const run=(await query(`SELECT status,lease_token,lease_until,revision,${NOW} AS now FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 FOR UPDATE`,[...this.args()])).rows[0];
  if(require==='lease'&&(!run||run.status!=='running'||run.lease_token!==this.token||run.lease_until==null||Number(run.now)>=Number(run.lease_until)))throw Error('Action lease unavailable');
  if(require==='uncertain'&&(!run||run.status!=='uncertain'))throw new AgentError('lost_race','Run is not uncertain');
  return run;
 }
 async get(actionId:string):Promise<AgentAction|undefined>{if(!id(actionId))throw Error('Invalid action');const row=await this.row(this.query,actionId);return row?this.metadata(row):undefined;}
 /** Dispatch at most once per key: a recorded result is returned, an unresolved attempt requires reconciliation. */
 async invoke(actionId:string,operationId:string,input:unknown,maxAttempts:number,dispatch:(input:unknown,idempotencyKey:string)=>Promise<unknown>):Promise<unknown>{
  if(!id(actionId)||!id(operationId)||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>20||typeof dispatch!=='function')throw Error('Invalid action');
  const serialized=actionJSON(input),hash=createHash('sha256').update(serialized).digest('hex');
  const prepared=await this.transaction(async query=>{
   await this.lockRun(query,'lease');let row=await this.row(query,actionId,true);
   if(!row){await query("INSERT INTO app_mixer_agent_actions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',0,$9,NULL)",[...this.args(),actionId,operationId,serialized,hash,randomUUID(),maxAttempts]);row=(await this.row(query,actionId,true))!;}
   if(row.operation_id!==operationId||row.input_hash!==hash||row.input_json!==serialized||Number(row.max_attempts)!==maxAttempts)throw Error('Action identity conflict');
   if(row.status==='succeeded')return {cached:true,result:String(row.result_json),key:String(row.idempotency_key)};
   if(row.status!=='ready'||Number(row.attempts)>=maxAttempts)throw Error('Action requires reconciliation');
   await query("UPDATE app_mixer_agent_actions SET status='dispatching',attempts=attempts+1 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4",[...this.args(),actionId]);
   return {cached:false,result:'',key:String(row.idempotency_key)};
  });
  if(prepared.cached)return JSON.parse(prepared.result);
  try{
   const result=actionJSON(await dispatch(JSON.parse(serialized),prepared.key));
   await this.transaction(async query=>{await this.lockRun(query,'lease');const row=await this.row(query,actionId,true);if(!row||row.status!=='dispatching')throw Error('Action state conflict');await query("UPDATE app_mixer_agent_actions SET status='succeeded',result_json=$5 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4",[...this.args(),actionId,result]);});
   return JSON.parse(result);
  }catch(error){
   // A refusal before any effect goes back to `ready` (or `failed` once attempts are exhausted) and is rethrown as is; anything else is uncertain.
   if(hadNoEffect(error)){let settled=false;try{await this.transaction(async query=>{await this.lockRun(query,'lease');const row=await this.row(query,actionId,true);if(row?.status!=='dispatching')return;await query('UPDATE app_mixer_agent_actions SET status=$5 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4',[...this.args(),actionId,Number(row.attempts)>=Number(row.max_attempts)?'failed':'ready']);settled=true;});}catch{}if(settled)throw error;}
   try{await this.transaction(async query=>{await this.lockRun(query,'lease');const row=await this.row(query,actionId,true);if(row?.status==='dispatching')await query("UPDATE app_mixer_agent_actions SET status='uncertain' WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4",[...this.args(),actionId]);});}catch{}
   throw Error('Action outcome uncertain',{cause:error});
  }
 }
 /** Actions that need a decision after the run became uncertain. */
 async unresolved():Promise<AgentAction[]>{return (await this.query("SELECT * FROM app_mixer_agent_actions WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND status IN ('dispatching','uncertain') ORDER BY action_id",[...this.args()])).rows.map(row=>this.metadata(row));}
 /** The host must first stop the old worker and mark its run uncertain. */
 async markUncertain(actionId:string):Promise<void>{if(!id(actionId))throw Error('Invalid action');await this.transaction(async query=>{await this.lockRun(query,'uncertain');const row=await this.row(query,actionId,true);if(!row||row.status!=='dispatching')throw new AgentError('lost_race','Invalid action state');await query("UPDATE app_mixer_agent_actions SET status='uncertain' WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4",[...this.args(),actionId]);});}
 /** Verify externally without replaying; a stale snapshot (another reconciliation won) is rejected. */
 async reconcileWith(actionId:string,verify:(request:ActionVerificationRequest)=>Promise<ActionVerification>):Promise<ActionVerification['outcome']>{
  if(!id(actionId)||typeof verify!=='function')throw Error('Invalid action verification');
  const snapshot=await this.transaction(async query=>{const run=await this.lockRun(query,'uncertain'),row=await this.row(query,actionId);if(!row||row.status!=='uncertain')throw new AgentError('lost_race','Invalid action state');return {revision:Number(run.revision),action:this.metadata(row),input:String(row.input_json)};});
  const decision=await verify({scope:{...this.scope},runId:this.runId,action:{...snapshot.action},input:JSON.parse(snapshot.input)}) as unknown;
  if(!decision||typeof decision!=='object'||Array.isArray(decision))throw Error('Invalid action verification');const d=decision as Record<string,unknown>,outcome=d.outcome;
  if(typeof outcome!=='string'||!['unknown','applied','not_applied','failed'].includes(outcome)||Object.keys(d).some(k=>k!=='outcome'&&k!=='result')||(outcome==='applied'?!Object.hasOwn(d,'result'):Object.hasOwn(d,'result')))throw Error('Invalid action verification');
  const serialized=outcome==='applied'?actionJSON(d.result):null;
  return this.transaction(async query=>{
   const run=await this.lockRun(query,'uncertain'),row=await this.row(query,actionId,true);
   if(Number(run.revision)!==snapshot.revision||!row||row.status!=='uncertain'||Number(row.attempts)!==snapshot.action.attempts||row.idempotency_key!==snapshot.action.idempotencyKey)throw new AgentError('lost_race','Action verification stale');
   if(outcome==='not_applied'&&Number(row.attempts)>=Number(row.max_attempts))throw Error('Action attempts exhausted');
   if(outcome!=='unknown')await query('UPDATE app_mixer_agent_actions SET status=$5,result_json=$6 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND action_id=$4',[...this.args(),actionId,outcome==='applied'?'succeeded':outcome==='not_applied'?'ready':'failed',serialized]);
   return outcome as ActionVerification['outcome'];
  });
 }
}
