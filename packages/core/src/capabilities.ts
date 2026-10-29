export type CapabilityCandidate = {operationId:string; method:string; path:string; summary?:string};
export type InvocationContext = {tenantId:string; principalId:string; origin:'ui'|'agent'|'service'};
export type CapabilityAuditEvent = {operationId:string; tenantId:string; principalId:string; outcome:'attempt'|'not_found'|'denied'|'invalid'|'succeeded'|'failed'};
export type CapabilityAuditSink = (event:CapabilityAuditEvent) => void | Promise<void>;
type PolicyContext = {tenantId:string; principalId:string};
type Binding = {
  authorize:(context:PolicyContext) => boolean | Promise<boolean>;
  validate:(input:unknown) => boolean | Promise<boolean>;
  authorizeInput?:(context:PolicyContext, input:unknown) => boolean | Promise<boolean>;
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
  constructor(private readonly audit:CapabilityAuditSink) {
    if(typeof audit !== 'function') throw Error('Audit sink is required');
  }
  register(candidate:CapabilityCandidate,binding:Binding):void {
    if(!candidate || typeof candidate.operationId!=='string' || !candidate.operationId.trim() ||
       typeof candidate.path!=='string' || !candidate.path.startsWith('/') ||
       typeof candidate.method!=='string' || !methods.has(candidate.method.toLowerCase()) ||
       !binding || typeof binding.authorize!=='function' || typeof binding.validate!=='function' || (binding.authorizeInput!==undefined && typeof binding.authorizeInput!=='function') || typeof binding.execute!=='function') throw Error('Invalid capability registration');
    if(this.bindings.has(candidate.operationId)) throw Error('Capability already registered');
    this.bindings.set(candidate.operationId,{candidate:structuredClone(candidate),binding:{...binding}});
  }
  async invoke(operationId:string,input:unknown,context:InvocationContext):Promise<unknown> {
    if(typeof operationId!=='string' || !operationId.trim()) throw Error('Invalid capability ID');
    if(!context || typeof context.tenantId!=='string' || !context.tenantId.trim() || typeof context.principalId!=='string' || !context.principalId.trim() || !['ui','agent','service'].includes(context.origin)) throw Error('Invalid invocation context');
    // Origin is intentionally not part of authorization or execution context.
    const policyContext={tenantId:context.tenantId,principalId:context.principalId};
    const audit = (outcome:CapabilityAuditEvent['outcome']) => this.audit({operationId,...policyContext,outcome});
    // An unavailable audit sink blocks execution before any side effect.
    await audit('attempt');
    const entry=this.bindings.get(operationId);
    if(!entry) { await audit('not_found'); throw Error('Capability not found'); }
    let authorized:boolean;
    try { authorized=await entry.binding.authorize({...policyContext}) === true; }
    catch(error) { await audit('failed'); throw error; }
    if(!authorized) { await audit('denied'); throw Error('Capability forbidden'); }
    let safeInput:unknown, valid:boolean;
    try { safeInput=structuredClone(input); valid=await entry.binding.validate(structuredClone(safeInput)) === true; }
    catch(error) { await audit('failed'); throw error; }
    if(!valid) { await audit('invalid'); throw Error('Invalid capability input'); }
    if(entry.binding.authorizeInput){
      let allowed:boolean;
      try { allowed=await entry.binding.authorizeInput({...policyContext},structuredClone(safeInput))===true; }
      catch(error) { await audit('failed'); throw error; }
      if(!allowed) { await audit('denied'); throw Error('Capability forbidden'); }
    }
    let result:unknown;
    try { result=await entry.binding.execute(safeInput,{...policyContext}); }
    catch(error) { await audit('failed'); throw error; }
    // If this write fails, the operation may already have occurred; do not automatically retry.
    await audit('succeeded');
    return result;
  }
}
