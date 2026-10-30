import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {JWTPayload} from 'jose';
const valid=(x:unknown,max=256):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
/** Host-authorized local revocations for one exact issuer. */
export class SqliteJwtRevocations {
 private readonly db:DatabaseSync;private readonly issuer:string;private readonly clock:()=>number;
 constructor(path:string,options:{issuer:string;clock?:()=>number}){
  if(!options||!valid(options.issuer,2048)||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid JWT revocation configuration');let url:URL;try{url=new URL(options.issuer);}catch{throw Error('Invalid JWT revocation configuration');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid JWT revocation configuration');this.issuer=options.issuer;this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);try{this.db.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS jwt_revocations (issuer TEXT NOT NULL,token_hash TEXT NOT NULL,retain_until INTEGER NOT NULL,PRIMARY KEY(issuer,token_hash));CREATE INDEX IF NOT EXISTS jwt_revocations_expiry ON jwt_revocations(issuer,retain_until);`);}catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private now():number{const value=this.clock();if(!integer(value))throw Error('Invalid clock');return value;}
 private hash(tokenId:string):string{return createHash('sha256').update(tokenId,'utf8').digest('hex');}
 /** retainUntil is a host-calculated UTC millisecond deadline covering all token acceptance. */
 revoke(tokenId:string,retainUntil:number):void{if(!valid(tokenId)||!integer(retainUntil)||retainUntil<=this.now())throw Error('Invalid JWT revocation');this.db.prepare('INSERT INTO jwt_revocations VALUES (?,?,?) ON CONFLICT(issuer,token_hash) DO UPDATE SET retain_until=MAX(retain_until,excluded.retain_until)').run(this.issuer,this.hash(tokenId),retainUntil);}
 /** Accept only independently verified claims and deployment-wide upper bounds on clock tolerance and skew. */
 revokeVerifiedToken(claims:JWTPayload,options:{maxClockToleranceSeconds:number;maxClockSkewSeconds:number}):number{
  if(!claims||claims.iss!==this.issuer||!valid(claims.jti)||!integer(claims.iat)||!integer(claims.exp)||claims.exp<=claims.iat||!options||!integer(options.maxClockToleranceSeconds)||options.maxClockToleranceSeconds>60||!integer(options.maxClockSkewSeconds)||options.maxClockSkewSeconds>86400)throw Error('Invalid verified JWT revocation');
  const seconds=claims.exp+options.maxClockToleranceSeconds+options.maxClockSkewSeconds+1,retainUntil=seconds*1000;if(!integer(seconds)||!integer(retainUntil))throw Error('Invalid verified JWT revocation');this.revoke(claims.jti,retainUntil);const row=this.db.prepare('SELECT retain_until FROM jwt_revocations WHERE issuer=? AND token_hash=?').get(this.issuer,this.hash(claims.jti));return Number(row!.retain_until);
 }
 /** Only pass claims already verified by the configured authenticator. */
 isTokenActive(claims:JWTPayload):boolean{if(!claims||claims.iss!==this.issuer||!valid(claims.jti))return false;return !this.db.prepare('SELECT 1 FROM jwt_revocations WHERE issuer=? AND token_hash=?').get(this.issuer,this.hash(claims.jti));}
 /** Delete a bounded batch only after the host's retention horizon has elapsed. */
 prune(cutoff:number,limit=100):number{if(!integer(cutoff)||cutoff>this.now()||!integer(limit)||limit<1||limit>1000)throw Error('Invalid JWT revocation pruning');const result=this.db.prepare('DELETE FROM jwt_revocations WHERE rowid IN (SELECT rowid FROM jwt_revocations WHERE issuer=? AND retain_until<=? ORDER BY retain_until,token_hash LIMIT ?)').run(this.issuer,cutoff,limit);return Number(result.changes);}
}
