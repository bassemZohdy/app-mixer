export type CapabilityCandidate = {operationId:string; method:string; path:string; summary?:string};
export type InvocationContext = {tenantId:string; principalId:string; origin:'ui'|'agent'};
type PolicyContext = {tenantId:string; principalId:string};
type Binding = {
  authorize:(context:PolicyContext) => boolean | Promise<boolean>;
  validate:(input:unknown) => boolean | Promise<boolean>;
  execute:(input:unknown, context:PolicyContext) => unknown | Promise<unknown>;
};
const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value==='object' && !Array.isArray(value);
const methods = new Set(['get','post','put','patch','delete','head','options','trace']);

/** Discovers operations only; it does not trust servers, schemas, or grant execution authority. */
export function importOpenAPI(document:unknown): CapabilityCandidate[] {
  if (!object(document) || typeof document.openapi !== 'string' || !/^3\.(0|1)\.\d+(?:[-+].*)?$/.test(document.openapi) || !object(document.paths)) throw Error('Invalid or unsupported OpenAPI document');
  const result:CapabilityCandidate[]=[], ids=new Set<string>();
  for(const [path,item] of Object.entries(document.paths)) {
    if(!path.startsWith('/') || path.includes('?') || path.includes('#') || !object(item) || '$ref' in item) throw Error('Unsupported path item');
    for(const [key,value] of Object.entries(item)) {
      if(!methods.has(key)) continue;
      if(!object(value) || typeof value.operationId!=='string' || !value.operationId.trim() || value.operationId.length>256 || ids.has(value.operationId)) throw Error('Missing or duplicate operation ID');
      if(value.summary!==undefined && (typeof value.summary!=='string' || value.summary.length>1024)) throw Error('Invalid operation summary');
      ids.add(value.operationId);
      result.push({operationId:value.operationId,method:key.toUpperCase(),path,...(typeof value.summary==='string'?{summary:value.summary}:{})});
      if(result.length>500) throw Error('Too many operations');
    }
  }
  return result;
}

/** Host registers explicit policy, input validation and implementation for each candidate. */
export class CapabilityRegistry {
  private readonly bindings=new Map<string,{candidate:CapabilityCandidate;binding:Binding}>();
  register(candidate:CapabilityCandidate,binding:Binding):void {
    if(!candidate || typeof candidate.operationId!=='string' || !candidate.operationId.trim() ||
       typeof candidate.path!=='string' || !candidate.path.startsWith('/') ||
       typeof candidate.method!=='string' || !methods.has(candidate.method.toLowerCase()) ||
       !binding || typeof binding.authorize!=='function' || typeof binding.validate!=='function' || typeof binding.execute!=='function') throw Error('Invalid capability registration');
    if(this.bindings.has(candidate.operationId)) throw Error('Capability already registered');
    this.bindings.set(candidate.operationId,{candidate:structuredClone(candidate),binding:{...binding}});
  }
  async invoke(operationId:string,input:unknown,context:InvocationContext):Promise<unknown> {
    const entry=this.bindings.get(operationId);
    if(!entry) throw Error('Capability not found');
    if(!context || typeof context.tenantId!=='string' || !context.tenantId.trim() || typeof context.principalId!=='string' || !context.principalId.trim() || !['ui','agent'].includes(context.origin)) throw Error('Invalid invocation context');
    // Origin is intentionally not part of authorization or execution context.
    const policyContext={tenantId:context.tenantId,principalId:context.principalId};
    if(await entry.binding.authorize({...policyContext}) !== true) throw Error('Capability forbidden');
    const safeInput=structuredClone(input);
    if(await entry.binding.validate(structuredClone(safeInput)) !== true) throw Error('Invalid capability input');
    return entry.binding.execute(safeInput,{...policyContext});
  }
}
