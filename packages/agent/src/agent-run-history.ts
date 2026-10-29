import {DatabaseSync} from 'node:sqlite';
import {type AgentRunScope} from './durable-runs.js';

type Actor={tenantId:string;principalId:string};
type Access='list'|'read';
export type AgentRunEvent={id:number;tenantId:string;agentId:string;runId:string;kind:'created'|'transition'|'updated'|'archived';revision:number;previousStatus:string|null;status:string;attempts:number;definitionVersion:number;workerId:string|null;archived:boolean;waitKind:'approval'|'delegation'|null;waitSubject:string|null;observedAt:number};
type Options={scope:AgentRunScope;authorize:(actor:Actor,action:Access,event:AgentRunEvent|null)=>boolean|Promise<boolean>};
const valid=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
/** Install run-level lifecycle capture on the same database as the registry. */
export function ensureAgentRunHistory(db:DatabaseSync):void{db.exec(`
 CREATE TABLE IF NOT EXISTS agent_run_events (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,previous_status TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL,definition_version INTEGER NOT NULL,worker_id TEXT,archived INTEGER NOT NULL,wait_kind TEXT,wait_subject TEXT,observed_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS agent_run_events_scope ON agent_run_events(tenant_id,agent_id,id);
 CREATE TRIGGER IF NOT EXISTS agent_run_events_no_replace BEFORE INSERT ON agent_run_events WHEN NEW.id>0 AND EXISTS(SELECT 1 FROM agent_run_events WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Run events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_run_events_no_update BEFORE UPDATE ON agent_run_events BEGIN SELECT RAISE(ABORT,'Run events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_run_events_no_delete BEFORE DELETE ON agent_run_events BEGIN SELECT RAISE(ABORT,'Run events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_runs_capture_insert AFTER INSERT ON agent_runs BEGIN
  INSERT INTO agent_run_events (tenant_id,agent_id,run_id,kind,revision,previous_status,status,attempts,definition_version,worker_id,archived,wait_kind,wait_subject,observed_at)
  VALUES (NEW.tenant_id,NEW.agent_id,NEW.run_id,'created',NEW.revision,NULL,NEW.status,NEW.attempts,NEW.definition_version,NEW.lease_owner,NEW.archived,NULL,NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
 END;
 CREATE TRIGGER IF NOT EXISTS agent_runs_capture_update AFTER UPDATE ON agent_runs WHEN NEW.status<>OLD.status OR NEW.archived<>OLD.archived OR NEW.attempts<>OLD.attempts OR NEW.lease_owner IS NOT OLD.lease_owner OR NEW.lease_token IS NOT OLD.lease_token OR NEW.definition_version<>OLD.definition_version BEGIN
  INSERT INTO agent_run_events (tenant_id,agent_id,run_id,kind,revision,previous_status,status,attempts,definition_version,worker_id,archived,wait_kind,wait_subject,observed_at)
  VALUES (NEW.tenant_id,NEW.agent_id,NEW.run_id,CASE WHEN NEW.archived<>OLD.archived THEN 'archived' WHEN NEW.status<>OLD.status THEN 'transition' ELSE 'updated' END,NEW.revision,OLD.status,NEW.status,NEW.attempts,NEW.definition_version,COALESCE(NEW.lease_owner,OLD.lease_owner),NEW.archived,
   CASE WHEN NEW.status='paused' AND EXISTS(SELECT 1 FROM agent_approval_waits WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id) THEN 'approval' WHEN NEW.status='paused' AND EXISTS(SELECT 1 FROM agent_delegation_waits WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id) THEN 'delegation' ELSE NULL END,
   CASE WHEN NEW.status='paused' THEN COALESCE((SELECT action_id FROM agent_approval_waits WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id),(SELECT grant_id FROM agent_delegation_waits WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id)) ELSE NULL END,
   CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
 END;`);}
/** Host-authorized, tenant/agent-scoped lifecycle history. */
export class SqliteAgentRunHistory {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];
 constructor(path:string,options:Options){if(!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||typeof options.authorize!=='function')throw Error('Invalid run history');this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.authorize=options.authorize;this.db=new DatabaseSync(path);try{this.db.exec('PRAGMA busy_timeout=5000');if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_run_events'").get())throw Error('Run history unavailable');}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 private actor(actor:Actor):Actor{if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw Error('Invalid run history actor');return {tenantId:actor.tenantId,principalId:actor.principalId};}
 private convert(row:Record<string,unknown>):AgentRunEvent{return {id:Number(row.id),tenantId:String(row.tenant_id),agentId:String(row.agent_id),runId:String(row.run_id),kind:row.kind as AgentRunEvent['kind'],revision:Number(row.revision),previousStatus:row.previous_status===null?null:String(row.previous_status),status:String(row.status),attempts:Number(row.attempts),definitionVersion:Number(row.definition_version),workerId:row.worker_id===null?null:String(row.worker_id),archived:row.archived===1,waitKind:row.wait_kind as AgentRunEvent['waitKind'],waitSubject:row.wait_subject===null?null:String(row.wait_subject),observedAt:Number(row.observed_at)};}
 async list(actor:Actor,options:{after?:number;limit?:number;runId?:string}={}):Promise<{items:AgentRunEvent[];nextAfter?:number}>{const who=this.actor(actor),after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100||(options.runId!==undefined&&!valid(options.runId)))throw Error('Invalid run history listing');const scope={...this.scope},runId=options.runId;if(await this.authorize({...who},'list',null)!==true)throw Error('Run history access denied');const rows=runId===undefined?this.db.prepare('SELECT * FROM agent_run_events WHERE tenant_id=? AND agent_id=? AND id>? ORDER BY id LIMIT ?').all(scope.tenantId,scope.agentId,after,limit):this.db.prepare('SELECT * FROM agent_run_events WHERE tenant_id=? AND agent_id=? AND run_id=? AND id>? ORDER BY id LIMIT ?').all(scope.tenantId,scope.agentId,runId,after,limit);const items:AgentRunEvent[]=[];for(const row of rows){const event=this.convert(row);if(await this.authorize({...who},'read',{...event})===true)items.push(event);}return {items,...(rows.length===limit?{nextAfter:Number(rows.at(-1)!.id)}:{})};}
}
export type {Actor as AgentRunHistoryActor,Access as AgentRunHistoryAccess,Options as AgentRunHistoryOptions};
