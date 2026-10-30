import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {createRemoteControlConnector} from './remote-control-connector.js';

type Actor={tenantId:string;principalId:string};
type Connector=ReturnType<typeof createRemoteControlConnector>;
type State={phase:'idle'|'running'|'importing'|'uncertain';sourceVersion:number|null;expectedVersion:number|null;token:string|null};
const validText=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);

/** Host-scheduled, single-flight rollout with a durable uncertainty gate. */
export class SqliteRemoteRollout {
 private readonly db:DatabaseSync;private readonly key:string;private readonly actor:Actor;private readonly connector:Connector;private active=false;
 constructor(path:string,connector:Connector,actor:Actor){
  if(!validText(path)||!connector?.rolloutConfig?.safe||!connector.rolloutRepository||typeof connector.rolloutRepository.getPublished!=='function'||typeof (connector.rolloutRepository as {getPromotionFloor?:unknown}).getPromotionFloor!=='function'||!actor||!validText(actor.tenantId)||!validText(actor.principalId))throw Error('Invalid remote rollout configuration');
  this.connector=connector;this.actor={tenantId:actor.tenantId,principalId:actor.principalId};const c=connector.rolloutConfig;this.key=JSON.stringify([this.actor.tenantId,c.applicationId,c.sourceEnvironment,c.targetEnvironment]);this.db=new DatabaseSync(path);
  try{this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS remote_rollouts (id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('idle','running','importing','uncertain')), token TEXT, source_version INTEGER, expected_version INTEGER)");this.db.prepare("INSERT OR IGNORE INTO remote_rollouts(id,phase) VALUES (?,'idle')").run(this.key);}catch(error){this.db.close();throw error;}
 }
 getState():State{const row=this.db.prepare('SELECT phase,token,source_version,expected_version FROM remote_rollouts WHERE id=?').get(this.key);if(!row||!['idle','running','importing','uncertain'].includes(String(row.phase)))throw Error('Invalid rollout state');return {phase:row.phase as State['phase'],token:row.token===null?null:String(row.token),sourceVersion:row.source_version===null?null:Number(row.source_version),expectedVersion:row.expected_version===null?null:Number(row.expected_version)};}
 async runOnce():Promise<{status:'unchanged'|'imported';sourceVersion:number;targetVersion:number}>{
  const token=randomUUID(),claim=this.db.prepare("UPDATE remote_rollouts SET phase='running',token=?,source_version=NULL,expected_version=NULL WHERE id=? AND phase='idle'").run(token,this.key);if(Number(claim.changes)!==1)throw Error('Remote rollout requires recovery');this.active=true;let importing=false;
  try{
   const result=await this.connector.discoverLatest({...this.actor}),c=this.connector.rolloutConfig,repo=this.connector.rolloutRepository;
   const floor=await repo.getPromotionFloor!(c.sourceEnvironment,c.targetEnvironment),target=(await repo.getPublished!())?.version??0;
   if(!Number.isSafeInteger(floor)||floor<0||!Number.isSafeInteger(target)||target<0||target>=Number.MAX_SAFE_INTEGER)throw Error('Invalid local rollout state');
   if(result.sourceVersion<floor)throw Error('Remote source version is behind local history');
   if(result.sourceVersion===floor){this.release(token);return {status:'unchanged',sourceVersion:floor,targetVersion:target};}
   const marked=this.db.prepare("UPDATE remote_rollouts SET phase='importing',source_version=?,expected_version=? WHERE id=? AND phase='running' AND token=?").run(result.sourceVersion,target,this.key,token);if(Number(marked.changes)!==1)throw Error('Remote rollout state changed');importing=true;
   const publication=await this.connector.importPublication({actor:{...this.actor},sourceVersion:result.sourceVersion,expectedVersion:target});this.release(token);return {status:'imported',sourceVersion:result.sourceVersion,targetVersion:publication.version};
  }catch(error){if(importing)this.db.prepare("UPDATE remote_rollouts SET phase='uncertain' WHERE id=? AND phase='importing' AND token=?").run(this.key,token);else this.release(token);throw error;}finally{this.active=false;}
 }
 private release(token:string):void{const result=this.db.prepare("UPDATE remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=? AND token=? AND phase IN ('running','importing')").run(this.key,token);if(Number(result.changes)!==1)throw Error('Remote rollout state changed');}
 async recover(authorize:(state:State)=>boolean|Promise<boolean>):Promise<void>{
  if(this.active||typeof authorize!=='function')throw Error('Invalid remote rollout recovery');const state=this.getState();if(state.phase==='idle'||!state.token)throw Error('No rollout requires recovery');let permitted=false;try{permitted=await authorize({...state})===true;}catch{}if(!permitted)throw Error('Remote rollout recovery denied');
  const result=this.db.prepare("UPDATE remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=? AND phase=? AND token=?").run(this.key,state.phase,state.token);if(Number(result.changes)!==1)throw Error('Remote rollout state changed');
 }
 close():void{if(this.active)throw Error('Remote rollout is active');this.db.close();}
}
