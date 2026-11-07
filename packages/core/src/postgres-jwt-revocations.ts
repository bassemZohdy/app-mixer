import {createHash} from 'node:crypto';
import type {JWTPayload} from 'jose';
import {verifiedJwtRevocationDeadline} from './jwt-revocations.js';
import {isNonNegativeInteger} from './validation.js';
import {jwtRevocationAnchorKey} from './file-sequence-anchor.js';
import type {AuditSequenceAnchor} from './file-sequence-anchor.js';

type Query=(sql:string,parameters:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount:number|null}>;
type Options={issuer:string;query:Query;clock?:()=>number;epochAnchor?:AuditSequenceAnchor};
const valid=(x:unknown,max=256):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const integer=isNonNegativeInteger;

/** Shared PostgreSQL revocations. The host owns connections, authentication and schema provisioning. */
export class PostgresJwtRevocations {
 private readonly issuer:string;private readonly query:Query;private readonly clock:()=>number;
 constructor(options:Options){if(!options||!valid(options.issuer,2048)||typeof options.query!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid JWT revocation configuration');let url:URL;try{url=new URL(options.issuer);}catch{throw Error('Invalid JWT revocation configuration');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid JWT revocation configuration');if(options.epochAnchor!==undefined&&(!options.epochAnchor||typeof options.epochAnchor.read!=='function'||typeof options.epochAnchor.advance!=='function'))throw Error('Invalid JWT revocation configuration');this.anchor=options.epochAnchor;this.issuer=options.issuer;this.query=options.query;this.clock=options.clock??Date.now;}
 private readonly anchor:AuditSequenceAnchor|undefined;
 private now():number{const value=this.clock();if(!integer(value))throw Error('Invalid clock');return value;}
 private hash(tokenId:string):string{return createHash('sha256').update(tokenId,'utf8').digest('hex');}
 /** Run once with a trusted schema-provisioning connection before serving traffic. */
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_jwt_revocations (issuer TEXT NOT NULL,token_hash TEXT NOT NULL,retain_until BIGINT NOT NULL,PRIMARY KEY(issuer,token_hash))',[]);await this.query('CREATE INDEX IF NOT EXISTS app_mixer_jwt_revocations_expiry ON app_mixer_jwt_revocations(issuer,retain_until)',[]);await this.query('CREATE TABLE IF NOT EXISTS app_mixer_jwt_revocation_epoch (issuer TEXT PRIMARY KEY,epoch BIGINT NOT NULL)',[]);}
 async revoke(tokenId:string,retainUntil:number):Promise<number>{if(!valid(tokenId)||!integer(retainUntil)||retainUntil<=this.now())throw Error('Invalid JWT revocation');const upsert='INSERT INTO app_mixer_jwt_revocations (issuer,token_hash,retain_until) VALUES ($1,$2,$3) ON CONFLICT (issuer,token_hash) DO UPDATE SET retain_until=GREATEST(app_mixer_jwt_revocations.retain_until,EXCLUDED.retain_until) RETURNING retain_until';
  // With an epoch anchor, every revocation also advances a per-issuer epoch in the same statement, so a restored database can be told apart by its lower epoch.
  const result=await this.query(this.anchor?'WITH bumped AS (INSERT INTO app_mixer_jwt_revocation_epoch (issuer,epoch) VALUES ($1,1) ON CONFLICT (issuer) DO UPDATE SET epoch=app_mixer_jwt_revocation_epoch.epoch+1 RETURNING epoch), revoked AS ('+upsert+') SELECT revoked.retain_until,(SELECT epoch FROM bumped) AS epoch FROM revoked':upsert,[this.issuer,this.hash(tokenId),retainUntil]);const value=Number(result.rows?.[0]?.retain_until);if(result.rows?.length!==1||!integer(value)||value<retainUntil)throw Error('Invalid JWT revocation result');
  if(this.anchor){const epoch=Number(result.rows?.[0]?.epoch);if(integer(epoch)&&epoch>0)try{await this.anchor.advance(jwtRevocationAnchorKey(this.issuer),epoch);}catch{}}
  return value;}
 async revokeVerifiedToken(claims:JWTPayload,options:{maxClockToleranceSeconds:number;maxClockSkewSeconds:number}):Promise<number>{const deadline=verifiedJwtRevocationDeadline(claims,this.issuer,options);return this.revoke(claims.jti!,deadline);}
 async isTokenActive(claims:JWTPayload):Promise<boolean>{if(!claims||claims.iss!==this.issuer||!valid(claims.jti))return false;if(this.anchor)return this.activeWithAnchor(claims.jti);const result=await this.query('SELECT 1 FROM app_mixer_jwt_revocations WHERE issuer=$1 AND token_hash=$2',[this.issuer,this.hash(claims.jti)]);if(!Array.isArray(result.rows)||result.rows.length>1)throw Error('Invalid JWT revocation result');return result.rows.length===0;}
 /** One statement reads the revocation and the epoch; an epoch below the anchored epoch means the database was restored, and the check fails closed. */
 private async activeWithAnchor(tokenId:string):Promise<boolean>{
  const anchor=this.anchor!,key=jwtRevocationAnchorKey(this.issuer);let anchored:unknown;try{anchored=await anchor.read(key);}catch{throw Error('Revocation epoch anchor unavailable');}
  if(!Number.isSafeInteger(anchored)||(anchored as number)<0)throw Error('Revocation epoch anchor unavailable');
  const result=await this.query('SELECT (SELECT epoch FROM app_mixer_jwt_revocation_epoch WHERE issuer=$1) AS epoch,EXISTS(SELECT 1 FROM app_mixer_jwt_revocations WHERE issuer=$1 AND token_hash=$2) AS revoked',[this.issuer,this.hash(tokenId)]);
  if(!Array.isArray(result.rows)||result.rows.length!==1||typeof result.rows[0].revoked!=='boolean')throw Error('Invalid JWT revocation result');
  const epoch=result.rows[0].epoch===null?0:Number(result.rows[0].epoch);if(!Number.isSafeInteger(epoch)||epoch<0)throw Error('Invalid JWT revocation result');
  if(epoch<(anchored as number))throw Error('Revocations were rolled back');
  if(epoch>(anchored as number))try{await anchor.advance(key,epoch);}catch{}
  return !result.rows[0].revoked;
 }
 async prune(cutoff:number,limit=100):Promise<number>{if(!integer(cutoff)||cutoff>this.now()||!integer(limit)||limit<1||limit>1000)throw Error('Invalid JWT revocation pruning');const result=await this.query('WITH expired AS (SELECT issuer,token_hash FROM app_mixer_jwt_revocations WHERE issuer=$1 AND retain_until<=$2 ORDER BY retain_until,token_hash LIMIT $3 FOR UPDATE SKIP LOCKED) DELETE FROM app_mixer_jwt_revocations AS r USING expired AS e WHERE r.issuer=e.issuer AND r.token_hash=e.token_hash',[this.issuer,cutoff,limit]);if(!integer(result.rowCount)||result.rowCount>limit)throw Error('Invalid JWT revocation result');return result.rowCount;}
}
export type {Options as PostgresJwtRevocationsOptions,Query as PostgresJwtRevocationQuery};
