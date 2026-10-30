import {CapabilityRegistry,type CapabilityCandidate} from './capabilities.js';
import {PostgresExtensionApprovals,type ExtensionApprovalScope} from './postgres-extension-approvals.js';
import {isValidExtensionReferences,isValidExtensionOperations,type ExtensionReference,type ExtensionOperation} from './index.js';

type Actor={tenantId:string;principalId:string};
type Decision={allowed:boolean;expiresAt:number;expectedRevision:number};
type Page={after?:number;limit?:number};
type Base={store:PostgresExtensionApprovals;scope:ExtensionApprovalScope;reference:ExtensionReference;operation:ExtensionOperation;candidate:CapabilityCandidate;authorize:(actor:Actor)=>boolean|Promise<boolean>};
type DecisionOptions=Base&{authorizeDecision:(actor:Actor,decision:Decision)=>boolean|Promise<boolean>};
type ReadOptions=Base;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const query=(input:unknown):Record<string,unknown>|undefined=>object(input)&&Object.keys(input).length===1&&Object.hasOwn(input,'query')&&object(input.query)?input.query:undefined;
const decision=(input:unknown):Decision|undefined=>{const value=query(input);if(!value||Object.keys(value).length!==3||!['allowed','expiresAt','expectedRevision'].every(key=>Object.hasOwn(value,key))||typeof value.allowed!=='boolean'||!Number.isSafeInteger(value.expiresAt)||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<0||Number(value.expectedRevision)>=Number.MAX_SAFE_INTEGER||(value.allowed?Number(value.expiresAt)<=0:value.expiresAt!==0))return;return {allowed:value.allowed,expiresAt:Number(value.expiresAt),expectedRevision:Number(value.expectedRevision)};};
const page=(input:unknown):Page|undefined=>{const value=query(input);if(!value||Object.keys(value).some(key=>!['after','limit'].includes(key))||(value.after!==undefined&&(!Number.isSafeInteger(value.after)||Number(value.after)<0))||(value.limit!==undefined&&(!Number.isSafeInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>100)))return;return {...(value.after===undefined?{}:{after:Number(value.after)}),...(value.limit===undefined?{}:{limit:Number(value.limit)})};};
function snapshot(registry:CapabilityRegistry,options:Base,method:'GET'|'POST'){
 if(!(registry instanceof CapabilityRegistry)||!options||!(options.store instanceof PostgresExtensionApprovals)||!options.scope||!id(options.scope.tenantId)||!id(options.scope.applicationId)||!isValidExtensionReferences([options.reference])||!isValidExtensionOperations([options.operation])||options.operation.extensionId!==options.reference.id||!options.candidate||typeof options.candidate.method!=='string'||options.candidate.method.toUpperCase()!==method||typeof options.authorize!=='function')throw Error('Invalid extension approval capability');
 return {store:options.store,scope:structuredClone(options.scope),reference:structuredClone(options.reference),operation:structuredClone(options.operation),candidate:structuredClone(options.candidate),authorize:options.authorize};
}
/** Fixed-target administrative approval decisions; the store independently authorizes and audits. */
export function registerExtensionApprovalDecision(registry:CapabilityRegistry,options:DecisionOptions):void{
 const c=snapshot(registry,options,'POST');if(typeof options.authorizeDecision!=='function')throw Error('Invalid extension approval capability');const authorizeDecision=options.authorizeDecision;
 registry.register(c.candidate,{authorize:async actor=>actor.tenantId===c.scope.tenantId&&await c.authorize({...actor})===true,validate:input=>!!decision(input),authorizeInput:async(actor,input)=>{const safe=decision(input);return !!safe&&await c.authorize({...actor})===true&&await authorizeDecision({...actor},{...safe})===true&&await c.authorize({...actor})===true;},execute:async(input,actor)=>{const safe=decision(input);if(!safe)throw Error('Invalid extension approval decision');const revision=await c.store.decide({...actor},c.scope,c.reference,c.operation,safe);return {revision};}});
}
/** Fixed-target administrative status, with separate store inspection authorization. */
export function registerExtensionApprovalStatus(registry:CapabilityRegistry,options:ReadOptions):void{
 const c=snapshot(registry,options,'GET');registry.register(c.candidate,{authorize:async actor=>actor.tenantId===c.scope.tenantId&&await c.authorize({...actor})===true,validate:input=>{const value=query(input);return !!value&&Object.keys(value).length===0;},authorizeInput:actor=>c.authorize({...actor}),execute:async(_input,actor)=>{const state=await c.store.inspect({...actor},c.scope,c.reference,c.operation);if(await c.authorize({...actor})!==true)throw Error('Extension approval forbidden');return state??null;}});
}
/** Fixed-target audit history, with separate store audit authorization. */
export function registerExtensionApprovalHistory(registry:CapabilityRegistry,options:ReadOptions):void{
 const c=snapshot(registry,options,'GET');registry.register(c.candidate,{authorize:async actor=>actor.tenantId===c.scope.tenantId&&await c.authorize({...actor})===true,validate:input=>!!page(input),authorizeInput:actor=>c.authorize({...actor}),execute:async(input,actor)=>{const safe=page(input);if(!safe)throw Error('Invalid extension approval history');const result=await c.store.history({...actor},c.scope,c.reference,c.operation,safe);if(await c.authorize({...actor})!==true)throw Error('Extension approval forbidden');return result;}});
}
export type {DecisionOptions as ExtensionApprovalDecisionCapabilityOptions,ReadOptions as ExtensionApprovalReadCapabilityOptions};
