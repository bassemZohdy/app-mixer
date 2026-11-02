import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {checkKey} from './data-provider.js';
import {SqliteOfflineQueue,type OfflineOperation} from './offline-queue.js';
type Actor={tenantId:string;principalId:string};
type Common={candidate:CapabilityCandidate;applicationId:string;queuePrincipalId:string;targetOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeOperation:(actor:Actor,operation:OfflineOperation,reference:string,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
export type OfflineAbandonedRecoveryCapabilityOptions=Common&{verifyStopped:(actor:Actor,operation:OfflineOperation,signal:AbortSignal)=>boolean|Promise<boolean>};
export type OfflineVerificationCapabilityOptions=Common&{verify:(actor:Actor,operation:OfflineOperation,signal:AbortSignal)=>'applied'|'not_applied'|'unknown'|Promise<'applied'|'not_applied'|'unknown'>};
const id=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=256&&!/[\u0000-\u001f]/.test(x);
const parse=(input:unknown):{id:string;reference:string}|undefined=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'id')||!Object.hasOwn(input,'reference'))return;const value=input as {id:unknown;reference:unknown};return id(value.id)&&id(value.reference)?{id:value.id,reference:value.reference}:undefined;};
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
  const value=parse(input);if(!value)throw Error('Invalid capability input');const actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};
  return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Offline recovery unavailable');};
   const permit=async(operation:OfflineOperation)=>{active();if(operation.operationId!==targetOperationId)throw Error('Operation not found');const actorAllowed=await authorize({...actor});active();if(actorAllowed!==true)throw Error('Capability forbidden');const operationAllowed=await authorizeOperation({...actor},structuredClone(operation),value.reference,signal);active();if(operationAllowed!==true)throw Error('Capability forbidden');};
   const selected=queue.get(scope,queuePrincipalId,value.id);if(!selected||selected.operationId!==targetOperationId)throw Error('Operation not found');await permit(selected);active();const evidence={operatorId:actor.principalId,reference:value.reference};
   if(kind==='recover'){
    const recovered=await queue.verifyAndRecoverAbandoned(scope,queuePrincipalId,value.id,async(_scope,operation)=>{await permit(operation);const confirmed=await verifyStopped!({...actor},structuredClone(operation),signal);active();await permit(operation);active();return confirmed;},evidence);return {recovered};
   }
   const outcome=await queue.verifyAndReconcile(scope,queuePrincipalId,value.id,async(_scope,operation)=>{await permit(operation);const result=await verify!({...actor},structuredClone(operation),signal);active();await permit(operation);active();return result;},evidence);return {outcome};
  });
 }});
}
