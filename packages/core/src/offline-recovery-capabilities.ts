import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {checkKey} from './data-provider.js';
import {isDeepStrictEqual} from 'node:util';
import {SqliteOfflineQueue,type OfflineOperation,type ArchivedOfflineOperation} from './offline-queue.js';
import {AppMixerError} from './errors.js';
type Actor={tenantId:string;principalId:string};
type Common={candidate:CapabilityCandidate;applicationId:string;queuePrincipalId:string;targetOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeOperation:(actor:Actor,operation:OfflineOperation,reference:string,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
export type OfflineAbandonedRecoveryCapabilityOptions=Common&{verifyStopped:(actor:Actor,operation:OfflineOperation,signal:AbortSignal)=>boolean|Promise<boolean>};
export type OfflineVerificationCapabilityOptions=Common&{verify:(actor:Actor,operation:OfflineOperation,signal:AbortSignal)=>'applied'|'not_applied'|'unknown'|Promise<'applied'|'not_applied'|'unknown'>};
const id=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=256&&!/[\u0000-\u001f]/.test(x);
const parse=(input:unknown):{id:string;reference:string}|undefined=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'id')||!Object.hasOwn(input,'reference'))return;const value=input as {id:unknown;reference:unknown};return id(value.id)&&id(value.reference)?{id:value.id,reference:value.reference}:undefined;};
export type OfflineArchiveCapabilityOptions=Common;
/** Retire a fixed owner's terminal operation after fresh, operation-specific authorization. */
export function registerOfflineArchiveCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineArchiveCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(queue instanceof SqliteOfflineQueue)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function')throw Error('Invalid offline archive capability');
 const {candidate,applicationId,queuePrincipalId,targetOperationId,authorize,authorizeOperation,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,queuePrincipalId);const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid offline archive capability','Offline archive unavailable');
 registry.register(candidate,{authorize,validate:input=>!!parse(input),execute:async(input,context)=>{
  const value=parse(input);if(!value)throw new AppMixerError('invalid','Invalid capability input');const actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Offline archive unavailable');};const operation=queue.get(scope,queuePrincipalId,value.id);if(!operation||operation.operationId!==targetOperationId)throw new AppMixerError('not_found','Operation not found');if(operation.status!=='succeeded'&&operation.status!=='discarded')throw new AppMixerError('conflict','Invalid offline operation state');
   const permit=async()=>{active();if(await authorize({...actor})!==true)throw new AppMixerError('denied','Capability forbidden');active();if(await authorizeOperation({...actor},structuredClone(operation),value.reference,signal)!==true)throw new AppMixerError('denied','Capability forbidden');active();};
   await permit();await permit();active();queue.archiveTerminal(scope,queuePrincipalId,value.id,{operatorId:actor.principalId,reference:value.reference},Date.now(),operation);return {archived:true};
  });
 }});
}

export type OfflineArchiveReadCapabilityOptions={candidate:CapabilityCandidate;applicationId:string;queuePrincipalId:string;targetOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeArchived:(actor:Actor,operation:ArchivedOfflineOperation,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
/** Read the immutable archive marker with separate authorization. */
export function registerOfflineArchiveReadCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineArchiveReadCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(queue instanceof SqliteOfflineQueue)||!options||typeof options.authorize!=='function'||typeof options.authorizeArchived!=='function')throw Error('Invalid offline archive read capability');
 const {candidate,applicationId,queuePrincipalId,targetOperationId,authorize,authorizeArchived,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,queuePrincipalId);const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid offline archive read capability','Offline archive unavailable');
 registry.register(candidate,{authorize,validate:input=>!!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1&&Object.hasOwn(input,'id')&&id((input as {id:unknown}).id),execute:async(input,context)=>{
  const value=input as {id:string},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Offline archive unavailable');};const operation=queue.getArchived(scope,queuePrincipalId,value.id);if(!operation||operation.operationId!==targetOperationId)throw new AppMixerError('not_found','Operation not found');const permit=async()=>{active();if(await authorize({...actor})!==true)throw new AppMixerError('denied','Capability forbidden');active();if(await authorizeArchived({...actor},structuredClone(operation),signal)!==true)throw new AppMixerError('denied','Capability forbidden');active();};await permit();await permit();active();if(!isDeepStrictEqual(queue.getArchived(scope,queuePrincipalId,value.id),operation))throw Error('Stale offline archive');return operation;
  });
 }});
}

