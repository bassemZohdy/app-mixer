import {DatabaseSync} from 'node:sqlite';
import {type AgentRunScope} from './durable-runs.js';
import {AgentError} from './errors.js';

type Actor={tenantId:string;principalId:string};
type Kind='approval_requested'|'delegation_renewal_required';
export type AgentNotice={id:number;tenantId:string;agentId:string;runId:string;kind:Kind;subjectId:string;subjectRevision:number;createdAt:number;actionable:boolean;acknowledgedAt:number|null};
type Access='list'|'read'|'acknowledge'|'prune';
type Options={scope:AgentRunScope;authorize:(actor:Actor,action:Access,notice:AgentNotice|null)=>boolean|Promise<boolean>;clock?:()=>number};
const valid=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
export function ensureAgentNoticeSchema(db:DatabaseSync):void{db.exec(`
 CREATE TABLE IF NOT EXISTS agent_notices (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,subject_id TEXT NOT NULL,subject_revision INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(tenant_id,agent_id,run_id,kind,subject_id,subject_revision));
 CREATE TABLE IF NOT EXISTS agent_notice_receipts (notice_id INTEGER NOT NULL,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,principal_id TEXT NOT NULL,acknowledged_at INTEGER NOT NULL,PRIMARY KEY(notice_id,tenant_id,agent_id,principal_id));
 CREATE TRIGGER IF NOT EXISTS agent_notices_no_replace BEFORE INSERT ON agent_notices WHEN NEW.id>0 AND EXISTS(SELECT 1 FROM agent_notices WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Notices are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_notices_no_update BEFORE UPDATE ON agent_notices BEGIN SELECT RAISE(ABORT,'Notices are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_notices_no_delete BEFORE DELETE ON agent_notices BEGIN SELECT RAISE(ABORT,'Notices are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_receipts_no_replace BEFORE INSERT ON agent_notice_receipts WHEN EXISTS(SELECT 1 FROM agent_notice_receipts WHERE notice_id=NEW.notice_id AND tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND principal_id=NEW.principal_id) BEGIN SELECT RAISE(ABORT,'Receipts are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_receipts_no_update BEFORE UPDATE ON agent_notice_receipts BEGIN SELECT RAISE(ABORT,'Receipts are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_receipts_no_delete BEFORE DELETE ON agent_notice_receipts BEGIN SELECT RAISE(ABORT,'Receipts are immutable'); END;
 CREATE TABLE IF NOT EXISTS agent_notice_prunes (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,actor_id TEXT NOT NULL,before_at INTEGER NOT NULL,notices INTEGER NOT NULL,observed_at INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS agent_notice_prunes_no_update BEFORE UPDATE ON agent_notice_prunes BEGIN SELECT RAISE(ABORT,'Prune records are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_notice_prunes_no_delete BEFORE DELETE ON agent_notice_prunes BEGIN SELECT RAISE(ABORT,'Prune records are immutable'); END;`);}
