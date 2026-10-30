import type {CapabilityAuditEvent} from './capabilities.js';
import type {StoredCapabilityAuditEvent} from './capability-audit.js';
import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

type Options={query:PostgresJwtRevocationQuery;clock?:()=>number};
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const outcomes=new Set(['attempt','not_found','denied','invalid','succeeded','failed']);

/** Shared PostgreSQL audit sink; authorization, database and connection lifecycle remain host-owned. */
export class PostgresCapabilityAudit {
 private readonly query:PostgresJwtRevocationQuery;private readonly clock:()=>number;
 constructor(options:Options){if(!options||typeof options.query!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid capability audit configuration');this.query=options.query;this.clock=options.clock??Date.now;}
 /** Provision once using a trusted schema-migration connection before accepting traffic. */
 async initialize():Promise<void>{
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_capability_audit_counters (tenant_id TEXT PRIMARY KEY,sequence BIGINT NOT NULL)',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_capability_audit (tenant_id TEXT NOT NULL,sequence BIGINT NOT NULL,recorded_at BIGINT NOT NULL,invocation_id TEXT NOT NULL,operation_id TEXT NOT NULL,principal_id TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(tenant_id,sequence))',[]);
  await this.query('CREATE INDEX IF NOT EXISTS app_mixer_capability_audit_retention ON app_mixer_capability_audit (tenant_id,recorded_at,sequence)',[]);
 }
 /** A single autocommitted statement serializes sequence assignment per tenant. */
 record=async(event:CapabilityAuditEvent):Promise<void>=>{
  if(!event||!text(event.invocationId)||!text(event.operationId)||!text(event.tenantId)||!text(event.principalId)||!outcomes.has(event.outcome))throw Error('Invalid capability audit event');const recordedAt=this.clock();if(!integer(recordedAt))throw Error('Invalid clock');const snapshot={...event};
  const result=await this.query('WITH assigned AS (INSERT INTO app_mixer_capability_audit_counters (tenant_id,sequence) VALUES ($1,1) ON CONFLICT (tenant_id) DO UPDATE SET sequence=app_mixer_capability_audit_counters.sequence+1 RETURNING sequence) INSERT INTO app_mixer_capability_audit (tenant_id,sequence,recorded_at,invocation_id,operation_id,principal_id,outcome) SELECT $1,sequence,$2,$3,$4,$5,$6 FROM assigned RETURNING sequence',[snapshot.tenantId,recordedAt,snapshot.invocationId,snapshot.operationId,snapshot.principalId,snapshot.outcome]);
  const sequence=Number(result.rows?.[0]?.sequence);if(result.rows?.length!==1||!integer(sequence)||sequence<1)throw Error('Invalid capability audit result');
 };
 /** The host must authorize deletion and preserve any records required for audit before pruning. */
 async prune(tenantId:string,options:{before:number;through:number;limit:number}):Promise<number>{
  const now=this.clock();if(!text(tenantId)||!integer(now)||!options||!integer(options.before)||options.before>now||!integer(options.through)||options.through<1||!integer(options.limit)||options.limit<1||options.limit>1000)throw Error('Invalid capability audit retention query');
  const result=await this.query('WITH selected AS (SELECT tenant_id,sequence FROM app_mixer_capability_audit WHERE tenant_id=$1 AND recorded_at<$2 AND sequence<=$3 ORDER BY recorded_at,sequence LIMIT $4 FOR UPDATE SKIP LOCKED) DELETE FROM app_mixer_capability_audit AS audit USING selected WHERE audit.tenant_id=selected.tenant_id AND audit.sequence=selected.sequence RETURNING audit.sequence',[tenantId,options.before,options.through,options.limit]);
  if(!Array.isArray(result.rows)||result.rows.length>options.limit||result.rows.some(row=>!integer(Number(row.sequence))||Number(row.sequence)<1||Number(row.sequence)>options.through))throw Error('Invalid capability audit retention result');return result.rows.length;
 }
 /** The host must authorize the tenant and protect returned metadata. */
 async list(tenantId:string,options:{after?:number;limit?:number}={}):Promise<StoredCapabilityAuditEvent[]>{
  if(!text(tenantId)||!options||!integer(options.after??0)||!integer(options.limit??100)||(options.limit??100)<1||(options.limit??100)>1000)throw Error('Invalid capability audit query');
  const after=options.after??0,limit=options.limit??100,result=await this.query('SELECT tenant_id,sequence,recorded_at,invocation_id,operation_id,principal_id,outcome FROM app_mixer_capability_audit WHERE tenant_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[tenantId,after,limit]);if(!Array.isArray(result.rows)||result.rows.length>limit)throw Error('Invalid capability audit result');
  let previous=after;return result.rows.map(row=>{const sequence=Number(row.sequence),recordedAt=Number(row.recorded_at);if(!integer(sequence)||sequence<=previous||!integer(recordedAt)||row.tenant_id!==tenantId||!text(row.invocation_id)||!text(row.operation_id)||!text(row.principal_id)||typeof row.outcome!=='string'||!outcomes.has(row.outcome))throw Error('Invalid capability audit result');previous=sequence;return {sequence,recordedAt,tenantId,invocationId:row.invocation_id,operationId:row.operation_id,principalId:row.principal_id,outcome:row.outcome as CapabilityAuditEvent['outcome']};});
 }
}
export type {Options as PostgresCapabilityAuditOptions};
