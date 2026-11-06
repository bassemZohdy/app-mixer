import {randomUUID} from 'node:crypto';
import type {AgentRunScope} from './durable-runs.js';
import {checkConfig,next,type AgentSchedule,type AgentScheduleConfig,type AgentScheduleCursor,type AgentScheduleFireOptions,type AgentSchedulePage} from './agent-schedules.js';

type Query=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
export type PostgresAgentSchedulesOptions={enabled:true;query:Query;transaction:<T>(operation:(query:Query)=>Promise<T>)=>Promise<T>};
/** One fired occurrence: a durable request to start a run, created exactly once per occurrence across all nodes. */
export type AgentScheduledRun={scheduleId:string;generation:number;scheduledAt:number;runId:string;principalId:string;payload:Record<string,unknown>;definitionVersion:number;maxAttempts:number;deadline:number;firedAt:number;firedBy:string};
export type AgentScheduledRunClaim=AgentScheduledRun & {token:string;leaseUntil:number;claims:number};
export type AgentScheduleHistoryEvent={id:number;scheduleId:string;kind:'created'|'updated'|'fired';revision:number;generation:number;nextAt:number;actorId?:string;runId?:string;scheduledAt?:number;observedAt:number};
/** `backlog` is true when the pass stopped at `maxFires` or `maxScans` while schedules may still be due; poll again. */
export type AgentScheduleFirePass={fired:{scheduleId:string;runId:string;scheduledAt:number}[];conflicts:number;scans:number;backlog:boolean};

const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const NOW='(extract(epoch from clock_timestamp())*1000)::bigint';
const ACTIVE="status IN ('pending','claimed')";

/**
 * Schedules shared by every node through one PostgreSQL primary. Firing an occurrence advances the schedule and
 * records one run request in the same transaction, so each occurrence is fired once however many nodes poll.
 * Nodes then claim run requests under a lease. The host supplies authorization and identity.
 */
