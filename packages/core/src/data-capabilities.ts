import {CapabilityRegistry, type CapabilityCandidate} from './capabilities.js';
import {checkKey, type DataProvider} from './data-provider.js';

type PolicyContext={tenantId:string;principalId:string};
export type DataCapabilityOptions={
  candidate:CapabilityCandidate;
  applicationId:string;
  collection:string;
  operation:'get'|'put'|'delete';
  authorize:(context:PolicyContext)=>boolean|Promise<boolean>;
  validate:(input:unknown)=>boolean|Promise<boolean>;
  authorizeRecord?:(context:PolicyContext, input:unknown)=>boolean|Promise<boolean>;
};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value:Record<string,unknown>,names:string[])=>Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const id=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<Number.MAX_SAFE_INTEGER;

/** Install one host-approved collection operation in the normal capability boundary. */
export function registerDataCapability(registry:CapabilityRegistry, provider:DataProvider, options:DataCapabilityOptions):void {
  if(!(registry instanceof CapabilityRegistry)||!provider||typeof provider.get!=='function'||typeof provider.put!=='function'||typeof provider.delete!=='function'||!options||!['get','put','delete'].includes(options.operation)||typeof options.authorize!=='function'||typeof options.validate!=='function'||(options.authorizeRecord!==undefined&&typeof options.authorizeRecord!=='function'))throw Error('Invalid data capability');
  const {applicationId,collection,operation,authorize,validate,authorizeRecord}=options;
  checkKey({tenantId:'validation',applicationId},collection,'validation');
  registry.register(options.candidate,{
    authorize,
    ...(authorizeRecord?{authorizeInput:authorizeRecord}:{}),
    validate:async input=>{
      if(!record(input)||!id(input.id))return false;
      const base=operation==='get'?['id']:operation==='delete'?['id','expectedRevision']:['id','expectedRevision','value'];
      const hasSchema=operation!=='get'&&Object.hasOwn(input,'expectedSchemaVersion');
      const shape=fields(input,hasSchema?[...base,'expectedSchemaVersion']:base)&&(!hasSchema||(Number.isSafeInteger(input.expectedSchemaVersion)&&Number(input.expectedSchemaVersion)>=0))&&(operation==='get'||(operation==='delete'?revision(input.expectedRevision):(input.expectedRevision===null||revision(input.expectedRevision))&&record(input.value)));
      return shape && await validate(structuredClone(input))===true;
    },
    execute:(input,context)=>{
      const value=input as {id:string;expectedRevision:number|null;value:Record<string,unknown>;expectedSchemaVersion?:number};
      const scope={tenantId:context.tenantId,applicationId};
      if(operation==='get')return provider.get(scope,collection,value.id)??null;
      if(operation==='put')return provider.put(scope,collection,value.id,value.value,value.expectedRevision,value.expectedSchemaVersion);
      provider.delete(scope,collection,value.id,value.expectedRevision as number,value.expectedSchemaVersion);return null;
    }
  });
}
