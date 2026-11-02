import {CapabilityRegistry, type CapabilityCandidate} from './capabilities.js';
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
 authorizeOperation:(actor:PolicyContext,operation:StagedOperation,reference:string)=>boolean|Promise<boolean>;
 verify:(actor:PolicyContext,operation:StagedOperation)=>StagedVerificationOutcome|Promise<StagedVerificationOutcome>;
};
export function registerStagedVerificationCapability(registry:CapabilityRegistry,store:SqliteStagedOperations,options:StagedVerificationCapabilityOptions):void{
 if(!(registry instanceof CapabilityRegistry)||!(store instanceof SqliteStagedOperations)||!options||typeof options.authorize!=='function'||typeof options.authorizeOperation!=='function'||typeof options.verify!=='function')throw Error('Invalid staged verification capability');
 const {applicationId,externalOperationId,authorize,authorizeOperation,verify}=options;checkKey({tenantId:'validation',applicationId},externalOperationId,'validation');
 registry.register(options.candidate,{authorize,validate:input=>record(input)&&Object.keys(input).length===2&&Object.hasOwn(input,'id')&&Object.hasOwn(input,'reference')&&id(input.id)&&id(input.reference),execute:async(input,context)=>{
  const value=input as {id:string;reference:string},actor={tenantId:context.tenantId,principalId:context.principalId},scope={tenantId:actor.tenantId,applicationId},staged=store.get(scope,value.id);
  if(!staged||staged.operationId!==externalOperationId)throw Error('Operation not found');
  const permitted=async(operation:StagedOperation)=>await authorize({...actor})===true&&await authorizeOperation({...actor},structuredClone(operation),value.reference)===true;
  if(!await permitted(staged))throw Error('Capability forbidden');
  const outcome=await store.verifyAndReconcile(scope,value.id,async(_scope,operation)=>{
   if(operation.operationId!==externalOperationId||!await permitted(operation))throw Error('Capability forbidden');
   const result=await verify({...actor},structuredClone(operation));
   if(!await permitted(operation))throw Error('Capability forbidden');return result;
  },{principalId:actor.principalId,reference:value.reference});
  return {outcome};
 }});
}
