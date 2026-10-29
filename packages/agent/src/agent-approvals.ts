import {ensureAgentNoticeSchema,insertAgentNotice} from './agent-notices.js';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {actionJSON} from './action-journal.js';
import {type AgentRunScope} from './durable-runs.js';

type Actor={tenantId:string;principalId:string};
type ApprovalStatus='pending'|'approved'|'rejected'|'cancelled'|'expired';
export type AgentApproval={actionId:string;operationId:string;input:unknown;inputHash:string;definitionVersion:number;status:ApprovalStatus;expiresAt:number;requestedBy:string;authority:string|null;decidedBy:string|null;decidedAt:number|null};
type ApprovalAccess='request'|'read'|'list'|'decide'|'cancel'|'expire'|'history';
type Options={scope:AgentRunScope;runId:string;authorize:(actor:Actor,action:ApprovalAccess,approval:{tenantId:string;agentId:string;runId:string;actionId:string;operationId:string})=>boolean|Promise<boolean>;clock?:()=>number};
const valid=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
/** Host-authenticated decision records; request creation requires the active run lease. */
export class SqliteAgentApprovals {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly runId:string;private readonly authorize:Options['authorize'];private readonly clock:()=>number;
 constructor(path:string,options:Options){
  if(!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||!valid(options.runId)||typeof options.authorize!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid approval configuration');
  this.scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};this.runId=options.runId;this.authorize=options.authorize;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS agent_approvals (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,operation_id TEXT NOT NULL,input_json TEXT NOT NULL,input_hash TEXT NOT NULL,definition_version INTEGER NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,requested_by TEXT NOT NULL,decided_by TEXT,decided_at INTEGER,PRIMARY KEY(tenant_id,agent_id,run_id,action_id));
   CREATE TABLE IF NOT EXISTS agent_approval_authority (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,authority TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id,action_id));
   CREATE TABLE IF NOT EXISTS agent_approval_events (event_id INTEGER PRIMARY KEY,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,action_id TEXT NOT NULL,event TEXT NOT NULL,actor_id TEXT NOT NULL,event_at INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS approval_events_no_replace BEFORE INSERT ON agent_approval_events WHEN NEW.event_id>0 AND EXISTS(SELECT 1 FROM agent_approval_events WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'Approval events are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS approval_events_no_update BEFORE UPDATE ON agent_approval_events BEGIN SELECT RAISE(ABORT,'Approval events are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS approval_events_no_delete BEFORE DELETE ON agent_approval_events BEGIN SELECT RAISE(ABORT,'Approval events are immutable'); END;`);
  ensureAgentNoticeSchema(this.db);
  }catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 isBoundTo(scope:AgentRunScope,runId:string):boolean{return !!scope&&this.scope.tenantId===scope.tenantId&&this.scope.agentId===scope.agentId&&this.runId===runId;}
 private args():[string,string,string]{return [this.scope.tenantId,this.scope.agentId,this.runId];}
 private now():number{const n=this.clock();if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid clock');return n;}
 private actor(value:Actor):Actor{if(!value||value.tenantId!==this.scope.tenantId||!valid(value.principalId))throw Error('Invalid approval actor');return {tenantId:value.tenantId,principalId:value.principalId};}
 private async permit(actor:Actor,action:ApprovalAccess,actionId:string,operationId:string):Promise<void>{if(await this.authorize({...actor},action,{...this.scope,runId:this.runId,actionId,operationId})!==true)throw Error('Approval access denied');}
 private row(actionId:string):Record<string,unknown>|undefined{return this.db.prepare('SELECT * FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);}
 private convert(row:Record<string,unknown>,now:number):AgentApproval{const status=(row.status==='pending'||row.status==='approved')&&Number(row.expires_at)<=now?'expired':row.status as ApprovalStatus;return {actionId:String(row.action_id),operationId:String(row.operation_id),input:JSON.parse(String(row.input_json)),inputHash:String(row.input_hash),definitionVersion:Number(row.definition_version),status,expiresAt:Number(row.expires_at),requestedBy:String(row.requested_by),authority:(this.db.prepare('SELECT authority FROM agent_approval_authority WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),String(row.action_id))?.authority as string|undefined)??null,decidedBy:row.decided_by===null?null:String(row.decided_by),decidedAt:row.decided_at===null?null:Number(row.decided_at)};}
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private event(actionId:string,event:string,actor:string,now:number):void{this.db.prepare('INSERT INTO agent_approval_events (tenant_id,agent_id,run_id,action_id,event,actor_id,event_at) VALUES (?,?,?,?,?,?,?)').run(...this.args(),actionId,event,actor,now);}
 async request(actor:Actor,leaseToken:string,actionId:string,operationId:string,input:unknown,expiresAt:number,authority?:string):Promise<AgentApproval>{
  const requester=this.actor(actor);if(!valid(leaseToken)||!valid(actionId)||!valid(operationId)||!Number.isSafeInteger(expiresAt)||(authority!==undefined&&(typeof authority!=='string'||authority.length<1||authority.length>1024)))throw Error('Invalid approval request');const payload=actionJSON(input),hash=createHash('sha256').update(payload).digest('hex');await this.permit(requester,'request',actionId,operationId);
  return this.transaction(()=>{const now=this.now(),run=this.db.prepare('SELECT status,lease_token,lease_until,deadline,definition_version FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(!run||run.status!=='running'||run.lease_token!==leaseToken||typeof run.lease_until!=='number'||now>=run.lease_until)throw Error('Approval lease unavailable');
   const previous=this.row(actionId);if(previous){const bound=this.db.prepare('SELECT authority FROM agent_approval_authority WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(...this.args(),actionId);if((bound?.authority??undefined)!==authority)throw Error('Approval authority conflict');if(previous.operation_id!==operationId||previous.input_hash!==hash||previous.input_json!==payload||Number(previous.definition_version)!==Number(run.definition_version))throw Error('Approval identity conflict');return this.convert(previous,now);}
   const count=this.db.prepare('SELECT COUNT(*) AS n FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(Number(count?.n)>=1000)throw Error('Approval quota exceeded');
   if(expiresAt<=now||expiresAt>Number(run.deadline)||expiresAt-now>86400000)throw Error('Invalid approval expiration');
   this.db.prepare("INSERT INTO agent_approvals VALUES (?,?,?,?,?,?,?,?,'pending',?,?,NULL,NULL)").run(...this.args(),actionId,operationId,payload,hash,Number(run.definition_version),expiresAt,requester.principalId);if(authority!==undefined)this.db.prepare('INSERT INTO agent_approval_authority VALUES (?,?,?,?,?)').run(...this.args(),actionId,authority);this.event(actionId,'requested',requester.principalId,now);insertAgentNotice(this.db,this.scope,this.runId,'approval_requested',actionId,0,now);return this.convert(this.row(actionId)!,now);
  });
 }
 async get(actor:Actor,actionId:string):Promise<AgentApproval|undefined>{const who=this.actor(actor);if(!valid(actionId))throw Error('Invalid approval');const row=this.row(actionId);await this.permit(who,'read',actionId,row?String(row.operation_id):'unknown');const current=this.row(actionId);return current?this.convert(current,this.now()):undefined;}
 async list(actor:Actor,options:{after?:string;limit?:number}={}):Promise<{items:AgentApproval[];nextAfter?:string}>{
  const who=this.actor(actor);if(!options||(options.after!==undefined&&!valid(options.after))||!Number.isSafeInteger(options.limit??100)||(options.limit??100)<1||(options.limit??100)>100)throw Error('Invalid approval listing');await this.permit(who,'list','all','all');const rows=this.db.prepare('SELECT action_id,operation_id FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id>? ORDER BY action_id').all(...this.args(),options.after??''),items:AgentApproval[]=[];const limit=options.limit??100;
  for(const row of rows){const actionId=String(row.action_id),operationId=String(row.operation_id);if(await this.authorize({...who},'read',{...this.scope,runId:this.runId,actionId,operationId})!==true)continue;const current=this.row(actionId);if(!current)continue;if(items.length===limit)return {items,nextAfter:items.at(-1)!.actionId};items.push(this.convert(current,this.now()));}return {items};
 }
 async decide(actor:Actor,actionId:string,decision:'approved'|'rejected'|'cancelled'):Promise<AgentApproval>{
  const who=this.actor(actor);if(!valid(actionId)||!['approved','rejected','cancelled'].includes(decision))throw Error('Invalid approval decision');const existing=this.row(actionId);await this.permit(who,decision==='cancelled'?'cancel':'decide',actionId,existing?String(existing.operation_id):'unknown');
  return this.transaction(()=>{const now=this.now(),row=this.row(actionId),run=this.db.prepare('SELECT status,archived FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(...this.args());if(!row)throw Error('Approval not found');if(!run||run.archived===1||['succeeded','failed','cancelled'].includes(String(run.status)))throw Error('Run is terminal');if(row.status!=='pending'&&!(decision==='cancelled'&&row.status==='approved'))throw Error('Approval already decided');if(now>=Number(row.expires_at))throw Error('Approval expired');
   this.db.prepare('UPDATE agent_approvals SET status=?,decided_by=?,decided_at=? WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').run(decision,who.principalId,now,...this.args(),actionId);this.event(actionId,decision,who.principalId,now);return this.convert(this.row(actionId)!,now);
  });
 }
 async expire(actor:Actor,actionId:string):Promise<AgentApproval>{
  const who=this.actor(actor);if(!valid(actionId))throw Error('Invalid approval');const existing=this.row(actionId);await this.permit(who,'expire',actionId,existing?String(existing.operation_id):'unknown');
  return this.transaction(()=>{const now=this.now(),row=this.row(actionId);if(!row)throw Error('Approval not found');if(!['pending','approved'].includes(String(row.status))||now<Number(row.expires_at))throw Error('Approval not expired');this.db.prepare("UPDATE agent_approvals SET status='expired',decided_by=?,decided_at=? WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?").run(who.principalId,now,...this.args(),actionId);this.event(actionId,'expired',who.principalId,now);return this.convert(this.row(actionId)!,now);});
 }
 async history(actor:Actor,actionId:string):Promise<{event:string;actorId:string;at:number}[]>{const who=this.actor(actor);if(!valid(actionId))throw Error('Invalid approval');const existing=this.row(actionId);await this.permit(who,'history',actionId,existing?String(existing.operation_id):'unknown');return this.db.prepare('SELECT event,actor_id,event_at FROM agent_approval_events WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=? ORDER BY event_id').all(...this.args(),actionId).map(row=>({event:String(row.event),actorId:String(row.actor_id),at:Number(row.event_at)}));}
}
export type {Actor as AgentApprovalActor,ApprovalStatus as AgentApprovalStatus,ApprovalAccess as AgentApprovalAccess,Options as AgentApprovalsOptions};
