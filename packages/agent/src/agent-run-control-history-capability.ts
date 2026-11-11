import {SqliteAgentRunControlHistory} from './agent-run-control-history.js';
import type {AgentRunScope} from './durable-runs.js';
import {isIdentifier} from './validation.js';
type Actor={tenantId:string;principalId:string};
type Registry={register:(candidate:{operationId:string;method:string;path:string;summary?:string},binding:{authorize:(actor:Actor)=>boolean|Promise<boolean>;validate:(input:unknown)=>boolean;execute:(input:unknown,actor:Actor)=>unknown|Promise<unknown>})=>void};
type Options={history:SqliteAgentRunControlHistory;scope:AgentRunScope;operationId:string;path:string;limit:number;authorize:(actor:Actor,signal:AbortSignal)=>boolean|Promise<boolean>;timeoutMs?:number;maxPending?:number};
const id=isIdentifier;
function parse(input:unknown):{after?:number}|undefined{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'query'))return;
 const query=(input as {query?:unknown}).query;if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>key!=='after'))return;
 const after=(query as {after?:unknown}).after;if(after!==undefined&&(!Number.isSafeInteger(after)||Number(after)<0))return;return after===undefined?{}:{after:after as number};
}
/** Register separately authorized evidence reads for one fixed tenant and agent. */
export function registerAgentRunControlHistory(registry:Registry,options:Options):void{
 if(!registry||typeof registry.register!=='function'||!options||!(options.history instanceof SqliteAgentRunControlHistory)||!options.scope||!id(options.scope.tenantId)||!id(options.scope.agentId)||!options.history.isBoundTo(options.scope)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId)||typeof options.path!=='string'||!options.path.startsWith('/')||options.path.length>1024||/[\u0000-\u001f]/.test(options.path)||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>100||typeof options.authorize!=='function'||(options.timeoutMs===undefined)!==(options.maxPending===undefined)||(options.timeoutMs!==undefined&&(!Number.isInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>30000))||(options.maxPending!==undefined&&(!Number.isInteger(options.maxPending)||options.maxPending<1||options.maxPending>100)))throw Error('Invalid run control history capability');
 const {history,operationId,path,limit,authorize,timeoutMs,maxPending}=options,scope={tenantId:options.scope.tenantId,agentId:options.scope.agentId};let pending=0;
 const bounded=async<T>(fn:(signal:AbortSignal)=>T|Promise<T>):Promise<T>=>{const controller=new AbortController();if(timeoutMs===undefined)return await fn(controller.signal);if(pending>=maxPending!)throw Error('Run control history unavailable');pending++;const task=Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('Run control history unavailable');return fn(controller.signal);});void task.then(()=>{pending--;},()=>{pending--;});let timer:ReturnType<typeof setTimeout>|undefined;try{const result=await Promise.race([task,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Run control history unavailable'));},timeoutMs);})]);if(controller.signal.aborted)throw Error('Run control history unavailable');return result;}finally{if(timer!==undefined)clearTimeout(timer);}};
 const permit=(actor:Actor)=>bounded(async signal=>await authorize({...actor},signal)===true);
 registry.register({operationId,method:'GET',path,summary:'Read agent run control evidence'},{
  authorize:async actor=>actor.tenantId===scope.tenantId&&await permit({tenantId:actor.tenantId,principalId:actor.principalId}),
  validate:input=>!!parse(input),
  execute:async(input,actor)=>{const query=parse(input);if(!query)throw Error('Invalid capability input');const who={tenantId:actor.tenantId,principalId:actor.principalId};try{const result=await bounded(signal=>history.listWithSignal(who,{...query,limit},signal));if(!await permit(who))throw Error('Capability forbidden');return result;}catch(error){if(error instanceof Error&&error.message==='Run control history access denied')throw Error('Capability forbidden');throw error;}}
 });
}
export type {Options as AgentRunControlHistoryCapabilityOptions};
