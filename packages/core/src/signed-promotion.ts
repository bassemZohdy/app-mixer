import {sign,verify,KeyObject} from 'node:crypto';
import {checkPromotionPackage,validEnvironment,type PromotionPackage} from './promotion.js';

export type SignedPromotionPackage={formatVersion:1;targetEnvironment:string;keyId:string;package:PromotionPackage;signature:string};
export type PromotionSigningKey={keyId:string;sourceEnvironment:string;publicKey:KeyObject};
const validKeyId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const signingBytes=(target:string,keyId:string,digest:string)=>Buffer.from(JSON.stringify(['app-mixer-promotion-signature-v1',target,keyId,digest]),'utf8');
/** Sign an existing validated package for one target environment. */
export function signPromotionPackage(input:PromotionPackage,targetEnvironment:string,keyId:string,privateKey:KeyObject):SignedPromotionPackage{
 if(!input||!object(input.definition)||typeof input.definition.id!=='string'||!validKeyId(keyId)||!(privateKey instanceof KeyObject)||privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')throw Error('Invalid promotion signing configuration');
 const pkg=checkPromotionPackage(input,targetEnvironment,input.definition.id),signature=sign(null,signingBytes(targetEnvironment,keyId,pkg.digest),privateKey).toString('base64url');return {formatVersion:1,targetEnvironment,keyId,package:pkg,signature};
}
/** Build a target-side verifier from trusted key/source bindings. */
export function createSignedPromotionVerifier(keys:PromotionSigningKey[],targetEnvironment:string){
 if(!validEnvironment(targetEnvironment)||!Array.isArray(keys)||keys.length<1||keys.length>100)throw Error('Invalid promotion verification configuration');const trusted=new Map<string,KeyObject>();
 for(const entry of keys){if(!entry||!validKeyId(entry.keyId)||!validEnvironment(entry.sourceEnvironment)||!(entry.publicKey instanceof KeyObject)||entry.publicKey.type!=='public'||entry.publicKey.asymmetricKeyType!=='ed25519')throw Error('Invalid promotion verification configuration');const key=JSON.stringify([entry.sourceEnvironment,entry.keyId]);if(trusted.has(key))throw Error('Invalid promotion verification configuration');trusted.set(key,entry.publicKey);}
 return (input:unknown,requestedTarget:string,applicationId:string):PromotionPackage=>{
  if(requestedTarget!==targetEnvironment||!object(input)||Object.keys(input).length!==5||!['formatVersion','targetEnvironment','keyId','package','signature'].every(k=>Object.hasOwn(input,k))||input.formatVersion!==1||input.targetEnvironment!==targetEnvironment||!validKeyId(input.keyId)||typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(input.signature)||!object(input.package)||!validEnvironment(input.package.sourceEnvironment))throw Error('Invalid signed promotion package');
  const key=trusted.get(JSON.stringify([input.package.sourceEnvironment,input.keyId]));if(!key)throw Error('Invalid signed promotion package');
  try{const pkg=checkPromotionPackage(input.package,targetEnvironment,applicationId),signature=Buffer.from(input.signature,'base64url');if(signature.length!==64||signature.toString('base64url')!==input.signature||!verify(null,signingBytes(targetEnvironment,input.keyId,pkg.digest),key,signature))throw Error('Invalid signature');return pkg;}catch{throw Error('Invalid signed promotion package');}
 };
}
