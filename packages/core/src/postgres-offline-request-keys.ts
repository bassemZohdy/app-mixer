import {createHash,randomUUID} from 'node:crypto';
import {checkKey,dataCopy,type DataScope} from './data-provider.js';
import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

type Options={query:PostgresJwtRevocationQuery};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
function canonical(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
}
/** Shared request identity; the host must authenticate and authorize every call. */
export class PostgresOfflineRequestKeys {
 private readonly query:PostgresJwtRevocationQuery;
 constructor(options:Options){if(!options||typeof options.query!=='function')throw Error('Invalid shared offline request configuration');this.query=options.query;}
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_offline_request_keys (tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,principal_id TEXT NOT NULL,request_key TEXT NOT NULL,operation_id TEXT NOT NULL,payload_digest TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,PRIMARY KEY(tenant_id,application_id,principal_id,request_key))',[]);}
 async allocate(scope:DataScope,principalId:string,operationId:string,requestKey:string,payload:Record<string,unknown>):Promise<string>{
  checkKey(scope,operationId,requestKey);checkKey(scope,'principal',principalId);const tenantId=scope.tenantId,applicationId=scope.applicationId,digest=createHash('sha256').update(canonical(dataCopy(payload))).digest('hex'),candidate=randomUUID();
  const result=await this.query('INSERT INTO app_mixer_offline_request_keys (tenant_id,application_id,principal_id,request_key,operation_id,payload_digest,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,application_id,principal_id,request_key) DO UPDATE SET idempotency_key=app_mixer_offline_request_keys.idempotency_key WHERE app_mixer_offline_request_keys.operation_id=EXCLUDED.operation_id AND app_mixer_offline_request_keys.payload_digest=EXCLUDED.payload_digest RETURNING idempotency_key',[tenantId,applicationId,principalId,requestKey,operationId,digest,candidate]);
  if(!Array.isArray(result.rows))throw Error('Invalid shared offline key result');if(result.rows.length===0)throw Error('Shared offline request conflict');if(result.rows.length!==1||!uuid(result.rows[0].idempotency_key))throw Error('Invalid shared offline key result');return result.rows[0].idempotency_key;
 }
 /** Validate a submitted key against the authenticated scope and exact operation content. */
 async verify(scope:DataScope,principalId:string,operationId:string,payload:Record<string,unknown>,idempotencyKey:string):Promise<boolean>{
  checkKey(scope,operationId,'validation');checkKey(scope,'principal',principalId);if(!uuid(idempotencyKey))throw Error('Invalid shared offline key');const tenantId=scope.tenantId,applicationId=scope.applicationId,digest=createHash('sha256').update(canonical(dataCopy(payload))).digest('hex');
  const result=await this.query('SELECT 1 AS valid FROM app_mixer_offline_request_keys WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND operation_id=$4 AND payload_digest=$5 AND idempotency_key=$6',[tenantId,applicationId,principalId,operationId,digest,idempotencyKey]);if(!Array.isArray(result.rows)||result.rows.length>1||(result.rows.length===1&&result.rows[0].valid!==1))throw Error('Invalid shared offline key result');return result.rows.length===1;
 }
}
export type {Options as PostgresOfflineRequestKeysOptions};
