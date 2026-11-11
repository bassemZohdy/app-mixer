import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {SqliteRemoteRollout,type RemoteRolloutScope} from './remote-rollout.js';
import {PostgresRemoteRollout} from './postgres-remote-rollout.js';
import {AppMixerError} from './errors.js';

type Actor={tenantId:string;principalId:string};
export type RemoteRolloutStatusCapabilityOptions={candidate:CapabilityCandidate;scope:RemoteRolloutScope;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeStatus:(actor:Actor,scope:RemoteRolloutScope,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
const valid=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
/** Read one host-fixed rollout gate without exposing its internal claim token. */
export function registerRemoteRolloutStatusCapability(registry:CapabilityRegistry,rollout:SqliteRemoteRollout|PostgresRemoteRollout,options:RemoteRolloutStatusCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(rollout instanceof SqliteRemoteRollout||rollout instanceof PostgresRemoteRollout)||!options||!options.scope||![options.scope.tenantId,options.scope.applicationId,options.scope.sourceEnvironment,options.scope.targetEnvironment].every(valid)||typeof options.authorize!=='function'||typeof options.authorizeStatus!=='function')throw Error('Invalid rollout status capability');
 const scope={tenantId:options.scope.tenantId,applicationId:options.scope.applicationId,sourceEnvironment:options.scope.sourceEnvironment,targetEnvironment:options.scope.targetEnvironment},authorize=options.authorize,authorizeStatus=options.authorizeStatus;if(!rollout.isBoundTo(scope))throw Error('Invalid rollout status capability');
 const bounded=createBoundedOperation(options.timeoutMs,options.maxPending,'Invalid rollout status capability','Rollout status unavailable');
 registry.register(options.candidate,{authorize:actor=>actor.tenantId===scope.tenantId&&authorize({...actor}),validate:input=>!!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===0,execute:async(_input,context)=>bounded(async signal=>{
  const actor={tenantId:context.tenantId,principalId:context.principalId},active=()=>{if(signal.aborted)throw new AppMixerError('unavailable','Rollout status unavailable');},permit=async()=>{active();if(actor.tenantId!==scope.tenantId||await authorize({...actor})!==true)throw new AppMixerError('denied','Capability forbidden');active();if(await authorizeStatus({...actor},{...scope},signal)!==true)throw new AppMixerError('denied','Capability forbidden');active();};
  await permit();const before=await rollout.getState();active();await permit();const after=await rollout.getState();active();if(JSON.stringify(before)!==JSON.stringify(after))throw new AppMixerError('conflict','Rollout status changed');
  const {phase,sourceVersion,expectedVersion,token}=after,version=(value:unknown,min:number)=>Number.isSafeInteger(value)&&Number(value)>=min;
  if((phase==='idle'&&(token!==null||sourceVersion!==null||expectedVersion!==null))||(phase==='running'&&(!valid(token)||sourceVersion!==null||expectedVersion!==null))||(['importing','uncertain'].includes(phase)&&(!valid(token)||!version(sourceVersion,1)||!version(expectedVersion,0)))||!['idle','running','importing','uncertain'].includes(phase))throw new AppMixerError('unavailable','Rollout status unavailable');
  return {phase,sourceVersion,expectedVersion};
 })});
}
