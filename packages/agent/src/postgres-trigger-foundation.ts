import {createHash,randomUUID} from 'node:crypto';
import {canonicalTriggerPayload} from './agent-trigger-payload.js';
import {parseAgentTraceParent} from './agent-trace-context.js';
import type {AgentRunScope} from './durable-runs.js';
import type {AgentTriggerInput,AgentTriggerEnqueueOptions,TriggerRecord} from './agent-triggers.js';
import {isIdentifier} from './validation.js';

type Query=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
type Options={query:Query;transaction:<T>(operation:(query:Query)=>Promise<T>)=>Promise<T>};
type DurationOptions=Omit<AgentTriggerEnqueueOptions,'deadline'>&{runTimeoutMs:number};
const id=isIdentifier;

/** Internal migration foundation. No shared worker, recovery, retention or public capability is available yet. */
export class PostgresAgentTriggerFoundation {
 private readonly query:Query;private readonly transaction:Options['transaction'];
 constructor(options:Options){if(!options||typeof options.query!=='function'||typeof options.transaction!=='function')throw Error('Invalid shared trigger configuration');this.query=options.query;this.transaction=options.transaction;}
 matchesDatabase(query:Query,transaction:Options['transaction']):boolean{return query===this.query&&transaction===this.transaction;}
 async initialize():Promise<void>{
  await this.transaction(async query=>{
   await query('CREATE TABLE IF NOT EXISTS app_mixer_shared_run_scopes (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id))',[]);
   await query("CREATE TABLE IF NOT EXISTS app_mixer_shared_runs (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,definition_version BIGINT NOT NULL,revision BIGINT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,deadline BIGINT NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until BIGINT,archived BOOLEAN NOT NULL DEFAULT FALSE,trace_parent TEXT,PRIMARY KEY(tenant_id,agent_id,run_id))",[]);
   await query('CREATE TABLE IF NOT EXISTS app_mixer_shared_trigger_inbox (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,source_id TEXT NOT NULL,event_id TEXT NOT NULL,principal_id TEXT NOT NULL,event_type TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,run_id TEXT NOT NULL,received_at BIGINT NOT NULL,PRIMARY KEY(tenant_id,agent_id,source_id,event_id),UNIQUE(tenant_id,agent_id,run_id),FOREIGN KEY(tenant_id,agent_id,run_id) REFERENCES app_mixer_shared_runs(tenant_id,agent_id,run_id))',[]);
   await query('CREATE TABLE IF NOT EXISTS app_mixer_shared_trigger_redactions (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,actor_id TEXT NOT NULL,redacted_at BIGINT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id),FOREIGN KEY(tenant_id,agent_id,run_id) REFERENCES app_mixer_shared_runs(tenant_id,agent_id,run_id))',[]);
   await query("CREATE OR REPLACE FUNCTION app_mixer_shared_trigger_redaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Shared trigger redactions are immutable'; END $$",[]);
   await query('DO $$ BEGIN CREATE TRIGGER app_mixer_shared_trigger_redaction_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_mixer_shared_trigger_redactions FOR EACH STATEMENT EXECUTE FUNCTION app_mixer_shared_trigger_redaction_immutable(); EXCEPTION WHEN duplicate_object THEN NULL; END $$',[]);
  });
 }
 /** Trusted host read; separately authorize access before exposing event payloads. */
 async get(scope:AgentRunScope,runId:string,signal?:AbortSignal):Promise<TriggerRecord|undefined>{
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(runId)||(signal!==undefined&&!(signal instanceof AbortSignal)))throw Error('Invalid trigger');signal?.throwIfAborted();const row=(await this.query('SELECT i.source_id,i.principal_id,i.event_id,i.event_type,i.payload,i.payload_hash,i.run_id,d.run_id AS redacted FROM app_mixer_shared_trigger_inbox i LEFT JOIN app_mixer_shared_trigger_redactions d ON d.tenant_id=i.tenant_id AND d.agent_id=i.agent_id AND d.run_id=i.run_id WHERE i.tenant_id=$1 AND i.agent_id=$2 AND i.run_id=$3',[scope.tenantId,scope.agentId,runId])).rows[0];signal?.throwIfAborted();if(!row)return undefined;const redacted=row.redacted!==null;if(!id(row.source_id)||!id(row.principal_id)||!id(row.event_id)||!id(row.event_type)||row.run_id!==runId||typeof row.payload!=='string'||typeof row.payload_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.payload_hash)||(redacted?row.payload!=='null':createHash('sha256').update(row.payload).digest('hex')!==row.payload_hash))throw Error('Invalid trigger data');let payload:unknown;try{payload=JSON.parse(row.payload);if(canonicalTriggerPayload(payload)!==row.payload)throw Error('Invalid payload');}catch{throw Error('Invalid trigger data');}return {sourceId:row.source_id,principalId:row.principal_id,eventId:row.event_id,eventType:row.event_type,payload,runId,...(redacted?{payloadRedacted:true as const}:{})};
 }
 /** Caller authenticates and authorizes the source. This does not dispatch a worker. */
 async enqueue(scope:AgentRunScope,event:AgentTriggerInput,options:AgentTriggerEnqueueOptions|DurationOptions,signal?:AbortSignal):Promise<{runId:string;duplicate:boolean}>{
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw Error('Invalid trigger signal');signal?.throwIfAborted();
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!event||!id(event.sourceId)||!id(event.principalId)||!id(event.eventId)||!id(event.eventType)||!options||!Number.isSafeInteger(options.definitionVersion)||options.definitionVersion<1||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>100||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||(options.traceParent!==undefined&&!parseAgentTraceParent(options.traceParent)))throw Error('Invalid trigger');
  const absolute='deadline' in options,duration='runTimeoutMs' in options;if(absolute===duration||(absolute&&!Number.isSafeInteger(options.deadline))||(duration&&(!Number.isSafeInteger(options.runTimeoutMs)||options.runTimeoutMs<1000||options.runTimeoutMs>86400000)))throw Error('Invalid trigger');
  const tenant=scope.tenantId,agent=scope.agentId,source=event.sourceId,eventId=event.eventId,principal=event.principalId,eventType=event.eventType,version=options.definitionVersion,attempts=options.maxAttempts,requestedDeadline=absolute?options.deadline:undefined,timeout=duration?options.runTimeoutMs:undefined,limit=options.maxPending,trace=options.traceParent??null;
  const payload=canonicalTriggerPayload(event.payload),hash=createHash('sha256').update(payload).digest('hex');
  return this.transaction(async query=>{
   signal?.throwIfAborted();
   await query('INSERT INTO app_mixer_shared_run_scopes (tenant_id,agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[tenant,agent]);
   const lock=await query('SELECT agent_id FROM app_mixer_shared_run_scopes WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',[tenant,agent]);if(lock.rows.length!==1)throw Error('Shared run scope unavailable');
   const now=Number((await query('SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now',[])).rows[0]?.now),deadline=requestedDeadline??(now+timeout!);if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(deadline)||deadline<=now)throw Error('Invalid trigger');
   const prior=(await query('SELECT i.principal_id,i.event_type,i.payload,i.payload_hash,i.run_id,d.run_id AS redacted FROM app_mixer_shared_trigger_inbox i LEFT JOIN app_mixer_shared_trigger_redactions d ON d.tenant_id=i.tenant_id AND d.agent_id=i.agent_id AND d.run_id=i.run_id WHERE i.tenant_id=$1 AND i.agent_id=$2 AND i.source_id=$3 AND i.event_id=$4',[tenant,agent,source,eventId])).rows[0];
   if(prior){if((prior.redacted!==null&&prior.payload!=='null')||prior.principal_id!==principal||prior.event_type!==eventType||(prior.redacted===null&&prior.payload!==payload)||prior.payload_hash!==hash||!id(prior.run_id))throw Error('Trigger identity conflict');signal?.throwIfAborted();return {runId:prior.run_id,duplicate:true};}
   const wakeups=(await query("SELECT to_regclass('app_mixer_shared_run_wakeups') AS name",[])).rows[0];if(wakeups?.name&&(await query('SELECT 1 FROM app_mixer_shared_run_wakeups WHERE tenant_id=$1 AND agent_id=$2 AND source_id=$3 AND event_id=$4',[tenant,agent,source,eventId])).rows.length)throw Error('Trigger identity conflict');
   const count=Number((await query("SELECT count(*)::bigint AS n FROM app_mixer_shared_runs WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('queued','running','pause_requested','cancel_requested','paused','uncertain')",[tenant,agent])).rows[0]?.n);if(!Number.isSafeInteger(count)||count<0)throw Error('Shared run count unavailable');if(count>=limit)throw Error('Trigger backlog full');
   const runId=randomUUID();await query("INSERT INTO app_mixer_shared_runs (tenant_id,agent_id,run_id,definition_version,revision,status,attempts,max_attempts,deadline,trace_parent) VALUES ($1,$2,$3,$4,1,'queued',0,$5,$6,$7)",[tenant,agent,runId,version,attempts,deadline,trace]);
   await query('INSERT INTO app_mixer_shared_trigger_inbox (tenant_id,agent_id,source_id,event_id,principal_id,event_type,payload,payload_hash,run_id,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenant,agent,source,eventId,principal,eventType,payload,hash,runId,now]);signal?.throwIfAborted();return {runId,duplicate:false};
  });
 }
}
