import type {ApplicationDefinition} from './index.js';
import type {DefinitionRepository} from './planes.js';
import {checkPromotionPackage,createPromotionPackage,validEnvironment} from './promotion.js';
import {checkPromotionEvidence,type VerifiedPromotion} from './signed-promotion.js';

export type RemoteControlImportRequest={actor:{tenantId:string;principalId:string};sourceVersion:number;expectedVersion:number};
export type RemoteControlImportDetails=RemoteControlImportRequest & {applicationId:string;sourceEnvironment:string;targetEnvironment:string;sourceOrigin:string;digest?:string};
export type RemoteControlImportEvent={phase:'attempt'|'source_verified'|'import_authorized'|'completed'|'denied'|'uncertain';details:RemoteControlImportDetails};
export type RemoteControlConnectorOptions={sourceOrigin:string;sourceToken:string;sourceEnvironment:string;targetEnvironment:string;applicationId:string;repository:DefinitionRepository;authorize:(stage:'export'|'import',details:RemoteControlImportDetails)=>boolean|Promise<boolean>;audit:(event:RemoteControlImportEvent)=>void|Promise<void>;verifyWithEvidence?:(input:unknown,targetEnvironment:string,applicationId:string,expectedVersion:number)=>VerifiedPromotion;timeoutMs?:number;allowLoopbackHttp?:boolean};
export class RemoteControlImportUncertainError extends Error{constructor(){super('Local import outcome is uncertain; inspect publication and provenance before retrying');this.name='RemoteControlImportUncertainError';}}
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
function checkedOrigin(value:unknown,loopback:boolean):string{
 if(!text(value,2048))throw Error('Invalid remote control configuration');let u:URL;try{u=new URL(value);}catch{throw Error('Invalid remote control configuration');}
 if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||(loopback&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw Error('Invalid remote control configuration');return u.origin;
}
async function readJson(response:Response):Promise<unknown>{
 if(response.status!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body)throw Error('Invalid response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('Response too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
}
/** Explicit host-driven imports; runtime reads remain entirely local. */
export function createRemoteControlConnector(options:RemoteControlConnectorOptions){
 if(!options||!text(options.sourceToken,4096)||!text(options.applicationId)||!validEnvironment(options.sourceEnvironment)||!validEnvironment(options.targetEnvironment)||options.sourceEnvironment===options.targetEnvironment||!options.repository||typeof options.repository.promote!=='function'||typeof options.authorize!=='function'||typeof options.audit!=='function'||(options.verifyWithEvidence!==undefined&&(typeof options.verifyWithEvidence!=='function'||typeof options.repository.promoteVerified!=='function'))||(options.allowLoopbackHttp!==undefined&&typeof options.allowLoopbackHttp!=='boolean')||!Number.isSafeInteger(options.timeoutMs??10000)||(options.timeoutMs??10000)<100||(options.timeoutMs??10000)>120000)throw Error('Invalid remote control configuration');
 const sourceOrigin=checkedOrigin(options.sourceOrigin,options.allowLoopbackHttp===true),{sourceToken,sourceEnvironment,targetEnvironment,applicationId,repository,authorize,audit,verifyWithEvidence}=options,timeoutMs=options.timeoutMs??10000;
 return {async importPublication(input:RemoteControlImportRequest):Promise<{version:number;definition:ApplicationDefinition}>{
  if(!input||!input.actor||!text(input.actor.tenantId)||!text(input.actor.principalId)||!Number.isSafeInteger(input.sourceVersion)||input.sourceVersion<1||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.expectedVersion>=Number.MAX_SAFE_INTEGER)throw Error('Invalid remote control import');
  const details:RemoteControlImportDetails={actor:{tenantId:input.actor.tenantId,principalId:input.actor.principalId},sourceVersion:input.sourceVersion,expectedVersion:input.expectedVersion,applicationId,sourceEnvironment,targetEnvironment,sourceOrigin};
  const emit=async(phase:RemoteControlImportEvent['phase'])=>audit({phase,details:structuredClone(details)});
  const permit=async(stage:'export'|'import')=>{let allowed=false;try{allowed=await authorize(stage,structuredClone(details))===true;}catch{}if(!allowed){await emit('denied');throw Error('Remote control authorization denied');}};
  await emit('attempt');await permit('export');
  let pkg,evidence;try{const response=await fetch(sourceOrigin+(verifyWithEvidence?'/promotion/export-signed':'/promotion/export'),{method:'POST',headers:{authorization:`Bearer ${sourceToken}`,'content-type':'application/json'},body:JSON.stringify(verifyWithEvidence?{sourceEnvironment,version:details.sourceVersion,targetEnvironment,expectedVersion:details.expectedVersion}:{sourceEnvironment,version:details.sourceVersion}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});const raw=await readJson(response);if(verifyWithEvidence){const verified=verifyWithEvidence(raw,targetEnvironment,applicationId,details.expectedVersion);pkg=checkPromotionPackage(verified.package,targetEnvironment,applicationId);evidence=checkPromotionEvidence(pkg,targetEnvironment,verified.evidence,details.expectedVersion);if(evidence.expectedVersion!==details.expectedVersion)throw Error('Unbound signature');}else pkg=checkPromotionPackage(raw,targetEnvironment,applicationId);if(pkg.sourceEnvironment!==sourceEnvironment||pkg.sourceVersion!==details.sourceVersion)throw Error('Unexpected source');}catch{throw Error('Remote control export failed');}
  details.digest=pkg.digest;await emit('source_verified');await permit('import');await emit('import_authorized');
  try{const result=evidence?repository.promoteVerified!(pkg,details.expectedVersion,targetEnvironment,evidence):repository.promote!(pkg,details.expectedVersion,targetEnvironment);if(!result||result.version!==details.expectedVersion+1||createPromotionPackage(sourceEnvironment,{version:details.sourceVersion,definition:result.definition}).digest!==pkg.digest)throw Error('Unexpected local publication');await emit('completed');return result;}catch{try{await emit('uncertain');}catch{}throw new RemoteControlImportUncertainError();}
 }};
}
