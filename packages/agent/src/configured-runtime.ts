import {LangGraphAGUIAdapter,type RunInput} from './index.js';
import {createCapabilityTool} from './capability-tool.js';
import {createToolCallingModel,type ToolModel} from './tool-model.js';
import {SqliteAgentActionJournal} from './action-journal.js';
import {SqliteAgentApprovals} from './agent-approvals.js';
import {type BaseCheckpointSaver} from '@langchain/langgraph-checkpoint';
import {type AgentDefinitionVersion} from './persistent-definitions.js';

type AgentIdentity={tenantId:string;agentId:string;definitionVersion:number;servicePrincipalId:string};
type Binding={operationId:string;toolName:string;description:string};
type Delegation={tenantId:string;agentId:string;runId:string;principalId:string;grantId:string;permissionVersion:string;expiresAt:number};
type DelegationOptions={grant:Delegation;authorize:(identity:AgentIdentity,grant:Delegation,operationId:string,input:unknown)=>boolean|Promise<boolean>;clock?:()=>number};
const validId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
type Tool=ReturnType<typeof createCapabilityTool>;
type Options={
 definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined};
 tenantId:string;agentId:string;expectedVersion:number;
 bindings:Binding[];
 registry:{invoke:(operationId:string,input:unknown,context:{tenantId:string;principalId:string;origin:'agent'})=>Promise<unknown>};
 authorizeRun:(identity:AgentIdentity)=>boolean|Promise<boolean>;
 authorizeCapability:(identity:AgentIdentity,operationId:string,input:unknown)=>boolean|Promise<boolean>;
 createModel:(definition:AgentDefinitionVersion,tools:Tool[])=>ToolModel|Promise<ToolModel>;
 actionJournal?:{journal:SqliteAgentActionJournal;maxAttempts:number;prepareInput:(operationId:string,input:unknown,idempotencyKey:string)=>unknown};
 approval?:{store:SqliteAgentApprovals;leaseToken:string;expiresAt:number;required:(identity:AgentIdentity,operationId:string,input:unknown)=>boolean|Promise<boolean>};
 delegation?:DelegationOptions;
 maxTurns?:number;checkpoint?:{saver:BaseCheckpointSaver;threadId:string;resume:boolean};
};

