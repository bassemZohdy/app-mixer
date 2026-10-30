import {KeyObject,sign,verify} from 'node:crypto';
import {validate,type ApplicationDefinition} from './index.js';

export type ReleasePublication={version:number;definition:ApplicationDefinition};
export type SignedPublicationRelease={formatVersion:1;environment:string;keyId:string;publication:ReleasePublication;signature:string};
export type PublicationReleaseKey={keyId:string;publicKey:KeyObject};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function publication(value:unknown):ReleasePublication {
 if(!object(value)||Object.keys(value).sort().join(',')!=='definition,version'||!Number.isSafeInteger(value.version)||Number(value.version)<1||!object(value.definition)||typeof value.definition.id!=='string'||!id(value.definition.id)||!Array.isArray(value.definition.pages))throw Error('Invalid release publication');
 const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized)>1024*1024)throw Error('Invalid release publication');const snapshot=JSON.parse(serialized) as ReleasePublication;try{validate(snapshot.definition);}catch{throw Error('Invalid release publication');}return snapshot;
}
const bytes=(environment:string,keyId:string,value:ReleasePublication)=>Buffer.from(JSON.stringify(['app-mixer-publication-release-v1',environment,keyId,value]),'utf8');
/** Sign only a release approved by the host; this function does not authorize publication. */
export function signPublicationRelease(input:ReleasePublication,environment:string,keyId:string,privateKey:KeyObject):SignedPublicationRelease {
 if(!id(environment)||!id(keyId)||!(privateKey instanceof KeyObject)||privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')throw Error('Invalid publication signing configuration');const snapshot=publication(input);return {formatVersion:1,environment,keyId,publication:snapshot,signature:sign(null,bytes(environment,keyId,snapshot),privateKey).toString('base64url')};
}
/** Verify a trusted release for a single host-configured environment and application. */
export function verifyPublicationRelease(input:unknown,environment:string,applicationId:string,keys:PublicationReleaseKey[]):ReleasePublication {
 if(!id(environment)||!id(applicationId)||!Array.isArray(keys)||keys.length<1||keys.length>20)throw Error('Invalid publication verification configuration');const trusted=new Map<string,KeyObject>();for(const entry of keys){if(!entry||!id(entry.keyId)||!(entry.publicKey instanceof KeyObject)||entry.publicKey.type!=='public'||entry.publicKey.asymmetricKeyType!=='ed25519'||trusted.has(entry.keyId))throw Error('Invalid publication verification configuration');trusted.set(entry.keyId,entry.publicKey);}
 if(!object(input)||Object.keys(input).sort().join(',')!=='environment,formatVersion,keyId,publication,signature'||input.formatVersion!==1||input.environment!==environment||!id(input.keyId)||typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(input.signature))throw Error('Invalid signed publication');const key=trusted.get(input.keyId);if(!key)throw Error('Invalid signed publication');
 try{const snapshot=publication(input.publication),signature=Buffer.from(input.signature,'base64url');if(snapshot.definition.id!==applicationId||signature.length!==64||signature.toString('base64url')!==input.signature||!verify(null,bytes(environment,input.keyId,snapshot),key,signature))throw Error('Invalid signature');return snapshot;}catch{throw Error('Invalid signed publication');}
}
