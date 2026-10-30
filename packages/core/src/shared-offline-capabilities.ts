import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {checkKey,dataCopy} from './data-provider.js';
import {PostgresOfflineRequestKeys} from './postgres-offline-request-keys.js';
import {PostgresOfflineExecutions} from './postgres-offline-executions.js';

type Actor={tenantId:string;principalId:string};
type Options={candidate:CapabilityCandidate;applicationId:string;targetOperationId:string;executions?:PostgresOfflineExecutions;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizePayload:(actor:Actor,payload:Record<string,unknown>)=>boolean|Promise<boolean>;validatePayload:(payload:Record<string,unknown>)=>boolean|Promise<boolean>};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function prepare(registry:CapabilityRegistry,store:PostgresOfflineRequestKeys,options:Options):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof PostgresOfflineRequestKeys)||!options||typeof options.authorize!=='function'||typeof options.authorizePayload!=='function'||typeof options.validatePayload!=='function'||(options.executions!==undefined&&(!(options.executions instanceof PostgresOfflineExecutions)||!options.executions.usesKeys(store))))throw Error('Invalid shared offline capability');
 checkKey({tenantId:'validation',applicationId:options.applicationId},options.targetOperationId,'validation');
}
function binding(options:Options,field:'requestKey'|'idempotencyKey'){
 const {authorize,authorizePayload,validatePayload,applicationId,targetOperationId}=options;
 return {
  authorize,
  validate:async(input:unknown)=>{if(!record(input)||Object.keys(input).length!==2||!Object.hasOwn(input,field)||!Object.hasOwn(input,'payload')||typeof input[field]!=='string'||(field==='idempotencyKey'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input[field] as string)))return false;try{checkKey({tenantId:'validation',applicationId},targetOperationId,input[field] as string);const payload=dataCopy(input.payload);return await validatePayload(payload)===true;}catch{return false;}},
  authorizeInput:(actor:Actor,input:unknown)=>authorizePayload(actor,dataCopy((input as Record<string,unknown>).payload))
 };
}
/** Bind one host-approved operation; tenant and principal come only from capability authentication. */
export function registerSharedOfflineAllocation(registry:CapabilityRegistry,store:PostgresOfflineRequestKeys,options:Options):void{
 prepare(registry,store,options);const {applicationId,targetOperationId}=options;
 registry.register(options.candidate,{...binding(options,'requestKey'),execute:async(input,actor)=>{const value=input as {requestKey:string;payload:Record<string,unknown>};return {idempotencyKey:await store.allocate({tenantId:actor.tenantId,applicationId},actor.principalId,targetOperationId,value.requestKey,value.payload)};}});
}
/** Check a shared key before forwarding through a separate authorized capability registry. */
export function registerSharedOfflineDispatch(registry:CapabilityRegistry,external:CapabilityRegistry,store:PostgresOfflineRequestKeys,options:Options):void{
 prepare(registry,store,options);if(!(external instanceof CapabilityRegistry)||external===registry)throw Error('Invalid shared offline capability');const {applicationId,targetOperationId,executions}=options;
 registry.register(options.candidate,{...binding(options,'idempotencyKey'),execute:async(input,actor)=>{const value=input as {idempotencyKey:string;payload:Record<string,unknown>},scope={tenantId:actor.tenantId,applicationId},forward=(payload:Record<string,unknown>)=>external.invoke(targetOperationId,{idempotencyKey:value.idempotencyKey,payload},{...actor,origin:'service'});if(executions)return executions.execute(scope,actor.principalId,targetOperationId,value.payload,value.idempotencyKey,forward);if(!await store.verify(scope,actor.principalId,targetOperationId,value.payload,value.idempotencyKey))throw Error('Shared offline key forbidden');return forward(value.payload);}});
}
export type {Options as SharedOfflineCapabilityOptions};
