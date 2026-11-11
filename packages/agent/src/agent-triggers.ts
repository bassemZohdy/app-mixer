import {canonicalTriggerPayload} from './agent-trigger-payload.js';
import {DatabaseSync} from 'node:sqlite';
import {ensureTriggerReceiptSchema} from './agent-trigger-receipts.js';
import {randomUUID,createHash} from 'node:crypto';
import {SqliteAgentRuns,type AgentRunScope} from './durable-runs.js';
import {insertAgentTraceParent,parseAgentTraceParent} from './agent-trace-context.js';
import {openDatabase} from './sqlite-open.js';
import {isIdentifier} from './validation.js';

type EventInput={sourceId:string;principalId:string;eventId:string;eventType:string;payload:unknown};
type EnqueueOptions={definitionVersion:number;maxAttempts:number;deadline:number;maxPending:number;traceParent?:string};
export type TriggerRecord={sourceId:string;principalId:string;eventId:string;eventType:string;payload:unknown;runId:string;payloadRedacted?:true};
const id=isIdentifier;
/** Local trigger inbox; caller must authenticate and authorize the source and scope. */
export class SqliteAgentTriggers {
 private readonly db:DatabaseSync;
 constructor(path:string){this.db=openDatabase(path);try{this.db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS agent_trigger_inbox (
   tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,source_id TEXT NOT NULL,event_id TEXT NOT NULL,principal_id TEXT NOT NULL,
   event_type TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,run_id TEXT NOT NULL,
   PRIMARY KEY(tenant_id,agent_id,source_id,event_id), UNIQUE(tenant_id,agent_id,run_id)
  );
  CREATE TABLE IF NOT EXISTS agent_trigger_redactions (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,actor_id TEXT NOT NULL,redacted_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));
  CREATE TRIGGER IF NOT EXISTS agent_trigger_redactions_no_replace BEFORE INSERT ON agent_trigger_redactions WHEN EXISTS(SELECT 1 FROM agent_trigger_redactions WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'Trigger redactions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS agent_trigger_redactions_no_update BEFORE UPDATE ON agent_trigger_redactions BEGIN SELECT RAISE(ABORT,'Trigger redactions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS agent_trigger_redactions_no_delete BEFORE DELETE ON agent_trigger_redactions BEGIN SELECT RAISE(ABORT,'Trigger redactions are immutable'); END;`);if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs'").get())throw Error('Run registry unavailable');ensureTriggerReceiptSchema(this.db);}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 /** Only on-disk stores backed by the same SQLite database can share trigger identities. */
 sharesRunDatabase(runs:SqliteAgentRuns):boolean{if(!(runs instanceof SqliteAgentRuns))return false;const row=this.db.prepare('PRAGMA database_list').all().find(item=>item.name==='main');return typeof row?.file==='string'&&row.file.length>0&&runs.isBackedByDatabase(row.file);}

 get(scope:AgentRunScope,runId:string):TriggerRecord|undefined{
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(runId))throw Error('Invalid trigger');
  const row=this.db.prepare('SELECT i.source_id,i.principal_id,i.event_id,i.event_type,i.payload,i.run_id,r.run_id AS redacted FROM agent_trigger_inbox i LEFT JOIN agent_trigger_redactions r ON r.tenant_id=i.tenant_id AND r.agent_id=i.agent_id AND r.run_id=i.run_id WHERE i.tenant_id=? AND i.agent_id=? AND i.run_id=?').get(scope.tenantId,scope.agentId,runId);if(!row)return undefined;
  return {sourceId:String(row.source_id),principalId:String(row.principal_id),eventId:String(row.event_id),eventType:String(row.event_type),payload:JSON.parse(String(row.payload)),runId:String(row.run_id),...(row.redacted!==null?{payloadRedacted:true as const}:{})};
 }
 enqueue(scope:AgentRunScope,event:EventInput,options:EnqueueOptions,now=Date.now()):{runId:string;duplicate:boolean}{
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!event||!id(event.sourceId)||!id(event.principalId)||!id(event.eventId)||!id(event.eventType)||!options||!Number.isSafeInteger(options.definitionVersion)||options.definitionVersion<1||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>100||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||!Number.isSafeInteger(options.deadline)||!Number.isSafeInteger(now)||now<0||options.deadline<=now||(options.traceParent!==undefined&&!parseAgentTraceParent(options.traceParent)))throw Error('Invalid trigger');
  const payload=canonicalTriggerPayload(event.payload),hash=createHash('sha256').update(payload).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{
   const wakeups=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_run_wakeups'").get();if(wakeups&&this.db.prepare('SELECT 1 FROM agent_run_wakeups WHERE tenant_id=? AND agent_id=? AND source_id=? AND event_id=?').get(scope.tenantId,scope.agentId,event.sourceId,event.eventId))throw Error('Trigger identity conflict');
   const existing=this.db.prepare('SELECT i.principal_id,i.event_type,i.payload,i.payload_hash,i.run_id,r.run_id AS redacted FROM agent_trigger_inbox i LEFT JOIN agent_trigger_redactions r ON r.tenant_id=i.tenant_id AND r.agent_id=i.agent_id AND r.run_id=i.run_id WHERE i.tenant_id=? AND i.agent_id=? AND i.source_id=? AND i.event_id=?').get(scope.tenantId,scope.agentId,event.sourceId,event.eventId);
   if(existing){if(existing.principal_id!==event.principalId||existing.event_type!==event.eventType||existing.payload_hash!==hash||(existing.redacted===null&&existing.payload!==payload))throw Error('Trigger identity conflict');this.db.exec('COMMIT');return {runId:String(existing.run_id),duplicate:true};}
   const count=this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status IN ('queued','running','pause_requested','cancel_requested','paused','uncertain')").get(scope.tenantId,scope.agentId);
   if(Number(count?.n)>=options.maxPending)throw Error('Trigger backlog full');
   const runId=randomUUID();this.db.prepare("INSERT INTO agent_runs (tenant_id,agent_id,run_id,definition_version,revision,status,attempts,max_attempts,deadline,lease_owner,lease_token,lease_until,archived) VALUES (?,?,?,?,1,'queued',0,?,?,NULL,NULL,NULL,0)").run(scope.tenantId,scope.agentId,runId,options.definitionVersion,options.maxAttempts,options.deadline);
   insertAgentTraceParent(this.db,scope,runId,options.traceParent);
   this.db.prepare('INSERT INTO agent_trigger_inbox VALUES (?,?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.agentId,event.sourceId,event.eventId,event.principalId,event.eventType,payload,hash,runId);
   this.db.prepare('INSERT INTO agent_trigger_receipts VALUES (?,?,?,?)').run(scope.tenantId,scope.agentId,runId,now);
   this.db.exec('COMMIT');return {runId,duplicate:false};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
export type {EventInput as AgentTriggerInput,EnqueueOptions as AgentTriggerEnqueueOptions};
