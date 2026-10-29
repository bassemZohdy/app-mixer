import {createHash} from 'node:crypto';
import {validate, isValidExtensionReferences, isValidExtensionOperations, type ApplicationDefinition} from './index.js';
import {isValidPatch} from './planes.js';

export type PromotionPackage = {formatVersion:1;sourceEnvironment:string;sourceVersion:number;definition:ApplicationDefinition;digest:string};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,allowed:string[])=>Object.keys(x).every(k=>allowed.includes(k));
export const validEnvironment=(x:unknown):x is string=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x);
function digest(payload:Omit<PromotionPackage,'digest'>):string{return createHash('sha256').update(JSON.stringify(payload)).digest('hex');}
function checkedDefinition(value:unknown):ApplicationDefinition {
 if(!object(value)||!exact(value,['id','schemaVersion','revision','pages','extensions','extensionOperations'])||typeof value.id!=='string'||!value.id.trim()||value.id.length>256||![1,2].includes(Number(value.schemaVersion))||!Number.isSafeInteger(value.revision)||Number(value.revision)<0||!Array.isArray(value.pages)||value.pages.length>500||!value.pages.every(page=>isValidPatch({op:'addPage',page}))||(value.extensions!==undefined&&!isValidExtensionReferences(value.extensions))||(value.extensionOperations!==undefined&&!isValidExtensionOperations(value.extensionOperations)))throw Error('Invalid promotion package');
 try{validate(value as ApplicationDefinition);}catch{throw Error('Invalid promotion package');}
 return structuredClone(value) as ApplicationDefinition;
}
export function createPromotionPackage(sourceEnvironment:string,publication:{version:number;definition:ApplicationDefinition}):PromotionPackage {
 if(!validEnvironment(sourceEnvironment)||!publication||!Number.isSafeInteger(publication.version)||publication.version<1)throw Error('Invalid promotion package');
 const definition=checkedDefinition(publication.definition),payload={formatVersion:1 as const,sourceEnvironment,sourceVersion:publication.version,definition};
 const serialized=JSON.stringify(payload);if(Buffer.byteLength(serialized)>1024*1024)throw Error('Invalid promotion package');return {...payload,digest:digest(payload)};
}
export function checkPromotionPackage(input:unknown,targetEnvironment:string,applicationId:string):PromotionPackage {
 if(!validEnvironment(targetEnvironment)||!object(input)||!exact(input,['formatVersion','sourceEnvironment','sourceVersion','definition','digest'])||input.formatVersion!==1||!validEnvironment(input.sourceEnvironment)||input.sourceEnvironment===targetEnvironment||!Number.isSafeInteger(input.sourceVersion)||Number(input.sourceVersion)<1||typeof input.digest!=='string'||!/^[a-f0-9]{64}$/.test(input.digest))throw Error('Invalid promotion package');
 const candidate=createPromotionPackage(input.sourceEnvironment,{version:Number(input.sourceVersion),definition:input.definition as ApplicationDefinition});
 if(candidate.definition.id!==applicationId||candidate.digest!==input.digest)throw Error('Invalid promotion package');return candidate;
}
