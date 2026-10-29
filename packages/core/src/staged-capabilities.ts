import {CapabilityRegistry, type CapabilityCandidate} from './capabilities.js';
import {checkKey} from './data-provider.js';
import {SqliteStagedOperations} from './staged-operations.js';

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
      if(!record(input)||Object.keys(input).length!==1)return false;
      if(operation==='stage' ? !Object.hasOwn(input,'payload')||!record(input.payload) : !Object.hasOwn(input,'id')||!id(input.id))return false;
      return await validate(structuredClone(input))===true;
    },
    execute:async(input,context)=>{
      const value=input as {id:string;payload:Record<string,unknown>},scope={tenantId:context.tenantId,applicationId};
      if(operation==='stage')return store.stage(scope,externalOperationId,value.payload);
      const staged=store.get(scope,value.id);
      if(!staged||staged.operationId!==externalOperationId){if(operation==='get')return null;throw Error('Operation not found');}
      if(operation==='get')return staged;
      return store.submit(scope,value.id,external,{...context,origin:'service'});
    }
  });
}