export type OfflineArchiveListCapabilityOptions={candidate:CapabilityCandidate;applicationId:string;queuePrincipalId:string;targetOperationId:string;kind:'candidates'|'archived';authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeListing:(actor:Actor,selection:{tenantId:string;applicationId:string;principalId:string;operationId:string;kind:'candidates'|'archived'},signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
/** List only metadata for one fixed owner, operation and archive phase. */
export function registerOfflineArchiveListCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineArchiveListCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(queue instanceof SqliteOfflineQueue)||!options||typeof options.authorize!=='function'||typeof options.authorizeListing!=='function'||(options.kind!=='candidates'&&options.kind!=='archived'))throw Error('Invalid offline archive listing capability');
 const {candidate,applicationId,queuePrincipalId,targetOperationId,kind,authorize,authorizeListing,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,queuePrincipalId);const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid offline archive listing capability','Offline archive listing unavailable');
 registry.register(candidate,{authorize,validate:input=>{if(!input||typeof input!=='object'||Array.isArray(input))return false;const value=input as Record<string,unknown>;return Object.keys(value).every(key=>['after','limit','completedBefore'].includes(key))&&(value.after===undefined||id(value.after))&&(value.limit===undefined||(Number.isSafeInteger(value.limit)&&Number(value.limit)>=1&&Number(value.limit)<=100))&&(value.completedBefore===undefined||(kind==='candidates'&&Number.isSafeInteger(value.completedBefore)&&Number(value.completedBefore)>=0));},execute:async(input,context)=>{
  const value=input as {after?:string;limit?:number;completedBefore?:number},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:context.tenantId,applicationId},selection={...scope,principalId:queuePrincipalId,operationId:targetOperationId,kind};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Offline archive listing unavailable');};const permit=async()=>{active();if(await authorize({...actor})!==true)throw new AppMixerError('denied','Capability forbidden');active();if(await authorizeListing({...actor},{...selection},signal)!==true)throw new AppMixerError('denied','Capability forbidden');active();};
   await permit();const page=queue.listArchiveRecords(scope,queuePrincipalId,targetOperationId,kind,value);await permit();active();return page;
  });
 }});
}
/** Host-confirmed stopped-submitter recovery; the caller cannot supply the decision. */
export function registerOfflineAbandonedRecoveryCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineAbandonedRecoveryCapabilityOptions):void{
 if(!options||typeof options.verifyStopped!=='function')throw Error('Invalid offline recovery capability');register(registry,queue,options,'recover');
}
/** Host-verified provider reconciliation; unknown leaves the queue untouched. */
export function registerOfflineVerificationCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineVerificationCapabilityOptions):void{
 if(!options||typeof options.verify!=='function')throw Error('Invalid offline recovery capability');register(registry,queue,options,'verify');
}
function register(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineAbandonedRecoveryCapabilityOptions|OfflineVerificationCapabilityOptions,kind:'recover'|'verify'):void{
 if(!(registry instanceof CapabilityRegistry)||!(queue instanceof SqliteOfflineQueue)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function')throw Error('Invalid offline recovery capability');
 const {candidate,applicationId,queuePrincipalId,targetOperationId,authorize,authorizeOperation,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,queuePrincipalId);const verifyStopped=kind==='recover'?(options as OfflineAbandonedRecoveryCapabilityOptions).verifyStopped:undefined,verify=kind==='verify'?(options as OfflineVerificationCapabilityOptions).verify:undefined,runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid offline recovery capability','Offline recovery unavailable');
 registry.register(candidate,{authorize,validate:input=>!!parse(input),execute:async(input,context)=>{
  const value=parse(input);if(!value)throw new AppMixerError('invalid','Invalid capability input');const actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};
  return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw new AppMixerError('unavailable','Offline recovery unavailable');};
   const permit=async(operation:OfflineOperation)=>{active();if(operation.operationId!==targetOperationId)throw new AppMixerError('not_found','Operation not found');const actorAllowed=await authorize({...actor});active();if(actorAllowed!==true)throw new AppMixerError('denied','Capability forbidden');const operationAllowed=await authorizeOperation({...actor},structuredClone(operation),value.reference,signal);active();if(operationAllowed!==true)throw new AppMixerError('denied','Capability forbidden');};
   const selected=queue.get(scope,queuePrincipalId,value.id);if(!selected||selected.operationId!==targetOperationId)throw new AppMixerError('not_found','Operation not found');await permit(selected);active();const evidence={operatorId:actor.principalId,reference:value.reference};
   if(kind==='recover'){
    const recovered=await queue.verifyAndRecoverAbandoned(scope,queuePrincipalId,value.id,async(_scope,operation)=>{await permit(operation);const confirmed=await verifyStopped!({...actor},structuredClone(operation),signal);active();await permit(operation);active();return confirmed;},evidence);return {recovered};
   }
   const outcome=await queue.verifyAndReconcile(scope,queuePrincipalId,value.id,async(_scope,operation)=>{await permit(operation);const result=await verify!({...actor},structuredClone(operation),signal);active();await permit(operation);active();return result;},evidence);return {outcome};
  });
 }});
}


