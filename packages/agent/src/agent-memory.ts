import {DatabaseSync} from 'node:sqlite';

type MemoryScope={tenantId:string;agentId:string;owner:{kind:'organization'|'team'|'application'|'user';id:string};kind:'session'|'semantic'|'episodic'|'procedural'};
type MemoryActor={tenantId:string;principalId:string};
type Provenance={kind:'run'|'human'|'system';id:string};
type MemoryAction='read'|'write'|'delete'|'list'|'purge'|'audit'|'erase';
export type AgentMemoryRecord={id:string;revision:number;value:unknown;provenance:Provenance;expiresAt:number};
export type AgentMemoryAuditEvent={id:number;action:'write'|'delete'|'purge'|'erase';actorId:string;memoryId:string|null;revision:number|null;count:number;observedAt:number};
type Options={enabled:true;maxTtlMs:number;maxEntries:number;authorize:(actor:MemoryActor,scope:MemoryScope,action:MemoryAction,id?:string)=>boolean|Promise<boolean>;clock?:()=>number;audit?:boolean};
export class MemoryAccessDenied extends Error {constructor(){super('Memory access denied');}}
export const validMemoryId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
export function checkedMemoryScope(actor:MemoryActor,scope:MemoryScope):{actor:MemoryActor;scope:MemoryScope}{
 if(!actor||!scope||!validMemoryId(actor.tenantId)||!validMemoryId(actor.principalId)||!validMemoryId(scope.tenantId)||!validMemoryId(scope.agentId)||actor.tenantId!==scope.tenantId||!scope.owner||!['organization','team','application','user'].includes(scope.owner.kind)||!validMemoryId(scope.owner.id)||!['session','semantic','episodic','procedural'].includes(scope.kind))throw Error('Invalid memory scope');
 return {actor:{tenantId:actor.tenantId,principalId:actor.principalId},scope:{tenantId:scope.tenantId,agentId:scope.agentId,owner:{kind:scope.owner.kind,id:scope.owner.id},kind:scope.kind}};
}
export function safeMemoryJSON(input:unknown):string{
 let count=0;const seen=new Set<object>();const visit=(v:unknown,depth:number):unknown=>{
  if(++count>10000||depth>40)throw Error('Invalid memory value');if(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v)))return v;
  if(!v||typeof v!=='object'||seen.has(v))throw Error('Invalid memory value');seen.add(v);let out:unknown;
  if(Array.isArray(v)){if(v.length>10000||Object.keys(v).length!==v.length||Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).some(x=>!x))throw Error('Invalid memory value');out=v.map(x=>visit(x,depth+1));}
  else{if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('Invalid memory value');const result:Record<string,unknown>={};for(const key of Object.keys(v)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid memory value');result[key]=visit((v as Record<string,unknown>)[key],depth+1);}out=result;}
  seen.delete(v);return out;
 };const result=JSON.stringify(visit(input,0));if(Buffer.byteLength(result)>256*1024)throw Error('Invalid memory value');return result;
}
/** Opt-in local memory with host authorization and bounded retention. */
export class SqliteAgentMemory {
 private readonly db:DatabaseSync;private readonly maxTtlMs:number;private readonly maxEntries:number;private readonly authorize:Options['authorize'];private readonly clock:()=>number;private readonly audit:boolean;
 constructor(path:string,options:Options){
  if(!options||options.enabled!==true||!Number.isSafeInteger(options.maxTtlMs)||options.maxTtlMs<1||options.maxTtlMs>365*86400000||!Number.isSafeInteger(options.maxEntries)||options.maxEntries<1||options.maxEntries>1000||typeof options.authorize!=='function'||(options.clock!==undefined&&typeof options.clock!=='function')||(options.audit!==undefined&&typeof options.audit!=='boolean'))throw Error('Invalid memory configuration');
  this.maxTtlMs=options.maxTtlMs;this.maxEntries=options.maxEntries;this.authorize=options.authorize;this.clock=options.clock??Date.now;this.audit=options.audit===true;this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS agent_memories (
    tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,memory_kind TEXT NOT NULL,memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL,value TEXT,provenance TEXT,expires_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id,agent_id,owner_kind,owner_id,memory_kind,memory_id)
   );
   CREATE TABLE IF NOT EXISTS agent_memory_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,memory_kind TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,memory_id TEXT,revision INTEGER,count INTEGER NOT NULL,observed_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS agent_memory_audit_scope ON agent_memory_audit(tenant_id,agent_id,owner_kind,owner_id,memory_kind,id);
   CREATE TRIGGER IF NOT EXISTS agent_memory_audit_no_replace BEFORE INSERT ON agent_memory_audit WHEN NEW.id>0 AND EXISTS(SELECT 1 FROM agent_memory_audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Memory audit is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS agent_memory_audit_no_update BEFORE UPDATE ON agent_memory_audit BEGIN SELECT RAISE(ABORT,'Memory audit is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS agent_memory_audit_no_delete BEFORE DELETE ON agent_memory_audit BEGIN SELECT RAISE(ABORT,'Memory audit is immutable'); END;`);}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private now():number{const n=this.clock();if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid clock');return n;}
 private args(scope:MemoryScope):[string,string,string,string,string]{return [scope.tenantId,scope.agentId,scope.owner.kind,scope.owner.id,scope.kind];}
 private recordAudit(actor:MemoryActor,scope:MemoryScope,action:AgentMemoryAuditEvent['action'],memoryId:string|null,revision:number|null,count:number,now:number):void{if(this.audit)this.db.prepare('INSERT INTO agent_memory_audit (tenant_id,agent_id,owner_kind,owner_id,memory_kind,actor_id,action,memory_id,revision,count,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...this.args(scope),actor.principalId,action,memoryId,revision,count,now);}
 private async permit(actor:MemoryActor,scope:MemoryScope,action:MemoryAction,memoryId?:string):Promise<void>{if(await this.authorize(structuredClone(actor),structuredClone(scope),action,memoryId)!==true)throw new MemoryAccessDenied();}
 private row(scope:MemoryScope,memoryId:string):Record<string,unknown>|undefined{return this.db.prepare('SELECT * FROM agent_memories WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND memory_id=?').get(...this.args(scope),memoryId);}
 private record(row:Record<string,unknown>,now:number):AgentMemoryRecord|undefined{
  if(row.deleted===1||Number(row.expires_at)<=now)return undefined;
  if(typeof row.value!=='string'||typeof row.provenance!=='string'||!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1)throw Error('Invalid stored memory');
  return {id:String(row.memory_id),revision:Number(row.revision),value:JSON.parse(row.value),provenance:JSON.parse(row.provenance) as Provenance,expiresAt:Number(row.expires_at)};
 }
 async assertAccess(actor:MemoryActor,scope:MemoryScope,action:MemoryAction,memoryId?:string):Promise<void>{
  const c=checkedMemoryScope(actor,scope);if(!['read','write','delete','list','purge','audit','erase'].includes(action)||(memoryId!==undefined&&!validMemoryId(memoryId))||(['read','write','delete'].includes(action)&&memoryId===undefined))throw Error('Invalid memory access');await this.permit(c.actor,c.scope,action,memoryId);
 }
 async get(actor:MemoryActor,scope:MemoryScope,memoryId:string):Promise<AgentMemoryRecord|undefined>{
  const checkedScope=checkedMemoryScope(actor,scope);if(!validMemoryId(memoryId))throw Error('Invalid memory ID');await this.permit(checkedScope.actor,checkedScope.scope,'read',memoryId);
  const row=this.row(checkedScope.scope,memoryId);return row?this.record(row,this.now()):undefined;
 }
 async put(actor:MemoryActor,scope:MemoryScope,memoryId:string,value:unknown,options:{expectedRevision:number|null;expiresAt:number;provenance:Provenance}):Promise<AgentMemoryRecord>{
  const c=checkedMemoryScope(actor,scope);if(!validMemoryId(memoryId)||!options||(options.expectedRevision!==null&&(!Number.isSafeInteger(options.expectedRevision)||options.expectedRevision<1))||!Number.isSafeInteger(options.expiresAt)||!options.provenance||Object.keys(options.provenance).length!==2||!['run','human','system'].includes(options.provenance.kind)||!validMemoryId(options.provenance.id))throw Error('Invalid memory write');
  const serialized=safeMemoryJSON(value),provenance=JSON.stringify({kind:options.provenance.kind,id:options.provenance.id}),expected=options.expectedRevision,expires=options.expiresAt;
  await this.permit(c.actor,c.scope,'write',memoryId);const now=this.now();if(expires<=now||expires-now>this.maxTtlMs)throw Error('Invalid memory expiration');
  this.db.exec('BEGIN IMMEDIATE');try{
   const prior=this.row(c.scope,memoryId),live=prior?this.record(prior,now):undefined;if((live?.revision??null)!==expected)throw Error('Memory revision conflict');
   if(!prior){const history=this.db.prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=?').get(...this.args(c.scope));if(Number(history?.n)>=this.maxEntries*10)throw Error('Memory history quota exceeded');}
   if(!live){const count=this.db.prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND deleted=0 AND expires_at>?').get(...this.args(c.scope),now);if(Number(count?.n)>=this.maxEntries)throw Error('Memory quota exceeded');}
   const revision=(prior?Number(prior.revision):0)+1;if(!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid memory revision');
   this.db.prepare('INSERT INTO agent_memories VALUES (?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(tenant_id,agent_id,owner_kind,owner_id,memory_kind,memory_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,provenance=excluded.provenance,expires_at=excluded.expires_at,deleted=0').run(...this.args(c.scope),memoryId,revision,serialized,provenance,expires);
   this.recordAudit(c.actor,c.scope,'write',memoryId,revision,1,now);
   this.db.exec('COMMIT');return {id:memoryId,revision,value:JSON.parse(serialized),provenance:JSON.parse(provenance) as Provenance,expiresAt:expires};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async delete(actor:MemoryActor,scope:MemoryScope,memoryId:string,expectedRevision:number):Promise<void>{
  const c=checkedMemoryScope(actor,scope);if(!validMemoryId(memoryId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid memory delete');await this.permit(c.actor,c.scope,'delete',memoryId);const now=this.now();
  this.db.exec('BEGIN IMMEDIATE');try{const result=this.db.prepare('UPDATE agent_memories SET revision=revision+1,value=NULL,provenance=NULL,expires_at=0,deleted=1 WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND memory_id=? AND revision=? AND deleted=0 AND expires_at>?').run(...this.args(c.scope),memoryId,expectedRevision,now);if(result.changes!==1)throw Error('Memory revision conflict');this.recordAudit(c.actor,c.scope,'delete',memoryId,expectedRevision+1,1,now);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async list(actor:MemoryActor,scope:MemoryScope,options:{after?:string;limit?:number}={}):Promise<{items:AgentMemoryRecord[];nextAfter?:string}>{
  const c=checkedMemoryScope(actor,scope);if(!options||(options.after!==undefined&&!validMemoryId(options.after))||!Number.isSafeInteger(options.limit??100)||(options.limit??100)<1||(options.limit??100)>100)throw Error('Invalid memory listing');const after=options.after??'',limit=options.limit??100;await this.permit(c.actor,c.scope,'list');
  const now=this.now(),rows=this.db.prepare('SELECT memory_id FROM agent_memories WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND memory_id>? AND deleted=0 AND expires_at>? ORDER BY memory_id').all(...this.args(c.scope),after,now);const items:AgentMemoryRecord[]=[];
  for(const row of rows){const memoryId=String(row.memory_id);try{await this.permit(c.actor,c.scope,'read',memoryId);}catch(error){if(error instanceof MemoryAccessDenied)continue;throw error;}const current=this.row(c.scope,memoryId),item=current?this.record(current,this.now()):undefined;if(!item)continue;if(items.length===limit)return {items,nextAfter:items.at(-1)!.id};items.push(item);}
  return {items};
 }
 async purgeExpired(actor:MemoryActor,scope:MemoryScope):Promise<number>{
  const c=checkedMemoryScope(actor,scope);await this.permit(c.actor,c.scope,'purge');const now=this.now();this.db.exec('BEGIN IMMEDIATE');try{const result=this.db.prepare('UPDATE agent_memories SET revision=revision+1,value=NULL,provenance=NULL,expires_at=0,deleted=1 WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND deleted=0 AND expires_at<=? AND revision<?').run(...this.args(c.scope),now,Number.MAX_SAFE_INTEGER),count=Number(result.changes);if(count)this.recordAudit(c.actor,c.scope,'purge',null,null,count,now);this.db.exec('COMMIT');return count;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 /** Tombstone every live or expired memory in one scope (for example when an owner asks for erasure). Needs the separate `erase` permission; returns how many were erased. */
 async eraseScope(actor:MemoryActor,scope:MemoryScope):Promise<number>{
  const c=checkedMemoryScope(actor,scope);await this.permit(c.actor,c.scope,'erase');const now=this.now();this.db.exec('BEGIN IMMEDIATE');
  try{const result=this.db.prepare('UPDATE agent_memories SET revision=revision+1,value=NULL,provenance=NULL,expires_at=0,deleted=1 WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND deleted=0 AND revision<?').run(...this.args(c.scope),Number.MAX_SAFE_INTEGER),count=Number(result.changes);if(count)this.recordAudit(c.actor,c.scope,'erase',null,null,count,now);this.db.exec('COMMIT');return count;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async auditHistory(actor:MemoryActor,scope:MemoryScope,options:{after?:number;limit?:number}={}):Promise<{items:AgentMemoryAuditEvent[];nextAfter?:number}>{
  const c=checkedMemoryScope(actor,scope),after=options?.after??0,limit=options?.limit??50;if(!this.audit||!options||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid memory audit listing');await this.permit(c.actor,c.scope,'audit');
  const rows=this.db.prepare('SELECT id,actor_id,action,memory_id,revision,count,observed_at FROM agent_memory_audit WHERE tenant_id=? AND agent_id=? AND owner_kind=? AND owner_id=? AND memory_kind=? AND id>? ORDER BY id LIMIT ?').all(...this.args(c.scope),after,limit+1),items:AgentMemoryAuditEvent[]=[];
  for(const row of rows.slice(0,limit)){const memoryId=row.memory_id===null?null:String(row.memory_id);try{await this.permit(c.actor,c.scope,'audit',memoryId??undefined);}catch(error){if(error instanceof MemoryAccessDenied)continue;throw error;}items.push({id:Number(row.id),actorId:String(row.actor_id),action:row.action as AgentMemoryAuditEvent['action'],memoryId,revision:row.revision===null?null:Number(row.revision),count:Number(row.count),observedAt:Number(row.observed_at)});}
  return {items,...(rows.length>limit?{nextAfter:Number(rows[limit-1].id)}:{})};
 }
}
export type {MemoryScope as AgentMemoryScope,MemoryActor as AgentMemoryActor,Provenance as AgentMemoryProvenance,MemoryAction as AgentMemoryAction,Options as AgentMemoryOptions};
