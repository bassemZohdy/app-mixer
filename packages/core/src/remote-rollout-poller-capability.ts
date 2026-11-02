import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {SqliteRemoteRollout,type RemoteRolloutScope} from './remote-rollout.js';
import {PostgresRemoteRollout} from './postgres-remote-rollout.js';
import {RemoteRolloutPoller} from './remote-rollout-poller.js';

type Actor={tenantId:string;principalId:string};
export type RemoteRolloutPollerCapabilityOptions={candidate:CapabilityCandidate;scope:RemoteRolloutScope;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeControl:(actor:Actor,scope:RemoteRolloutScope,action:'start'|'stop',signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
const valid=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);

/** Control one host-fixed poller; this never clears or reconciles its durable gate. */
export function registerRemoteRolloutPollerCapability(registry:CapabilityRegistry,rollout:SqliteRemoteRollout|PostgresRemoteRollout,poller:RemoteRolloutPoller,options:RemoteRolloutPollerCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(rollout instanceof SqliteRemoteRollout||rollout instanceof PostgresRemoteRollout)||!(poller instanceof RemoteRolloutPoller)||!poller.isFor(rollout)||!options||!options.scope||![options.scope.tenantId,options.scope.applicationId,options.scope.sourceEnvironment,options.scope.targetEnvironment].every(valid)||typeof options.authorize!=='function'||typeof options.authorizeControl!=='function')throw Error('Invalid rollout poller capability');
 const scope={tenantId:options.scope.tenantId,applicationId:options.scope.applicationId,sourceEnvironment:options.scope.sourceEnvironment,targetEnvironment:options.scope.targetEnvironment},authorize=options.authorize,authorizeControl=options.authorizeControl;if(!rollout.isBoundTo(scope))throw Error('Invalid rollout poller capability');const bounded=createBoundedOperation(options.timeoutMs,options.maxPending,'Invalid rollout poller capability','Rollout poller unavailable');
 registry.register(options.candidate,{authorize:actor=>actor.tenantId===scope.tenantId&&authorize({...actor}),validate:input=>!!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1&&Object.hasOwn(input,'action')&&((input as {action?:unknown}).action==='start'||(input as {action?:unknown}).action==='stop'),execute:async(input,context)=>{
  const actor={tenantId:context.tenantId,principalId:context.principalId},action=(input as {action:'start'|'stop'}).action;
  await bounded(async signal=>{const check=()=>{if(signal.aborted)throw Error('Rollout poller unavailable');},permit=async()=>{check();if(actor.tenantId!==scope.tenantId||await authorize({...actor})!==true)throw Error('Capability forbidden');check();if(await authorizeControl({...actor},{...scope},action,signal)!==true)throw Error('Capability forbidden');check();};const requireIdle=async()=>{if(action!=='start'||poller.isRunning())return;let state;try{state=await rollout.getState();}catch{check();throw Error('Rollout poller unavailable');}check();if(state.phase!=='idle')throw Error('Rollout poller requires review');};await permit();await requireIdle();await permit();await requireIdle();check();});
  if(action==='start'){if(!poller.isRunning())poller.start();}else await poller.stop();return poller.getStatus();
 }});
}
