import type {AgentRunScope} from './durable-runs.js';
import type {AgentRunExpiryEvent,AgentRunExpiryHistoryOptions,AgentRunExpiryHistoryActor} from './agent-expiry-history.js';
import {isIdentifier,isNonNegativeInteger} from './validation.js';
type Query=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
type Options=AgentRunExpiryHistoryOptions&{query:Query};
const id=isIdentifier;
const integer=isNonNegativeInteger;
/** Scope-bound evidence; the host must supply an authorized read-only adapter. */
export class PostgresAgentExpiryHistoryFoundation {
 private readonly scope:AgentRunScope;private readonly query:Query;private readonly authorize:Options['authorize'];
 constructor(options:Options){if(!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.query!=='function'||typeof options.authorize!=='function')throw Error('Invalid expiry history');this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.query=options.query;this.authorize=options.authorize;}
 async list(actor:AgentRunExpiryHistoryActor,options:{after?:number;limit?:number}={}):Promise<{items:AgentRunExpiryEvent[];nextAfter?:number}>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId))throw Error('Invalid expiry history actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid expiry history listing');const permit=async(action:'list'|'read',event:AgentRunExpiryEvent|null)=>await this.authorize({...who},action,event?{...event}:null)===true;if(!await permit('list',null))throw Error('Expiry history access denied');
  const rows=(await this.query('SELECT scope_seq AS id,run_id,revision,previous_status,deadline,actor_id,reference,observed_at FROM app_mixer_shared_run_expiry_audit WHERE tenant_id=$1 AND agent_id=$2 AND scope_seq>$3 ORDER BY scope_seq LIMIT $4',[this.scope.tenantId,this.scope.agentId,after,limit+1])).rows,items:AgentRunExpiryEvent[]=[];
  for(const row of rows.slice(0,limit)){const seq=Number(row.id),revision=Number(row.revision),deadline=Number(row.deadline),observedAt=Number(row.observed_at);if(!integer(seq)||seq<1||!id(row.run_id)||!integer(revision)||revision<2||!['queued','paused'].includes(String(row.previous_status))||!integer(deadline)||!id(row.actor_id)||!id(row.reference)||!integer(observedAt)||observedAt<deadline)throw Error('Invalid expiry history data');const event:AgentRunExpiryEvent={id:seq,runId:row.run_id,revision,previousStatus:row.previous_status as AgentRunExpiryEvent['previousStatus'],deadline,principalId:row.actor_id,reference:row.reference,observedAt};if(await permit('read',event))items.push(event);}
  for(const event of items)if(!await permit('read',event))throw Error('Expiry history access denied');if(!await permit('list',null))throw Error('Expiry history access denied');return {items,...(rows.length>limit?{nextAfter:Number(rows[limit-1]!.id)}:{})};
 }
}
