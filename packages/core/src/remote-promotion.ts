import {checkPromotionPackage, createPromotionPackage, validEnvironment} from './promotion.js';
import type {ApplicationDefinition} from './index.js';
import type {PromotionPackage} from './promotion.js';
import type {SignedPromotionPackage} from './signed-promotion.js';

export type RemotePromotionRequest = {actor:{tenantId:string;principalId:string};applicationId:string;sourceEnvironment:string;sourceVersion:number;targetEnvironment:string;expectedVersion:number};
export type RemotePromotionDetails = RemotePromotionRequest & {sourceOrigin:string;targetOrigin:string;digest?:string};
export type RemotePromotionEvent = {phase:'attempt'|'source_verified'|'import_authorized'|'completed'|'denied'|'uncertain';details:RemotePromotionDetails};
export type RemotePromotionOptions = {sourceOrigin:string;targetOrigin:string;sourceToken:string;targetToken:string;allowLoopbackHttp?:boolean;timeoutMs?:number;authorize:(stage:'export'|'import',details:RemotePromotionDetails)=>boolean|Promise<boolean>;audit:(event:RemotePromotionEvent)=>void|Promise<void>;signPackage?:(pkg:PromotionPackage,details:RemotePromotionDetails)=>SignedPromotionPackage|Promise<SignedPromotionPackage>};
export class RemotePromotionUncertainError extends Error { constructor(){super('Promotion outcome is uncertain; inspect target publication and provenance before retrying');this.name='RemotePromotionUncertainError';} }
const validText=(v:unknown,max=256):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
function origin(value:string,allowLoopback:boolean):string {
 let u:URL;try{u=new URL(value);}catch{throw Error('Invalid promotion origin');}
 if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||(allowLoopback&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw Error('Invalid promotion origin');
 return u.origin;
}
async function json(response:Response):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body)throw Error('Invalid response');
 const reader=response.body.getReader();let length=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024)throw Error('Response too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function createRemotePromotionClient(options:RemotePromotionOptions){
 const sourceOrigin=origin(options.sourceOrigin,options.allowLoopbackHttp===true),targetOrigin=origin(options.targetOrigin,options.allowLoopbackHttp===true);
 const {sourceToken,targetToken,authorize,audit,signPackage}=options,timeoutMs=options.timeoutMs??10000;
 if(sourceOrigin===targetOrigin||!validText(sourceToken,4096)||!validText(targetToken,4096)||typeof authorize!=='function'||typeof audit!=='function'||(signPackage!==undefined&&typeof signPackage!=='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('Invalid remote promotion configuration');
 async function post(base:string,path:string,token:string,body:unknown):Promise<Response>{
  const payload=JSON.stringify(body);if(Buffer.byteLength(payload)>1024*1024)throw Error('Request too large');
  return fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:payload,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 }
 return {async promote(input:RemotePromotionRequest):Promise<{version:number;definition:ApplicationDefinition}>{
  if(!input||!input.actor||!validText(input.actor.tenantId)||!validText(input.actor.principalId)||!validText(input.applicationId)||!validEnvironment(input.sourceEnvironment)||!validEnvironment(input.targetEnvironment)||input.sourceEnvironment===input.targetEnvironment||!Number.isSafeInteger(input.sourceVersion)||input.sourceVersion<1||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.expectedVersion>=Number.MAX_SAFE_INTEGER)throw Error('Invalid remote promotion request');
  const details:RemotePromotionDetails={actor:{tenantId:input.actor.tenantId,principalId:input.actor.principalId},applicationId:input.applicationId,sourceEnvironment:input.sourceEnvironment,sourceVersion:input.sourceVersion,targetEnvironment:input.targetEnvironment,expectedVersion:input.expectedVersion,sourceOrigin,targetOrigin};
  const emit=async(phase:RemotePromotionEvent['phase'])=>audit({phase,details:structuredClone(details)});
  const permit=async(stage:'export'|'import')=>{let allowed=false;try{allowed=await authorize(stage,structuredClone(details))===true;}catch{}if(!allowed){await emit('denied');throw Error('Promotion authorization denied');}};
  await emit('attempt');await permit('export');
  let pkg;
  try{const response=await post(sourceOrigin,'/promotion/export',sourceToken,{sourceEnvironment:details.sourceEnvironment,version:details.sourceVersion});if(response.status!==200)throw Error('Export failed');pkg=checkPromotionPackage(await json(response),details.targetEnvironment,details.applicationId);if(pkg.sourceEnvironment!==details.sourceEnvironment||pkg.sourceVersion!==details.sourceVersion)throw Error('Unexpected source');}catch{throw Error('Remote promotion export failed');}
  details.digest=pkg.digest;await emit('source_verified');await permit('import');await emit('import_authorized');
  let importPackage:unknown=pkg;if(signPackage){try{const signed=structuredClone(await signPackage(structuredClone(pkg),structuredClone(details)));if(!signed||signed.formatVersion!==1||signed.targetEnvironment!==details.targetEnvironment||typeof signed.keyId!=='string'||typeof signed.signature!=='string'||checkPromotionPackage(signed.package,details.targetEnvironment,details.applicationId).digest!==pkg.digest)throw Error('Unexpected signed package');importPackage=signed;}catch{throw Error('Remote promotion signing failed');}}
  let result:{version:number;definition:ApplicationDefinition};
  try{const response=await post(targetOrigin,'/promotion/import',targetToken,{package:importPackage,targetEnvironment:details.targetEnvironment,expectedVersion:details.expectedVersion});if(response.status!==201)throw Error('Import failed');const value=await json(response);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid response');const item=value as {version:number;definition:ApplicationDefinition};if(item.version!==details.expectedVersion+1||createPromotionPackage(details.sourceEnvironment,{version:details.sourceVersion,definition:item.definition}).digest!==pkg.digest)throw Error('Invalid response');result={version:item.version,definition:item.definition};await emit('completed');}catch{try{await emit('uncertain');}catch{}throw new RemotePromotionUncertainError();}
  return result;
 }};
}
