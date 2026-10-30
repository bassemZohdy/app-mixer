import {randomUUID} from 'node:crypto';
import type {createRemoteControlConnector} from './remote-control-connector.js';
import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

type Actor={tenantId:string;principalId:string};
type Connector=ReturnType<typeof createRemoteControlConnector>;
export type PostgresRemoteRolloutState={phase:'idle'|'running'|'importing'|'uncertain';sourceVersion:number|null;expectedVersion:number|null;token:string|null};
type Options={enabled:boolean;query:PostgresJwtRevocationQuery;connector:Connector;actor:Actor};
const validText=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const version=(v:unknown,min:number)=>Number.isSafeInteger(v)&&Number(v)>=min;

/** Shared single-flight journal; the host owns authorization, target storage and recovery. */
export class PostgresRemoteRollout {
 private readonly query:PostgresJwtRevocationQuery;private readonly connector:Connector;private readonly actor:Actor;private readonly key:string;private active=false;
 constructor(options:Options){
  if(!options||options.enabled!==true||typeof options.query!=='function'||!options.connector?.rolloutConfig?.safe||!options.connector.rolloutRepository||typeof options.connector.rolloutRepository.getPublished!=='function'||typeof (options.connector.rolloutRepository as {getPromotionFloor?:unknown}).getPromotionFloor!=='function'||!options.actor||!validText(options.actor.tenantId)||!validText(options.actor.principalId))throw Error('Invalid remote rollout configuration');
  this.query=options.query;this.connector=options.connector;this.actor={tenantId:options.actor.tenantId,principalId:options.actor.principalId};const c=options.connector.rolloutConfig;this.key=JSON.stringify([this.actor.tenantId,c.applicationId,c.sourceEnvironment,c.targetEnvironment]);
 }
 async initialize():Promise<void>{
  await this.query("CREATE TABLE IF NOT EXISTS app_mixer_remote_rollouts (id TEXT PRIMARY KEY,phase TEXT NOT NULL CHECK (phase IN ('idle','running','importing','uncertain')),token TEXT,source_version BIGINT,expected_version BIGINT)",[]);
  await this.query("INSERT INTO app_mixer_remote_rollouts(id,phase) VALUES ($1,'idle') ON CONFLICT (id) DO NOTHING",[this.key]);
 }
 async getState():Promise<PostgresRemoteRolloutState>{
  const result=await this.query('SELECT phase,token,source_version,expected_version FROM app_mixer_remote_rollouts WHERE id=$1',[this.key]);const row=result.rows?.[0];
  if(!Array.isArray(result.rows)||result.rows.length!==1||!row||!['idle','running','importing','uncertain'].includes(String(row.phase)))throw Error('Invalid rollout state');
  const phase=row.phase as PostgresRemoteRolloutState['phase'],token=row.token===null?null:row.token,sourceVersion=row.source_version===null?null:Number(row.source_version),expectedVersion=row.expected_version===null?null:Number(row.expected_version);
  if((phase==='idle'&&(token!==null||sourceVersion!==null||expectedVersion!==null))||(phase==='running'&&(!validText(token)||sourceVersion!==null||expectedVersion!==null))||(['importing','uncertain'].includes(phase)&&(!validText(token)||!version(sourceVersion,1)||!version(expectedVersion,0))))throw Error('Invalid rollout state');
  return {phase,token:token as string|null,sourceVersion,expectedVersion};
 }
 private async change(sql:string,args:unknown[]):Promise<void>{const result=await this.query(sql,args);if(!Array.isArray(result.rows)||result.rows.length!==1)throw Error('Remote rollout state changed');}
 private async release(token:string):Promise<void>{await this.change("UPDATE app_mixer_remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=$1 AND token=$2 AND phase IN ('running','importing') RETURNING id",[this.key,token]);}
 async runOnce():Promise<{status:'unchanged'|'imported';sourceVersion:number;targetVersion:number}>{
  if(this.active)throw Error('Remote rollout already active');this.active=true;const token=randomUUID();let claimed=false,importing=false;
  try{
   const result=await this.query("UPDATE app_mixer_remote_rollouts SET phase='running',token=$2,source_version=NULL,expected_version=NULL WHERE id=$1 AND phase='idle' AND token IS NULL AND source_version IS NULL AND expected_version IS NULL RETURNING id",[this.key,token]);if(!Array.isArray(result.rows)||result.rows.length!==1)throw Error('Remote rollout requires recovery');claimed=true;
   const discovered=await this.connector.discoverLatest({...this.actor}),c=this.connector.rolloutConfig,repo=this.connector.rolloutRepository as Connector['rolloutRepository'] & {getPromotionFloor:(source:string,target:string)=>number};
   const floor=repo.getPromotionFloor(c.sourceEnvironment,c.targetEnvironment),target=repo.getPublished()?.version??0;
   if(!version(floor,0)||!version(target,0)||target>=Number.MAX_SAFE_INTEGER)throw Error('Invalid local rollout state');
   if(discovered.sourceVersion<floor)throw Error('Remote source version is behind local history');
   if(discovered.sourceVersion===floor){await this.release(token);claimed=false;return {status:'unchanged',sourceVersion:floor,targetVersion:target};}
   await this.change("UPDATE app_mixer_remote_rollouts SET phase='importing',source_version=$3,expected_version=$4 WHERE id=$1 AND phase='running' AND token=$2 RETURNING id",[this.key,token,discovered.sourceVersion,target]);importing=true;
   const publication=await this.connector.importPublication({actor:{...this.actor},sourceVersion:discovered.sourceVersion,expectedVersion:target});await this.release(token);claimed=false;return {status:'imported',sourceVersion:discovered.sourceVersion,targetVersion:publication.version};
  }catch(error){
   if(claimed){if(importing){try{await this.query("UPDATE app_mixer_remote_rollouts SET phase='uncertain' WHERE id=$1 AND phase='importing' AND token=$2",[this.key,token]);}catch{}}else{try{await this.release(token);}catch{}}}throw error;
  }finally{this.active=false;}
 }
 async recover(authorize:(state:PostgresRemoteRolloutState)=>boolean|Promise<boolean>):Promise<void>{
  if(this.active||typeof authorize!=='function')throw Error('Invalid remote rollout recovery');const state=await this.getState();if(state.phase==='idle'||!state.token)throw Error('No rollout requires recovery');let permitted=false;try{permitted=await authorize({...state})===true;}catch{}if(!permitted)throw Error('Remote rollout recovery denied');
  await this.change("UPDATE app_mixer_remote_rollouts SET phase='idle',token=NULL,source_version=NULL,expected_version=NULL WHERE id=$1 AND phase=$2 AND token=$3 RETURNING id",[this.key,state.phase,state.token]);
 }
}
export type {Options as PostgresRemoteRolloutOptions};