export type OfflineRecoveryEvidenceCapabilityOptions={candidate:CapabilityCandidate;applicationId:string;queuePrincipalId:string;targetOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeOperation:(actor:Actor,operation:OfflineOperation,signal:AbortSignal)=>boolean|Promise<boolean>;authorizeArchived?:(actor:Actor,operation:ArchivedOfflineOperation,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
/** Read scoped recovery evidence only after separate host authorization. */
export function registerOfflineRecoveryEvidenceCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineRecoveryEvidenceCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(queue instanceof SqliteOfflineQueue)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function'||(options.authorizeArchived!==undefined&&typeof options.authorizeArchived!=='function'))throw Error('Invalid offline evidence capability');
 const {candidate,applicationId,queuePrincipalId,targetOperationId,authorize,authorizeOperation,authorizeArchived,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,queuePrincipalId);const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid offline evidence capability','Offline evidence unavailable');
 registry.register(candidate,{authorize,validate:input=>{if(!input||typeof input!=='object'||Array.isArray(input))return false;const value=input as Record<string,unknown>;return Object.keys(value).every(key=>['id','after','limit'].includes(key))&&Object.hasOwn(value,'id')&&id(value.id)&&(value.after===undefined||(Number.isSafeInteger(value.after)&&Number(value.after)>=0))&&(value.limit===undefined||(Number.isSafeInteger(value.limit)&&Number(value.limit)>=1&&Number(value.limit)<=99));},execute:async(input,context)=>{
  const value=input as {id:string;after?:number;limit?:number},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:context.tenantId,applicationId};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw new AppMixerError('unavailable','Offline evidence unavailable');};const permit=async()=>{active();const operation=queue.get(scope,queuePrincipalId,value.id),archived=operation?undefined:queue.getArchived(scope,queuePrincipalId,value.id);if((operation??archived)?.operationId!==targetOperationId||(!operation&&!authorizeArchived))throw new AppMixerError('not_found','Operation not found');if(await authorize({...actor})!==true)throw new AppMixerError('denied','Capability forbidden');active();const allowed=operation?await authorizeOperation({...actor},structuredClone(operation),signal):await authorizeArchived!({...actor},structuredClone(archived!),signal);if(allowed!==true)throw new AppMixerError('denied','Capability forbidden');active();};
   await permit();const limit=value.limit??50,rows=queue.listRecoveryEvidence(scope,queuePrincipalId,value.id,{after:value.after,limit:limit+1});await permit();active();const items=rows.slice(0,limit);return {items,...(rows.length>limit?{nextAfter:items.at(-1)!.id}:{})};
  });
 }});
}


export type OfflineRecoveryListCapabilityOptions={candidate:CapabilityCandidate;applicationId:string;queuePrincipalId:string;targetOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeListing:(actor:Actor,selection:{tenantId:string;applicationId:string;principalId:string;operationId:string},signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
/** List metadata for the entire fixed owner and operation only with aggregate authorization. */
export function registerOfflineRecoveryListCapability(registry:CapabilityRegistry,queue:SqliteOfflineQueue,options:OfflineRecoveryListCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(queue instanceof SqliteOfflineQueue)||!options||typeof options.authorize!=='function'||typeof options.authorizeListing!=='function')throw Error('Invalid offline recovery listing capability');const {candidate,applicationId,queuePrincipalId,targetOperationId,authorize,authorizeListing,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,queuePrincipalId);const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid offline recovery listing capability','Offline listing unavailable');
 registry.register(candidate,{authorize,validate:input=>{if(!input||typeof input!=='object'||Array.isArray(input))return false;const value=input as Record<string,unknown>;return Object.keys(value).every(key=>['after','limit'].includes(key))&&(value.after===undefined||id(value.after))&&(value.limit===undefined||(Number.isSafeInteger(value.limit)&&Number(value.limit)>=1&&Number(value.limit)<=100));},execute:async(input,context)=>{
  const value=input as {after?:string;limit?:number},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:context.tenantId,applicationId},selection={...scope,principalId:queuePrincipalId,operationId:targetOperationId};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw new AppMixerError('unavailable','Offline listing unavailable');};const permit=async()=>{active();if(await authorize({...actor})!==true)throw new AppMixerError('denied','Capability forbidden');active();if(await authorizeListing({...actor},{...selection},signal)!==true)throw new AppMixerError('denied','Capability forbidden');active();};
   await permit();const page=queue.listRecoveryCandidates(scope,queuePrincipalId,targetOperationId,value);await permit();active();return page;
  });
 }});
}
