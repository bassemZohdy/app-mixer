import {createHash} from 'node:crypto';
import type {JWTPayload} from 'jose';
import {verifiedJwtRevocationDeadline} from './jwt-revocations.js';

type Query=(sql:string,parameters:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount:number|null}>;
type Options={issuer:string;query:Query;clock?:()=>number};
const valid=(x:unknown,max=256):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;

/** Shared PostgreSQL revocations. The host owns connections, authentication and schema provisioning. */
export class PostgresJwtRevocations {
 private readonly issuer:string;private readonly query:Query;private readonly clock:()=>number;
 constructor(options:Options){if(!options||!valid(options.issuer,2048)||typeof options.query!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid JWT revocation configuration');let url:URL;try{url=new URL(options.issuer);}catch{throw Error('Invalid JWT revocation configuration');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid JWT revocation configuration');this.issuer=options.issuer;this.query=options.query;this.clock=options.clock??Date.now;}
 private now():number{const value=this.clock();if(!integer(value))throw Error('Invalid clock');return value;}
 private hash(tokenId:string):string{return createHash('sha256').update(tokenId,'utf8').digest('hex');}
 /** Run once with a trusted schema-provisioning connection before serving traffic. */
 async initialize():Promise<void>{await this.query('CREATE TABLE IF NOT EXISTS app_mixer_jwt_revocations (issuer TEXT NOT NULL,token_hash TEXT NOT NULL,retain_until BIGINT NOT NULL,PRIMARY KEY(issuer,token_hash))',[]);await this.query('CREATE INDEX IF NOT EXISTS app_mixer_jwt_revocations_expiry ON app_mixer_jwt_revocations(issuer,retain_until)',[]);}
 async revoke(tokenId:string,retainUntil:number):Promise<number>{if(!valid(tokenId)||!integer(retainUntil)||retainUntil<=this.now())throw Error('Invalid JWT revocation');const result=await this.query('INSERT INTO app_mixer_jwt_revocations (issuer,token_hash,retain_until) VALUES ($1,$2,$3) ON CONFLICT (issuer,token_hash) DO UPDATE SET retain_until=GREATEST(app_mixer_jwt_revocations.retain_until,EXCLUDED.retain_until) RETURNING retain_until',[this.issuer,this.hash(tokenId),retainUntil]);const value=Number(result.rows?.[0]?.retain_until);if(result.rows?.length!==1||!integer(value)||value<retainUntil)throw Error('Invalid JWT revocation result');return value;}
 async revokeVerifiedToken(claims:JWTPayload,options:{maxClockToleranceSeconds:number;maxClockSkewSeconds:number}):Promise<number>{const deadline=verifiedJwtRevocationDeadline(claims,this.issuer,options);return this.revoke(claims.jti!,deadline);}
 async isTokenActive(claims:JWTPayload):Promise<boolean>{if(!claims||claims.iss!==this.issuer||!valid(claims.jti))return false;const result=await this.query('SELECT 1 FROM app_mixer_jwt_revocations WHERE issuer=$1 AND token_hash=$2',[this.issuer,this.hash(claims.jti)]);if(!Array.isArray(result.rows)||result.rows.length>1)throw Error('Invalid JWT revocation result');return result.rows.length===0;}
 async prune(cutoff:number,limit=100):Promise<number>{if(!integer(cutoff)||cutoff>this.now()||!integer(limit)||limit<1||limit>1000)throw Error('Invalid JWT revocation pruning');const result=await this.query('WITH expired AS (SELECT issuer,token_hash FROM app_mixer_jwt_revocations WHERE issuer=$1 AND retain_until<=$2 ORDER BY retain_until,token_hash LIMIT $3 FOR UPDATE SKIP LOCKED) DELETE FROM app_mixer_jwt_revocations AS r USING expired AS e WHERE r.issuer=e.issuer AND r.token_hash=e.token_hash',[this.issuer,cutoff,limit]);if(!integer(result.rowCount)||result.rowCount>limit)throw Error('Invalid JWT revocation result');return result.rowCount;}
}
export type {Options as PostgresJwtRevocationsOptions,Query as PostgresJwtRevocationQuery};
