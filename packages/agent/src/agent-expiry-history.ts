import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';

type Actor={tenantId:string;principalId:string};
export type AgentRunExpiryEvent={id:number;runId:string;revision:number;previousStatus:'queued'|'paused';deadline:number;principalId:string;reference:string;observedAt:number};
type Options={scope:AgentRunScope;authorize:(actor:Actor,action:'list'|'read',event:AgentRunExpiryEvent|null)=>boolean|Promise<boolean>};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
/** Authorized access to atomic operator-attributed expiry decisions for one agent. */
export class SqliteAgentExpiryHistory{
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){if(typeof path!=='string'||!path||!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid expiry history');this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path,{readOnly:true});try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_run_expiry_audit'").get())throw Error('Expiry history unavailable');}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 async list(actor:Actor,options:{after?:number;limit?:number}={}):Promise<{items:AgentRunExpiryEvent[];nextAfter?:number}>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId))throw Error('Invalid expiry history actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid expiry history listing');if(await this.authorize({...who},'list',null)!==true)throw Error('Expiry history access denied');
  const rows=this.db.prepare('SELECT id,run_id,revision,previous_status,deadline,actor_id,reference,observed_at FROM agent_run_expiry_audit WHERE tenant_id=? AND agent_id=? AND id>? ORDER BY id LIMIT ?').all(this.scope.tenantId,this.scope.agentId,after,limit+1),items:AgentRunExpiryEvent[]=[];
  for(const row of rows.slice(0,limit)){if(!integer(row.id)||!id(row.run_id)||!integer(row.revision)||Number(row.revision)<2||!['queued','paused'].includes(String(row.previous_status))||!integer(row.deadline)||!id(row.actor_id)||!id(row.reference)||!integer(row.observed_at))throw Error('Invalid expiry history data');const event:AgentRunExpiryEvent={id:Number(row.id),runId:String(row.run_id),revision:Number(row.revision),previousStatus:row.previous_status as 'queued'|'paused',deadline:Number(row.deadline),principalId:String(row.actor_id),reference:String(row.reference),observedAt:Number(row.observed_at)};if(await this.authorize({...who},'read',{...event})===true)items.push(event);}
  return {items,...(rows.length>limit?{nextAfter:Number(rows[limit-1].id)}:{})};
 }
}
export type {Options as AgentRunExpiryHistoryOptions,Actor as AgentRunExpiryHistoryActor};
