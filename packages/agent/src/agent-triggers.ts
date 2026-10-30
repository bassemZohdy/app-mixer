import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {type AgentRunScope} from './durable-runs.js';
import {insertAgentTraceParent,parseAgentTraceParent} from './agent-trace-context.js';

type EventInput={sourceId:string;principalId:string;eventId:string;eventType:string;payload:unknown};
type EnqueueOptions={definitionVersion:number;maxAttempts:number;deadline:number;maxPending:number;traceParent?:string};
export type TriggerRecord={sourceId:string;principalId:string;eventId:string;eventType:string;payload:unknown;runId:string};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
function canonical(value:unknown):string {
 let count=0;const ancestors=new Set<object>();
 const copy=(x:unknown,depth:number):unknown=>{
  if(++count>10000||depth>40)throw Error('Invalid trigger payload');
  if(x===null||typeof x==='boolean'||typeof x==='string'||(typeof x==='number'&&Number.isFinite(x)))return x;
  if(!x||typeof x!=='object'||ancestors.has(x))throw Error('Invalid trigger payload');ancestors.add(x);let result:unknown;
  if(Array.isArray(x)){if(x.length>10000||Object.keys(x).length!==x.length||Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).some(v=>!v))throw Error('Invalid trigger payload');result=x.map(y=>copy(y,depth+1));}
  else{if(![Object.prototype,null].includes(Object.getPrototypeOf(x)))throw Error('Invalid trigger payload');const obj:Record<string,unknown>={};for(const key of Object.keys(x).sort()){if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid trigger payload');obj[key]=copy((x as Record<string,unknown>)[key],depth+1);}result=obj;}
  ancestors.delete(x);return result;
 };
 const text=JSON.stringify(copy(value,0));if(Buffer.byteLength(text)>256*1024)throw Error('Invalid trigger payload');return text;
}
/** Local trigger inbox; caller must authenticate and authorize the source and scope. */
export class SqliteAgentTriggers {
 private readonly db:DatabaseSync;
 constructor(path:string){this.db=new DatabaseSync(path);try{this.db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS agent_trigger_inbox (
   tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,source_id TEXT NOT NULL,event_id TEXT NOT NULL,principal_id TEXT NOT NULL,
   event_type TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,run_id TEXT NOT NULL,
   PRIMARY KEY(tenant_id,agent_id,source_id,event_id), UNIQUE(tenant_id,agent_id,run_id)
  );`);if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs'").get())throw Error('Run registry unavailable');}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 get(scope:AgentRunScope,runId:string):TriggerRecord|undefined{
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!id(runId))throw Error('Invalid trigger');
  const row=this.db.prepare('SELECT source_id,principal_id,event_id,event_type,payload,run_id FROM agent_trigger_inbox WHERE tenant_id=? AND agent_id=? AND run_id=?').get(scope.tenantId,scope.agentId,runId);if(!row)return undefined;
  return {sourceId:String(row.source_id),principalId:String(row.principal_id),eventId:String(row.event_id),eventType:String(row.event_type),payload:JSON.parse(String(row.payload)),runId:String(row.run_id)};
 }
 enqueue(scope:AgentRunScope,event:EventInput,options:EnqueueOptions,now=Date.now()):{runId:string;duplicate:boolean}{
  if(!scope||!id(scope.tenantId)||!id(scope.agentId)||!event||!id(event.sourceId)||!id(event.principalId)||!id(event.eventId)||!id(event.eventType)||!options||!Number.isSafeInteger(options.definitionVersion)||options.definitionVersion<1||!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>100||!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>10000||!Number.isSafeInteger(options.deadline)||!Number.isSafeInteger(now)||now<0||options.deadline<=now||(options.traceParent!==undefined&&!parseAgentTraceParent(options.traceParent)))throw Error('Invalid trigger');
  const payload=canonical(event.payload),hash=createHash('sha256').update(payload).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{
   const existing=this.db.prepare('SELECT principal_id,event_type,payload,payload_hash,run_id FROM agent_trigger_inbox WHERE tenant_id=? AND agent_id=? AND source_id=? AND event_id=?').get(scope.tenantId,scope.agentId,event.sourceId,event.eventId);
   if(existing){if(existing.principal_id!==event.principalId||existing.event_type!==event.eventType||existing.payload_hash!==hash||existing.payload!==payload)throw Error('Trigger identity conflict');this.db.exec('COMMIT');return {runId:String(existing.run_id),duplicate:true};}
   const count=this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status IN ('queued','running','pause_requested','cancel_requested','paused','uncertain')").get(scope.tenantId,scope.agentId);
   if(Number(count?.n)>=options.maxPending)throw Error('Trigger backlog full');
   const runId=randomUUID();this.db.prepare("INSERT INTO agent_runs VALUES (?,?,?,?,1,'queued',0,?,?,NULL,NULL,NULL,0)").run(scope.tenantId,scope.agentId,runId,options.definitionVersion,options.maxAttempts,options.deadline);
   insertAgentTraceParent(this.db,scope,runId,options.traceParent);
   this.db.prepare('INSERT INTO agent_trigger_inbox VALUES (?,?,?,?,?,?,?,?,?)').run(scope.tenantId,scope.agentId,event.sourceId,event.eventId,event.principalId,event.eventType,payload,hash,runId);
   this.db.exec('COMMIT');return {runId,duplicate:false};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
export type {EventInput as AgentTriggerInput,EnqueueOptions as AgentTriggerEnqueueOptions};
