import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {checkKey,dataCopy} from './data-provider.js';
import {PostgresOfflineSlots} from './postgres-offline-slots.js';

type Actor={tenantId:string;principalId:string};
type Action='open'|'reset'|'allocate'|'restore';
type Options={candidate:CapabilityCandidate;applicationId:string;targetOperationId:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeSlot:(actor:Actor,slot:string,action:Action)=>boolean|Promise<boolean>;authorizePayload:(actor:Actor,payload:Record<string,unknown>,action:'allocate'|'restore')=>boolean|Promise<boolean>;validatePayload:(payload:Record<string,unknown>)=>boolean|Promise<boolean>};
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
/** Host selects one target operation and authorizes every actor, slot and payload. */
export function registerSharedOfflineSlotCapability(registry:CapabilityRegistry,store:PostgresOfflineSlots,options:Options):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof PostgresOfflineSlots)||!options||typeof options.authorize!=='function'||typeof options.authorizeSlot!=='function'||typeof options.authorizePayload!=='function'||typeof options.validatePayload!=='function')throw Error('Invalid shared offline slot capability');
 const {candidate,applicationId,targetOperationId,authorize,authorizeSlot,authorizePayload,validatePayload}=options;checkKey({tenantId:'validation',applicationId},targetOperationId,'validation');
 registry.register(candidate,{
  authorize,
  validate:async input=>{if(!record(input)||typeof input.action!=='string'||typeof input.slot!=='string')return false;const action=input.action,fields=action==='open'?['action','slot']:action==='reset'?['action','slot','expectedRequestKey']:action==='allocate'?['action','slot','expectedRequestKey','payload']:action==='restore'?['action','slot','expectedRequestKey','requestKey','idempotencyKey','payload']:[];if(!fields.length||Object.keys(input).length!==fields.length||!fields.every(name=>Object.hasOwn(input,name))||(action!=='open'&&!uuid(input.expectedRequestKey))||(action==='restore'&&(!uuid(input.requestKey)||!uuid(input.idempotencyKey))))return false;try{checkKey({tenantId:'validation',applicationId},'slot',input.slot);return action==='allocate'||action==='restore'?await validatePayload(dataCopy(input.payload))===true:true;}catch{return false;}},
  authorizeInput:async(actor,input)=>{const value=input as {action:Action;slot:string;payload?:unknown};if(await authorizeSlot({...actor},value.slot,value.action)!==true)return false;return value.action==='allocate'||value.action==='restore'?await authorizePayload({...actor},dataCopy(value.payload),value.action)===true:true;},
  execute:async(input,actor)=>{const value=input as {action:Action;slot:string;expectedRequestKey:string;requestKey:string;idempotencyKey:string;payload:Record<string,unknown>},scope={tenantId:actor.tenantId,applicationId};if(value.action==='open')return {requestKey:await store.open(scope,actor.principalId,value.slot)};if(value.action==='reset')return {requestKey:await store.reset(scope,actor.principalId,value.slot,value.expectedRequestKey)};if(value.action==='allocate')return store.allocate(scope,actor.principalId,value.slot,value.expectedRequestKey,targetOperationId,value.payload);return {requestKey:await store.restore(scope,actor.principalId,value.slot,value.expectedRequestKey,targetOperationId,value.payload,{requestKey:value.requestKey,idempotencyKey:value.idempotencyKey})};}
 });
}
export type {Action as SharedOfflineSlotAction,Options as SharedOfflineSlotCapabilityOptions};
