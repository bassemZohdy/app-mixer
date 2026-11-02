import {CapabilityRegistry, type CapabilityCandidate} from './capabilities.js';
import {createBoundedOperation} from './bounded-operation.js';
import {checkKey} from './data-provider.js';
import {SqliteStagedOperations,type StagedOperation,type StagedVerificationOutcome} from './staged-operations.js';

type PolicyContext={tenantId:string;principalId:string};
export type StagedCapabilityOptions={
  candidate:CapabilityCandidate;
  applicationId:string;
  externalOperationId:string;
  operation:'stage'|'get'|'submit';
  authorize:(context:PolicyContext)=>boolean|Promise<boolean>;
  validate:(input:unknown)=>boolean|Promise<boolean>;
  authorizeInput?:(context:PolicyContext,input:unknown)=>boolean|Promise<boolean>;
};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);

/** Expose one host-selected staged operation through the authenticated capability boundary. */
export function registerStagedCapability(registry:CapabilityRegistry, external:CapabilityRegistry, store:SqliteStagedOperations, options:StagedCapabilityOptions):void {
  if(!(registry instanceof CapabilityRegistry)||!(external instanceof CapabilityRegistry)||!(store instanceof SqliteStagedOperations)||!options||!['stage','get','submit'].includes(options.operation)||typeof options.authorize!=='function'||typeof options.validate!=='function'||(options.authorizeInput!==undefined&&typeof options.authorizeInput!=='function'))throw Error('Invalid staged capability');
  const {applicationId,externalOperationId,operation,authorize,validate,authorizeInput}=options;
  checkKey({tenantId:'validation',applicationId},externalOperationId,'validation');
  if(options.candidate?.operationId===externalOperationId&&registry===external)throw Error('Staged capability conflicts with external operation');
  registry.register(options.candidate,{
    authorize,
    ...(authorizeInput?{authorizeInput}:{}),
    validate:async input=>{
      if(!record(input))return false;
      if(operation==='stage'){
        if(!Object.hasOwn(input,'payload')||!record(input.payload)||Object.keys(input).some(key=>!['payload','requestKey'].includes(key))||(Object.hasOwn(input,'requestKey')&&!id(input.requestKey)))return false;
      } else if(Object.keys(input).length!==1||!Object.hasOwn(input,'id')||!id(input.id))return false;
      return await validate(structuredClone(input))===true;
    },
    execute:async(input,context)=>{
      const value=input as {id:string;payload:Record<string,unknown>;requestKey?:string},scope={tenantId:context.tenantId,applicationId};
      if(operation==='stage')return store.stage(scope,externalOperationId,value.payload,value.requestKey);
      const staged=store.get(scope,value.id);
      if(!staged||staged.operationId!==externalOperationId){if(operation==='get')return null;throw Error('Operation not found');}
      if(operation==='get')return staged;
      return store.submit(scope,value.id,external,{...context,origin:'service'});
    }
  });
}

/** Host-fixed provider verification with authenticated, evidence-bearing reconciliation. */
export type StagedVerificationCapabilityOptions={
 candidate:CapabilityCandidate;applicationId:string;externalOperationId:string;
 authorize:(actor:PolicyContext)=>boolean|Promise<boolean>;
 authorizeOperation:(actor:PolicyContext,operation:StagedOperation,reference:string,signal:AbortSignal)=>boolean|Promise<boolean>;
 verify:(actor:PolicyContext,operation:StagedOperation,signal:AbortSignal)=>StagedVerificationOutcome|Promise<StagedVerificationOutcome>;
 timeoutMs?:number;maxPending?:number;
};
export function registerStagedVerificationCapability(registry:CapabilityRegistry,store:SqliteStagedOperations,options:StagedVerificationCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof SqliteStagedOperations)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function'||typeof options.verify!=='function')throw Error('Invalid staged verification capability');
 const {applicationId,externalOperationId,authorize,authorizeOperation,verify,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},externalOperationId,'validation');
 const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid staged verification capability','Staged verification unavailable');
 registry.register(options.candidate,{authorize,validate:input=>record(input)&&Object.keys(input).length===2&&Object.hasOwn(input,'id')&&Object.hasOwn(input,'reference')&&id(input.id)&&id(input.reference),execute:async(input,context)=>{
  const value=input as {id:string;reference:string},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};
  return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Staged verification unavailable');};
   const staged=store.get(scope,value.id);if(!staged||staged.operationId!==externalOperationId)throw Error('Operation not found');
   const permitted=async(operation:StagedOperation)=>{active();const actorAllowed=await authorize({...actor});active();if(actorAllowed!==true)return false;const operationAllowed=await authorizeOperation({...actor},structuredClone(operation),value.reference,signal);active();return operationAllowed===true;};
   if(!await permitted(staged))throw Error('Capability forbidden');active();
   const outcome=await store.verifyAndReconcile(scope,value.id,async(_scope,operation)=>{
    if(operation.operationId!==externalOperationId||!await permitted(operation))throw Error('Capability forbidden');active();
    const result=await verify({...actor},structuredClone(operation),signal);active();
    if(!await permitted(operation))throw Error('Capability forbidden');active();return result;
   },{principalId:actor.principalId,reference:value.reference});
   return {outcome};
  });
 }});
}

