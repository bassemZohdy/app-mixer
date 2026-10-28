import type { ApplicationDefinition, PublicationGuard } from './index.js';

/** Metadata for trusted, statically installed extensions. This is not a code loader. */
export type ExtensionManifest = {
  manifestVersion: 1;
  id: string;
  version: string;
  scope: 'platform' | 'development' | 'application';
  runtimeVersions: string[];
  renderers: string[];
  components: string[];
  tools: string[];
  providers: string[];
  permissions: string[];
};
export type ExtensionHost = {
  runtimeVersion: string;
  renderer: string;
  approved: { id: string; version: string; scope: ExtensionManifest['scope']; permissions: string[] }[];
};
export type ExtensionRequirements = { components: string[]; tools: string[]; providers: string[] };
const idPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
function fields(x: unknown, names: string[]): x is Record<string, unknown> {
  return record(x) && Object.keys(x).length === names.length && names.every(name => Object.hasOwn(x, name));
}
function list(x: unknown, pattern = idPattern): x is string[] {
  return Array.isArray(x) && x.length <= 256 && x.every(v => typeof v === 'string' && pattern.test(v)) && new Set(x).size === x.length;
}
const scope = (x: unknown): x is ExtensionManifest['scope'] => x === 'platform' || x === 'development' || x === 'application';

/** Check metadata against an explicit host approval and required registrations.
 * Exact versions only; neither approval nor this check enforces runtime authorization. */
export function checkExtensionCompatibility(manifests: unknown, host: unknown, requirements: unknown): { compatible: boolean; errors: string[] } {
  if (!Array.isArray(manifests) || manifests.length > 256 || !fields(host, ['runtimeVersion','renderer','approved']) || typeof host.runtimeVersion !== 'string' || !versionPattern.test(host.runtimeVersion) || typeof host.renderer !== 'string' || !idPattern.test(host.renderer) || !Array.isArray(host.approved) || host.approved.length > 256 || !fields(requirements, ['components','tools','providers']) || !list(requirements.components) || !list(requirements.tools) || !list(requirements.providers)) throw Error('Invalid extension compatibility input');
  const approvals = new Map<string, {version:string; scope:ExtensionManifest['scope']; permissions:string[]}>();
  for (const a of host.approved) {
    if (!fields(a, ['id','version','scope','permissions']) || typeof a.id !== 'string' || !idPattern.test(a.id) || typeof a.version !== 'string' || !versionPattern.test(a.version) || !scope(a.scope) || !list(a.permissions) || approvals.has(a.id)) throw Error('Invalid extension approval');
    approvals.set(a.id, {version:a.version,scope:a.scope,permissions:a.permissions});
  }
  const errors:string[] = [], ids = new Set<string>();
  const registrations = {components:new Set<string>(),tools:new Set<string>(),providers:new Set<string>()};
  for (const m of manifests) {
    if (!fields(m, ['manifestVersion','id','version','scope','runtimeVersions','renderers','components','tools','providers','permissions']) || m.manifestVersion !== 1 || typeof m.id !== 'string' || !idPattern.test(m.id) || typeof m.version !== 'string' || !versionPattern.test(m.version) || !scope(m.scope) || !list(m.runtimeVersions, versionPattern) || !list(m.renderers) || !list(m.components) || !list(m.tools) || !list(m.providers) || !list(m.permissions)) throw Error('Invalid extension manifest');
    if (ids.has(m.id)) { errors.push(`Duplicate extension: ${m.id}`); continue; }
    ids.add(m.id);
    const approval=approvals.get(m.id);
    if (!approval || approval.version !== m.version || approval.scope !== m.scope || m.permissions.some(p => !approval.permissions.includes(p))) errors.push(`Extension not approved: ${m.id}`);
    if (!m.runtimeVersions.includes(host.runtimeVersion) || !m.renderers.includes(host.renderer)) errors.push(`Incompatible extension: ${m.id}`);
    for (const kind of ['components','tools','providers'] as const) for (const name of m[kind] as string[]) {
      if (registrations[kind].has(name)) errors.push(`Duplicate ${kind} registration: ${name}`);
      registrations[kind].add(name);
    }
  }
  for (const kind of ['components','tools','providers'] as const) for (const name of requirements[kind] as string[]) if (!registrations[kind].has(name)) errors.push(`Missing ${kind} registration: ${name}`);
  return {compatible:errors.length===0, errors};
}

/** Build a synchronous publication guard from trusted static metadata and a host-owned requirement selector. */
export function createExtensionPublicationGuard(manifests: ExtensionManifest[], host: ExtensionHost, requirementsFor: (draft: ApplicationDefinition) => ExtensionRequirements): PublicationGuard {
  if (typeof requirementsFor !== 'function') throw Error('Invalid extension requirements selector');
  // Snapshot configuration so callers cannot silently alter approvals after guard creation.
  const installed = structuredClone(manifests), target = structuredClone(host);
  // Validate configuration even when there are no application requirements.
  checkExtensionCompatibility(installed, target, {components:[], tools:[], providers:[]});
  return draft => {
    const requirements = requirementsFor(structuredClone(draft));
    const result = checkExtensionCompatibility(installed, target, requirements);
    if (!result.compatible) throw Error('Extension compatibility failed');
    return true;
  };
}

export type ExtensionImplementation = (...args: never[]) => unknown;
export type ExtensionBindings = {
  components: Record<string, ExtensionImplementation>;
  tools: Record<string, ExtensionImplementation>;
  providers: Record<string, ExtensionImplementation>;
};
type RegistrationKind = keyof ExtensionBindings;

/** Trusted static registrations only; authorization remains the host's responsibility. */
export class ExtensionRegistry {
  private readonly manifests: ExtensionManifest[] = [];
  private readonly registrations: Record<RegistrationKind, Map<string, ExtensionImplementation>> = {
    components: new Map(), tools: new Map(), providers: new Map()
  };
  private readonly host: ExtensionHost;

  constructor(host: ExtensionHost) {
    this.host = structuredClone(host);
    checkExtensionCompatibility([], this.host, {components:[], tools:[], providers:[]});
  }

  register(manifest: ExtensionManifest, bindings: ExtensionBindings): void {
    const snapshot = structuredClone(manifest);
    const result = checkExtensionCompatibility([...this.manifests, snapshot], this.host, {components:[], tools:[], providers:[]});
    if (!result.compatible) throw Error('Extension compatibility failed');
    if (!fields(bindings, ['components','tools','providers'])) throw Error('Invalid extension bindings');
    const pending: {kind:RegistrationKind; name:string; implementation:ExtensionImplementation}[] = [];
    for (const kind of ['components','tools','providers'] as const) {
      const values = bindings[kind];
      if (!record(values) || Object.keys(values).length !== snapshot[kind].length ||
          !snapshot[kind].every(name => Object.hasOwn(values,name) && typeof values[name] === 'function')) throw Error('Extension bindings do not match manifest');
      for (const name of snapshot[kind]) pending.push({kind,name,implementation:values[name] as ExtensionImplementation});
    }
    // Install only after all metadata and bindings have been checked.
    this.manifests.push(snapshot);
    for (const {kind,name,implementation} of pending) this.registrations[kind].set(name,implementation);
  }

  get(kind: RegistrationKind, name: string): ExtensionImplementation | undefined {
    if (!['components','tools','providers'].includes(kind) || typeof name !== 'string' || !idPattern.test(name)) throw Error('Invalid extension lookup');
    return this.registrations[kind].get(name);
  }

  getManifests(): ExtensionManifest[] { return structuredClone(this.manifests); }
}
