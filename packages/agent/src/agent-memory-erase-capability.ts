import {SqliteAgentMemory,checkedMemoryScope} from './agent-memory.js';
import {PostgresAgentMemory} from './postgres-agent-memory.js';
import type {AgentMemoryScope} from './agent-memory.js';

type Actor={tenantId:string;principalId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(actor:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean;authorizeInput:(actor:Actor,input:unknown)=>boolean|Promise<boolean>;execute:(input:unknown,actor:Actor)=>unknown|Promise<unknown>})=>void};
type Options={memory:SqliteAgentMemory|PostgresAgentMemory;scope:AgentMemoryScope;operationId:string;path:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeErase:(actor:Actor)=>boolean|Promise<boolean>};
const confirmed=(input:unknown):boolean=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return false;const query=(input as {query?:unknown}).query;return !!query&&typeof query==='object'&&!Array.isArray(query)&&Object.keys(query).length===1&&Object.hasOwn(query,'confirm')&&(query as {confirm?:unknown}).confirm===true;};
/** Administrative erasure of a host-fixed memory scope, with independent capability and store policies. */
export function registerAgentMemoryScopeErase(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||(!(options.memory instanceof SqliteAgentMemory)&&!(options.memory instanceof PostgresAgentMemory))||!options.scope||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||typeof options.authorize!=='function'||typeof options.authorizeErase!=='function')throw Error('Invalid memory erasure capability');
 const scope=checkedMemoryScope({tenantId:options.scope.tenantId,principalId:'capability'},options.scope).scope,{memory,operationId,path,authorize,authorizeErase}=options;
 const permit=async(actor:Actor)=>actor.tenantId===scope.tenantId&&await authorize({...actor})===true&&await authorizeErase({...actor})===true;
 registry.register({operationId,method:'POST',path,summary:'Erase one fixed agent memory scope'},{authorize:actor=>actor.tenantId===scope.tenantId&&authorize({...actor}),validate:confirmed,authorizeInput:(actor,input)=>confirmed(input)&&permit(actor),execute:async(input,actor)=>{if(!confirmed(input))throw Error('Invalid memory erasure');if(!await permit(actor))throw Error('Capability forbidden');return {erased:await memory.eraseScope({...actor},scope)};}});
}
export type {Options as AgentMemoryScopeEraseOptions};
