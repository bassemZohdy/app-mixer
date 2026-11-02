import {SqliteAgentMemory,checkedMemoryScope} from './agent-memory.js';
import {PostgresAgentMemory} from './postgres-agent-memory.js';
import type {AgentMemoryScope} from './agent-memory.js';

type Actor={tenantId:string;principalId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(actor:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean;authorizeInput:(actor:Actor,input:unknown)=>boolean|Promise<boolean>;execute:(input:unknown,actor:Actor)=>unknown|Promise<unknown>})=>void};
type Options={memory:SqliteAgentMemory|PostgresAgentMemory;scope:AgentMemoryScope;operationId:string;path:string;authorize:(actor:Actor)=>boolean|Promise<boolean>;authorizeErase:(actor:Actor)=>boolean|Promise<boolean>};
const parse=(input:unknown):{requestId?:string}|undefined=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return;const value=(input as {query?:unknown}).query;if(!value||typeof value!=='object'||Array.isArray(value))return;const q=value as Record<string,unknown>;if(Object.keys(q).some(key=>key!=='confirm'&&key!=='requestId')||!Object.hasOwn(q,'confirm')||q.confirm!==true||(q.requestId!==undefined&&(typeof q.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(q.requestId))))return;return q.requestId===undefined?{}:{requestId:q.requestId as string};};
/** Administrative erasure of a host-fixed memory scope, with independent capability and store policies. */
export function registerAgentMemoryScopeErase(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||(!(options.memory instanceof SqliteAgentMemory)&&!(options.memory instanceof PostgresAgentMemory))||!options.scope||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||typeof options.authorize!=='function'||typeof options.authorizeErase!=='function')throw Error('Invalid memory erasure capability');
 const scope=checkedMemoryScope({tenantId:options.scope.tenantId,principalId:'capability'},options.scope).scope,{memory,operationId,path,authorize,authorizeErase}=options;
 const permit=async(actor:Actor)=>actor.tenantId===scope.tenantId&&await authorize({...actor})===true&&await authorizeErase({...actor})===true;
 registry.register({operationId,method:'POST',path,summary:'Erase one fixed agent memory scope'},{authorize:actor=>actor.tenantId===scope.tenantId&&authorize({...actor}),validate:input=>!!parse(input),authorizeInput:(actor,input)=>!!parse(input)&&permit(actor),execute:async(input,actor)=>{const safe=parse(input);if(!safe)throw Error('Invalid memory erasure');if(!await permit(actor))throw Error('Capability forbidden');return safe.requestId===undefined?{erased:await memory.eraseScope({...actor},scope)}:await memory.eraseScopeOnce({...actor},scope,safe.requestId);}});
}
export type {Options as AgentMemoryScopeEraseOptions};
