import {DatabaseSync} from 'node:sqlite';
import {createHash,type KeyObject} from 'node:crypto';
import {signPromotionPackage,type SignedPromotionPackage,type PromotionSignatureEvidence} from './signed-promotion.js';
import {validEnvironment,type PromotionPackage} from './promotion.js';

export type PromotionSigningAuditEntry={sequence:number;previousHash:string;recordedAt:number;tenantId:string;principalId:string;applicationId:string;sourceEnvironment:string;sourceVersion:number;packageDigest:string;targetEnvironment:string;keyId:string;expectedVersion:number|null;signerPrincipal:string|null;signature:string;hash:string};
export type PromotionSigningAuditHead={sequence:number;hash:string};
export type PromotionImportRecord={applicationId:string;sourceEnvironment:string;sourceVersion:number;packageDigest:string;targetEnvironment:string;evidence:PromotionSignatureEvidence};
export type UnauditedPromotionImport={index:number;reason:'missing'|'mismatch'};

const GENESIS='0'.repeat(64);
const text=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&(x as number)>=0;
const signaturePattern=/^[A-Za-z0-9_-]{86}$/,digestPattern=/^[a-f0-9]{64}$/;
const fields=['sequence','previousHash','recordedAt','tenantId','principalId','applicationId','sourceEnvironment','sourceVersion','packageDigest','targetEnvironment','keyId','expectedVersion','signerPrincipal','signature'] as const;
type Body=Omit<PromotionSigningAuditEntry,'hash'>;
const hashOf=(body:Body)=>createHash('sha256').update(JSON.stringify(fields.map(name=>body[name]))).digest('hex');
const packageDigest=(pkg:PromotionPackage)=>{const digest=pkg.digest.startsWith('sha256:')?pkg.digest.slice(7):pkg.digest;if(!digestPattern.test(digest))throw Error('Invalid promotion package digest');return digest;};