export function insertAgentNotice(db:DatabaseSync,scope:AgentRunScope,runId:string,kind:Kind,subjectId:string,revision:number,now:number):void{db.prepare('INSERT INTO agent_notices (tenant_id,agent_id,run_id,kind,subject_id,subject_revision,created_at) VALUES (?,?,?,?,?,?,?)').run(scope.tenantId,scope.agentId,runId,kind,subjectId,revision,now);}
/** Authorized local inbox; acknowledgements are per principal and do not decide a request. */
export class SqliteAgentNotices {
 private readonly db:DatabaseSync;private readonly scope:AgentRunScope;private readonly authorize:Options['authorize'];private readonly clock:()=>number;
 constructor(path:string,options:Options){if(!options||!options.scope||!valid(options.scope.tenantId)||!valid(options.scope.agentId)||typeof options.authorize!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid notice configuration');this.scope={...options.scope};this.authorize=options.authorize;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL');ensureAgentNoticeSchema(this.db)}catch(error){this.db.close();throw error;}}
 close():void{this.db.close();}
 isBoundTo(scope:AgentRunScope):boolean{return !!scope&&scope.tenantId===this.scope.tenantId&&scope.agentId===this.scope.agentId;}
 private actor(actor:Actor):Actor{if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId))throw Error('Invalid notice actor');return {tenantId:actor.tenantId,principalId:actor.principalId};}
 private now():number{const now=this.clock();if(!integer(now))throw Error('Invalid clock');return now;}
 private async permit(actor:Actor,action:Access,notice:AgentNotice|null):Promise<void>{if(await this.authorize({...actor},action,notice?{...notice}:null)!==true)throw new AgentError('denied','Notice access denied');}
 private row(id:number,actor:Actor):AgentNotice|undefined{const row=this.db.prepare('SELECT n.*,r.acknowledged_at FROM agent_notices n LEFT JOIN agent_notice_receipts r ON r.notice_id=n.id AND r.tenant_id=n.tenant_id AND r.agent_id=n.agent_id AND r.principal_id=? WHERE n.tenant_id=? AND n.agent_id=? AND n.id=?').get(actor.principalId,this.scope.tenantId,this.scope.agentId,id);if(!row)return undefined;const runId=String(row.run_id),kind=String(row.kind) as Kind,subjectId=String(row.subject_id),subjectRevision=Number(row.subject_revision),now=this.now();let actionable=false;
  const run=this.db.prepare('SELECT status,archived,deadline FROM agent_runs WHERE tenant_id=? AND agent_id=? AND run_id=?').get(this.scope.tenantId,this.scope.agentId,runId);if(run&&run.archived!==1&&!['succeeded','failed','cancelled'].includes(String(run.status))&&Number(run.deadline)>now){if(kind==='approval_requested'){const a=this.db.prepare('SELECT status,expires_at FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND run_id=? AND action_id=?').get(this.scope.tenantId,this.scope.agentId,runId,subjectId);actionable=!!a&&a.status==='pending'&&Number(a.expires_at)>now;}else if(kind==='delegation_renewal_required'){const w=this.db.prepare('SELECT grant_id,grant_revision FROM agent_delegation_waits WHERE tenant_id=? AND agent_id=? AND run_id=?').get(this.scope.tenantId,this.scope.agentId,runId);const g=this.db.prepare('SELECT revision,revoked,expires_at FROM agent_delegations WHERE tenant_id=? AND agent_id=? AND run_id=? AND grant_id=?').get(this.scope.tenantId,this.scope.agentId,runId,subjectId);actionable=run.status==='paused'&&!!w&&w.grant_id===subjectId&&Number(w.grant_revision)===subjectRevision&&!!g&&g.revoked!==1&&Number(g.revision)===subjectRevision&&Number(g.expires_at)<=now;}}
  return {id:Number(row.id),...this.scope,runId,kind,subjectId,subjectRevision,createdAt:Number(row.created_at),actionable,acknowledgedAt:row.acknowledged_at===null?null:Number(row.acknowledged_at)};
 }
 async list(actor:Actor,options:{after?:number|undefined;limit?:number|undefined}={}):Promise<{items:AgentNotice[];nextAfter?:number}>{const who=this.actor(actor),after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid notice listing');await this.permit(who,'list',null);const rows=this.db.prepare('SELECT id FROM agent_notices WHERE tenant_id=? AND agent_id=? AND id>? ORDER BY id LIMIT ?').all(this.scope.tenantId,this.scope.agentId,after,limit),items:AgentNotice[]=[];for(const row of rows){const notice=this.row(Number(row.id),who);if(!notice)continue;if(await this.authorize({...who},'read',{...notice})!==true)continue;const current=this.row(notice.id,who);if(current&&JSON.stringify(current)===JSON.stringify(notice))items.push(current);}return {items,...(rows.length===limit?{nextAfter:Number(rows.at(-1)!.id)}:{})};}
 /**
  * Retention: delete up to `limit` (1 to 1,000) notices created before `before`, with their receipts and delivery history, oldest first, and return how many notices went.
  * A notice with a delivery that is not yet delivered (pending, sending or uncertain) is kept. Notices, receipts and delivery events are immutable by trigger; the
  * delete triggers are dropped and recreated inside the same transaction, so no other connection sees the gap, and every prune leaves an immutable record (who, horizon, count).
  * Needs the `prune` permission; choose a horizon beyond the time a notice can still be actionable.
  */
 async prune(actor:Actor,options:{before:number;limit:number}):Promise<number>{
  const who=this.actor(actor);if(!options||typeof options!=='object'||!integer(options.before)||options.before>this.now()||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>1000)throw Error('Invalid notice retention');
  await this.permit(who,'prune',null);
  const has=(name:string)=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const deliveries=has('agent_notice_deliveries'),events=has('agent_notice_delivery_events');
   const ids=this.db.prepare(`SELECT id FROM agent_notices WHERE tenant_id=? AND agent_id=? AND created_at<?${deliveries?" AND NOT EXISTS (SELECT 1 FROM agent_notice_deliveries d WHERE d.notice_id=agent_notices.id AND d.tenant_id=agent_notices.tenant_id AND d.agent_id=agent_notices.agent_id AND d.status<>'delivered')":''} ORDER BY id LIMIT ?`).all(this.scope.tenantId,this.scope.agentId,options.before,options.limit).map(row=>Number(row.id));
   if(ids.length){
    const tables=['agent_notices','agent_notice_receipts',...(deliveries?['agent_notice_deliveries']:[]),...(events?['agent_notice_delivery_events']:[])];
    const triggers=(this.db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${tables.map(()=>'?').join(',')})`).all(...tables) as {name:string;sql:string}[]).filter(trigger=>/_no_delete$/.test(trigger.name));
    for(const trigger of triggers)this.db.exec(`DROP TRIGGER "${trigger.name}"`);
    const marks=ids.map(()=>'?').join(','),scope=[this.scope.tenantId,this.scope.agentId];
    if(events&&deliveries)this.db.prepare(`DELETE FROM agent_notice_delivery_events WHERE tenant_id=? AND agent_id=? AND delivery_id IN (SELECT id FROM agent_notice_deliveries WHERE tenant_id=? AND agent_id=? AND notice_id IN (${marks}))`).run(...scope,...scope,...ids);
    if(deliveries)this.db.prepare(`DELETE FROM agent_notice_deliveries WHERE tenant_id=? AND agent_id=? AND notice_id IN (${marks})`).run(...scope,...ids);
    this.db.prepare(`DELETE FROM agent_notice_receipts WHERE tenant_id=? AND agent_id=? AND notice_id IN (${marks})`).run(...scope,...ids);
    this.db.prepare(`DELETE FROM agent_notices WHERE tenant_id=? AND agent_id=? AND id IN (${marks})`).run(...scope,...ids);
    for(const trigger of triggers)this.db.exec(trigger.sql);
    this.db.prepare('INSERT INTO agent_notice_prunes (tenant_id,agent_id,actor_id,before_at,notices,observed_at) VALUES (?,?,?,?,?,?)').run(this.scope.tenantId,this.scope.agentId,who.principalId,options.before,ids.length,this.now());
   }
   this.db.exec('COMMIT');return ids.length;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async acknowledge(actor:Actor,id:number):Promise<AgentNotice>{const who=this.actor(actor);if(!integer(id)||id<1)throw Error('Invalid notice');const before=this.row(id,who);await this.permit(who,'read',before??null);await this.permit(who,'acknowledge',before??null);if(!before)throw new AgentError('not_found','Notice not found');this.db.exec('BEGIN IMMEDIATE');try{const current=this.row(id,who);if(!current)throw new AgentError('not_found','Notice not found');if(JSON.stringify(current)!==JSON.stringify(before))throw new AgentError('conflict','Notice changed');if(current.acknowledgedAt===null)this.db.prepare('INSERT INTO agent_notice_receipts VALUES (?,?,?,?,?)').run(id,this.scope.tenantId,this.scope.agentId,who.principalId,this.now());const result=this.row(id,who)!;this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
export type {Actor as AgentNoticeActor,Access as AgentNoticeAccess,Options as AgentNoticeOptions};
