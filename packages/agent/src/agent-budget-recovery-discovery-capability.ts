import {SqliteAgentBudgetRecoveryDiscovery} from './agent-budget-recovery-discovery.js';
import type {AgentRunScope} from './durable-runs.js';
type Actor={tenantId:string;principalId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(actor:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean;execute:(input:unknown,actor:Actor)=>unknown|Promise<unknown>})=>void};
type Options={discovery:SqliteAgentBudgetRecoveryDiscovery;scope:AgentRunScope;operationId:string;path:string;limit:number;authorize:(actor:Actor,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
function parse(input:unknown):{after?:string}|undefined{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return;
 const query=(input as {query?:unknown}).query;if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>key!=='after'))return;
 const after=(query as {after?:unknown}).after;if(after!==undefined&&!id(after))return;return after===undefined?{}:{after};
}
/** Register read-only recovery discovery for one host-selected tenant and agent. */
export function registerBudgetRecoveryDiscovery(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||!(options.discovery instanceof SqliteAgentBudgetRecoveryDiscovery)||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||!options.discovery.isBoundTo(options.scope)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100||typeof options.authorize!=='function'||(options.timeoutMs===undefined)!==(options.maxPending===undefined)||(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000))||(options.maxPending!==undefined&&(!Number.isSafeInteger(options.maxPending)||options.maxPending<1||options.maxPending>100)))throw Error('Invalid budget recovery discovery capability');
 const {discovery,operationId,path,limit,authorize,timeoutMs,maxPending}=options,scope={...options.scope};let pending=0;
 const permit=async(actor:Actor):Promise<boolean>=>{const controller=new AbortController();if(timeoutMs===undefined)return await authorize({...actor},controller.signal)===true;if(pending>=maxPending!)throw Error('Budget recovery discovery unavailable');pending++;const task=Promise.resolve().then(async()=>{const result=await authorize({...actor},controller.signal);if(controller.signal.aborted)throw Error('Budget recovery discovery unavailable');return result===true;});void task.then(()=>{pending--;},()=>{pending--;});let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Budget recovery discovery unavailable'));},timeoutMs);})]);}finally{if(timer!==undefined)clearTimeout(timer);}};
 registry.register({operationId,method:'GET',path,summary:'Discover unresolved agent budgets'},{
  authorize:async actor=>actor.tenantId===scope.tenantId&&await permit({tenantId:actor.tenantId,principalId:actor.principalId}),
  validate:input=>!!parse(input),
  execute:async(input,actor)=>{const safe=parse(input);if(!safe)throw Error('Invalid budget recovery discovery request');try{const rows=await discovery.list({tenantId:actor.tenantId,principalId:actor.principalId},{...safe,limit});if(await permit({tenantId:actor.tenantId,principalId:actor.principalId})!==true)throw Error('Capability forbidden');return rows;}catch(error){if(error instanceof Error&&error.message==='Budget recovery discovery denied')throw Error('Capability forbidden');throw error;}}
 });
}
export type {Options as BudgetRecoveryDiscoveryCapabilityOptions};
