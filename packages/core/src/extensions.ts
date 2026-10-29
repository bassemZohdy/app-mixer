import { isValidExtensionReferences, type ApplicationDefinition, type ExtensionReference, type PublicationGuard } from './index.js';

export type ExtensionConfigRule =
  | {type:'string'; required:boolean; minLength?:number; maxLength?:number; enum?:string[]; default?:string}
  | {type:'number'; required:boolean; minimum?:number; maximum?:number; enum?:number[]; default?:number}
  | {type:'boolean'; required:boolean; enum?:boolean[]; default?:boolean}
  | {type:'object'; required:boolean; properties:ExtensionConfigSchema; default?:ExtensionConfiguration}
  | {type:'array'; required:boolean; items:ExtensionConfigRule; maxItems?:number; default?:ExtensionConfigValue[]};
export type ExtensionConfigSchema = Record<string, ExtensionConfigRule>;
export type ExtensionConfigValue = string | number | boolean | ExtensionConfiguration | ExtensionConfigValue[];
export type ExtensionConfiguration = {[key:string]:ExtensionConfigValue};

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
  configSchema?: ExtensionConfigSchema;
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
const configKey = (x:string) => idPattern.test(x) && !['__proto__','prototype','constructor'].includes(x);
function validateConfigSchema(schema:unknown): void {
  let count=0;const ancestors=new Set<object>(),defaults:ExtensionConfigRule[]=[];
  const fail=():never=>{throw Error('Invalid extension configuration schema');};
  const visitSchema=(input:unknown,depth:number):void=>{
    if (!record(input) || depth>10 || Object.keys(input).length>64 || ancestors.has(input)) return fail();
    ancestors.add(input);
    for(const [key,rule] of Object.entries(input)){if(!configKey(key))return fail();visitRule(rule,depth);}
    ancestors.delete(input);
  };
  const visitRule=(input:unknown,depth:number):void=>{
    if (++count>256 || depth>10 || !record(input) || ancestors.has(input) || !Object.hasOwn(input,'type') || !Object.hasOwn(input,'required') || typeof input.required!=='boolean') return fail();
    ancestors.add(input);
    const type=input.type;
    const allowed=type==='string'?['type','required','minLength','maxLength','enum','default']:type==='number'?['type','required','minimum','maximum','enum','default']:type==='boolean'?['type','required','enum','default']:type==='object'?['type','required','properties','default']:type==='array'?['type','required','items','maxItems','default']:[];
    if(!allowed.length || Object.keys(input).some(key=>!allowed.includes(key)) || (input.required && Object.hasOwn(input,'default'))) return fail();
    if(type==='string'){
      for(const name of ['minLength','maxLength'])if(Object.hasOwn(input,name)&&(!Number.isSafeInteger(input[name])||(input[name] as number)<0||(input[name] as number)>4096))return fail();
      if(typeof input.minLength==='number'&&typeof input.maxLength==='number'&&input.minLength>input.maxLength)return fail();
    }
    if(type==='number'){
      for(const name of ['minimum','maximum'])if(Object.hasOwn(input,name)&&(typeof input[name]!=='number'||!Number.isFinite(input[name])))return fail();
      if(typeof input.minimum==='number'&&typeof input.maximum==='number'&&input.minimum>input.maximum)return fail();
    }
    if(type==='object'){if(!Object.hasOwn(input,'properties'))return fail();visitSchema(input.properties,depth+1);}
    if(type==='array'){
      if(!Object.hasOwn(input,'items') || (Object.hasOwn(input,'maxItems')&&(!Number.isSafeInteger(input.maxItems)||(input.maxItems as number)<0||(input.maxItems as number)>256)))return fail();
      visitRule(input.items,depth+1);
    }
    if(Object.hasOwn(input,'enum')){
      const values=input.enum;
      if(!Array.isArray(values)||values.length===0||values.length>64||new Set(values).size!==values.length||values.some(value=>!matchesPrimitive(input as ExtensionConfigRule,value)))return fail();
    }
    if(Object.hasOwn(input,'default'))defaults.push(input as ExtensionConfigRule);
    ancestors.delete(input);
  };
  visitSchema(schema,0);
  for(const rule of defaults){try{resolveRule(rule,rule.default,{count:0,ancestors:new Set()},0);}catch{return fail();}}
}
function matchesPrimitive(rule:ExtensionConfigRule,value:unknown):boolean {
  if(rule.type==='string')return typeof value==='string'&&value.length<=4096&&value.length>=(rule.minLength??0)&&value.length<=(rule.maxLength??4096);
  if(rule.type==='number')return typeof value==='number'&&Number.isFinite(value)&&(rule.minimum===undefined||value>=rule.minimum)&&(rule.maximum===undefined||value<=rule.maximum);
  return rule.type==='boolean'&&typeof value==='boolean';
}
type ConfigWalk={count:number;ancestors:Set<object>};
function resolveSchema(schema:ExtensionConfigSchema,input:unknown,state:ConfigWalk,depth:number):ExtensionConfiguration {
  if(!record(input)||depth>10||Object.keys(input).length>64||state.ancestors.has(input))throw Error('Invalid extension configuration');
  state.ancestors.add(input);const output:ExtensionConfiguration={};
  for(const key of Object.keys(input))if(!Object.hasOwn(schema,key))throw Error('Invalid extension configuration');
  for(const [key,rule] of Object.entries(schema)){
    if(Object.hasOwn(input,key))output[key]=resolveRule(rule,input[key],state,depth+1);
    else if(Object.hasOwn(rule,'default'))output[key]=resolveRule(rule,rule.default,state,depth+1);
    else if(rule.required)throw Error('Invalid extension configuration');
  }
  state.ancestors.delete(input);return output;
}
function resolveRule(rule:ExtensionConfigRule,value:unknown,state:ConfigWalk,depth:number):ExtensionConfigValue {
  if(++state.count>10000||depth>10)throw Error('Invalid extension configuration');
  if(rule.type==='object')return resolveSchema(rule.properties,value,state,depth);
  if(rule.type==='array'){
    if(!Array.isArray(value)||value.length>(rule.maxItems??256)||state.ancestors.has(value))throw Error('Invalid extension configuration');
    state.ancestors.add(value);const result:ExtensionConfigValue[]=[];
    for(let i=0;i<value.length;i++){if(!Object.hasOwn(value,i))throw Error('Invalid extension configuration');result.push(resolveRule(rule.items,value[i],state,depth+1));}
    state.ancestors.delete(value);return result;
  }
  if(!matchesPrimitive(rule,value)||(rule.enum!==undefined&&!(rule.enum as unknown[]).includes(value)))throw Error('Invalid extension configuration');
  return value as string|number|boolean;
}
function validateConfiguration(schema:ExtensionConfigSchema, config:unknown):ExtensionConfiguration {
  return resolveSchema(schema,config,{count:0,ancestors:new Set()},0);
}

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
    if (!fields(m, ['manifestVersion','id','version','scope','runtimeVersions','renderers','components','tools','providers','permissions', ...(record(m) && Object.hasOwn(m,'configSchema') ? ['configSchema'] : [])]) || m.manifestVersion !== 1 || typeof m.id !== 'string' || !idPattern.test(m.id) || typeof m.version !== 'string' || !versionPattern.test(m.version) || !scope(m.scope) || !list(m.runtimeVersions, versionPattern) || !list(m.renderers) || !list(m.components) || !list(m.tools) || !list(m.providers) || !list(m.permissions)) throw Error('Invalid extension manifest');
    if (Object.hasOwn(m,'configSchema')) validateConfigSchema(m.configSchema);
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
    for (const ref of draft.extensions ?? []) {
      if (!installed.some(manifest => manifest.id === ref.id && manifest.version === ref.version && manifest.scope === ref.scope)) throw Error('Extension compatibility failed');
    }
    for (const page of draft.pages) for (const component of page.components) {
      if (component.type !== 'Extension') continue;
      const ref = draft.extensions?.find(item => item.id === component.extensionId);
      const manifest = ref && installed.find(item => item.id === ref.id && item.version === ref.version && item.scope === ref.scope);
      if (!manifest || !manifest.components.includes(component.name)) throw Error('Extension compatibility failed');
    }
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
  private readonly configurations = new Map<string, ExtensionConfiguration>();

  constructor(host: ExtensionHost) {
    this.host = structuredClone(host);
    checkExtensionCompatibility([], this.host, {components:[], tools:[], providers:[]});
  }

  register(manifest: ExtensionManifest, bindings: ExtensionBindings, configuration: ExtensionConfiguration = {}): void {
    const snapshot = structuredClone(manifest);
    const result = checkExtensionCompatibility([...this.manifests, snapshot], this.host, {components:[], tools:[], providers:[]});
    if (!result.compatible) throw Error('Extension compatibility failed');
    const configSnapshot = validateConfiguration(snapshot.configSchema ?? {}, configuration);
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
    this.configurations.set(snapshot.id,configSnapshot);
    for (const {kind,name,implementation} of pending) this.registrations[kind].set(name,implementation);
  }

  get(kind: RegistrationKind, name: string): ExtensionImplementation | undefined {
    if (!['components','tools','providers'].includes(kind) || typeof name !== 'string' || !idPattern.test(name)) throw Error('Invalid extension lookup');
    return this.registrations[kind].get(name);
  }

  /** Resolve only registrations belonging to the application's declared, installed extensions. */
  getForApplication(references: ExtensionReference[], kind: RegistrationKind, name: string): ExtensionImplementation | undefined {
    if (!isValidExtensionReferences(references)) throw Error('Invalid extension references');
    if (!['components','tools','providers'].includes(kind) || typeof name !== 'string' || !idPattern.test(name)) throw Error('Invalid extension lookup');
    const selected = references.map(ref => {
      const manifest = this.manifests.find(m => m.id === ref.id && m.version === ref.version && m.scope === ref.scope);
      if (!manifest) throw Error('Extension compatibility failed');
      return manifest;
    });
    return selected.some(manifest => manifest[kind].includes(name)) ? this.registrations[kind].get(name) : undefined;
  }

  getConfiguration(id:string): ExtensionConfiguration | undefined {
    if (typeof id !== 'string' || !idPattern.test(id)) throw Error('Invalid extension lookup');
    const config=this.configurations.get(id);
    return config === undefined ? undefined : structuredClone(config);
  }

  getManifests(): ExtensionManifest[] { return structuredClone(this.manifests); }
}
