import {DatabaseSync} from 'node:sqlite';
import {BaseCheckpointSaver,WRITES_IDX_MAP,compareWritesSortKeys,writesSortKey,type Checkpoint,type CheckpointTuple,type CheckpointMetadata,type ChannelVersions,type CheckpointListOptions,type PendingWrite} from '@langchain/langgraph-checkpoint';
import {type RunnableConfig} from '@langchain/core/runnables';
import {type AgentRunScope} from './durable-runs.js';

type Options={scope:AgentRunScope;runId:string;leaseToken:string;clock?:()=>number};
const valid=(value:unknown,empty=false):value is string=>typeof value==='string'&&(empty||value.length>0)&&value.length<=1024&&!/[\u0000-\u001f]/.test(value);
/** LangGraph saver bound to one run; checkpoint writes are fenced by its live SQLite lease. */
export class SqliteAgentCheckpointer extends BaseCheckpointSaver {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly runId:string;private readonly token:string;private readonly clock:()=>number;
 constructor(path:string,options:Options){
  super();if(!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||!valid(options.runId)||!valid(options.leaseToken)||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid checkpoint configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.runId=options.runId;this.token=options.leaseToken;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS agent_checkpoints (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,ns TEXT NOT NULL,checkpoint_id TEXT NOT NULL,parent_id TEXT,checkpoint_type TEXT NOT NULL,checkpoint BLOB NOT NULL,metadata_type TEXT NOT NULL,metadata BLOB NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id,ns,checkpoint_id));
   CREATE TABLE IF NOT EXISTS agent_checkpoint_writes (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,ns TEXT NOT NULL,checkpoint_id TEXT NOT NULL,task_id TEXT NOT NULL,idx INTEGER NOT NULL,task_path TEXT NOT NULL,channel TEXT NOT NULL,value_type TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id,ns,checkpoint_id,task_id,idx));`);
  }catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private fields(config:RunnableConfig,requireId=false):{ns:string;checkpointId?:string}{
  const c=config?.configurable,thread=c?.thread_id,ns=c?.checkpoint_ns??'',checkpointId=c?.checkpoint_id;
  if(thread!==this.runId||!valid(ns,true)||(checkpointId!==undefined&&!valid(checkpointId))||(requireId&&!valid(checkpointId)))throw Error('Invalid checkpoint scope');
  return {ns,checkpointId:checkpointId as string|undefined};
 }
 private fence():void{
  const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid clock');
  const row=this.db.prepare('SELECT status,lease_token,lease_until FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(this.scope.tenantId,this.scope.agentId,this.runId);
  if(!row||!['running','pause_requested','cancel_requested'].includes(row.status as string)||row.lease_token!==this.token||typeof row.lease_until!=='number'||now>=row.lease_until)throw Error('Checkpoint lease unavailable');
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{this.fence();const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private args(ns:string):[string,string,string,string]{return [this.scope.tenantId,this.scope.agentId,this.runId,ns];}
 private config(ns:string,checkpointId:string):RunnableConfig{return {configurable:{thread_id:this.runId,checkpoint_ns:ns,checkpoint_id:checkpointId}};}
 private async tuple(row:Record<string,unknown>):Promise<CheckpointTuple>{
  const ns=row.ns as string,checkpointId=row.checkpoint_id as string;
  const writes=this.db.prepare('SELECT task_id,idx,task_path,channel,value_type,value FROM agent_checkpoint_writes WHERE tenant_id=? AND agent_id=? AND run_id=? AND ns=? AND checkpoint_id=?').all(...this.args(ns),checkpointId);
  writes.sort((a,b)=>compareWritesSortKeys(writesSortKey(String(a.task_path),String(a.task_id),Number(a.idx)),writesSortKey(String(b.task_path),String(b.task_id),Number(b.idx))));
  const pendingWrites=await Promise.all(writes.map(async w=>[String(w.task_id),String(w.channel),await this.serde.loadsTyped(String(w.value_type),w.value as Uint8Array)] as [string,string,unknown]));
  const checkpoint=await this.serde.loadsTyped(String(row.checkpoint_type),row.checkpoint as Uint8Array) as Checkpoint;
  const metadata=await this.serde.loadsTyped(String(row.metadata_type),row.metadata as Uint8Array) as CheckpointMetadata;
  return {config:this.config(ns,checkpointId),checkpoint,metadata,pendingWrites,...(typeof row.parent_id==='string'?{parentConfig:this.config(ns,row.parent_id)}:{})};
 }
 async getTuple(config:RunnableConfig):Promise<CheckpointTuple|undefined>{
  const {ns,checkpointId}=this.fields(config);
  const row=checkpointId?this.db.prepare('SELECT * FROM agent_checkpoints WHERE tenant_id=? AND agent_id=? AND run_id=? AND ns=? AND checkpoint_id=?').get(...this.args(ns),checkpointId):this.db.prepare('SELECT * FROM agent_checkpoints WHERE tenant_id=? AND agent_id=? AND run_id=? AND ns=? ORDER BY checkpoint_id DESC LIMIT 1').get(...this.args(ns));
  return row?this.tuple(row):undefined;
 }
 async *list(config:RunnableConfig,options:CheckpointListOptions={}):AsyncGenerator<CheckpointTuple>{
  const {ns,checkpointId}=this.fields(config);const before=options.before?this.fields(options.before,true):undefined;
  if(before&&before.ns!==ns)throw Error('Invalid checkpoint scope');
  if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<0||options.limit>10000))throw Error('Invalid checkpoint limit');
  let count=0;const rows=this.db.prepare('SELECT * FROM agent_checkpoints WHERE tenant_id=? AND agent_id=? AND run_id=? AND ns=? ORDER BY checkpoint_id DESC').all(...this.args(ns));
  for(const row of rows){if(checkpointId&&row.checkpoint_id!==checkpointId)continue;if(before&&String(row.checkpoint_id)>=before.checkpointId!)continue;const item=await this.tuple(row);if(options.filter&&!Object.entries(options.filter).every(([k,v])=>(item.metadata as Record<string,unknown>|undefined)?.[k]===v))continue;if(options.limit!==undefined&&count>=options.limit)break;count++;yield item;}
 }
 async put(config:RunnableConfig,checkpoint:Checkpoint,metadata:CheckpointMetadata,_versions:ChannelVersions):Promise<RunnableConfig>{
  const {ns,checkpointId:parent}=this.fields(config);if(!checkpoint||!valid(checkpoint.id))throw Error('Invalid checkpoint');
  const [[ct,cb],[mt,mb]]=await Promise.all([this.serde.dumpsTyped(checkpoint),this.serde.dumpsTyped(metadata)]);if(cb.length+mb.length>16*1024*1024)throw Error('Checkpoint too large');
  this.transaction(()=>{const previous=this.db.prepare('SELECT checkpoint_type,checkpoint,metadata_type,metadata,parent_id FROM agent_checkpoints WHERE tenant_id=? AND agent_id=? AND run_id=? AND ns=? AND checkpoint_id=?').get(...this.args(ns),checkpoint.id);
   if(previous){if(previous.checkpoint_type!==ct||previous.metadata_type!==mt||previous.parent_id!==(parent??null)||!Buffer.from(previous.checkpoint as Uint8Array).equals(Buffer.from(cb))||!Buffer.from(previous.metadata as Uint8Array).equals(Buffer.from(mb)))throw Error('Checkpoint conflict');return;}
   this.db.prepare('INSERT INTO agent_checkpoints VALUES (?,?,?,?,?,?,?,?,?,?)').run(...this.args(ns),checkpoint.id,parent??null,ct,cb,mt,mb);
  });return this.config(ns,checkpoint.id);
 }
 async putWrites(config:RunnableConfig,writes:PendingWrite[],taskId:string,taskPath=''):Promise<void>{
  const {ns,checkpointId}=this.fields(config,true);if(!valid(taskId)||!valid(taskPath,true)||!Array.isArray(writes)||writes.length>10000)throw Error('Invalid checkpoint writes');
  const entries=await Promise.all(writes.map(async ([channel,value],index)=>{if(!valid(channel))throw Error('Invalid checkpoint writes');const [type,bytes]=await this.serde.dumpsTyped(value);if(bytes.length>16*1024*1024)throw Error('Checkpoint too large');return {channel,type,bytes,idx:WRITES_IDX_MAP[channel]??index};}));
  this.transaction(()=>{const exists=this.db.prepare('SELECT 1 FROM agent_checkpoints WHERE tenant_id=? AND agent_id=? AND run_id=? AND ns=? AND checkpoint_id=?').get(...this.args(ns),checkpointId!);if(!exists)throw Error('Checkpoint not found');
   for(const entry of entries){const query=entry.idx<0?'INSERT OR REPLACE INTO agent_checkpoint_writes VALUES (?,?,?,?,?,?,?,?,?,?,?)':'INSERT OR IGNORE INTO agent_checkpoint_writes VALUES (?,?,?,?,?,?,?,?,?,?,?)';this.db.prepare(query).run(...this.args(ns),checkpointId!,taskId,entry.idx,taskPath,entry.channel,entry.type,entry.bytes);}
  });
 }
 async deleteThread(threadId:string):Promise<void>{if(threadId!==this.runId)throw Error('Invalid checkpoint scope');this.transaction(()=>{this.db.prepare('DELETE FROM agent_checkpoint_writes WHERE tenant_id=? AND agent_id=? AND run_id=?').run(this.scope.tenantId,this.scope.agentId,this.runId);this.db.prepare('DELETE FROM agent_checkpoints WHERE tenant_id=? AND agent_id=? AND run_id=?').run(this.scope.tenantId,this.scope.agentId,this.runId);});}
}
export type {Options as AgentCheckpointerOptions};
