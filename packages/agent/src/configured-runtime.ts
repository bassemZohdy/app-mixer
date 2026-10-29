import {LangGraphAGUIAdapter,type RunInput} from './index.js';
import {createCapabilityTool} from './capability-tool.js';
import {createToolCallingModel,type ToolModel} from './tool-model.js';
import {type AgentDefinitionVersion} from './persistent-definitions.js';

type AgentIdentity={tenantId:string;agentId:string;definitionVersion:number;servicePrincipalId:string};
type Binding={operationId:string;toolName:string;description:string};
type Tool=ReturnType<typeof createCapabilityTool>;
type Options={
 definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined};
 tenantId:string;agentId:string;expectedVersion:number;
 bindings:Binding[];
 registry:{invoke:(operationId:string,input:unknown,context:{tenantId:string;principalId:string;origin:'agent'})=>Promise<unknown>};
 authorizeRun:(identity:AgentIdentity)=>boolean|Promise<boolean>;
 authorizeCapability:(identity:AgentIdentity,operationId:string,input:unknown)=>boolean|Promise<boolean>;
 createModel:(definition:AgentDefinitionVersion,tools:Tool[])=>ToolModel|Promise<ToolModel>;
 maxTurns?:number;
};

/** Prepare one host-authorized ephemeral run from the current agent definition. */
export async function createConfiguredAgentRun(options:Options):Promise<{run:(input:RunInput,options?:{signal?:AbortSignal})=>ReturnType<LangGraphAGUIAdapter['run']>}> {
 if(!options||!options.definitions||typeof options.definitions.get!=='function'||!options.registry||typeof options.registry.invoke!=='function'||typeof options.authorizeRun!=='function'||typeof options.authorizeCapability!=='function'||typeof options.createModel!=='function'||!Array.isArray(options.bindings)||!Number.isSafeInteger(options.expectedVersion)||options.expectedVersion<1)throw Error('Invalid configured agent');
 const {definitions,registry,authorizeRun,authorizeCapability,createModel,tenantId,agentId,expectedVersion,maxTurns}=options;
 const definition=definitions.get(tenantId,agentId);
 if(!definition||definition.version!==expectedVersion||!definition.manifest.lifecycle.enabled||definition.manifest.tenantId!==tenantId||definition.manifest.agentId!==agentId)throw Error('Agent definition unavailable');
 const snapshot=structuredClone(definition),identity:AgentIdentity={tenantId,agentId,definitionVersion:expectedVersion,servicePrincipalId:snapshot.manifest.servicePrincipalId};
 const current=()=>{const latest=definitions.get(tenantId,agentId);if(!latest||latest.version!==expectedVersion||!latest.manifest.lifecycle.enabled||latest.manifest.tenantId!==tenantId||latest.manifest.agentId!==agentId||latest.manifest.servicePrincipalId!==identity.servicePrincipalId)throw Error('Agent definition changed');};
 if(await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');current();
 if(snapshot.manifest.allowedCapabilities.length>50)throw Error('Too many configured tools');
 const bindings=new Map<string,Binding>(),names=new Set<string>();
 for(const binding of options.bindings){
  if(!binding||typeof binding.operationId!=='string'||typeof binding.toolName!=='string'||typeof binding.description!=='string'||bindings.has(binding.operationId)||names.has(binding.toolName))throw Error('Invalid configured tool');
  const entry={operationId:binding.operationId,toolName:binding.toolName,description:binding.description};bindings.set(entry.operationId,entry);names.add(entry.toolName);
 }
 let runSignal:AbortSignal|undefined;
 const tools=snapshot.manifest.allowedCapabilities.map(operationId=>{
  const binding=bindings.get(operationId);if(!binding)throw Error('Configured capability unavailable');
  return createCapabilityTool({name:binding.toolName,description:binding.description,invoke:async input=>{
   if(!runSignal||runSignal.aborted)throw Error('Agent run aborted');current();
   if(await authorizeCapability({...identity},operationId,structuredClone(input))!==true)throw Error('Agent capability forbidden');
   if(runSignal?.aborted)throw Error('Agent run aborted');current();
   return registry.invoke(operationId,structuredClone(input),{tenantId,principalId:identity.servicePrincipalId,origin:'agent'});
  }});
 });
 const model=await createModel(structuredClone(snapshot),[...tools]);if(!model||typeof model.invoke!=='function')throw Error('Invalid agent model');current();
 const adapter=new LangGraphAGUIAdapter(createToolCallingModel(model,tools,{maxTurns}));let used=false;
 return {async *run(input,runOptions={}){
  if(used)throw Error('Configured agent run already used');used=true;current();
  const deadline=AbortSignal.timeout(snapshot.manifest.lifecycle.runTimeoutMs);
  runSignal=runOptions.signal?AbortSignal.any([deadline,runOptions.signal]):deadline;
  if(runSignal.aborted||await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');
  if(runSignal.aborted)throw Error('Agent run aborted');current();
  yield* adapter.run(input,{signal:runSignal});
 }};
}
export type {AgentIdentity as ConfiguredAgentIdentity,Binding as ConfiguredAgentBinding,Options as ConfiguredAgentOptions};
