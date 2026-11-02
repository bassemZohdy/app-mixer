import {createHash,randomUUID} from 'node:crypto';
import {canonicalTriggerPayload} from './agent-trigger-payload.js';
import {parseAgentTraceParent} from './agent-trace-context.js';
import type {AgentRunScope} from './durable-runs.js';
import type {AgentTriggerInput,AgentTriggerEnqueueOptions} from './agent-triggers.js';

type Query=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
type Options={query:Query;transaction:<T>(operation:(query:Query)=>Promise<T>)=>Promise<T>};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);

/** Internal migration foundation. No shared worker, recovery, retention or public capability is available yet. */
export class PostgresAgentTriggerFoundation {
 private readonly query:Query;private readonly transaction:Options['transaction'];
 constructor(options:Options){if(!options||typeof options.query!=='function'||typeof options.transaction!=='function')throw Error('Invalid shared trigger configuration');this.query=options.query;this.transaction=options.transaction;}
 async initialize():Promise<void>{
  await this.transaction(async query=>{
   await query('CREATE TABLE IF NOT EXISTS app_mixer_shared_run_scopes (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id))',[]);
   await query("CREATE TABLE IF NOT EXISTS app_mixer_shared_runs (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,definition_version BIGINT NOT NULL,revision BIGINT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,deadline BIGINT NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until BIGINT,archived BOOLEAN NOT NULL DEFAULT FALSE,trace_parent TEXT,PRIMARY KEY(tenant_id,agent_id,run_id))",[]);
   await query('CREATE TABLE IF NOT EXISTS app_mixer_shared_trigger_inbox (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,source_id TEXT NOT NULL,event_id TEXT NOT NULL,principal_id TEXT NOT NULL,event_type TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,run_id TEXT NOT NULL,received_at BIGINT NOT NULL,PRIMARY KEY(tenant_id,agent_id,source_id,event_id),UNIQUE(tenant_id,agent_id,run_id),FOREIGN KEY(tenant_id,agent_id,run_id) REFERENCES app_mixer_shared_runs(tenant_id,agent_id,run_id))',[]);
  });
 }
 /** Caller authenticates and authorizes the source. This does not dispatch a worker. */
 async enqueue(scope:AgentRunScope,event:AgentTriggerInput,options:AgentTriggerEnqueueOptions):Promise<{runId:string;duplicate:boolean}>{
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!event||!id(event.sourceId)||!id(event.principalId)||!id(event.eventId)||!id(event.eventType)||!options||!Number.isSafeInteger(options.definitionVersion)||options.definitionVersion<1||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>100||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||!Number.isSafeInteger(options.deadline)||(options.traceParent!==undefined&&!parseAgentTraceParent(options.traceParent)))throw Error('Invalid trigger');
  const tenant=scope.tenantId,agent=scope.agentId,source=event.sourceId,eventId=event.eventId,principal=event.principalId,eventType=event.eventType,version=options.definitionVersion,attempts=options.maxAttempts,deadline=options.deadline,limit=options.maxPending,trace=options.traceParent??null;
  const payload=canonicalTriggerPayload(event.payload),hash=createHash('sha256').update(payload).digest('hex');
  return this.transaction(async query=>{
   await query('INSERT INTO app_mixer_shared_run_scopes (tenant_id,agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[tenant,agent]);
   const lock=await query('SELECT agent_id FROM app_mixer_shared_run_scopes WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',[tenant,agent]);if(lock.rows.length!==1)throw Error('Shared run scope unavailable');
   const now=Number((await query('SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now',[])).rows[0]?.now);if(!Number.isSafeInteger(now)||now<0||deadline<=now)throw Error('Invalid trigger');
   const prior=(await query('SELECT principal_id,event_type,payload,payload_hash,run_id FROM app_mixer_shared_trigger_inbox WHERE tenant_id=$1 AND agent_id=$2 AND source_id=$3 AND event_id=$4',[tenant,agent,source,eventId])).rows[0];
   if(prior){if(prior.principal_id!==principal||prior.event_type!==eventType||prior.payload!==payload||prior.payload_hash!==hash||!id(prior.run_id))throw Error('Trigger identity conflict');return {runId:prior.run_id,duplicate:true};}
   const count=Number((await query("SELECT count(*)::bigint AS n FROM app_mixer_shared_runs WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('queued','running','pause_requested','cancel_requested','paused','uncertain')",[tenant,agent])).rows[0]?.n);if(!Number.isSafeInteger(count)||count<0)throw Error('Shared run count unavailable');if(count>=limit)throw Error('Trigger backlog full');
   const runId=randomUUID();await query("INSERT INTO app_mixer_shared_runs (tenant_id,agent_id,run_id,definition_version,revision,status,attempts,max_attempts,deadline,trace_parent) VALUES ($1,$2,$3,$4,1,'queued',0,$5,$6,$7)",[tenant,agent,runId,version,attempts,deadline,trace]);
   await query('INSERT INTO app_mixer_shared_trigger_inbox (tenant_id,agent_id,source_id,event_id,principal_id,event_type,payload,payload_hash,run_id,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenant,agent,source,eventId,principal,eventType,payload,hash,runId,now]);return {runId,duplicate:false};
  });
 }
}
