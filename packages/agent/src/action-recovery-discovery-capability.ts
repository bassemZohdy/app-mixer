import {SqliteAgentActionRecoveryDiscovery} from './action-recovery-discovery.js';
import type {AgentRunScope} from './durable-runs.js';
type Actor={tenantId:string;principalId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(actor:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean;execute:(input:unknown,actor:Actor)=>unknown|Promise<unknown>})=>void};
type Options={discovery:SqliteAgentActionRecoveryDiscovery;scope:AgentRunScope;operationId:string;path:string;limit:number;authorize:(actor:Actor)=>boolean|Promise<boolean>};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
function parse(input:unknown):{after?:string}|undefined{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return;
 const query=(input as {query?:unknown}).query;if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>key!=='after'))return;
 const after=(query as {after?:unknown}).after;if(after!==undefined&&!id(after))return;return after===undefined?{}:{after};
}
/** Register read-only recovery discovery for one host-selected tenant and agent. */
export function registerActionRecoveryDiscovery(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||!(options.discovery instanceof SqliteAgentActionRecoveryDiscovery)||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||!options.discovery.isBoundTo(options.scope)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100||typeof options.authorize!=='function')throw Error('Invalid action recovery discovery capability');
 const {discovery,operationId,path,limit,authorize}=options,scope={...options.scope};
 registry.register({operationId,method:'GET',path,summary:'Discover unresolved agent actions'},{
  authorize:async actor=>actor.tenantId===scope.tenantId&&await authorize({tenantId:actor.tenantId,principalId:actor.principalId})===true,
  validate:input=>!!parse(input),
  execute:(input,actor)=>{const safe=parse(input);if(!safe)throw Error('Invalid action recovery discovery request');return discovery.list({tenantId:actor.tenantId,principalId:actor.principalId},{...safe,limit});}
 });
}
export type {Options as ActionRecoveryDiscoveryCapabilityOptions};
