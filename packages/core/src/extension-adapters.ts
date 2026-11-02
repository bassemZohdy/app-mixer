import { ComponentRegistry, basicRegistry } from '@app-mixer/web';
import { CapabilityRegistry, type CapabilityCandidate, type CapabilityAuditSink } from './capabilities.js';
import { createBoundedOperation } from './bounded-operation.js';
import { ExtensionRegistry, createExtensionPublicationGuard, type ExtensionManifest, type ExtensionHost } from './extensions.js';
import { isValidExtensionOperations, validate, type ApplicationDefinition, type ExtensionOperation, type ExtensionReference } from './index.js';

export type ExtensionInvocationApproval=(context:{tenantId:string;principalId:string},reference:ExtensionReference,operation:ExtensionOperation)=>boolean|Promise<boolean>;
export type ExtensionInvocationApprovalWithSignal=(context:{tenantId:string;principalId:string},reference:ExtensionReference,operation:ExtensionOperation,signal:AbortSignal)=>boolean|Promise<boolean>;
type CapabilityPolicy = {authorize:(context:{tenantId:string;principalId:string})=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean|Promise<boolean>};
type DeclaredCapabilityPolicy = CapabilityPolicy & {authorizeWithSignal?:(context:{tenantId:string;principalId:string},signal:AbortSignal)=>boolean|Promise<boolean>;authorizeExtension?:ExtensionInvocationApproval;authorizeExtensionWithSignal?:ExtensionInvocationApprovalWithSignal;policyTimeoutMs?:number;maxPendingPolicies?:number;validateWithSignal?:(input:unknown,signal:AbortSignal)=>boolean|Promise<boolean>;validationTimeoutMs?:number;maxPendingValidations?:number};

/** Install a host-selected trusted extension component for an application. */
export function registerExtensionComponent(target: ComponentRegistry, extensions: ExtensionRegistry, references: ExtensionReference[], name: string, validate?: Parameters<ComponentRegistry['register']>[2]): void {
  const implementation = extensions.getForApplication(references, 'components', name);
  if (!implementation) throw Error('Extension component not available');
  target.register(name, implementation as unknown as Parameters<ComponentRegistry['register']>[1], validate);
}

/** Install an application-declared native extension into a host-owned native registry. */
export function registerDeclaredNativeExtensionComponent(
  target:{register:(name:string,render:(props:Record<string,unknown>)=>unknown,validate:(component:Record<string,unknown>)=>boolean)=>void},
  extensions:ExtensionRegistry, application:ApplicationDefinition, extensionId:string, name:string,
  validateComponent:(component:Record<string,unknown>)=>boolean
):void {
  const snapshot=structuredClone(application);validate(snapshot);
  if(!snapshot.pages.some(page=>page.components.some(component=>component.type==='Extension'&&component.extensionId===extensionId&&component.name===name)))throw Error('Extension component not declared');
  const implementation=extensions.getForExtension(snapshot.extensions??[],extensionId,'components',name);
  if(!implementation)throw Error('Extension component not available');
  target.register(name,implementation as unknown as (props:Record<string,unknown>)=>unknown,validateComponent);
}

/** Bind a host-selected extension tool to the normal capability policy, validation and audit boundary. */
export function registerExtensionCapability(
  target: CapabilityRegistry, extensions: ExtensionRegistry, references: ExtensionReference[], candidate: CapabilityCandidate,
  policy: CapabilityPolicy
): void {
  if(policy&&['authorizeExtension','authorizeExtensionWithSignal','authorizeWithSignal','policyTimeoutMs','maxPendingPolicies','validateWithSignal','validationTimeoutMs','maxPendingValidations'].some(key=>key in policy))throw Error('Live approval requires a declared extension capability');
  const implementation = extensions.getForApplication(references, 'tools', candidate.operationId);
  if (!implementation) throw Error('Extension tool not available');
  const execute = implementation as unknown as (input:unknown, context:{tenantId:string;principalId:string})=>unknown|Promise<unknown>;
  target.register(candidate, {authorize:policy?.authorize,validate:policy?.validate,execute});
}

