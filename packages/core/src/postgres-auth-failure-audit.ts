import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';
import {isNonNegativeInteger} from './validation.js';
import {authenticationFailureAnchorKey,checkAgainstAnchor,advanceAnchor} from './file-sequence-anchor.js';
import type {AuditSequenceAnchor,AnchorErrorHandler} from './file-sequence-anchor.js';

export type AuthenticationFailureEvent={reason:'unauthenticated';remoteAddress?:string};
export type StoredAuthenticationFailure={sequence:number;recordedAt:number;reason:'unauthenticated';addressHash:string|null};
type Options={query:PostgresJwtRevocationQuery;clock?:()=>number;addressKey?:Uint8Array;sequenceAnchor?:AuditSequenceAnchor;onAnchorError?:AnchorErrorHandler};
const integer=isNonNegativeInteger;

/** Global security audit for requests without an authenticated tenant or principal. */
export class PostgresAuthenticationFailureAudit {
 private readonly query:PostgresJwtRevocationQuery;private readonly clock:()=>number;private readonly addressKey:Buffer|undefined;
 constructor(options:Options){if(!options||typeof options.query!=='function'||(options.clock!==undefined&&typeof options.clock!=='function')||(options.addressKey!==undefined&&(!(options.addressKey instanceof Uint8Array)||options.addressKey.byteLength<32||options.addressKey.byteLength>1024)))throw Error('Invalid authentication audit configuration');if(options.sequenceAnchor!==undefined&&(!options.sequenceAnchor||typeof options.sequenceAnchor.read!=='function'||typeof options.sequenceAnchor.advance!=='function'))throw Error('Invalid authentication audit configuration');this.anchor=options.sequenceAnchor;this.onAnchorError=options.onAnchorError;this.query=options.query;this.clock=options.clock??Date.now;this.addressKey=options.addressKey===undefined?undefined:Buffer.from(options.addressKey);}
 private readonly anchor:AuditSequenceAnchor|undefined;private readonly onAnchorError:AnchorErrorHandler|undefined;
 /** Refuses to record when the database sequence is below the anchored high-water mark, which means the database was restored to an older state. */
 private async checkAnchor():Promise<void>{
  await checkAgainstAnchor({anchor:this.anchor!,key:authenticationFailureAnchorKey,unavailable:'Audit sequence anchor unavailable',rolledBack:'Audit log was rolled back',onError:this.onAnchorError,stored:async()=>{
   const result=await this.query('SELECT sequence FROM app_mixer_auth_failure_counter WHERE id=1',[]);
   if(!Array.isArray(result.rows)||result.rows.length>1)throw Error('Invalid authentication audit result');
   const stored=result.rows.length===0?0:Number(result.rows[0].sequence);if(!Number.isSafeInteger(stored)||stored<0)throw Error('Invalid authentication audit result');return stored;
  }});
 }
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_auth_failure_counter (id SMALLINT PRIMARY KEY CHECK (id=1),sequence BIGINT NOT NULL)',[]);await this.query('CREATE TABLE IF NOT EXISTS app_mixer_auth_failure_audit (sequence BIGINT PRIMARY KEY,recorded_at BIGINT NOT NULL,reason TEXT NOT NULL,address_hash TEXT)',[]);await this.query('CREATE INDEX IF NOT EXISTS app_mixer_auth_failure_audit_retention ON app_mixer_auth_failure_audit (recorded_at,sequence)',[]);}
 record=async(event:AuthenticationFailureEvent):Promise<void>=>{
  if(!event||event.reason!=='unauthenticated'||(event.remoteAddress!==undefined&&(typeof event.remoteAddress!=='string'||!isIP(event.remoteAddress))))throw Error('Invalid authentication audit event');const now=this.clock();if(!integer(now))throw Error('Invalid clock');const addressHash=this.addressKey&&event.remoteAddress?createHmac('sha256',this.addressKey).update('app-mixer-auth-failure-address-v1\0').update(event.remoteAddress).digest('hex'):null;
  if(this.anchor)await this.checkAnchor();
  const result=await this.query("WITH assigned AS (INSERT INTO app_mixer_auth_failure_counter (id,sequence) VALUES (1,1) ON CONFLICT (id) DO UPDATE SET sequence=app_mixer_auth_failure_counter.sequence+1 RETURNING sequence) INSERT INTO app_mixer_auth_failure_audit (sequence,recorded_at,reason,address_hash) SELECT sequence,$1,'unauthenticated',$2 FROM assigned RETURNING sequence",[now,addressHash]);const sequence=Number(result.rows?.[0]?.sequence);if(result.rows?.length!==1||!integer(sequence)||sequence<1)throw Error('Invalid authentication audit result');
  // The event is committed; an anchor failure leaves the anchor behind until the next record catches it up.
  if(this.anchor)await advanceAnchor(this.anchor,authenticationFailureAnchorKey,sequence,this.onAnchorError);
 };
 /** The host must authorize deletion and preserve any records required for audit before pruning. */
 async prune(options:{before:number;through:number;limit:number}):Promise<number>{
  const now=this.clock();if(!integer(now)||!options||!integer(options.before)||options.before>now||!integer(options.through)||options.through<1||!integer(options.limit)||options.limit<1||options.limit>1000)throw Error('Invalid authentication audit retention query');
  const result=await this.query('WITH selected AS (SELECT sequence FROM app_mixer_auth_failure_audit WHERE recorded_at<$1 AND sequence<=$2 ORDER BY recorded_at,sequence LIMIT $3 FOR UPDATE SKIP LOCKED) DELETE FROM app_mixer_auth_failure_audit AS audit USING selected WHERE audit.sequence=selected.sequence RETURNING audit.sequence',[options.before,options.through,options.limit]);
  if(!Array.isArray(result.rows)||result.rows.length>options.limit||result.rows.some(row=>!integer(Number(row.sequence))||Number(row.sequence)<1||Number(row.sequence)>options.through))throw Error('Invalid authentication audit retention result');return result.rows.length;
 }
 /** Host must separately authorize global security-audit access. */
 async list(options:{after?:number;limit?:number}={}):Promise<StoredAuthenticationFailure[]>{
  if(!options||!integer(options.after??0)||!integer(options.limit??100)||(options.limit??100)<1||(options.limit??100)>1000)throw Error('Invalid authentication audit query');const after=options.after??0,limit=options.limit??100,result=await this.query('SELECT sequence,recorded_at,reason,address_hash FROM app_mixer_auth_failure_audit WHERE sequence>$1 ORDER BY sequence LIMIT $2',[after,limit]);if(!Array.isArray(result.rows)||result.rows.length>limit)throw Error('Invalid authentication audit result');let previous=after;return result.rows.map(row=>{const sequence=Number(row.sequence),recordedAt=Number(row.recorded_at);if(!integer(sequence)||sequence<=previous||!integer(recordedAt)||row.reason!=='unauthenticated'||(row.address_hash!==null&&(typeof row.address_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.address_hash))))throw Error('Invalid authentication audit result');previous=sequence;return {sequence,recordedAt,reason:'unauthenticated',addressHash:row.address_hash as string|null};});
 }
}
export type {Options as PostgresAuthenticationFailureAuditOptions};
