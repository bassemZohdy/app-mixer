import {AgentSemanticMemory} from './semantic-memory.js';
import type {AgentMemoryScope} from './agent-memory.js';

type Actor={tenantId:string;principalId:string};
type Input={memoryId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(actor:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean|Promise<boolean>;authorizeInput:(actor:Actor,input:unknown)=>boolean|Promise<boolean>;execute:(input:unknown,actor:Actor)=>unknown|Promise<unknown>})=>void};
type Options={memory:AgentSemanticMemory;scope:AgentMemoryScope;operationId:string;path:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeRead:(actor:Actor,input:Input)=>boolean|Promise<boolean>};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const parse=(input:unknown):Input|undefined=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return;const value=(input as {query?:unknown}).query;if(!value||typeof value!=='object'||Array.isArray(value))return;const fields=value as Record<string,unknown>;if(Object.keys(fields).length!==1||!Object.hasOwn(fields,'memoryId')||!id(fields.memoryId))return;return {memoryId:fields.memoryId};};
/** Fixed-scope reading with separate host and store authorization. */
export function registerSemanticMemoryRead(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||!(options.memory instanceof AgentSemanticMemory)||!options.scope||options.scope.kind!=='semantic'||!id(options.scope.tenantId)||!id(options.scope.agentId)||!options.scope.owner||!['organization','team','application','user'].includes(options.scope.owner.kind)||!id(options.scope.owner.id)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||typeof options.authorize!=='function'||typeof options.authorizeRead!=='function')throw Error('Invalid memory read capability');
 const scope=structuredClone(options.scope),{memory,operationId,path,authorize,authorizeRead}=options;
 registry.register({operationId,method:'GET',path,summary:'Read authorized agent memory'},{
  authorize:async actor=>actor.tenantId===scope.tenantId&&await authorize({...actor})===true,
  validate:input=>!!parse(input),
  authorizeInput:async(actor,input)=>{const safe=parse(input);return !!safe&&await authorizeRead({...actor},safe)===true;},
  execute:async(input,actor)=>{const safe=parse(input);if(!safe)throw Error('Invalid memory read');return await memory.get({...actor},scope,safe.memoryId)??null;}
 });
}
export type {Options as SemanticMemoryReadOptions,Input as SemanticMemoryReadInput};
