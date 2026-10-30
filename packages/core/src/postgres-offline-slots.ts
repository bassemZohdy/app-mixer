import {randomUUID} from 'node:crypto';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';
import {PostgresOfflineRequestKeys,offlineRequestDigest} from './postgres-offline-request-keys.js';
import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

type Options={query:PostgresJwtRevocationQuery;requestKeys:PostgresOfflineRequestKeys};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
/** Shared logical form slots; callers must authenticate and authorize the scope and slot. */
export class PostgresOfflineSlots {
 private readonly query:PostgresJwtRevocationQuery;private readonly keys:PostgresOfflineRequestKeys;
 constructor(options:Options){if(!options||typeof options.query!=='function'||!(options.requestKeys instanceof PostgresOfflineRequestKeys))throw Error('Invalid shared offline slots');this.query=options.query;this.keys=options.requestKeys;}
 usesKeys(keys:PostgresOfflineRequestKeys):boolean{return this.keys===keys;}
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_offline_slots (tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,principal_id TEXT NOT NULL,slot_id TEXT NOT NULL,request_key TEXT NOT NULL,PRIMARY KEY(tenant_id,application_id,principal_id,slot_id))',[]);}
 private args(scope:DataScope,principalId:string,slot:string):[string,string,string,string]{checkKey(scope,'principal',principalId);checkKey(scope,'slot',slot);return [scope.tenantId,scope.applicationId,principalId,slot];}
 private one(result:{rows:Record<string,unknown>[]},expected?:string):string{if(!Array.isArray(result.rows))throw Error('Invalid shared offline slot result');if(!result.rows.length)throw Error('Shared offline slot conflict');if(result.rows.length!==1||!uuid(result.rows[0].request_key)||(expected!==undefined&&result.rows[0].request_key!==expected))throw Error('Invalid shared offline slot result');return result.rows[0].request_key;}
 async open(scope:DataScope,principalId:string,slot:string):Promise<string>{const args=this.args(scope,principalId,slot),candidate=randomUUID(),result=await this.query('INSERT INTO app_mixer_offline_slots (tenant_id,application_id,principal_id,slot_id,request_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,application_id,principal_id,slot_id) DO UPDATE SET request_key=app_mixer_offline_slots.request_key RETURNING request_key',[...args,candidate]);return this.one(result);}
 async reset(scope:DataScope,principalId:string,slot:string,expectedRequestKey:string):Promise<string>{const args=this.args(scope,principalId,slot);if(!uuid(expectedRequestKey))throw Error('Invalid shared offline slot');const next=randomUUID(),result=await this.query('UPDATE app_mixer_offline_slots SET request_key=$6 WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND slot_id=$4 AND request_key=$5 RETURNING request_key',[...args,expectedRequestKey,next]);return this.one(result,next);}
 /** Lock the slot during allocation so a reset cannot silently reassign a stale generation. */
 async allocate(scope:DataScope,principalId:string,slot:string,expectedRequestKey:string,operationId:string,payload:Record<string,unknown>):Promise<{requestKey:string;idempotencyKey:string}>{
  const args=this.args(scope,principalId,slot),safeScope={tenantId:args[0],applicationId:args[1]};checkKey(safeScope,operationId,'validation');if(!uuid(expectedRequestKey))throw Error('Invalid shared offline slot');const digest=offlineRequestDigest(payload),candidate=randomUUID();
  const result=await this.query('WITH current_slot AS (SELECT request_key FROM app_mixer_offline_slots WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND slot_id=$4 AND request_key=$5 FOR UPDATE) INSERT INTO app_mixer_offline_request_keys (tenant_id,application_id,principal_id,request_key,operation_id,payload_digest,idempotency_key) SELECT $1,$2,$3,request_key,$6,$7,$8 FROM current_slot WHERE true ON CONFLICT (tenant_id,application_id,principal_id,request_key) DO UPDATE SET idempotency_key=app_mixer_offline_request_keys.idempotency_key WHERE app_mixer_offline_request_keys.operation_id=EXCLUDED.operation_id AND app_mixer_offline_request_keys.payload_digest=EXCLUDED.payload_digest RETURNING request_key,idempotency_key',[...args,expectedRequestKey,operationId,digest,candidate]);
  this.one(result,expectedRequestKey);if(!uuid(result.rows[0].idempotency_key))throw Error('Invalid shared offline slot result');return {requestKey:expectedRequestKey,idempotencyKey:result.rows[0].idempotency_key};
 }
 /** Selecting an earlier request is explicit and bound to its authenticated content. */
 async restore(scope:DataScope,principalId:string,slot:string,expectedRequestKey:string,operationId:string,payload:Record<string,unknown>,pair:{requestKey:string;idempotencyKey:string}):Promise<string>{
  const args=this.args(scope,principalId,slot),safeScope={tenantId:args[0],applicationId:args[1]},safePayload=dataCopy(payload);checkKey(safeScope,operationId,'validation');if(!uuid(expectedRequestKey)||!pair||!uuid(pair.requestKey)||!uuid(pair.idempotencyKey))throw Error('Invalid shared offline slot');const requestKey=pair.requestKey,idempotencyKey=pair.idempotencyKey;if(!await this.keys.verify(safeScope,principalId,operationId,safePayload,idempotencyKey))throw Error('Shared offline key forbidden');
  const result=await this.query('UPDATE app_mixer_offline_slots SET request_key=$6 WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND slot_id=$4 AND request_key=$5 AND EXISTS (SELECT 1 FROM app_mixer_offline_request_keys WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND request_key=$6 AND idempotency_key=$7 AND operation_id=$8) RETURNING request_key',[...args,expectedRequestKey,requestKey,idempotencyKey,operationId]);return this.one(result,requestKey);
 }
}
export type {Options as PostgresOfflineSlotsOptions};
