import {AgentSemanticMemory} from './semantic-memory.js';
import type {AgentMemoryScope,AgentMemoryProvenance} from './agent-memory.js';

type Actor={tenantId:string;principalId:string};
type Input={memoryId:string;text:string;expectedRevision:number|null};
type Metadata={expiresAt:number;provenance:AgentMemoryProvenance};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(context:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean|Promise<boolean>;authorizeInput:(context:Actor,input:unknown)=>boolean|Promise<boolean>;execute:(input:unknown,context:Actor)=>unknown|Promise<unknown>})=>void};
type Options={memory:AgentSemanticMemory;scope:AgentMemoryScope;operationId:string;path:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeWrite:(actor:Actor,input:Input)=>boolean|Promise<boolean>;metadata:(actor:Actor,input:Input)=>Metadata|Promise<Metadata>};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const parse=(input:unknown):Input|undefined=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return;const value=(input as {query?:unknown}).query;if(!value||typeof value!=='object'||Array.isArray(value))return;const fields=value as Record<string,unknown>;if(Object.keys(fields).length!==3||!['memoryId','text','expectedRevision'].every(key=>Object.hasOwn(fields,key))||!id(fields.memoryId)||typeof fields.text!=='string'||!fields.text.trim()||fields.text.length>2000||!Number.isSafeInteger(fields.expectedRevision)||Number(fields.expectedRevision)<0)return;return {memoryId:fields.memoryId,text:fields.text,expectedRevision:fields.expectedRevision===0?null:Number(fields.expectedRevision)};};
/** Fixed-scope, host-authorized memory writes with host-supplied provenance and expiry. */
export function registerSemanticMemoryWrite(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||!(options.memory instanceof AgentSemanticMemory)||!options.scope||options.scope.kind!=='semantic'||!id(options.scope.tenantId)||!id(options.scope.agentId)||!options.scope.owner||!['organization','team','application','user'].includes(options.scope.owner.kind)||!id(options.scope.owner.id)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||typeof options.authorize!=='function'||typeof options.authorizeWrite!=='function'||typeof options.metadata!=='function')throw Error('Invalid memory write capability');
 const scope=structuredClone(options.scope),{memory,operationId,path,authorize,authorizeWrite,metadata}=options;
 registry.register({operationId,method:'POST',path,summary:'Store authorized agent memory'},{
  authorize:async actor=>actor.tenantId===scope.tenantId&&await authorize({...actor})===true,
  validate:input=>!!parse(input),
  authorizeInput:async(actor,input)=>{const safe=parse(input);return !!safe&&await authorizeWrite({...actor},safe)===true;},
  execute:async(input,actor)=>{const safe=parse(input);if(!safe)throw Error('Invalid memory write');const context={...actor},meta=structuredClone(await metadata({...context},structuredClone(safe)));if(!meta||typeof meta!=='object'||Array.isArray(meta)||Object.keys(meta).length!==2||!Object.hasOwn(meta,'expiresAt')||!Object.hasOwn(meta,'provenance')||!Number.isSafeInteger(meta.expiresAt)||!meta.provenance||typeof meta.provenance!=='object'||Array.isArray(meta.provenance)||Object.keys(meta.provenance).length!==2||!['run','human','system'].includes(meta.provenance.kind)||!id(meta.provenance.id))throw Error('Invalid memory metadata');if(await authorize({...context})!==true||await authorizeWrite({...context},structuredClone(safe))!==true)throw Error('Memory write forbidden');return memory.put(context,scope,safe.memoryId,safe.text,{expectedRevision:safe.expectedRevision,expiresAt:meta.expiresAt,provenance:meta.provenance});}
 });
}
export type {Options as SemanticMemoryWriteOptions,Input as SemanticMemoryWriteInput,Metadata as SemanticMemoryWriteMetadata};
