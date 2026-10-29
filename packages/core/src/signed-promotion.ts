import {sign,verify,KeyObject,createPublicKey,createHash} from 'node:crypto';
import {checkPromotionPackage,validEnvironment,type PromotionPackage} from './promotion.js';

export type SignedPromotionPackage={formatVersion:1;targetEnvironment:string;keyId:string;package:PromotionPackage;signature:string};
export type PromotionSignatureEvidence={algorithm:'ed25519';keyId:string;publicKey:string;signature:string;keyFingerprint:string};
export type VerifiedPromotion={package:PromotionPackage;evidence:PromotionSignatureEvidence};
export type PromotionSigningKey={keyId:string;sourceEnvironment:string;publicKey:KeyObject};
const validKeyId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const signingBytes=(target:string,keyId:string,digest:string)=>Buffer.from(JSON.stringify(['app-mixer-promotion-signature-v1',target,keyId,digest]),'utf8');
/** Sign an existing validated package for one target environment. */
export function signPromotionPackage(input:PromotionPackage,targetEnvironment:string,keyId:string,privateKey:KeyObject):SignedPromotionPackage{
 if(!input||!object(input.definition)||typeof input.definition.id!=='string'||!validKeyId(keyId)||!(privateKey instanceof KeyObject)||privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')throw Error('Invalid promotion signing configuration');
 const pkg=checkPromotionPackage(input,targetEnvironment,input.definition.id),signature=sign(null,signingBytes(targetEnvironment,keyId,pkg.digest),privateKey).toString('base64url');return {formatVersion:1,targetEnvironment,keyId,package:pkg,signature};
}
/** Verify persisted evidence against a package; trust in that key is established separately by the host. */
export function checkPromotionEvidence(pkg:PromotionPackage,targetEnvironment:string,input:unknown):PromotionSignatureEvidence{
 if(!object(input)||Object.keys(input).length!==5||input.algorithm!=='ed25519'||!validKeyId(input.keyId)||typeof input.publicKey!=='string'||input.publicKey.length>256||!/^[A-Za-z0-9_-]+$/.test(input.publicKey)||typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(input.signature)||typeof input.keyFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.keyFingerprint))throw Error('Invalid promotion evidence');
 try{const bytes=Buffer.from(input.publicKey,'base64url'),sig=Buffer.from(input.signature,'base64url');if(bytes.toString('base64url')!==input.publicKey||sig.length!==64||sig.toString('base64url')!==input.signature||createHash('sha256').update(bytes).digest('hex')!==input.keyFingerprint)throw Error('Invalid evidence');const key=createPublicKey({key:bytes,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ed25519'||!verify(null,signingBytes(targetEnvironment,input.keyId,pkg.digest),key,sig))throw Error('Invalid signature');return {algorithm:'ed25519',keyId:input.keyId,publicKey:input.publicKey,signature:input.signature,keyFingerprint:input.keyFingerprint};}catch{throw Error('Invalid promotion evidence');}
}
/** Build a target-side verifier from trusted key/source bindings. */
export function createSignedPromotionVerifier(keys:PromotionSigningKey[],targetEnvironment:string){
 if(!validEnvironment(targetEnvironment)||!Array.isArray(keys)||keys.length<1||keys.length>100)throw Error('Invalid promotion verification configuration');const trusted=new Map<string,KeyObject>();
 for(const entry of keys){if(!entry||!validKeyId(entry.keyId)||!validEnvironment(entry.sourceEnvironment)||!(entry.publicKey instanceof KeyObject)||entry.publicKey.type!=='public'||entry.publicKey.asymmetricKeyType!=='ed25519')throw Error('Invalid promotion verification configuration');const key=JSON.stringify([entry.sourceEnvironment,entry.keyId]);if(trusted.has(key))throw Error('Invalid promotion verification configuration');trusted.set(key,entry.publicKey);}
 const check=(input:unknown,requestedTarget:string,applicationId:string):PromotionPackage=>{
  if(requestedTarget!==targetEnvironment||!object(input)||Object.keys(input).length!==5||!['formatVersion','targetEnvironment','keyId','package','signature'].every(k=>Object.hasOwn(input,k))||input.formatVersion!==1||input.targetEnvironment!==targetEnvironment||!validKeyId(input.keyId)||typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(input.signature)||!object(input.package)||!validEnvironment(input.package.sourceEnvironment))throw Error('Invalid signed promotion package');
  const key=trusted.get(JSON.stringify([input.package.sourceEnvironment,input.keyId]));if(!key)throw Error('Invalid signed promotion package');
  try{const pkg=checkPromotionPackage(input.package,targetEnvironment,applicationId),signature=Buffer.from(input.signature,'base64url');if(signature.length!==64||signature.toString('base64url')!==input.signature||!verify(null,signingBytes(targetEnvironment,input.keyId,pkg.digest),key,signature))throw Error('Invalid signature');return pkg;}catch{throw Error('Invalid signed promotion package');}
 };
 const verifyWithEvidence=(input:unknown,requestedTarget:string,applicationId:string):VerifiedPromotion=>{const pkg=check(input,requestedTarget,applicationId),signed=input as SignedPromotionPackage,key=trusted.get(JSON.stringify([pkg.sourceEnvironment,signed.keyId]))!,bytes=key.export({format:'der',type:'spki'});return {package:pkg,evidence:{algorithm:'ed25519',keyId:signed.keyId,publicKey:bytes.toString('base64url'),signature:signed.signature,keyFingerprint:createHash('sha256').update(bytes).digest('hex')}};};
 return Object.assign(check,{verifyWithEvidence});
}