/** Host-authorized access to all reconciliation evidence for one staged operation. */
export type StagedEvidenceCapabilityOptions={
 candidate:CapabilityCandidate;applicationId:string;externalOperationId:string;
 authorize:(actor:PolicyContext)=>boolean|Promise<boolean>;
 authorizeOperation:(actor:PolicyContext,operation:StagedOperation,signal:AbortSignal)=>boolean|Promise<boolean>;
 timeoutMs?:number;maxPending?:number;
};
export function registerStagedEvidenceCapability(registry:CapabilityRegistry,store:SqliteStagedOperations,options:StagedEvidenceCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof SqliteStagedOperations)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function')throw Error('Invalid staged evidence capability');
 const {applicationId,externalOperationId,authorize,authorizeOperation,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},externalOperationId,'validation');
 const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid staged evidence capability','Staged evidence unavailable');
 registry.register(options.candidate,{authorize,validate:input=>record(input)&&Object.keys(input).every(key=>['id','after','limit'].includes(key))&&Object.hasOwn(input,'id')&&id(input.id)&&(input.after===undefined||(Number.isSafeInteger(input.after)&&Number(input.after)>=0))&&(input.limit===undefined||(Number.isSafeInteger(input.limit)&&Number(input.limit)>=1&&Number(input.limit)<=99)),execute:async(input,context)=>{
  const value=input as {id:string;after?:number;limit?:number},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};
  return runBounded(async signal=>{const active=()=>{if(signal.aborted)throw Error('Staged evidence unavailable');};const permit=async()=>{active();const operation=store.get(scope,value.id);if(!operation||operation.operationId!==externalOperationId)throw Error('Operation not found');const actorAllowed=await authorize({...actor});active();if(actorAllowed!==true)throw Error('Capability forbidden');const operationAllowed=await authorizeOperation({...actor},structuredClone(operation),signal);active();if(operationAllowed!==true)throw Error('Capability forbidden');};
   await permit();active();const limit=value.limit??50,rows=store.listReconciliationEvidence(scope,value.id,{after:value.after,limit:limit+1});await permit();active();const items=rows.slice(0,limit);return {items,...(rows.length>limit?{nextAfter:items.at(-1)!.revision}:{})};
  });
 }});
}

/** Explicit host-confirmed recovery of an abandoned submission. */
export type StagedRecoveryCapabilityOptions={
 candidate:CapabilityCandidate;applicationId:string;externalOperationId:string;
 authorize:(actor:PolicyContext)=>boolean|Promise<boolean>;
 authorizeOperation:(actor:PolicyContext,operation:StagedOperation,reference:string,signal:AbortSignal)=>boolean|Promise<boolean>;
 verifyStopped:(actor:PolicyContext,operation:StagedOperation,signal:AbortSignal)=>boolean|Promise<boolean>;
 timeoutMs?:number;maxPending?:number;
};
export function registerStagedRecoveryCapability(registry:CapabilityRegistry,store:SqliteStagedOperations,options:StagedRecoveryCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof SqliteStagedOperations)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function'||typeof options.verifyStopped!=='function')throw Error('Invalid staged recovery capability');
 const {applicationId,externalOperationId,authorize,authorizeOperation,verifyStopped,timeoutMs,maxPending}=options;checkKey({tenantId:'validation',applicationId},externalOperationId,'validation');const runBounded=createBoundedOperation(timeoutMs,maxPending,'Invalid staged recovery capability','Staged recovery unavailable');
 registry.register(options.candidate,{authorize,validate:input=>record(input)&&Object.keys(input).length===2&&Object.hasOwn(input,'id')&&Object.hasOwn(input,'reference')&&id(input.id)&&id(input.reference),execute:async(input,context)=>{
  const value=input as {id:string;reference:string},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId};return runBounded(async signal=>{
   const active=()=>{if(signal.aborted)throw Error('Staged recovery unavailable');},staged=store.get(scope,value.id);if(!staged||staged.operationId!==externalOperationId)throw Error('Operation not found');
   const permitted=async(operation:StagedOperation)=>{active();const actorAllowed=await authorize({...actor});active();if(actorAllowed!==true)return false;const operationAllowed=await authorizeOperation({...actor},structuredClone(operation),value.reference,signal);active();return operationAllowed===true;};
   if(!await permitted(staged))throw Error('Capability forbidden');active();const recovered=await store.verifyAndRecoverAbandoned(scope,value.id,async(_scope,operation)=>{if(operation.operationId!==externalOperationId||!await permitted(operation))throw Error('Capability forbidden');active();const confirmed=await verifyStopped({...actor},structuredClone(operation),signal);active();if(!await permitted(operation))throw Error('Capability forbidden');active();return confirmed;},{principalId:actor.principalId,reference:value.reference});return {recovered};
  });
 }});
}