/** Prepare one host-authorized ephemeral run from the current agent definition. */
export async function createConfiguredAgentRun(options:Options):Promise<{run:(input:RunInput,options?:{signal?:AbortSignal})=>ReturnType<LangGraphAGUIAdapter['run']>}> {
 if(!options||!options.definitions||typeof options.definitions.get!=='function'||!options.registry||typeof options.registry.invoke!=='function'||typeof options.authorizeRun!=='function'||typeof options.authorizeCapability!=='function'||typeof options.createModel!=='function'||!Array.isArray(options.bindings)||!Number.isSafeInteger(options.expectedVersion)||options.expectedVersion<1)throw Error('Invalid configured agent');
 const {definitions,registry,authorizeRun,authorizeCapability,createModel,tenantId,agentId,expectedVersion,maxTurns,checkpoint,actionJournal,approval}=options;
 const configuredDelegation=options.delegation;
 if(configuredDelegation&&(!configuredDelegation.grant||typeof configuredDelegation.authorize!=='function'||(configuredDelegation.clock!==undefined&&typeof configuredDelegation.clock!=='function')))throw Error('Invalid delegation');
 const grant=configuredDelegation?structuredClone(configuredDelegation.grant):undefined;
 if(grant&&(!validId(grant.tenantId)||!validId(grant.agentId)||!validId(grant.runId)||!validId(grant.principalId)||!validId(grant.grantId)||!validId(grant.permissionVersion)||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<0||grant.tenantId!==tenantId||grant.agentId!==agentId))throw Error('Invalid delegation');
 const delegationAuthorize=configuredDelegation?.authorize,delegationClock=configuredDelegation?.clock??Date.now;
 if(approval&&(!actionJournal||!(approval.store instanceof SqliteAgentApprovals)||typeof approval.leaseToken!=='string'||!Number.isSafeInteger(approval.expiresAt)||typeof approval.required!=='function'))throw Error('Invalid approval policy');
 if(actionJournal&&(!(actionJournal.journal instanceof SqliteAgentActionJournal)||!Number.isSafeInteger(actionJournal.maxAttempts)||actionJournal.maxAttempts<1||actionJournal.maxAttempts>20||typeof actionJournal.prepareInput!=='function'))throw Error('Invalid action journal');
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
 const checkDelegation=async(operationId:string,input:unknown)=>{if(!grant)return;const now=delegationClock();if(!Number.isSafeInteger(now)||now<0||now>=grant.expiresAt)throw Error('Delegation expired');if(await delegationAuthorize!({...identity},{...grant},operationId,structuredClone(input))!==true)throw Error('Delegation forbidden');const after=delegationClock();if(!Number.isSafeInteger(after)||after<0||after>=grant.expiresAt)throw Error('Delegation expired');if(runSignal?.aborted)throw Error('Agent run aborted');current();};
 const authority=grant?JSON.stringify([identity.servicePrincipalId,grant.principalId]):undefined;
 const tools=snapshot.manifest.allowedCapabilities.map(operationId=>{
  const binding=bindings.get(operationId);if(!binding)throw Error('Configured capability unavailable');
  return createCapabilityTool({name:binding.toolName,description:binding.description,invoke:async (input,context)=>{
   if(!runSignal||runSignal.aborted)throw Error('Agent run aborted');current();
   if(await authorizeCapability({...identity},operationId,structuredClone(input))!==true)throw Error('Agent capability forbidden');
   if(runSignal?.aborted)throw Error('Agent run aborted');current();
   await checkDelegation(operationId,input);
   const actor={tenantId,principalId:grant?.principalId??identity.servicePrincipalId,origin:'agent' as const};
   if(actionJournal){if(!context?.toolCallId)throw Error('Missing action ID');let required=false;
    if(approval){const decision=await approval.required({...identity},operationId,structuredClone(input));if(typeof decision!=='boolean')throw Error('Invalid approval policy result');required=decision;if(runSignal?.aborted)throw Error('Agent run aborted');current();if(required){const request=await approval.store.request({tenantId,principalId:identity.servicePrincipalId},approval.leaseToken,context.toolCallId,operationId,input,approval.expiresAt,authority);if(request.status!=='approved')throw Error('Approval required');}}
    await checkDelegation(operationId,input);
    return actionJournal.journal.invoke(context.toolCallId,operationId,input,actionJournal.maxAttempts,async (data,key)=>{if(runSignal?.aborted)throw Error('Agent run aborted');current();await checkDelegation(operationId,data);const mapped=actionJournal.prepareInput(operationId,data,key);return registry.invoke(operationId,mapped,actor);},required,authority);}
   return registry.invoke(operationId,structuredClone(input),actor);
  }});
 });
 const model=await createModel(structuredClone(snapshot),[...tools]);if(!model||typeof model.invoke!=='function')throw Error('Invalid agent model');current();
 const adapter=new LangGraphAGUIAdapter(createToolCallingModel(model,tools,{maxTurns,checkpoint}),{direct:!!checkpoint});let used=false;
 return {async *run(input,runOptions={}){
  if(used)throw Error('Configured agent run already used');if(grant&&grant.runId!==input.runId)throw Error('Delegation run mismatch');if(checkpoint&&checkpoint.threadId!==input.runId)throw Error('Checkpoint run mismatch');if(actionJournal&&!actionJournal.journal.isBoundTo({tenantId,agentId},input.runId))throw Error('Action journal run mismatch');if(approval&&!approval.store.isBoundTo({tenantId,agentId},input.runId))throw Error('Approval run mismatch');used=true;current();
  const deadline=AbortSignal.timeout(snapshot.manifest.lifecycle.runTimeoutMs);
  runSignal=runOptions.signal?AbortSignal.any([deadline,runOptions.signal]):deadline;
  if(runSignal.aborted||await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');
  if(runSignal.aborted)throw Error('Agent run aborted');current();
  yield* adapter.run(input,{signal:runSignal});
 }};
}
export type {AgentIdentity as ConfiguredAgentIdentity,Binding as ConfiguredAgentBinding,Options as ConfiguredAgentOptions,Delegation as AgentDelegation,DelegationOptions as AgentDelegationOptions};
