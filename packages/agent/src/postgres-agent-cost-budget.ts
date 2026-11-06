import type {AgentRunScope} from './durable-runs.js';
import {POSTGRES_NOW as NOW,type PostgresAgentRunsOptions,type PostgresRunQuery as Query} from './postgres-agent-runs.js';

export type PostgresCostCall={runId:string;callId:string;day:number;reserved:number;used:number|null;status:'reserved'|'settled'};
export type PostgresCostSummary={currency:string;limit:number;day:number;committed:number;reserved:number;overrun:boolean};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const micros=(value:unknown,max=100000000000):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
const DAY=86400000;
function key(scope:AgentRunScope):[string,string]{if(!scope||!id(scope.tenantId)||!id(scope.agentId))throw Error('Invalid cost scope');return [scope.tenantId,scope.agentId];}

/**
 * A daily cost budget per agent, shared by every node through the PostgreSQL database that holds the
 * PostgresAgentRuns registry. A reservation is fenced on the caller's live run lease and admitted under one per-agent
 * lock, so concurrent nodes cannot together exceed the limit. Days are UTC days of the database clock. A settled
 * call that used more than it reserved (a provider overrun) blocks further reservations for that day. A run with an
 * open reservation settles as uncertain; reconcile the reservation once actual usage is known.
 */
