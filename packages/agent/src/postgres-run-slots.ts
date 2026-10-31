import {randomUUID} from 'node:crypto';
import type {AgentRunScope} from './durable-runs.js';

type Query=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
export type PostgresAgentRunSlotsOptions={enabled:true;query:Query;transaction:<T>(operation:(query:Query)=>Promise<T>)=>Promise<T>};
export type AgentRunSlotLimits={maxConcurrentRuns:number;maxRunsPerDay?:number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=1;
const NOW='(extract(epoch from clock_timestamp())*1000)::bigint';

/** Shared run slots so workers on separate nodes respect one agent's concurrency and daily-run quotas. Expiry uses database time. */
export class PostgresAgentRunSlots {
 private readonly query:Query;private readonly transaction:PostgresAgentRunSlotsOptions['transaction'];
 constructor(options:PostgresAgentRunSlotsOptions){if(!options||options.enabled!==true||typeof options.query!=='function'||typeof options.transaction!=='function')throw Error('Invalid agent run slot configuration');this.query=options.query;this.transaction=options.transaction;}
 async initialize():Promise<void>{
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_run_slot_scopes (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id))',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_run_slots (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,token TEXT NOT NULL UNIQUE,worker_id TEXT NOT NULL,lease_until BIGINT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id))',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_run_starts (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,day BIGINT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,day,run_id))',[]);
 }
 private scope(scope:AgentRunScope):AgentRunScope{if(!scope||!id(scope.tenantId)||!id(scope.agentId))throw Error('Invalid agent run scope');return {tenantId:scope.tenantId,agentId:scope.agentId};}
 /** Take a slot for one run, or throw `Agent run quota exceeded`. Returns the slot token. */
 async acquire(scope:AgentRunScope,runId:string,workerId:string,leaseMs:number,limits:AgentRunSlotLimits):Promise<string>{
  const {tenantId,agentId}=this.scope(scope);
  if(!id(runId)||!id(workerId)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000||!limits||!positive(limits.maxConcurrentRuns)||(limits.maxRunsPerDay!==undefined&&!positive(limits.maxRunsPerDay)))throw Error('Invalid agent run slot request');
  const token=randomUUID();
  return this.transaction(async query=>{
   await query('INSERT INTO app_mixer_agent_run_slot_scopes (tenant_id,agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[tenantId,agentId]);
   const locked=await query('SELECT agent_id FROM app_mixer_agent_run_slot_scopes WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',[tenantId,agentId]);if(locked.rows?.length!==1)throw Error('Invalid agent run slot lock');
   const now=Number((await query(`SELECT ${NOW} AS now`,[])).rows[0]?.now);if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid database clock');
   await query('DELETE FROM app_mixer_agent_run_slots WHERE tenant_id=$1 AND agent_id=$2 AND lease_until<=$3',[tenantId,agentId,now]);
   const held=await query('SELECT run_id FROM app_mixer_agent_run_slots WHERE tenant_id=$1 AND agent_id=$2',[tenantId,agentId]);
   if(held.rows.some(row=>row.run_id===runId))throw Error('Agent run slot held');
   if(held.rows.length>=limits.maxConcurrentRuns)throw Error('Agent run quota exceeded');
   const day=Math.floor(now/86400000);
   if(limits.maxRunsPerDay!==undefined){
    const seen=await query('SELECT 1 FROM app_mixer_agent_run_starts WHERE tenant_id=$1 AND agent_id=$2 AND day=$3 AND run_id=$4',[tenantId,agentId,day,runId]);
    if(!seen.rows.length){const count=Number((await query('SELECT COUNT(*)::bigint AS count FROM app_mixer_agent_run_starts WHERE tenant_id=$1 AND agent_id=$2 AND day=$3',[tenantId,agentId,day])).rows[0]?.count);if(!Number.isSafeInteger(count))throw Error('Invalid agent run count');if(count>=limits.maxRunsPerDay)throw Error('Agent run quota exceeded');}
   }
   await query('INSERT INTO app_mixer_agent_run_starts (tenant_id,agent_id,day,run_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,agentId,day,runId]);
   await query('INSERT INTO app_mixer_agent_run_slots (tenant_id,agent_id,run_id,token,worker_id,lease_until) VALUES ($1,$2,$3,$4,$5,$6)',[tenantId,agentId,runId,token,workerId,now+leaseMs]);
   return token;
  });
 }
 /** Extend an unexpired slot; returns false when it expired or was taken over. */
 async renew(scope:AgentRunScope,runId:string,token:string,leaseMs:number):Promise<boolean>{
  const {tenantId,agentId}=this.scope(scope);if(!id(runId)||!id(token)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000)throw Error('Invalid agent run slot request');
  const result=await this.query(`UPDATE app_mixer_agent_run_slots SET lease_until=${NOW}+$5 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND token=$4 AND lease_until>${NOW}`,[tenantId,agentId,runId,token,leaseMs]);return result.rowCount===1;
 }
 async release(scope:AgentRunScope,runId:string,token:string):Promise<void>{
  const {tenantId,agentId}=this.scope(scope);if(!id(runId)||!id(token))throw Error('Invalid agent run slot request');
  await this.query('DELETE FROM app_mixer_agent_run_slots WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND token=$4',[tenantId,agentId,runId,token]);
 }
 /** Count unexpired slots, for diagnostics. */
 async active(scope:AgentRunScope):Promise<number>{const {tenantId,agentId}=this.scope(scope);const count=Number((await this.query(`SELECT COUNT(*)::bigint AS count FROM app_mixer_agent_run_slots WHERE tenant_id=$1 AND agent_id=$2 AND lease_until>${NOW}`,[tenantId,agentId])).rows[0]?.count);if(!Number.isSafeInteger(count))throw Error('Invalid agent run count');return count;}
 /** Remove day counters older than the given number of UTC days; slots are not affected. */
 async pruneStarts(retainDays:number):Promise<number>{if(!Number.isSafeInteger(retainDays)||retainDays<1||retainDays>3660)throw Error('Invalid retention');const result=await this.query(`DELETE FROM app_mixer_agent_run_starts WHERE day<floor(${NOW}/86400000)::bigint-$1`,[retainDays]);return result.rowCount??0;}
}
