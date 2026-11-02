import {createBoundedOperation} from './bounded-operation.js';
import {SqliteRemoteRollout,type RemoteRolloutScope} from './remote-rollout.js';
import {PostgresRemoteRollout} from './postgres-remote-rollout.js';

type Actor={tenantId:string;principalId:string};
export type RemoteRolloutMetricPhase='idle'|'running'|'importing'|'uncertain';
export type RemoteRolloutMetricsOptions={scope:RemoteRolloutScope;authorize:(actor:Actor,scope:RemoteRolloutScope,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
const valid=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const phases:RemoteRolloutMetricPhase[]=['idle','running','importing','uncertain'];

/** One host-fixed, separately authorized rollout-gate gauge without identifying labels. */
export class RemoteRolloutMetrics {
 private readonly rollout:SqliteRemoteRollout|PostgresRemoteRollout;private readonly scope:RemoteRolloutScope;private readonly authorize:RemoteRolloutMetricsOptions['authorize'];private readonly bounded:ReturnType<typeof createBoundedOperation>;
 constructor(rollout:SqliteRemoteRollout|PostgresRemoteRollout,options:RemoteRolloutMetricsOptions){
  if(!(rollout instanceof SqliteRemoteRollout||rollout instanceof PostgresRemoteRollout)||!options||!options.scope||![options.scope.tenantId,options.scope.applicationId,options.scope.sourceEnvironment,options.scope.targetEnvironment].every(valid)||typeof options.authorize!=='function')throw Error('Invalid rollout metrics');
  this.scope={tenantId:options.scope.tenantId,applicationId:options.scope.applicationId,sourceEnvironment:options.scope.sourceEnvironment,targetEnvironment:options.scope.targetEnvironment};if(!rollout.isBoundTo(this.scope))throw Error('Invalid rollout metrics');this.rollout=rollout;this.authorize=options.authorize;this.bounded=createBoundedOperation(options.timeoutMs,options.maxPending,'Invalid rollout metrics','Rollout metrics unavailable');
 }
 async snapshot(actor:Actor,signal?:AbortSignal):Promise<{phase:RemoteRolloutMetricPhase}>{
  if(!actor||actor.tenantId!==this.scope.tenantId||!valid(actor.principalId)||(signal!==undefined&&!(signal instanceof AbortSignal)))throw Error('Invalid rollout metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId};
  return this.bounded(async inner=>{const combined=signal?AbortSignal.any([inner,signal]):inner,check=()=>{if(combined.aborted)throw Error('Rollout metrics unavailable');},permit=async()=>{check();let allowed=false;try{allowed=await this.authorize({...who},{...this.scope},combined)===true;}catch{check();}check();if(!allowed)throw Error('Rollout metrics access denied');};await permit();const state=await this.rollout.getState();check();if(!state||!phases.includes(state.phase as RemoteRolloutMetricPhase))throw Error('Invalid rollout metrics data');await permit();return {phase:state.phase as RemoteRolloutMetricPhase};});
 }
 async render(actor:Actor):Promise<string>{return this.renderWithSignal(actor,new AbortController().signal);}
 async renderWithSignal(actor:Actor,signal:AbortSignal):Promise<string>{if(!(signal instanceof AbortSignal))throw Error('Invalid rollout metrics signal');const {phase}=await this.snapshot(actor,signal);return ['# HELP app_mixer_remote_rollout_gate Current state of one remote rollout recovery gate.','# TYPE app_mixer_remote_rollout_gate gauge',...phases.map(item=>`app_mixer_remote_rollout_gate{phase="${item}"} ${Number(item===phase)}`),''].join('\n');}
}
export type {Actor as RemoteRolloutMetricsActor};