export class PostgresAgentCostBudget {
 private readonly query:Query;private readonly transaction:PostgresAgentRunsOptions['transaction'];
 constructor(options:PostgresAgentRunsOptions){if(!options||options.enabled!==true||typeof options.query!=='function'||typeof options.transaction!=='function')throw Error('Invalid cost budget configuration');this.query=options.query;this.transaction=options.transaction;}
 /** Requires PostgresAgentRuns.initialize(), which creates the call ledger. */
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_agent_cost_budgets (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,currency TEXT NOT NULL,max_micros_per_day BIGINT NOT NULL,PRIMARY KEY(tenant_id,agent_id))',[]);}
 /** Set or change an agent's daily limit (host-authorized). The currency cannot change once calls exist. */
 async configure(scope:AgentRunScope,budget:{currency:string;maxMicrosPerDay:number}):Promise<void>{
  const [tenantId,agentId]=key(scope);if(!budget||typeof budget.currency!=='string'||!/^[A-Z]{3}$/.test(budget.currency)||!micros(budget.maxMicrosPerDay)||budget.maxMicrosPerDay<1)throw Error('Invalid cost budget');
  await this.transaction(async query=>{
   const current=(await query('SELECT currency FROM app_mixer_agent_cost_budgets WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',[tenantId,agentId])).rows[0];
   if(current&&current.currency!==budget.currency&&(await query('SELECT 1 FROM app_mixer_agent_cost_calls WHERE tenant_id=$1 AND agent_id=$2 LIMIT 1',[tenantId,agentId])).rows.length)throw Error('Cost budget currency conflict');
   await query('INSERT INTO app_mixer_agent_cost_budgets VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,agent_id) DO UPDATE SET currency=EXCLUDED.currency,max_micros_per_day=EXCLUDED.max_micros_per_day',[tenantId,agentId,budget.currency,budget.maxMicrosPerDay]);
  });
 }
 private async budget(query:Query,tenantId:string,agentId:string,lock:boolean):Promise<{currency:string;limit:number}>{const row=(await query(`SELECT currency,max_micros_per_day FROM app_mixer_agent_cost_budgets WHERE tenant_id=$1 AND agent_id=$2${lock?' FOR UPDATE':''}`,[tenantId,agentId])).rows[0];if(!row)throw Error('Cost budget unavailable');return {currency:String(row.currency),limit:Number(row.max_micros_per_day)};}
 private async totals(query:Query,tenantId:string,agentId:string,day:number):Promise<{committed:number;reserved:number;overrun:boolean}>{const row=(await query("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE 0 END),0)::bigint AS committed,COALESCE(SUM(CASE WHEN status='reserved' THEN reserved ELSE 0 END),0)::bigint AS reserved,COALESCE(BOOL_OR(status='settled' AND used>reserved),false) AS overrun FROM app_mixer_agent_cost_calls WHERE tenant_id=$1 AND agent_id=$2 AND day=$3",[tenantId,agentId,day])).rows[0];return {committed:Number(row?.committed??0),reserved:Number(row?.reserved??0),overrun:row?.overrun===true};}
 private async fence(query:Query,tenantId:string,agentId:string,runId:string,token:string|null):Promise<number>{
  const run=(await query(`SELECT status,lease_token,lease_until,${NOW} AS now FROM app_mixer_agent_runs WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 FOR UPDATE`,[tenantId,agentId,runId])).rows[0];
  if(token===null){if(!run||run.status!=='uncertain')throw Error('Run is not uncertain');}
  else if(!run||run.status!=='running'||run.lease_token!==token||run.lease_until==null||Number(run.now)>=Number(run.lease_until))throw Error('Cost budget lease unavailable');
  return Number(run.now);
 }
 /** Reserve the worst-case cost of one model call before making it. */
 async reserve(scope:AgentRunScope,runId:string,leaseToken:string,callId:string,costMicros:number):Promise<PostgresCostCall>{
  const [tenantId,agentId]=key(scope);if(!id(runId)||!id(leaseToken)||!id(callId)||!micros(costMicros)||costMicros<1)throw Error('Invalid cost reservation');
  return this.transaction(async query=>{
   const now=await this.fence(query,tenantId,agentId,runId,leaseToken),day=Math.floor(now/DAY)*DAY;
   // One lock per agent serializes admission across nodes, so the sum below cannot be read stale.
   const {limit}=await this.budget(query,tenantId,agentId,true);
   if((await query('SELECT 1 FROM app_mixer_agent_cost_calls WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND call_id=$4',[tenantId,agentId,runId,callId])).rows.length)throw Error('Cost call already exists');
   const totals=await this.totals(query,tenantId,agentId,day);
   if(totals.overrun)throw Error('Cost provider limit violated');
   if(totals.committed+totals.reserved+costMicros>limit)throw Error('Cost budget exhausted');
   await query("INSERT INTO app_mixer_agent_cost_calls VALUES ($1,$2,$3,$4,$5,$6,NULL,'reserved')",[tenantId,agentId,runId,callId,day,costMicros]);
   return {runId,callId,day,reserved:costMicros,used:null,status:'reserved' as const};
  });
 }
 private async close(scope:AgentRunScope,runId:string,token:string|null,callId:string,usedMicros:number):Promise<PostgresCostCall>{
  const [tenantId,agentId]=key(scope);if(!id(runId)||(token!==null&&!id(token))||!id(callId)||!micros(usedMicros))throw Error('Invalid cost usage');
  return this.transaction(async query=>{
   await this.fence(query,tenantId,agentId,runId,token);
   const row=(await query("UPDATE app_mixer_agent_cost_calls SET status='settled',used=$5 WHERE tenant_id=$1 AND agent_id=$2 AND run_id=$3 AND call_id=$4 AND status='reserved' RETURNING day,reserved",[tenantId,agentId,runId,callId,usedMicros])).rows[0];
   if(!row)throw Error('Invalid cost call state');return {runId,callId,day:Number(row.day),reserved:Number(row.reserved),used:usedMicros,status:'settled' as const};
  });
 }
 /** Record the provider-reported cost while holding the lease. */
 settle(scope:AgentRunScope,runId:string,leaseToken:string,callId:string,usedMicros:number):Promise<PostgresCostCall>{return this.close(scope,runId,leaseToken,callId,usedMicros);}
 /** Record actual cost for an open reservation of an uncertain run (after the old worker stopped). */
 reconcile(scope:AgentRunScope,runId:string,callId:string,usedMicros:number):Promise<PostgresCostCall>{return this.close(scope,runId,null,callId,usedMicros);}
 /** Spend for one UTC day (default: today by the database clock). */
 async summary(scope:AgentRunScope,day?:number):Promise<PostgresCostSummary>{
  const [tenantId,agentId]=key(scope);if(day!==undefined&&(!micros(day,Number.MAX_SAFE_INTEGER)||day%DAY!==0))throw Error('Invalid cost day');
  const {currency,limit}=await this.budget(this.query,tenantId,agentId,false),selected=day??Math.floor(Number((await this.query(`SELECT ${NOW} AS now`,[])).rows[0]?.now)/DAY)*DAY;
  return {currency,limit,day:selected,...await this.totals(this.query,tenantId,agentId,selected)};
 }
}
