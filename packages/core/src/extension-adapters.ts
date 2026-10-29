import { ComponentRegistry, basicRegistry } from '@app-mixer/web';
import { CapabilityRegistry, type CapabilityCandidate, type CapabilityAuditSink } from './capabilities.js';
import { ExtensionRegistry } from './extensions.js';
import { isValidExtensionOperations, validate, type ApplicationDefinition, type ExtensionOperation, type ExtensionReference } from './index.js';

type CapabilityPolicy = {authorize:(context:{tenantId:string;principalId:string})=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean|Promise<boolean>};

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
  const implementation = extensions.getForApplication(references, 'tools', candidate.operationId);
  if (!implementation) throw Error('Extension tool not available');
  const execute = implementation as unknown as (input:unknown, context:{tenantId:string;principalId:string})=>unknown|Promise<unknown>;
  target.register(candidate, {authorize:policy?.authorize,validate:policy?.validate,execute});
}

/** Bind a declared tool or provider to a capability with host-supplied policy and validation. */
export function registerDeclaredExtensionCapability(
  target: CapabilityRegistry, extensions: ExtensionRegistry, application: ApplicationDefinition,
  operation: ExtensionOperation, candidate: CapabilityCandidate, policy: CapabilityPolicy
): void {
  const operations=application?.extensionOperations;
  if(!isValidExtensionOperations(operations)||!isValidExtensionOperations([operation])||!operations.some(item=>item.extensionId===operation.extensionId&&item.kind===operation.kind&&item.name===operation.name)||candidate?.operationId!==operation.name)throw Error('Extension operation not declared');
  const implementation=extensions.getForExtension(application.extensions??[],operation.extensionId,operation.kind==='tool'?'tools':'providers',operation.name);
  if(!implementation)throw Error('Extension operation not available');
  const execute=implementation as unknown as (input:unknown,context:{tenantId:string;principalId:string})=>unknown|Promise<unknown>;
  target.register(candidate,{authorize:policy?.authorize,validate:policy?.validate,execute});
}

export type ExtensionRuntimeBindings = {
  componentValidators?: Record<string, NonNullable<Parameters<ComponentRegistry['register']>[2]>>;
  operations: Record<string, {candidate:CapabilityCandidate} & CapabilityPolicy>;
};

/** Construct fresh registries from a host-selected published definition. */
export function createExtensionRuntime(application:ApplicationDefinition, extensions:ExtensionRegistry, audit:CapabilityAuditSink, bindings:ExtensionRuntimeBindings): {components:ComponentRegistry;capabilities:CapabilityRegistry} {
  const snapshot=structuredClone(application);validate(snapshot);
  if(!bindings || !bindings.operations || typeof bindings.operations!=='object' || Array.isArray(bindings.operations) || (bindings.componentValidators!==undefined && (!bindings.componentValidators || typeof bindings.componentValidators!=='object' || Array.isArray(bindings.componentValidators))))throw Error('Invalid extension runtime bindings');
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
    registerDeclaredExtensionCapability(capabilities,extensions,snapshot,operation,binding.candidate,binding);
  }
  return {components,capabilities};
}
