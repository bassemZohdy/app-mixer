import {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';
import type {AgentScheduleConfig} from './agent-schedules.js';

type Actor={tenantId:string;principalId:string};
export type AgentScheduleEvent={id:number;tenantId:string;agentId:string;scheduleId:string;kind:'created'|'updated'|'fired';revision:number;generation:number;nextAt:number;config:AgentScheduleConfig;actorId:string|null;runId:string|null;scheduledAt:number|null;observedAt:number};
type Options={scope:AgentRunScope;authorize:(actor:Actor,action:'list'|'read',event:AgentScheduleEvent|null)=>boolean|Promise<boolean>};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;

/** Host-authorized read access to immutable schedule configuration and activation history. */
export class SqliteAgentScheduleHistory {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){if(!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid schedule history');this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path);try{this.db.exec('PRAGMA busy_timeout=5000');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_schedule_events'").get())throw Error('Schedule history unavailable');}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 async list(actor:Actor,options:{after?:number;limit?:number;scheduleId?:string}={}):Promise<{items:AgentScheduleEvent[];nextAfter?:number}>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!id(actor.principalId))throw Error('Invalid schedule history actor');const who={tenantId:actor.tenantId,principalId:actor.principalId},after=options?.after??0,limit=options?.limit??50,scheduleId=options?.scheduleId;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100||(scheduleId!==undefined&&!id(scheduleId)))throw Error('Invalid schedule history listing');if(await this.authorize({...who},'list',null)!==true)throw Error('Schedule history access denied');
  const rows=this.db.prepare('SELECT * FROM agent_schedule_events WHERE tenant_id=? AND agent_id=? AND id>? AND (? IS NULL OR schedule_id=?) ORDER BY id LIMIT ?').all(this.scope.tenantId,this.scope.agentId,after,scheduleId??null,scheduleId??null,limit),items:AgentScheduleEvent[]=[];
  for(const row of rows){const event:AgentScheduleEvent={id:Number(row.id),tenantId:String(row.tenant_id),agentId:String(row.agent_id),scheduleId:String(row.schedule_id),kind:row.kind as AgentScheduleEvent['kind'],revision:Number(row.revision),generation:Number(row.generation),nextAt:Number(row.next_at),config:JSON.parse(String(row.config)),actorId:row.actor_id===null?null:String(row.actor_id),runId:row.run_id===null?null:String(row.run_id),scheduledAt:row.scheduled_at===null?null:Number(row.scheduled_at),observedAt:Number(row.observed_at)};if(await this.authorize({...who},'read',structuredClone(event))===true)items.push(event);}
  return {items,...(rows.length===limit?{nextAfter:Number(rows.at(-1)!.id)}:{})};
 }
}
export type {Options as AgentScheduleHistoryOptions,Actor as AgentScheduleHistoryActor};