/** Append-only, hash-chained record of promotion signatures, kept by the signing service separately from any target. */
export class SqlitePromotionSigningAudit {
 private readonly db:DatabaseSync;private readonly clock:()=>number;
 constructor(path:string,options:{clock?:()=>number}={}){
  if(typeof path!=='string'||!path||!options||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid promotion signing audit configuration');
  this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS promotion_signing_audit (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, recorded_at INTEGER NOT NULL, tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, application_id TEXT NOT NULL, source_environment TEXT NOT NULL, source_version INTEGER NOT NULL, package_digest TEXT NOT NULL, target_environment TEXT NOT NULL, key_id TEXT NOT NULL, expected_version INTEGER, signer_principal TEXT, signature TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
   CREATE INDEX IF NOT EXISTS promotion_signing_audit_signature ON promotion_signing_audit(signature);
   CREATE TRIGGER IF NOT EXISTS promotion_signing_audit_no_update BEFORE UPDATE ON promotion_signing_audit BEGIN SELECT RAISE(ABORT,'promotion signing audit is append-only'); END;
   CREATE TRIGGER IF NOT EXISTS promotion_signing_audit_no_delete BEFORE DELETE ON promotion_signing_audit BEGIN SELECT RAISE(ABORT,'promotion signing audit is append-only'); END;`);}catch(error){this.db.close();throw error;}
 }
 /** Record one signature; the entry commits before the caller may release the envelope. */
 record(actor:{tenantId:string;principalId:string},signed:SignedPromotionPackage):PromotionSigningAuditEntry{
  if(!actor||!text(actor.tenantId)||!text(actor.principalId)||!signed||typeof signed!=='object'||!signed.package||!text(signed.package.definition?.id)||!validEnvironment(signed.package.sourceEnvironment)||!integer(signed.package.sourceVersion)||!validEnvironment(signed.targetEnvironment)||!text(signed.keyId)||typeof signed.signature!=='string'||!signaturePattern.test(signed.signature))throw Error('Invalid promotion signing audit entry');
  const expectedVersion=signed.formatVersion===1?null:signed.expectedVersion,signerPrincipal=signed.formatVersion===3?signed.signerPrincipal:null,time=this.clock();
  if((expectedVersion!==null&&!integer(expectedVersion))||(signerPrincipal!==null&&!text(signerPrincipal))||!integer(time))throw Error('Invalid promotion signing audit entry');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const last=this.db.prepare('SELECT sequence,hash FROM promotion_signing_audit ORDER BY sequence DESC LIMIT 1').get() as {sequence:number;hash:string}|undefined;
   const body:Body={sequence:Number(last?.sequence??0)+1,previousHash:last?String(last.hash):GENESIS,recordedAt:time,tenantId:actor.tenantId,principalId:actor.principalId,applicationId:signed.package.definition.id,sourceEnvironment:signed.package.sourceEnvironment,sourceVersion:signed.package.sourceVersion,packageDigest:packageDigest(signed.package),targetEnvironment:signed.targetEnvironment,keyId:signed.keyId,expectedVersion,signerPrincipal,signature:signed.signature};
   const entry={...body,hash:hashOf(body)};
   this.db.prepare('INSERT INTO promotion_signing_audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.sequence,entry.previousHash,entry.recordedAt,entry.tenantId,entry.principalId,entry.applicationId,entry.sourceEnvironment,entry.sourceVersion,entry.packageDigest,entry.targetEnvironment,entry.keyId,entry.expectedVersion,entry.signerPrincipal,entry.signature,entry.hash);
   this.db.exec('COMMIT');return entry;
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 list(options:{after?:number;limit?:number}={}):PromotionSigningAuditEntry[]{
  const after=options?.after??0,limit=options?.limit??100;if(!integer(after)||!integer(limit)||limit<1||limit>1000)throw Error('Invalid promotion signing audit query');
  return (this.db.prepare('SELECT * FROM promotion_signing_audit WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,limit) as Record<string,unknown>[]).map(row);
 }
 /** The latest sequence and hash; publish or retain it elsewhere so truncation of the tail can be detected. */
 head():PromotionSigningAuditHead{const last=this.db.prepare('SELECT sequence,hash FROM promotion_signing_audit ORDER BY sequence DESC LIMIT 1').get() as {sequence:number;hash:string}|undefined;return last?{sequence:Number(last.sequence),hash:String(last.hash)}:{sequence:0,hash:GENESIS};}
 /** Recompute the chain; optionally require that a previously retained head is still present. */
 verify(checkpoint?:PromotionSigningAuditHead):{valid:boolean;head:PromotionSigningAuditHead;error?:string}{
  if(checkpoint!==undefined&&(!checkpoint||!integer(checkpoint.sequence)||typeof checkpoint.hash!=='string'||!digestPattern.test(checkpoint.hash)))throw Error('Invalid promotion signing audit checkpoint');
  let previous=GENESIS,expected=1,checkpointSeen=!checkpoint||checkpoint.sequence===0&&checkpoint.hash===GENESIS;
  for(const value of this.db.prepare('SELECT * FROM promotion_signing_audit ORDER BY sequence').iterate() as Iterable<Record<string,unknown>>){
   const entry=row(value),{hash,...body}=entry,head={sequence:entry.sequence,hash};
   if(entry.sequence!==expected)return {valid:false,head,error:`Missing entry ${expected}`};
   if(entry.previousHash!==previous)return {valid:false,head,error:`Broken chain at ${entry.sequence}`};
   if(hashOf(body)!==hash)return {valid:false,head,error:`Altered entry ${entry.sequence}`};
   if(checkpoint&&checkpoint.sequence===entry.sequence){if(checkpoint.hash!==hash)return {valid:false,head,error:`Checkpoint mismatch at ${entry.sequence}`};checkpointSeen=true;}
   previous=hash;expected++;
  }
  const head={sequence:expected-1,hash:previous};
  return checkpointSeen?{valid:true,head}:{valid:false,head,error:'Checkpoint not found'};
 }
 /** Compare a target's imported signature evidence with this log. Returns imports the signing service did not record. */
 findUnaudited(imports:PromotionImportRecord[]):UnauditedPromotionImport[]{
  if(!Array.isArray(imports)||imports.length>10000)throw Error('Invalid promotion import records');
  const lookup=this.db.prepare('SELECT * FROM promotion_signing_audit WHERE signature=? ORDER BY sequence');
  return imports.flatMap((item,index):UnauditedPromotionImport[]=>{
   if(!item||!item.evidence||typeof item.evidence.signature!=='string'||!signaturePattern.test(item.evidence.signature))throw Error('Invalid promotion import records');
   const matches=(lookup.all(item.evidence.signature) as Record<string,unknown>[]).map(row);if(!matches.length)return [{index,reason:'missing'}];
   const digest=item.packageDigest?.startsWith('sha256:')?item.packageDigest.slice(7):item.packageDigest;
   const same=matches.some(entry=>entry.applicationId===item.applicationId&&entry.sourceEnvironment===item.sourceEnvironment&&entry.sourceVersion===item.sourceVersion&&entry.packageDigest===digest&&entry.targetEnvironment===item.targetEnvironment&&entry.keyId===item.evidence.keyId&&entry.expectedVersion===(item.evidence.expectedVersion??null)&&entry.signerPrincipal===(item.evidence.signerPrincipal??null));
   return same?[]:[{index,reason:'mismatch'}];
  });
 }
 close():void{this.db.close();}
}
function row(value:Record<string,unknown>):PromotionSigningAuditEntry{
 return {sequence:Number(value.sequence),previousHash:String(value.previous_hash),recordedAt:Number(value.recorded_at),tenantId:String(value.tenant_id),principalId:String(value.principal_id),applicationId:String(value.application_id),sourceEnvironment:String(value.source_environment),sourceVersion:Number(value.source_version),packageDigest:String(value.package_digest),targetEnvironment:String(value.target_environment),keyId:String(value.key_id),expectedVersion:value.expected_version===null?null:Number(value.expected_version),signerPrincipal:value.signer_principal===null?null:String(value.signer_principal),signature:String(value.signature),hash:String(value.hash)};
}

/** A control-plane export signer that records every signature before releasing it. */
export function createAuditedPromotionSigner(options:{audit:SqlitePromotionSigningAudit;actor:{tenantId:string;principalId:string};keyId:string;privateKey:KeyObject;signerPrincipal?:string}){
 if(!options||!(options.audit instanceof SqlitePromotionSigningAudit)||!options.actor||!text(options.actor.tenantId)||!text(options.actor.principalId)||!text(options.keyId)||!options.privateKey||(options.signerPrincipal!==undefined&&!text(options.signerPrincipal)))throw Error('Invalid audited promotion signer configuration');
 const {audit,keyId,privateKey,signerPrincipal}=options,actor={...options.actor};
 return (pkg:PromotionPackage,targetEnvironment:string,expectedVersion?:number):SignedPromotionPackage=>{
  if(signerPrincipal!==undefined&&expectedVersion===undefined)throw Error('Signer identity requires a target version');
  const signed=signPromotionPackage(pkg,targetEnvironment,keyId,privateKey,expectedVersion,signerPrincipal);audit.record(actor,signed);return signed;
 };
}
