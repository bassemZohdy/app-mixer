import {createRecordJsonSchemaValidator} from './record-json-schema.js';
import {createRecordFieldValidator,type RecordField} from './record-field-validator.js';
import {CapabilityRegistry, type CapabilityCandidate} from './capabilities.js';
import {checkKey, type DataProvider} from './data-provider.js';
import {createBoundedOperation} from './bounded-operation.js';

type PolicyContext={tenantId:string;principalId:string};
export type DataCapabilityOptions={
  candidate:CapabilityCandidate;
  applicationId:string;
  collection:string;
  operation:'get'|'put'|'delete';
  authorize:(context:PolicyContext,signal:AbortSignal)=>boolean|Promise<boolean>;
  validate:(input:unknown,signal:AbortSignal)=>boolean|Promise<boolean>;
  fields?:RecordField[];
  jsonSchema?:unknown;
  allowAdditionalFields?:boolean;
  authorizeRecord?:(context:PolicyContext, input:unknown,signal:AbortSignal)=>boolean|Promise<boolean>;
  policyTimeoutMs?:number;
  maxPendingPolicies?:number;
};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value:Record<string,unknown>,names:string[])=>Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const id=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<Number.MAX_SAFE_INTEGER;

/** Install one host-approved collection operation in the normal capability boundary. */
export function registerDataCapability(registry:CapabilityRegistry, provider:DataProvider, options:DataCapabilityOptions):void {
  if(!(registry instanceof CapabilityRegistry)||!provider||typeof provider.get!=='function'||typeof provider.put!=='function'||typeof provider.delete!=='function'||!options||!['get','put','delete'].includes(options.operation)||typeof options.authorize!=='function'||typeof options.validate!=='function'||(options.authorizeRecord!==undefined&&typeof options.authorizeRecord!=='function'))throw Error('Invalid data capability');
  const {applicationId,collection,operation,authorize,validate,authorizeRecord}=options;
  const runPolicy=createBoundedOperation(options.policyTimeoutMs,options.maxPendingPolicies,'Invalid data capability','Data capability unavailable');
  const checkPolicy=(callback:(signal:AbortSignal)=>boolean|Promise<boolean>)=>runPolicy(async signal=>{const result=await callback(signal);if(signal.aborted)throw Error('Data capability unavailable');return result===true;});
  if(((options.fields!==undefined||options.jsonSchema!==undefined)&&operation!=='put')||(options.fields!==undefined&&options.jsonSchema!==undefined)||(options.allowAdditionalFields!==undefined&&options.fields===undefined))throw Error('Invalid data capability schema');
  const validateFields=options.fields===undefined?undefined:createRecordFieldValidator(options.fields,{...(options.allowAdditionalFields===undefined?{}:{allowAdditionalFields:options.allowAdditionalFields})});
  const validateSchema=options.jsonSchema===undefined?undefined:createRecordJsonSchemaValidator(options.jsonSchema);
  checkKey({tenantId:'validation',applicationId},collection,'validation');
  registry.register(options.candidate,{
    authorize:context=>checkPolicy(signal=>authorize(context,signal)),
    ...(authorizeRecord?{authorizeInput:(context:PolicyContext,input:unknown)=>checkPolicy(signal=>authorizeRecord(context,input,signal))}:{}),
    validate:async input=>{
      if(!record(input)||!id(input.id))return false;
      const base=operation==='get'?['id']:operation==='delete'?['id','expectedRevision']:['id','expectedRevision','value'];
      const hasSchema=Object.hasOwn(input,'expectedSchemaVersion');
      const shape=fields(input,hasSchema?[...base,'expectedSchemaVersion']:base)&&(!hasSchema||(Number.isSafeInteger(input.expectedSchemaVersion)&&Number(input.expectedSchemaVersion)>=0))&&(operation==='get'||(operation==='delete'?revision(input.expectedRevision):(input.expectedRevision===null||revision(input.expectedRevision))&&record(input.value)));
      return shape && (!validateFields||validateFields(input.value)) && (!validateSchema||validateSchema(input.value)) && await checkPolicy(signal=>validate(structuredClone(input),signal));
    },
    execute:(input,context)=>{
      const value=input as {id:string;expectedRevision:number|null;value:Record<string,unknown>;expectedSchemaVersion?:number};
      const scope={tenantId:context.tenantId,applicationId};
      if(operation==='get'){if(value.expectedSchemaVersion!==undefined&&provider.supportsSchemaRead!==true)throw Error('Data schema guard unavailable');return provider.get(scope,collection,value.id,value.expectedSchemaVersion)??null;}
      if(operation==='put')return provider.put(scope,collection,value.id,value.value,value.expectedRevision,value.expectedSchemaVersion);
      provider.delete(scope,collection,value.id,value.expectedRevision as number,value.expectedSchemaVersion);return null;
    }
  });
}
