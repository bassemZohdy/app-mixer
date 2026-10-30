import {checkKey,dataCopy,type DataScope} from './data-provider.js';
import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

type Actor={tenantId:string;principalId:string};
type Target={scope:DataScope;principalId:string;idempotencyKey:string};
type Action='mark_uncertain'|'reconcile'|'history';
type Options={query:PostgresJwtRevocationQuery;authorize:(actor:Actor,target:Target,action:Action)=>boolean|Promise<boolean>;clock?:()=>number};
export type OfflineRecoveryEvent={id:number;actorId:string;attemptToken:string;action:'mark_uncertain'|'reconciled_applied'|'reconciled_not_applied';reference:string;recordedAt:number};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const reference=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=512&&!/[\u0000-\u001f\u007f]/.test(x);
const actions=new Set(['mark_uncertain','reconciled_applied','reconciled_not_applied']);

/** Host-authorized recovery with atomic, actor-attributed PostgreSQL evidence. */
export class PostgresOfflineRecovery {
 private readonly query:PostgresJwtRevocationQuery;private readonly authorize:Options['authorize'];private readonly clock:()=>number;
 constructor(options:Options){if(!options||typeof options.query!=='function'||typeof options.authorize!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid offline recovery configuration');this.query=options.query;this.authorize=options.authorize;this.clock=options.clock??Date.now;}
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_offline_recovery_events (id BIGSERIAL PRIMARY KEY,tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,principal_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,attempt_token TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,reference TEXT NOT NULL,recorded_at BIGINT NOT NULL)',[]);await this.query('CREATE INDEX IF NOT EXISTS app_mixer_offline_recovery_scope ON app_mixer_offline_recovery_events (tenant_id,application_id,principal_id,idempotency_key,id)',[]);}
 private snapshot(actor:Actor,target:Target):{actor:Actor;target:Target;args:[string,string,string,string]}{
  if(!actor||!target||!target.scope||actor.tenantId!==target.scope.tenantId)throw Error('Invalid offline recovery scope');checkKey(target.scope,'principal',target.principalId);checkKey(target.scope,'actor',actor.principalId);if(!uuid(target.idempotencyKey))throw Error('Invalid offline recovery scope');const scope={tenantId:target.scope.tenantId,applicationId:target.scope.applicationId},who={tenantId:actor.tenantId,principalId:actor.principalId},safe={scope,principalId:target.principalId,idempotencyKey:target.idempotencyKey};return {actor:who,target:safe,args:[scope.tenantId,scope.applicationId,safe.principalId,safe.idempotencyKey]};
 }
 private async permit(actor:Actor,target:Target,action:Action):Promise<void>{if(await this.authorize({...actor},{...target,scope:{...target.scope}},action)!==true)throw Error('Offline recovery forbidden');}
 private now():number{const now=this.clock();if(!integer(now))throw Error('Invalid clock');return now;}
 private checked(result:{rows:Record<string,unknown>[]},attemptToken:string):void{if(!Array.isArray(result.rows)||result.rows.length!==1||result.rows[0].attempt_token!==attemptToken||!integer(Number(result.rows[0].id))||Number(result.rows[0].id)<1)throw Error('Offline recovery state changed');}
 /** The host must establish that the old dispatcher cannot still act. */
 async markUncertain(actor:Actor,target:Target,attemptToken:string,evidence:string):Promise<void>{
  const c=this.snapshot(actor,target);if(!uuid(attemptToken)||!reference(evidence))throw Error('Invalid offline recovery evidence');await this.permit(c.actor,c.target,'mark_uncertain');const now=this.now();
  const result=await this.query("WITH changed AS (UPDATE app_mixer_offline_executions SET status='uncertain' WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND attempt_token=$5 AND status='running' RETURNING attempt_token) INSERT INTO app_mixer_offline_recovery_events (tenant_id,application_id,principal_id,idempotency_key,attempt_token,actor_id,action,reference,recorded_at) SELECT $1,$2,$3,$4,attempt_token,$6,'mark_uncertain',$7,$8 FROM changed RETURNING id,attempt_token",[...c.args,attemptToken,c.actor.principalId,evidence,now]);this.checked(result,attemptToken);
 }
 /** The host must independently establish the provider outcome. */
 async reconcile(actor:Actor,target:Target,attemptToken:string,decision:{outcome:'applied';result:unknown}|{outcome:'not_applied'},evidence:string):Promise<void>{
  const c=this.snapshot(actor,target);if(!uuid(attemptToken)||!reference(evidence)||!decision||!['applied','not_applied'].includes(decision.outcome))throw Error('Invalid offline recovery evidence');const outcome=decision.outcome,status=outcome==='applied'?'succeeded':'ready',serialized=outcome==='applied'?JSON.stringify(dataCopy({value:decision.result}).value):null,event=outcome==='applied'?'reconciled_applied':'reconciled_not_applied';await this.permit(c.actor,c.target,'reconcile');const now=this.now();
  const result=await this.query("WITH changed AS (UPDATE app_mixer_offline_executions SET status=$6,result_json=$7 WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND attempt_token=$5 AND status='uncertain' RETURNING attempt_token) INSERT INTO app_mixer_offline_recovery_events (tenant_id,application_id,principal_id,idempotency_key,attempt_token,actor_id,action,reference,recorded_at) SELECT $1,$2,$3,$4,attempt_token,$8,$9,$10,$11 FROM changed RETURNING id,attempt_token",[...c.args,attemptToken,status,serialized,c.actor.principalId,event,evidence,now]);this.checked(result,attemptToken);
 }
 async history(actor:Actor,target:Target,options:{after?:number;limit?:number}={}):Promise<{items:OfflineRecoveryEvent[];nextAfter?:number}>{
  const c=this.snapshot(actor,target),after=options?.after??0,limit=options?.limit??50;if(!options||!integer(after)||!integer(limit)||limit<1||limit>100)throw Error('Invalid offline recovery history');await this.permit(c.actor,c.target,'history');const result=await this.query('SELECT id,actor_id,attempt_token,action,reference,recorded_at FROM app_mixer_offline_recovery_events WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND id>$5 ORDER BY id LIMIT $6',[...c.args,after,limit+1]);if(!Array.isArray(result.rows)||result.rows.length>limit+1)throw Error('Invalid offline recovery history');let previous=after;const items=result.rows.slice(0,limit).map(row=>{const id=Number(row.id),recordedAt=Number(row.recorded_at);if(!integer(id)||id<=previous||!integer(recordedAt)||typeof row.actor_id!=='string'||!uuid(row.attempt_token)||typeof row.action!=='string'||!actions.has(row.action)||!reference(row.reference))throw Error('Invalid offline recovery history');previous=id;return {id,actorId:row.actor_id,attemptToken:row.attempt_token,action:row.action as OfflineRecoveryEvent['action'],reference:row.reference,recordedAt};});return {items,...(result.rows.length>limit?{nextAfter:previous}:{})};
 }
}
export type {Actor as OfflineRecoveryActor,Target as OfflineRecoveryTarget,Action as OfflineRecoveryAction,Options as PostgresOfflineRecoveryOptions};
