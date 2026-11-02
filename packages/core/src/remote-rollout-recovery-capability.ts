import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {SqliteRemoteRollout,type RemoteRolloutScope} from './remote-rollout.js';
import {PostgresRemoteRollout} from './postgres-remote-rollout.js';

type Actor={tenantId:string;principalId:string};
export type RemoteRolloutRecoveryState={phase:'running'|'importing'|'uncertain';sourceVersion:number|null;expectedVersion:number|null};
export type RemoteRolloutRecoveryCapabilityOptions={candidate:CapabilityCandidate;scope:RemoteRolloutScope;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeRecovery:(actor:Actor,scope:RemoteRolloutScope,state:RemoteRolloutRecoveryState,reference:string,signal:AbortSignal)=>boolean|Promise<boolean>;verifyRecovery:(actor:Actor,scope:RemoteRolloutScope,state:RemoteRolloutRecoveryState,reference:string,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number;clock?:()=>number};
const valid=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
/** Clear one fixed rollout gate only after host authorization and independent verification. */
export function registerRemoteRolloutRecoveryCapability(registry:CapabilityRegistry,rollout:SqliteRemoteRollout|PostgresRemoteRollout,options:RemoteRolloutRecoveryCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(rollout instanceof SqliteRemoteRollout||rollout instanceof PostgresRemoteRollout)||!options||!options.scope||![options.scope.tenantId,options.scope.applicationId,options.scope.sourceEnvironment,options.scope.targetEnvironment].every(valid)||typeof options.authorize!=='function'||typeof options.authorizeRecovery!=='function'||typeof options.verifyRecovery!=='function'||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid rollout recovery capability');
 const scope={tenantId:options.scope.tenantId,applicationId:options.scope.applicationId,sourceEnvironment:options.scope.sourceEnvironment,targetEnvironment:options.scope.targetEnvironment},authorize=options.authorize,authorizeRecovery=options.authorizeRecovery,verifyRecovery=options.verifyRecovery,clock=options.clock??Date.now;if(!rollout.isBoundTo(scope))throw Error('Invalid rollout recovery capability');
 const bounded=createBoundedOperation(options.timeoutMs,options.maxPending,'Invalid rollout recovery capability','Rollout recovery unavailable');
 registry.register(options.candidate,{authorize:actor=>actor.tenantId===scope.tenantId&&authorize({...actor}),validate:input=>!!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1&&valid((input as {reference?:unknown}).reference),execute:async(input,context)=>{
  const actor={tenantId:context.tenantId,principalId:context.principalId},reference=(input as {reference:string}).reference,observedAt=clock();if(!Number.isSafeInteger(observedAt)||observedAt<0)throw Error('Invalid rollout recovery evidence');let failure:unknown;
  try{await rollout.recover(async current=>{try{return await bounded(async signal=>{
   const version=(value:unknown,min:number)=>Number.isSafeInteger(value)&&Number(value)>=min,active=()=>{if(signal.aborted)throw Error('Rollout recovery unavailable');};
   if(!valid(current.token)||!['running','importing','uncertain'].includes(current.phase)||(current.phase==='running'?(current.sourceVersion!==null||current.expectedVersion!==null):(!version(current.sourceVersion,1)||!version(current.expectedVersion,0))))throw Error('Rollout recovery unavailable');
   const state:RemoteRolloutRecoveryState={phase:current.phase as RemoteRolloutRecoveryState['phase'],sourceVersion:current.sourceVersion,expectedVersion:current.expectedVersion};
   const permit=async()=>{active();if(actor.tenantId!==scope.tenantId||await authorize({...actor})!==true)throw Error('Capability forbidden');active();if(await authorizeRecovery({...actor},{...scope},{...state},reference,signal)!==true)throw Error('Capability forbidden');active();};
   await permit();if(await verifyRecovery({...actor},{...scope},{...state},reference,signal)!==true)throw Error('Rollout recovery not verified');active();await permit();active();return true;
  });}catch(error){failure=error;return false;}},{principalId:actor.principalId,reference,observedAt});}catch(error){if(failure!==undefined)throw failure;throw error;}
  return {recovered:true};
 }});
}
