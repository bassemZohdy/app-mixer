import {DatabaseSync} from 'node:sqlite';
import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import type {AgentNoticeMessage} from './agent-notice-delivery.js';
import type {AgentRunScope} from './durable-runs.js';

type Actor={tenantId:string;principalId:string};
type Access='receive'|'list'|'read'|'acknowledge';
export type ReceivedAgentNotice={id:number;senderId:string;message:AgentNoticeMessage;receivedAt:number;acknowledgedAt:number|null;acknowledgedBy:string|null};
type Options={scope:AgentRunScope;maxPending:number;authorize:(actor:Actor,action:Access,notice:ReceivedAgentNotice|null)=>boolean|Promise<boolean>;clock?:()=>number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const key=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function message(value:unknown,scope:AgentRunScope):AgentNoticeMessage{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid notice message');const m=value as Record<string,unknown>;
 if(Object.keys(m).length!==8||!['version','noticeId','tenantId','agentId','runId','kind','subjectId','subjectRevision'].every(k=>Object.hasOwn(m,k))||m.version!==1||!integer(m.noticeId)||m.noticeId<1||m.tenantId!==scope.tenantId||m.agentId!==scope.agentId||!id(m.runId)||!['approval_requested','delegation_renewal_required'].includes(String(m.kind))||!id(m.subjectId)||!integer(m.subjectRevision))throw Error('Invalid notice message');
 return {noticeId:m.noticeId,tenantId:scope.tenantId,agentId:scope.agentId,runId:m.runId,kind:m.kind as AgentNoticeMessage['kind'],subjectId:m.subjectId,subjectRevision:m.subjectRevision};
}

/** A scoped durable inbox with atomic deduplication and explicit acknowledgement. */
export class SqliteAgentNoticeReceiver {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly maxPending:number;private readonly authorize:Options['authorize'];private readonly clock:()=>number;
 constructor(path:string,options:Options){
  if(!options||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||!integer(options.maxPending)||options.maxPending<1||options.maxPending>10000||typeof options.authorize!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid notice receiver configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.maxPending=options.maxPending;this.authorize=options.authorize;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS received_agent_notices (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,delivery_key TEXT NOT NULL,sender_id TEXT NOT NULL,message TEXT NOT NULL,received_at INTEGER NOT NULL,UNIQUE(tenant_id,agent_id,delivery_key));
   CREATE INDEX IF NOT EXISTS received_agent_notices_scope ON received_agent_notices(tenant_id,agent_id,id);
   CREATE TABLE IF NOT EXISTS received_agent_notice_acks (notice_id INTEGER PRIMARY KEY,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,principal_id TEXT NOT NULL,acknowledged_at INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS received_agent_notices_no_update BEFORE UPDATE ON received_agent_notices BEGIN SELECT RAISE(ABORT,'Received notices are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS received_agent_notices_no_delete BEFORE DELETE ON received_agent_notices BEGIN SELECT RAISE(ABORT,'Received notices are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS received_agent_notices_no_replace BEFORE INSERT ON received_agent_notices WHEN (NEW.id>0 AND EXISTS(SELECT 1 FROM received_agent_notices WHERE id=NEW.id)) OR EXISTS(SELECT 1 FROM received_agent_notices WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND delivery_key=NEW.delivery_key) BEGIN SELECT RAISE(ABORT,'Received notices are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS received_agent_notice_acks_no_update BEFORE UPDATE ON received_agent_notice_acks BEGIN SELECT RAISE(ABORT,'Notice acknowledgements are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS received_agent_notice_acks_no_delete BEFORE DELETE ON received_agent_notice_acks BEGIN SELECT RAISE(ABORT,'Notice acknowledgements are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS received_agent_notice_acks_no_replace BEFORE INSERT ON received_agent_notice_acks WHEN EXISTS(SELECT 1 FROM received_agent_notice_acks WHERE notice_id=NEW.notice_id) BEGIN SELECT RAISE(ABORT,'Notice acknowledgements are immutable'); END;`);}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private actor(value:Actor):Actor{if(!value||value.tenantId!==this.scope.tenantId||!id(value.principalId))throw Error('Invalid notice receiver actor');return {tenantId:value.tenantId,principalId:value.principalId};}
 private now():number{const now=this.clock();if(!integer(now))throw Error('Invalid clock');return now;}
 private row(noticeId:number):ReceivedAgentNotice|undefined{const row=this.db.prepare('SELECT n.*,a.principal_id AS acknowledged_by,a.acknowledged_at FROM received_agent_notices n LEFT JOIN received_agent_notice_acks a ON a.notice_id=n.id AND a.tenant_id=n.tenant_id AND a.agent_id=n.agent_id WHERE n.tenant_id=? AND n.agent_id=? AND n.id=?').get(this.scope.tenantId,this.scope.agentId,noticeId);if(!row)return;return {id:Number(row.id),senderId:String(row.sender_id),message:JSON.parse(String(row.message)) as AgentNoticeMessage,receivedAt:Number(row.received_at),acknowledgedAt:row.acknowledged_at===null?null:Number(row.acknowledged_at),acknowledgedBy:row.acknowledged_by===null?null:String(row.acknowledged_by)};}
 private async permit(actor:Actor,action:Access,notice:ReceivedAgentNotice|null):Promise<void>{if(await this.authorize({...actor},action,notice?structuredClone(notice):null)!==true)throw Error('Notice receiver access denied');}
 private transaction<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 async receive(actor:Actor,deliveryKey:string,payload:unknown):Promise<{id:number;duplicate:boolean}>{
  const who=this.actor(actor);if(!key(deliveryKey))throw Error('Invalid notice delivery key');const safe=message(payload,this.scope),canonical=JSON.stringify(safe),normalized=deliveryKey.toLowerCase(),candidate:ReceivedAgentNotice={id:0,senderId:who.principalId,message:safe,receivedAt:0,acknowledgedAt:null,acknowledgedBy:null};await this.permit(who,'receive',candidate);
  return this.transaction(()=>{const existing=this.db.prepare('SELECT id,sender_id,message FROM received_agent_notices WHERE tenant_id=? AND agent_id=? AND delivery_key=?').get(this.scope.tenantId,this.scope.agentId,normalized);if(existing){if(existing.sender_id!==who.principalId||existing.message!==canonical)throw Error('Notice delivery conflict');return {id:Number(existing.id),duplicate:true};}const count=this.db.prepare('SELECT COUNT(*) AS n FROM received_agent_notices n WHERE n.tenant_id=? AND n.agent_id=? AND NOT EXISTS (SELECT 1 FROM received_agent_notice_acks a WHERE a.notice_id=n.id)').get(this.scope.tenantId,this.scope.agentId);if(Number(count?.n)>=this.maxPending)throw Error('Notice receiver backlog full');const result=this.db.prepare('INSERT INTO received_agent_notices (tenant_id,agent_id,delivery_key,sender_id,message,received_at) VALUES (?,?,?,?,?,?)').run(this.scope.tenantId,this.scope.agentId,normalized,who.principalId,canonical,this.now());return {id:Number(result.lastInsertRowid),duplicate:false};});
 }
 async list(actor:Actor,options:{after?:number;limit?:number}={}):Promise<{items:ReceivedAgentNotice[];nextAfter?:number}>{
  const who=this.actor(actor),after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid notice receiver listing');await this.permit(who,'list',null);const rows=this.db.prepare('SELECT id FROM received_agent_notices WHERE tenant_id=? AND agent_id=? AND id>? ORDER BY id LIMIT ?').all(this.scope.tenantId,this.scope.agentId,after,limit),items:ReceivedAgentNotice[]=[];for(const row of rows){const before=this.row(Number(row.id));if(!before)continue;if(await this.authorize({...who},'read',structuredClone(before))!==true)continue;const current=this.row(before.id);if(current&&JSON.stringify(current)===JSON.stringify(before))items.push(current);}return {items,...(rows.length===limit?{nextAfter:Number(rows.at(-1)!.id)}:{})};
 }
 async acknowledge(actor:Actor,noticeId:number):Promise<ReceivedAgentNotice>{const who=this.actor(actor);if(!integer(noticeId)||noticeId<1)throw Error('Invalid received notice');const before=this.row(noticeId);await this.permit(who,'read',before??null);await this.permit(who,'acknowledge',before??null);if(!before)throw Error('Received notice not found');return this.transaction(()=>{const current=this.row(noticeId);if(!current||JSON.stringify(current)!==JSON.stringify(before))throw Error('Received notice changed');if(current.acknowledgedAt===null)this.db.prepare('INSERT INTO received_agent_notice_acks VALUES (?,?,?,?,?)').run(noticeId,this.scope.tenantId,this.scope.agentId,who.principalId,this.now());return this.row(noticeId)!;});}
}

type ServerOptions={receiver:SqliteAgentNoticeReceiver;authenticate:(request:IncomingMessage)=>Actor|undefined|Promise<Actor|undefined>};
const reply=(res:ServerResponse,status:number)=>{res.writeHead(status,{'cache-control':'no-store','x-content-type-options':'nosniff'});res.end();};
/** Host supplies TLS, authentication, authorization, network limits and lifecycle. */
export function createAgentNoticeReceiverServer(options:ServerOptions):Server{
 if(!options||!(options.receiver instanceof SqliteAgentNoticeReceiver)||typeof options.authenticate!=='function')throw Error('Invalid notice receiver server');const {receiver,authenticate}=options;
 return createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/notice'){reply(res,404);return;}let actor:Actor|undefined;try{actor=await authenticate(req);}catch{}if(!actor){reply(res,401);return;}
  let contentType:string|undefined,deliveryKey:string|undefined;for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i].toLowerCase();if(name==='content-type'){if(contentType!==undefined){reply(res,400);return;}contentType=req.rawHeaders[i+1];}if(name==='idempotency-key'){if(deliveryKey!==undefined){reply(res,400);return;}deliveryKey=req.rawHeaders[i+1];}}
  if(!contentType||!/^application\/json(?:\s*;|$)/i.test(contentType)||!key(deliveryKey)){reply(res,400);return;}
  let payload:unknown;try{const parts:Buffer[]=[];let size=0;for await(const chunk of req){const part=Buffer.from(chunk);size+=part.length;if(size>8192)throw Error('large');parts.push(part);}payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{reply(res,400);return;}
  try{await receiver.receive(actor,deliveryKey,payload);reply(res,204);}catch(error){const text=error instanceof Error?error.message:'';reply(res,text==='Notice receiver access denied'||text==='Invalid notice receiver actor'?403:text==='Notice delivery conflict'?409:text==='Notice receiver backlog full'?503:text==='Invalid notice message'||text==='Invalid notice delivery key'?400:500);}
 });
}
export type {Options as AgentNoticeReceiverOptions,Actor as AgentNoticeReceiverActor,Access as AgentNoticeReceiverAccess,ServerOptions as AgentNoticeReceiverServerOptions};
