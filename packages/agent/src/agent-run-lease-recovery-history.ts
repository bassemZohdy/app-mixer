import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
type Actor={tenantId:string;principalId:string};
export type AgentRunLeaseRecoveryEvent={id:number;runId:string;revision:number;previousStatus:'running'|'pause_requested'|'cancel_requested';leaseUntil:number;principalId:string;reference:string;observedAt:number};
type Options={scope:AgentRunScope;authorize:(actor:Actor,action:'list'|'read',event:AgentRunLeaseRecoveryEvent|null)=>boolean|Promise<boolean>};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
/** Authorized, fixed-scope access to atomic lease-recovery decisions. */
export class SqliteAgentLeaseRecoveryHistory{
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){if(typeof path!=='string'||!path||!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid lease recovery history');this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path,{readOnly:true});try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_run_lease_recovery_audit'").get())throw Error('Lease recovery history unavailable');}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 async list(actor:Actor,options:{after?:number;limit?:number}={}):Promise<{items:AgentRunLeaseRecoveryEvent[];nextAfter?:number}>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId))throw Error('Invalid lease recovery history actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid lease recovery history listing');if(await this.authorize({...who},'list',null)!==true)throw Error('Lease recovery history access denied');
  const rows=this.db.prepare('SELECT scope_seq AS id,run_id,revision,previous_status,lease_until,actor_id,reference,observed_at FROM agent_run_lease_recovery_audit WHERE tenant_id=? AND agent_id=? AND scope_seq>? ORDER BY scope_seq LIMIT ?').all(this.scope.tenantId,this.scope.agentId,after,limit+1),items:AgentRunLeaseRecoveryEvent[]=[];
  for(const row of rows.slice(0,limit)){if(!integer(row.id)||row.id<1||!id(row.run_id)||!integer(row.revision)||row.revision<2||!['running','pause_requested','cancel_requested'].includes(String(row.previous_status))||!integer(row.lease_until)||!id(row.actor_id)||!id(row.reference)||!integer(row.observed_at)||row.observed_at<row.lease_until)throw Error('Invalid lease recovery history data');const event:AgentRunLeaseRecoveryEvent={id:row.id,runId:row.run_id,revision:row.revision,previousStatus:row.previous_status as AgentRunLeaseRecoveryEvent['previousStatus'],leaseUntil:row.lease_until,principalId:row.actor_id,reference:row.reference,observedAt:row.observed_at};if(await this.authorize({...who},'read',{...event})===true)items.push(event);}
  for(const event of items)if(await this.authorize({...who},'read',{...event})!==true)throw Error('Lease recovery history access denied');if(await this.authorize({...who},'list',null)!==true)throw Error('Lease recovery history access denied');
  return {items,...(rows.length>limit?{nextAfter:Number(rows[limit-1].id)}:{})};
 }
}
export type {Options as AgentRunLeaseRecoveryHistoryOptions,Actor as AgentRunLeaseRecoveryHistoryActor};