/** Bind a declared tool or provider to a capability with host-supplied policy and validation. */
export function registerDeclaredExtensionCapability(
  target: CapabilityRegistry, extensions: ExtensionRegistry, application: ApplicationDefinition,
  operation: ExtensionOperation, candidate: CapabilityCandidate, policy: DeclaredCapabilityPolicy
): void {
  const operations=application?.extensionOperations;
  if(!isValidExtensionOperations(operations)||!isValidExtensionOperations([operation])||!operations.some(item=>item.extensionId===operation.extensionId&&item.kind===operation.kind&&item.name===operation.name)||candidate?.operationId!==operation.name)throw Error('Extension operation not declared');
  const implementation=extensions.getForExtension(application.extensions??[],operation.extensionId,operation.kind==='tool'?'tools':'providers',operation.name);
  if(!implementation)throw Error('Extension operation not available');
  if(!policy||typeof policy.authorize!=='function'||typeof policy.validate!=='function'||(policy.authorizeWithSignal!==undefined&&typeof policy.authorizeWithSignal!=='function')||(policy.authorizeExtension!==undefined&&typeof policy.authorizeExtension!=='function')||(policy.authorizeExtensionWithSignal!==undefined&&typeof policy.authorizeExtensionWithSignal!=='function')||(policy.validateWithSignal!==undefined&&typeof policy.validateWithSignal!=='function'))throw Error('Invalid extension capability policy');
  const reference=application.extensions?.find(item=>item.id===operation.extensionId);if(!reference)throw Error('Extension reference not available');
  const safeReference=structuredClone(reference),safeOperation=structuredClone(operation),{authorize,authorizeWithSignal,validate,validateWithSignal,authorizeExtension,authorizeExtensionWithSignal}=policy,bounded=createBoundedOperation(policy.policyTimeoutMs,policy.maxPendingPolicies,'Invalid extension capability policy','Extension policy unavailable'),boundedValidation=createBoundedOperation(policy.validationTimeoutMs,policy.maxPendingValidations,'Invalid extension capability policy','Extension validation unavailable');
  const permit=(context:{tenantId:string;principalId:string})=>bounded(async signal=>{const check=()=>{if(signal.aborted)throw Error('Extension policy unavailable');},scope=async()=>{check();const allowed=(authorizeWithSignal?await authorizeWithSignal({...context},signal):await authorize({...context}))===true;check();return allowed;},approval=async()=>{check();const allowed=authorizeExtensionWithSignal?await authorizeExtensionWithSignal({...context},structuredClone(safeReference),structuredClone(safeOperation),signal)===true:!authorizeExtension||await authorizeExtension({...context},structuredClone(safeReference),structuredClone(safeOperation))===true;check();return allowed;};return await scope()&&await approval()&&await scope()&&await approval();});
  const execute=implementation as unknown as (input:unknown,context:{tenantId:string;principalId:string})=>unknown|Promise<unknown>;
  const recheck=!!authorizeWithSignal||!!authorizeExtension||!!authorizeExtensionWithSignal||policy.policyTimeoutMs!==undefined||!!validateWithSignal||policy.validationTimeoutMs!==undefined,checkedValidate=validateWithSignal||policy.validationTimeoutMs!==undefined?(input:unknown)=>boundedValidation(async signal=>{if(signal.aborted)throw Error('Extension validation unavailable');const allowed=validateWithSignal?await validateWithSignal(input,signal):await validate(input);if(signal.aborted)throw Error('Extension validation unavailable');return allowed===true;}):validate;target.register(candidate,{authorize:recheck?permit:authorize,validate:checkedValidate,...(recheck?{authorizeInput:(context:{tenantId:string;principalId:string})=>permit(context)}:{}),execute});
}

export type ExtensionRuntimeBindings = {
  componentValidators?: Record<string, NonNullable<Parameters<ComponentRegistry['register']>[2]>>;
  operations: Record<string, {candidate:CapabilityCandidate} & DeclaredCapabilityPolicy>;
  authorizeExtension?: ExtensionInvocationApproval;
  authorizeExtensionWithSignal?: ExtensionInvocationApprovalWithSignal;
};

