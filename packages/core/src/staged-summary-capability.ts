import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {checkKey} from './data-provider.js';
import {SqliteStagedOperations} from './staged-operations.js';

type Actor={tenantId:string;principalId:string};
type AggregateScope={tenantId:string;applicationId:string;externalOperationId:string};
export type StagedSummaryCapabilityOptions={candidate:CapabilityCandidate;applicationId:string;externalOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeAggregate:(actor:Actor,scope:AggregateScope,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};

/** Authorized counts for the whole fixed operation scope; not a per-record filtered listing. */
export function registerStagedSummaryCapability(registry:CapabilityRegistry,store:SqliteStagedOperations,options:StagedSummaryCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof SqliteStagedOperations)||!options||typeof options.authorize!=='function'||typeof options.authorizeAggregate!=='function')throw Error('Invalid staged summary capability');
 const {applicationId,externalOperationId,authorize,authorizeAggregate,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},externalOperationId,'validation');const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid staged summary capability','Staged summary unavailable');
 registry.register(options.candidate,{authorize,validate:input=>!!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===0,execute:async(_input,context)=>{
  const actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId,externalOperationId};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Staged summary unavailable');};const permit=async()=>{active();const actorAllowed=await authorize({...actor});active();if(actorAllowed!==true)throw Error('Capability forbidden');const aggregateAllowed=await authorizeAggregate({...actor},{...scope},signal);active();if(aggregateAllowed!==true)throw Error('Capability forbidden');};
   await permit();active();const counts=store.countByStatus(scope,externalOperationId);await permit();active();return {counts};
  });
 }});
}
