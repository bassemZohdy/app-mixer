import {RemoteControlImportCancelledError} from './remote-control-connector.js';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {createRemoteControlConnector} from './remote-control-connector.js';

type Actor={tenantId:string;principalId:string};
export type RemoteRolloutScope={tenantId:string;applicationId:string;sourceEnvironment:string;targetEnvironment:string};
export type RemoteRolloutRecoveryEvidence={principalId:string;reference:string;observedAt:number};
export type RemoteRolloutRecoveryEvent=RemoteRolloutRecoveryEvidence&{id:number;phase:'running'|'importing'|'uncertain';sourceVersion:number|null;expectedVersion:number|null};
type Connector=ReturnType<typeof createRemoteControlConnector>;
type State={phase:'idle'|'running'|'importing'|'uncertain';sourceVersion:number|null;expectedVersion:number|null;token:string|null};
const validText=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);

/** Host-scheduled, single-flight rollout with a durable uncertainty gate. */
export class SqliteRemoteRollout {
 private readonly db:DatabaseSync;private readonly key:string;private readonly actor:Actor;private readonly connector:Connector;private active=false;
 constructor(path:string,connector:Connector,actor:Actor){
  if(!validText(path)||!connector?.rolloutConfig?.safe||!connector.rolloutRepository||typeof connector.rolloutRepository.getPublished!=='function'||typeof (connector.rolloutRepository as {getPromotionFloor?:unknown}).getPromotionFloor!=='function'||!actor||!validText(actor.tenantId)||!validText(actor.principalId))throw Error('Invalid remote rollout configuration');
  this.connector=connector;this.actor={tenantId:actor.tenantId,principalId:actor.principalId};const c=connector.rolloutConfig;this.key=JSON.stringify([this.actor.tenantId,c.applicationId,c.sourceEnvironment,c.targetEnvironment]);this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS remote_rollouts (id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('idle','running','importing','uncertain')), token TEXT, source_version INTEGER, expected_version INTEGER);
   CREATE TABLE IF NOT EXISTS remote_rollout_recovery_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT,rollout_id TEXT NOT NULL,principal_id TEXT NOT NULL,reference TEXT NOT NULL,phase TEXT NOT NULL,source_version INTEGER,expected_version INTEGER,observed_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS remote_rollout_recovery_scope ON remote_rollout_recovery_events(rollout_id,event_id);
   CREATE TRIGGER IF NOT EXISTS remote_rollout_recovery_no_update BEFORE UPDATE ON remote_rollout_recovery_events BEGIN SELECT RAISE(ABORT,'Recovery evidence is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS remote_rollout_recovery_no_delete BEFORE DELETE ON remote_rollout_recovery_events BEGIN SELECT RAISE(ABORT,'Recovery evidence is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS remote_rollout_recovery_no_replace BEFORE INSERT ON remote_rollout_recovery_events WHEN NEW.event_id>0 AND EXISTS(SELECT 1 FROM remote_rollout_recovery_events WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'Recovery evidence is immutable'); END;`);this.db.prepare("INSERT OR IGNORE INTO remote_rollouts(id,phase) VALUES (?,'idle')").run(this.key);}catch(error){this.db.close();throw error;}
 }
 isBoundTo(scope:RemoteRolloutScope):boolean{return !!scope&&JSON.stringify([scope.tenantId,scope.applicationId,scope.sourceEnvironment,scope.targetEnvironment])===this.key;}
 getState():State{const row=this.db.prepare('SELECT phase,token,source_version,expected_version FROM remote_rollouts WHERE id=?').get(this.key);if(!row||!['idle','running','importing','uncertain'].includes(String(row.phase)))throw Error('Invalid rollout state');return {phase:row.phase as State['phase'],token:row.token===null?null:String(row.token),sourceVersion:row.source_version===null?null:Number(row.source_version),expectedVersion:row.expected_version===null?null:Number(row.expected_version)};}
 async runOnce(signal?:AbortSignal):Promise<{status:'unchanged'|'imported';sourceVersion:number;targetVersion:number}>{
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw Error('Invalid rollout signal');const check=()=>{if(signal?.aborted)throw Error('Remote rollout cancelled');};check();
  const token=randomUUID(),claim=this.db.prepare("UPDATE remote_rollouts SET phase='running',token=?,source_version=NULL,expected_version=NULL WHERE id=? AND phase='idle'").run(token,this.key);if(Number(claim.changes)!==1)throw Error('Remote rollout requires recovery');this.active=true;let importing=false;
  try{check();
   const result=await this.connector.discoverLatest({...this.actor},signal),c=this.connector.rolloutConfig,repo=this.connector.rolloutRepository;check();
   const floor=await repo.getPromotionFloor!(c.sourceEnvironment,c.targetEnvironment);check();const target=(await repo.getPublished!())?.version??0;check();
   if(!Number.isSafeInteger(floor)||floor<0||!Number.isSafeInteger(target)||target<0||target>=Number.MAX_SAFE_INTEGER)throw Error('Invalid local rollout state');
   if(result.sourceVersion<floor)throw Error('Remote source version is behind local history');
   if(result.sourceVersion===floor){this.release(token);return {status:'unchanged',sourceVersion:floor,targetVersion:target};}
   const marked=this.db.prepare("UPDATE remote_rollouts SET phase='importing',source_version=?,expected_version=? WHERE id=? AND phase='running' AND token=?").run(result.sourceVersion,target,this.key,token);if(Number(marked.changes)!==1)throw Error('Remote rollout state changed');check();importing=true;
   const publication=await this.connector.importPublication({actor:{...this.actor},sourceVersion:result.sourceVersion,expectedVersion:target},signal);this.release(token);return {status:'imported',sourceVersion:result.sourceVersion,targetVersion:publication.version};
  }catch(error){if(importing&&!(signal?.aborted&&error instanceof RemoteControlImportCancelledError))this.db.prepare("UPDATE remote_rollouts SET phase='uncertain' WHERE id=? AND phase='importing' AND token=?").run(this.key,token);else this.release(token);throw error;}finally{this.active=false;}
 }
 private release(token:string):void{const result=this.db.prepare("UPDATE remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=? AND token=? AND phase IN ('running','importing')").run(this.key,token);if(Number(result.changes)!==1)throw Error('Remote rollout state changed');}
 async recover(authorize:(state:State)=>boolean|Promise<boolean>,evidence?:RemoteRolloutRecoveryEvidence):Promise<void>{
  if(evidence!==undefined&&(!evidence||!validText(evidence.principalId)||!validText(evidence.reference)||!Number.isSafeInteger(evidence.observedAt)||evidence.observedAt<0))throw Error('Invalid rollout recovery evidence');const recorded=evidence?{principalId:evidence.principalId,reference:evidence.reference,observedAt:evidence.observedAt}:undefined;
  if(this.active||typeof authorize!=='function')throw Error('Invalid remote rollout recovery');const state=this.getState();if(state.phase==='idle'||!state.token)throw Error('No rollout requires recovery');let permitted=false;try{permitted=await authorize({...state})===true;}catch{}if(!permitted)throw Error('Remote rollout recovery denied');
  if(!recorded){const result=this.db.prepare("UPDATE remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=? AND phase=? AND token=?").run(this.key,state.phase,state.token);if(Number(result.changes)!==1)throw Error('Remote rollout state changed');return;}
  this.db.exec('BEGIN IMMEDIATE');try{const result=this.db.prepare("UPDATE remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=? AND phase=? AND token=?").run(this.key,state.phase,state.token);if(Number(result.changes)!==1)throw Error('Remote rollout state changed');this.db.prepare('INSERT INTO remote_rollout_recovery_events(rollout_id,principal_id,reference,phase,source_version,expected_version,observed_at) VALUES (?,?,?,?,?,?,?)').run(this.key,recorded.principalId,recorded.reference,state.phase,state.sourceVersion,state.expectedVersion,recorded.observedAt);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 listRecoveryEvidence(options:{after?:number;limit?:number}={}):{items:RemoteRolloutRecoveryEvent[];nextAfter?:number}{const after=options?.after??0,limit=options?.limit??50;if(!options||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid rollout recovery listing');const rows=this.db.prepare('SELECT event_id,principal_id,reference,phase,source_version,expected_version,observed_at FROM remote_rollout_recovery_events WHERE rollout_id=? AND event_id>? ORDER BY event_id LIMIT ?').all(this.key,after,limit+1),items=rows.slice(0,limit).map(row=>{const id=Number(row.event_id),observedAt=Number(row.observed_at),sourceVersion=row.source_version===null?null:Number(row.source_version),expectedVersion=row.expected_version===null?null:Number(row.expected_version),phase=row.phase,version=(value:unknown,min:number)=>Number.isSafeInteger(value)&&Number(value)>=min;if(!version(id,1)||!version(observedAt,0)||!validText(row.principal_id)||!validText(row.reference)||!['running','importing','uncertain'].includes(String(phase))||(phase==='running'?(sourceVersion!==null||expectedVersion!==null):(!version(sourceVersion,1)||!version(expectedVersion,0))))throw Error('Invalid rollout recovery listing');return {id,principalId:row.principal_id,reference:row.reference,phase:phase as RemoteRolloutRecoveryEvent['phase'],sourceVersion,expectedVersion,observedAt};});return {items,...(rows.length>limit?{nextAfter:items.at(-1)!.id}:{})};
 }
 close():void{if(this.active)throw Error('Remote rollout is active');this.db.close();}
}
