import { ComponentRegistry } from '@app-mixer/web';
import { CapabilityRegistry, type CapabilityCandidate } from './capabilities.js';
import { ExtensionRegistry } from './extensions.js';
import type { ExtensionReference } from './index.js';

/** Install a host-selected trusted extension component for an application. */
export function registerExtensionComponent(target: ComponentRegistry, extensions: ExtensionRegistry, references: ExtensionReference[], name: string, validate?: Parameters<ComponentRegistry['register']>[2]): void {
  const implementation = extensions.getForApplication(references, 'components', name);
  if (!implementation) throw Error('Extension component not available');
  target.register(name, implementation as unknown as Parameters<ComponentRegistry['register']>[1], validate);
}

/** Bind a host-selected extension tool to the normal capability policy, validation and audit boundary. */
export function registerExtensionCapability(
  target: CapabilityRegistry, extensions: ExtensionRegistry, references: ExtensionReference[], candidate: CapabilityCandidate,
  policy: {authorize:(context:{tenantId:string;principalId:string})=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean|Promise<boolean>}
): void {
  const implementation = extensions.getForApplication(references, 'tools', candidate.operationId);
  if (!implementation) throw Error('Extension tool not available');
  const execute = implementation as unknown as (input:unknown, context:{tenantId:string;principalId:string})=>unknown|Promise<unknown>;
  target.register(candidate, {authorize:policy?.authorize,validate:policy?.validate,execute});
}