export class PostgresAgentSchedules {
 private readonly query:Query;private readonly transaction:PostgresAgentSchedulesOptions['transaction'];
 constructor(options:PostgresAgentSchedulesOptions){if(!options||options.enabled!==true||typeof options.query!=='function'||typeof options.transaction!=='function')throw Error('Invalid agent schedule configuration');this.query=options.query;this.transaction=options.transaction;}
 async initialize():Promise<void>{
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_schedules (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,schedule_id TEXT NOT NULL,revision BIGINT NOT NULL,generation BIGINT NOT NULL,next_at BIGINT NOT NULL,enabled BOOLEAN NOT NULL,config TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,schedule_id))',[]);
  await this.query('CREATE INDEX IF NOT EXISTS app_mixer_agent_schedules_due ON app_mixer_agent_schedules(tenant_id,agent_id,enabled,next_at,schedule_id)',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_schedule_events (id BIGSERIAL PRIMARY KEY,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,schedule_id TEXT NOT NULL,kind TEXT NOT NULL,revision BIGINT NOT NULL,generation BIGINT NOT NULL,next_at BIGINT NOT NULL,config TEXT NOT NULL,actor_id TEXT,run_id TEXT,scheduled_at BIGINT,observed_at BIGINT NOT NULL,UNIQUE(tenant_id,agent_id,schedule_id,revision))',[]);
  await this.query("CREATE TABLE IF NOT EXISTS app_mixer_agent_scheduled_runs (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,schedule_id TEXT NOT NULL,generation BIGINT NOT NULL,scheduled_at BIGINT NOT NULL,run_id TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,payload TEXT NOT NULL,definition_version INTEGER NOT NULL,max_attempts INTEGER NOT NULL,deadline BIGINT NOT NULL,fired_at BIGINT NOT NULL,fired_by TEXT NOT NULL,status TEXT NOT NULL CHECK (status IN ('pending','claimed','started')),token TEXT,claimed_by TEXT,lease_until BIGINT,claims INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,agent_id,schedule_id,generation,scheduled_at))",[]);
  await this.query('CREATE INDEX IF NOT EXISTS app_mixer_agent_scheduled_runs_open ON app_mixer_agent_scheduled_runs(tenant_id,agent_id,status,scheduled_at,schedule_id)',[]);
 }
 private check(scope:AgentRunScope,scheduleId:string):AgentRunScope{if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(scheduleId))throw Error('Invalid schedule scope');return {tenantId:scope.tenantId,agentId:scope.agentId};}
 private parse(row:Record<string,unknown>):AgentSchedule{return {tenantId:String(row.tenant_id),agentId:String(row.agent_id),scheduleId:String(row.schedule_id),revision:Number(row.revision),generation:Number(row.generation),nextAt:Number(row.next_at),config:checkConfig(JSON.parse(String(row.config)))};}
 private parseRun(row:Record<string,unknown>):AgentScheduledRun{return {scheduleId:String(row.schedule_id),generation:Number(row.generation),scheduledAt:Number(row.scheduled_at),runId:String(row.run_id),principalId:String(row.principal_id),payload:JSON.parse(String(row.payload)),definitionVersion:Number(row.definition_version),maxAttempts:Number(row.max_attempts),deadline:Number(row.deadline),firedAt:Number(row.fired_at),firedBy:String(row.fired_by)};}
 private async now(query:Query):Promise<number>{const now=Number((await query(`SELECT ${NOW} AS now`,[])).rows[0]?.now);if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid database clock');return now;}
 async get(scope:AgentRunScope,scheduleId:string):Promise<AgentSchedule|undefined>{const {tenantId,agentId}=this.check(scope,scheduleId);const row=(await this.query('SELECT * FROM app_mixer_agent_schedules WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3',[tenantId,agentId,scheduleId])).rows[0];return row?this.parse(row):undefined;}
 /** Bounded keyset scan of enabled schedules due at `now` (database time when omitted). */
 async duePage(scope:AgentRunScope,now?:number,limit=100,after?:AgentScheduleCursor):Promise<AgentSchedulePage>{
  const {tenantId,agentId}=this.check(scope,'validation');if((now!==undefined&&!integer(now))||!integer(limit)||limit<1||limit>100||(after!==undefined&&(!after||!integer(after.nextAt)||!id(after.scheduleId))))throw Error('Invalid schedule query');
  const at=now??await this.now(this.query);
  const rows=(after===undefined?await this.query('SELECT * FROM app_mixer_agent_schedules WHERE tenant_id=$1 AND agent_id=$2 AND enabled AND next_at<=$3 ORDER BY next_at,schedule_id LIMIT $4',[tenantId,agentId,at,limit+1]):await this.query('SELECT * FROM app_mixer_agent_schedules WHERE tenant_id=$1 AND agent_id=$2 AND enabled AND next_at<=$3 AND (next_at>$4 OR (next_at=$4 AND schedule_id>$5)) ORDER BY next_at,schedule_id LIMIT $6',[tenantId,agentId,at,after.nextAt,after.scheduleId,limit+1])).rows;
  const items=rows.slice(0,limit).map(row=>this.parse(row)),last=items.at(-1);return {items,...(rows.length>limit&&last?{next:{nextAt:last.nextAt,scheduleId:last.scheduleId}}:{})};
 }
 /** Create or replace a schedule with optimistic concurrency; every change starts a new generation. */
 async save(scope:AgentRunScope,scheduleId:string,config:AgentScheduleConfig,expectedRevision:number,now?:number,actorId?:string):Promise<AgentSchedule>{
  const {tenantId,agentId}=this.check(scope,scheduleId);if(!integer(expectedRevision)||expectedRevision>=Number.MAX_SAFE_INTEGER||(now!==undefined&&!integer(now))||(actorId!==undefined&&!id(actorId)))throw Error('Invalid schedule');const safe=checkConfig(config);
  return this.transaction(async query=>{
   const at=now??await this.now(query),nextAt=next(safe.rule,at),old=(await query('SELECT revision,generation FROM app_mixer_agent_schedules WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3 FOR UPDATE',[tenantId,agentId,scheduleId])).rows[0];
   if(Number(old?.revision??0)!==expectedRevision)throw Error('Schedule revision conflict');const revision=expectedRevision+1,generation=Number(old?.generation??0)+1;
   if(old)await query('UPDATE app_mixer_agent_schedules SET revision=$4,generation=$5,next_at=$6,enabled=$7,config=$8 WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3',[tenantId,agentId,scheduleId,revision,generation,nextAt,safe.enabled,JSON.stringify(safe)]);
   else{const inserted=await query('INSERT INTO app_mixer_agent_schedules VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[tenantId,agentId,scheduleId,revision,generation,nextAt,safe.enabled,JSON.stringify(safe)]);if(inserted.rowCount!==1)throw Error('Schedule revision conflict');}
   await query('INSERT INTO app_mixer_agent_schedule_events (tenant_id,agent_id,schedule_id,kind,revision,generation,next_at,config,actor_id,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenantId,agentId,scheduleId,old?'updated':'created',revision,generation,nextAt,JSON.stringify(safe),actorId??null,at]);
   return {tenantId,agentId,scheduleId,revision,generation,nextAt,config:safe};
  });
 }
 /**
  * Fire the due occurrence of one schedule. The schedule row is locked, so of several nodes firing the same revision
  * one succeeds and the others get `Schedule revision conflict`. Same misfire handling as SqliteAgentSchedules.
  */
 async fire(scope:AgentRunScope,scheduleId:string,expectedRevision:number,policy:AgentScheduleFireOptions,options:{now?:number;actorId?:string;nodeId:string}):Promise<{runId:string;scheduledAt:number}>{
  const {tenantId,agentId}=this.check(scope,scheduleId);
  if(!integer(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER||!options||!id(options.nodeId)||(options.now!==undefined&&!integer(options.now))||(options.actorId!==undefined&&!id(options.actorId))||!policy||!integer(policy.definitionVersion)||policy.definitionVersion<1||!integer(policy.maxAttempts)||policy.maxAttempts<1||policy.maxAttempts>100||!integer(policy.runTimeoutMs)||policy.runTimeoutMs<1000||policy.runTimeoutMs>86400000||!integer(policy.maxPending)||policy.maxPending<1||policy.maxPending>10000)throw Error('Invalid schedule fire');
  return this.transaction(async query=>{
   const row=(await query('SELECT * FROM app_mixer_agent_schedules WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3 FOR UPDATE',[tenantId,agentId,scheduleId])).rows[0];
   const schedule=row?this.parse(row):undefined;if(!schedule||schedule.revision!==expectedRevision)throw Error('Schedule revision conflict');
   const now=options.now??await this.now(query);if(!schedule.config.enabled||schedule.nextAt>now)throw Error('Schedule not due');if(!Number.isSafeInteger(now+policy.runTimeoutMs))throw Error('Invalid schedule fire');
   const pending=Number((await query(`SELECT COUNT(*)::bigint AS n FROM app_mixer_agent_scheduled_runs WHERE tenant_id=$1 AND agent_id=$2 AND ${ACTIVE}`,[tenantId,agentId])).rows[0]?.n);if(pending>=policy.maxPending)throw Error('Trigger backlog full');
   const scheduledAt=schedule.nextAt,coalesce=schedule.config.misfire==='coalesce',rule=schedule.config.rule;
   const nextAt=coalesce&&rule.kind==='interval'?now+(rule.intervalMs-((now-scheduledAt)%rule.intervalMs)):next(rule,coalesce?now:scheduledAt);if(!Number.isSafeInteger(nextAt))throw Error('Invalid schedule time');
   const runId=randomUUID(),payload=JSON.stringify({scheduleId,scheduledAt,...(coalesce?{coalescedThrough:now}:{})});
   await query("INSERT INTO app_mixer_agent_scheduled_runs (tenant_id,agent_id,schedule_id,generation,scheduled_at,run_id,principal_id,payload,definition_version,max_attempts,deadline,fired_at,fired_by,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')",[tenantId,agentId,scheduleId,schedule.generation,scheduledAt,runId,schedule.config.principalId,payload,policy.definitionVersion,policy.maxAttempts,now+policy.runTimeoutMs,now,options.nodeId]);
   await query('UPDATE app_mixer_agent_schedules SET revision=$4,next_at=$5 WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3',[tenantId,agentId,scheduleId,schedule.revision+1,nextAt]);
   await query("INSERT INTO app_mixer_agent_schedule_events (tenant_id,agent_id,schedule_id,kind,revision,generation,next_at,config,actor_id,run_id,scheduled_at,observed_at) VALUES ($1,$2,$3,'fired',$4,$5,$6,$7,$8,$9,$10,$11)",[tenantId,agentId,scheduleId,schedule.revision+1,schedule.generation,nextAt,JSON.stringify(schedule.config),options.actorId??null,runId,scheduledAt,now]);
   return {runId,scheduledAt};
  });
 }
 /**
  * One polling pass for a node: fire every due occurrence (catching up missed ones) up to `maxFires`, leaving any
  * occurrence another node fired first. Returns what this node fired and how many races it lost.
  */
 async fireDue(scope:AgentRunScope,policy:AgentScheduleFireOptions,options:{nodeId:string;actorId?:string;maxFires?:number;maxScans?:number;authorize?:(schedule:AgentSchedule)=>boolean|Promise<boolean>}):Promise<AgentScheduleFirePass>{
  const maxFires=options?.maxFires??100,maxScans=options?.maxScans??maxFires+100;if(!options||!id(options.nodeId)||!integer(maxFires)||maxFires<1||maxFires>1000||!integer(maxScans)||maxScans<1||maxScans>10000||(options.authorize!==undefined&&typeof options.authorize!=='function'))throw Error('Invalid schedule fire');
  const pass:AgentScheduleFirePass={fired:[],conflicts:0,scans:0,backlog:false};let after:AgentScheduleCursor|undefined;
  while(pass.fired.length<maxFires){
   // Every contested or fired schedule rescans from the first page, so the number of scans is bounded explicitly.
   if(pass.scans>=maxScans){pass.backlog=true;break;}
   pass.scans++;const page=await this.duePage(scope,undefined,100,after);if(!page.items.length)break;let progressed=false;
   for(const schedule of page.items){
    if(pass.fired.length>=maxFires)break;if(options.authorize&&await options.authorize({...schedule,config:{...schedule.config}})!==true)continue;
    try{const fired=await this.fire(scope,schedule.scheduleId,schedule.revision,policy,{nodeId:options.nodeId,actorId:options.actorId});pass.fired.push({scheduleId:schedule.scheduleId,...fired});progressed=true;}
    catch(error){const message=(error as Error)?.message;if(message==='Schedule revision conflict'||message==='Schedule not due'){pass.conflicts++;progressed=true;continue;}throw error;}
   }
   // A fired or contested schedule may still be due (catch-up); rescan from the start until nothing is left.
   after=progressed?undefined:page.next;if(!progressed&&!page.next)break;
  }
  if(pass.fired.length>=maxFires)pass.backlog=true;
  return pass;
 }
 /** Claim the oldest unstarted run request, or one whose claim expired, for `leaseMs` of database time. */
 async claimRun(scope:AgentRunScope,workerId:string,leaseMs:number):Promise<AgentScheduledRunClaim|undefined>{
  const {tenantId,agentId}=this.check(scope,'validation');if(!id(workerId)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000)throw Error('Invalid scheduled run claim');
  return this.transaction(async query=>{
   const now=await this.now(query),row=(await query("SELECT * FROM app_mixer_agent_scheduled_runs WHERE tenant_id=$1 AND agent_id=$2 AND (status='pending' OR (status='claimed' AND lease_until<=$3)) ORDER BY scheduled_at,schedule_id LIMIT 1 FOR UPDATE SKIP LOCKED",[tenantId,agentId,now])).rows[0];
   if(!row)return undefined;const token=randomUUID(),leaseUntil=now+leaseMs,claims=Number(row.claims)+1;
   await query("UPDATE app_mixer_agent_scheduled_runs SET status='claimed',token=$3,claimed_by=$4,lease_until=$5,claims=$6 WHERE tenant_id=$1 AND run_id=$2",[tenantId,String(row.run_id),token,workerId,leaseUntil,claims]);
   return {...this.parseRun(row),token,leaseUntil,claims};
  });
 }
 /** Record that the claimed run was handed to an executor. False when the claim expired or was taken over. */
 async markStarted(scope:AgentRunScope,runId:string,token:string):Promise<boolean>{
  const {tenantId,agentId}=this.check(scope,'validation');if(!id(runId)||!id(token))throw Error('Invalid scheduled run claim');
  const result=await this.query(`UPDATE app_mixer_agent_scheduled_runs SET status='started',lease_until=NULL WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND token=$4 AND status='claimed' AND lease_until>${NOW}`,[tenantId,agentId,runId,token]);return result.rowCount===1;
 }
 /** Every fired occurrence of one schedule, oldest first, for audits and tests. */
 async runs(scope:AgentRunScope,scheduleId:string,options:{after?:number;limit?:number}={}):Promise<(AgentScheduledRun & {status:string;claims:number})[]>{
  const {tenantId,agentId}=this.check(scope,scheduleId),limit=options.limit??100,after=options.after??-1;if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(after))throw Error('Invalid schedule query');
  return (await this.query('SELECT * FROM app_mixer_agent_scheduled_runs WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3 AND scheduled_at>$4 ORDER BY generation,scheduled_at LIMIT $5',[tenantId,agentId,scheduleId,after,limit])).rows.map(row=>({...this.parseRun(row),status:String(row.status),claims:Number(row.claims)}));
 }
 /** Bounded immutable-by-convention change and fire history of one schedule. */
 async history(scope:AgentRunScope,scheduleId:string,options:{after?:number;limit?:number}={}):Promise<AgentScheduleHistoryEvent[]>{
  const {tenantId,agentId}=this.check(scope,scheduleId),limit=options.limit??100,after=options.after??0;if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!integer(after))throw Error('Invalid schedule query');
  return (await this.query('SELECT * FROM app_mixer_agent_schedule_events WHERE tenant_id=$1 AND agent_id=$2 AND schedule_id=$3 AND id>$4 ORDER BY id LIMIT $5',[tenantId,agentId,scheduleId,after,limit])).rows.map(row=>({id:Number(row.id),scheduleId:String(row.schedule_id),kind:String(row.kind) as AgentScheduleHistoryEvent['kind'],revision:Number(row.revision),generation:Number(row.generation),nextAt:Number(row.next_at),...(row.actor_id==null?{}:{actorId:String(row.actor_id)}),...(row.run_id==null?{}:{runId:String(row.run_id)}),...(row.scheduled_at==null?{}:{scheduledAt:Number(row.scheduled_at)}),observedAt:Number(row.observed_at)}));
 }
}