/** Construct fresh registries from a host-selected published definition. */
export function createExtensionRuntime(application:ApplicationDefinition, extensions:ExtensionRegistry, audit:CapabilityAuditSink, bindings:ExtensionRuntimeBindings): {components:ComponentRegistry;capabilities:CapabilityRegistry} {
  const snapshot=structuredClone(application);validate(snapshot);
  if(!bindings || !bindings.operations || typeof bindings.operations!=='object' || Array.isArray(bindings.operations) || (bindings.componentValidators!==undefined && (!bindings.componentValidators || typeof bindings.componentValidators!=='object' || Array.isArray(bindings.componentValidators))) || (bindings.authorizeExtension!==undefined && typeof bindings.authorizeExtension!=='function') || (bindings.authorizeExtensionWithSignal!==undefined && typeof bindings.authorizeExtensionWithSignal!=='function'))throw Error('Invalid extension runtime bindings');
  const references=snapshot.extensions??[];
  // Resolve every reference even if it contributes no components or operations.
  extensions.validateReferences(references);
  const components=basicRegistry(),capabilities=new CapabilityRegistry(audit),owners=new Map<string,string>();
  for(const page of snapshot.pages)for(const component of page.components){
    if(component.type!=='Extension')continue;
    const implementation=extensions.getForExtension(references,component.extensionId,'components',component.name);
    if(!implementation)throw Error('Extension component not available');
    if(owners.has(component.name)){
      if(owners.get(component.name)!==component.extensionId)throw Error('Duplicate extension component');
      continue;
    }
    const validator=bindings.componentValidators && Object.hasOwn(bindings.componentValidators,component.name) ? bindings.componentValidators[component.name] : undefined;
    components.register(component.name,implementation as unknown as Parameters<ComponentRegistry['register']>[1],validator);
    owners.set(component.name,component.extensionId);
  }
  for(const operation of snapshot.extensionOperations??[]){
    const binding=Object.hasOwn(bindings.operations,operation.name)?bindings.operations[operation.name]:undefined;
    if(!binding)throw Error('Extension operation policy missing');
    const globalApproval=bindings.authorizeExtension,globalSignal=bindings.authorizeExtensionWithSignal,operationApproval=binding.authorizeExtension,operationSignal=binding.authorizeExtensionWithSignal;
    if((operationApproval!==undefined&&typeof operationApproval!=='function')||(operationSignal!==undefined&&typeof operationSignal!=='function'))throw Error('Invalid extension capability policy');
    const authorizeExtensionWithSignal:ExtensionInvocationApprovalWithSignal|undefined=globalApproval||globalSignal||operationApproval||operationSignal?async(actor,reference,declared,signal)=>{const check=()=>{if(signal.aborted)throw Error('Extension policy unavailable');};check();const globalAllowed=globalSignal?await globalSignal({...actor},structuredClone(reference),structuredClone(declared),signal):!globalApproval||await globalApproval({...actor},structuredClone(reference),structuredClone(declared));check();if(globalAllowed!==true)return false;const operationAllowed=operationSignal?await operationSignal({...actor},structuredClone(reference),structuredClone(declared),signal):!operationApproval||await operationApproval({...actor},structuredClone(reference),structuredClone(declared));check();return operationAllowed===true;}:undefined;
    registerDeclaredExtensionCapability(capabilities,extensions,snapshot,operation,binding.candidate,{...binding,authorizeExtensionWithSignal});
  }
  return {components,capabilities};
}

export type FlutterExtensionPlan = {version:1; applicationId:string; revision:number; components:({name:string} & ExtensionReference)[]};

/** Produce metadata only; the host must select a published definition and authenticate delivery. */
export function createFlutterExtensionPlan(application:ApplicationDefinition, manifests:ExtensionManifest[], host:ExtensionHost):FlutterExtensionPlan {
  const snapshot=structuredClone(application);validate(snapshot);
  if(host?.renderer!=='flutter')throw Error('Flutter host required');
  const guard=createExtensionPublicationGuard(manifests,host,()=>({components:[],tools:[],providers:[]}));
  guard(snapshot);
  return checkedFlutterPlan(snapshot);
}

/** Build a Flutter plan from the registrations and approvals already checked by a host registry. */
export function createFlutterExtensionPlanFromRegistry(application:ApplicationDefinition,registry:ExtensionRegistry):FlutterExtensionPlan {
  const snapshot=structuredClone(application);validate(snapshot);
  if(!(registry instanceof ExtensionRegistry)||registry.getTarget().renderer!=='flutter')throw Error('Flutter host required');
  registry.createPublicationGuard(()=>({components:[],tools:[],providers:[]}))(snapshot);
  return checkedFlutterPlan(snapshot);
}

function checkedFlutterPlan(snapshot:ApplicationDefinition):FlutterExtensionPlan {
  const components:FlutterExtensionPlan['components']=[],owners=new Map<string,string>();
  for(const page of snapshot.pages)for(const component of page.components){
    if(component.type!=='Extension')continue;
    const ref=snapshot.extensions?.find(item=>item.id===component.extensionId);
    if(!ref)throw Error('Extension compatibility failed');
    if(owners.has(component.name)){if(owners.get(component.name)!==ref.id)throw Error('Duplicate extension component');continue;}
    owners.set(component.name,ref.id);components.push({...ref,name:component.name});
    if(components.length>1000)throw Error('Too many extension components');
  }
  return {version:1,applicationId:snapshot.id,revision:snapshot.revision,components};
}
