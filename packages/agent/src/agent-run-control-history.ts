import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
type Actor={tenantId:string;principalId:string};
export type AgentRunControlEvent={id:number;runId:string;revision:number;action:'pause'|'resume'|'cancel';previousStatus:string;status:string;principalId:string;observedAt:number};
type Options={scope:AgentRunScope;authorize:(actor:Actor,action:'list'|'read',event:AgentRunControlEvent|null)=>boolean|Promise<boolean>};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const statuses=['queued','running','pause_requested','cancel_requested','paused','uncertain','succeeded','failed','cancelled'];
/** Separately authorized scoped reads of atomic lifecycle decisions. */
export class SqliteAgentRunControlHistory{
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){if(typeof path!=='string'||!path||!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid run control history');this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path,{readOnly:true});try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_run_control_audit'").get())throw Error('Run control history unavailable');}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 async list(actor:Actor,options:{after?:number;limit?:number}={}):Promise<{items:AgentRunControlEvent[];nextAfter?:number}>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId))throw Error('Invalid run control history actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid run control history listing');const permit=(action:'list'|'read',event:AgentRunControlEvent|null)=>this.authorize({...who},action,event?{...event}:null);if(await permit('list',null)!==true)throw Error('Run control history access denied');
  const rows=this.db.prepare('SELECT scope_seq AS id,run_id,revision,action,previous_status,status,actor_id,observed_at FROM agent_run_control_audit WHERE tenant_id=? AND agent_id=? AND scope_seq>? ORDER BY scope_seq LIMIT ?').all(this.scope.tenantId,this.scope.agentId,after,limit+1),items:AgentRunControlEvent[]=[];
  for(const row of rows.slice(0,limit)){if(!integer(row.id)||row.id<1||!id(row.run_id)||!integer(row.revision)||row.revision<2||!['pause','resume','cancel'].includes(String(row.action))||!statuses.includes(String(row.previous_status))||!statuses.includes(String(row.status))||!id(row.actor_id)||!integer(row.observed_at))throw Error('Invalid run control history data');const event:AgentRunControlEvent={id:row.id,runId:row.run_id,revision:row.revision,action:row.action as AgentRunControlEvent['action'],previousStatus:String(row.previous_status),status:String(row.status),principalId:row.actor_id,observedAt:row.observed_at};if(await permit('read',event)===true)items.push(event);}
  for(const event of items)if(await permit('read',event)!==true)throw Error('Run control history access denied');if(await permit('list',null)!==true)throw Error('Run control history access denied');return {items,...(rows.length>limit?{nextAfter:Number(rows[limit-1].id)}:{})};
 }
}
export type {Options as AgentRunControlHistoryOptions,Actor as AgentRunControlHistoryActor};
