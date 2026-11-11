import {randomUUID} from 'node:crypto';
import {context as otelContext,trace,SpanKind,SpanStatusCode,type Tracer} from '@opentelemetry/api';
import {SqliteAgentTokenBudget} from './agent-token-budget.js';
import {PostgresAgentSharedCost,type SharedCostActor} from './postgres-agent-shared-cost.js';
import {AgentApprovalRequired} from './approval-required.js';
import {AgentDelegationExpired} from './delegation-expired.js';
import {LangGraphAGUIAdapter,type RunInput} from './index.js';
import {createCapabilityTool} from './capability-tool.js';
import {createToolCallingModel,type ToolModel,type LimitedToolModel,type CostLimitedToolModel} from './tool-model.js';
import {SqliteAgentActionJournal,markNoEffect,hadNoEffect} from './action-journal.js';
import {PostgresAgentActionJournalFoundation} from './postgres-action-journal-foundation.js';
import {PostgresAgentTokenBudgetFoundation} from './postgres-token-budget-foundation.js';
import {PostgresAgentCheckpointerFoundation} from './postgres-checkpointer-foundation.js';
import {PostgresAgentApprovalsFoundation} from './postgres-agent-approvals-foundation.js';
import {PostgresAgentDelegationsFoundation} from './postgres-agent-delegations-foundation.js';
import {SqliteAgentApprovals} from './agent-approvals.js';
import {type BaseCheckpointSaver} from '@langchain/langgraph-checkpoint';
import {type AgentDefinitionVersion} from './persistent-definitions.js';
import {isIdentifier} from './validation.js';

export type ConfiguredAgentOperationObservation={kind:'model'|'capability';outcome:'succeeded'|'failed';durationMs:number};
type AgentIdentity={tenantId:string;agentId:string;definitionVersion:number;servicePrincipalId:string};
type Binding={operationId:string;toolName:string;description:string};
type Delegation={tenantId:string;agentId:string;runId:string;principalId:string;grantId:string;permissionVersion:string;expiresAt:number;revision?:number};
type DelegationOptions={grant:Delegation;store?:PostgresAgentDelegationsFoundation;authorize:(identity:AgentIdentity,grant:Delegation,operationId:string,input:unknown)=>boolean|Promise<boolean>;clock?:()=>number};
const validId=isIdentifier;
type Tool=ReturnType<typeof createCapabilityTool>;
type Options={
 definitions:{get:(tenantId:string,agentId:string)=>AgentDefinitionVersion|undefined|Promise<AgentDefinitionVersion|undefined>;getWithSignal?:(tenantId:string,agentId:string,signal:AbortSignal)=>AgentDefinitionVersion|undefined|Promise<AgentDefinitionVersion|undefined>};
 tenantId:string;agentId:string;expectedVersion:number;
 bindings:Binding[];
 registry:{invoke:(operationId:string,input:unknown,context:{tenantId:string;principalId:string;origin:'agent'})=>Promise<unknown>};
 authorizeRun:(identity:AgentIdentity)=>boolean|Promise<boolean>;
 authorizeCapability:(identity:AgentIdentity,operationId:string,input:unknown)=>boolean|Promise<boolean>;
 createModel:(definition:AgentDefinitionVersion,tools:Tool[])=>ToolModel|Promise<ToolModel>;
 actionJournal?:{journal:SqliteAgentActionJournal|PostgresAgentActionJournalFoundation;maxAttempts:number;prepareInput:(operationId:string,input:unknown,idempotencyKey:string)=>unknown};
 approval?:{store:SqliteAgentApprovals|PostgresAgentApprovalsFoundation;leaseToken:string;expiresAt:number;required:(identity:AgentIdentity,operationId:string,input:unknown)=>boolean|Promise<boolean>};
 delegation?:DelegationOptions;
 tokenBudget?:{budget:SqliteAgentTokenBudget|PostgresAgentTokenBudgetFoundation;maxTokensPerCall:number;maxCostMicrosPerCall?:number;sharedCost?:{ledger:PostgresAgentSharedCost;actor:SharedCostActor}};
 /** Internal integration only; all shared stores must be bound to this run lease. */
 sharedRunLease?:string;
 maxTurns?:number;recheckModelAuthority?:boolean;checkpoint?:{saver:BaseCheckpointSaver;threadId:string;resume:boolean};tracing?:{tracer:Tracer};observeOperation?:(observation:ConfiguredAgentOperationObservation)=>void;
};

/** Prepare one host-authorized ephemeral run from the current agent definition. */
export async function createConfiguredAgentRun(options:Options):Promise<{run:(input:RunInput,options?:{signal?:AbortSignal})=>ReturnType<LangGraphAGUIAdapter['run']>;pendingApproval:()=>{actionId:string}|undefined}> {
 if(!options||!options.definitions||typeof options.definitions.get!=='function'||(options.definitions.getWithSignal!==undefined&&typeof options.definitions.getWithSignal!=='function')||!options.registry||typeof options.registry.invoke!=='function'||typeof options.authorizeRun!=='function'||typeof options.authorizeCapability!=='function'||typeof options.createModel!=='function'||!Array.isArray(options.bindings)||!Number.isSafeInteger(options.expectedVersion)||options.expectedVersion<1||(options.maxTurns!==undefined&&(!Number.isSafeInteger(options.maxTurns)||options.maxTurns<1||options.maxTurns>10))||(options.recheckModelAuthority!==undefined&&typeof options.recheckModelAuthority!=='boolean'))throw Error('Invalid configured agent');
 const {definitions,registry,authorizeRun,authorizeCapability,createModel,tenantId,agentId,expectedVersion,maxTurns,recheckModelAuthority,sharedRunLease}=options;
 const checkpoint=options.checkpoint?{...options.checkpoint}:undefined,actionJournal=options.actionJournal?{...options.actionJournal}:undefined,approval=options.approval?{...options.approval}:undefined,tokenBudget=options.tokenBudget?{...options.tokenBudget}:undefined;
 const getDefinition=definitions.get.bind(definitions),getDefinitionWithSignal=definitions.getWithSignal?.bind(definitions);
 if(options.tracing!==undefined&&(!options.tracing||!options.tracing.tracer||typeof options.tracing.tracer.startSpan!=='function'))throw Error('Invalid configured agent tracing');const tracer=options.tracing?.tracer;if(options.observeOperation!==undefined&&typeof options.observeOperation!=='function')throw Error('Invalid configured agent observation');const observeOperation=options.observeOperation;
 const configuredDelegation=options.delegation;
 if(configuredDelegation&&(!configuredDelegation.grant||typeof configuredDelegation.authorize!=='function'||(configuredDelegation.clock!==undefined&&typeof configuredDelegation.clock!=='function')))throw Error('Invalid delegation');
 const grant=configuredDelegation?structuredClone(configuredDelegation.grant):undefined;
 if(grant&&(!validId(grant.tenantId)||!validId(grant.agentId)||!validId(grant.runId)||!validId(grant.principalId)||!validId(grant.grantId)||!validId(grant.permissionVersion)||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<0||(grant.revision!==undefined&&(!Number.isSafeInteger(grant.revision)||grant.revision<1))||grant.tenantId!==tenantId||grant.agentId!==agentId))throw Error('Invalid delegation');
 const delegationAuthorize=configuredDelegation?.authorize,delegationClock=configuredDelegation?.clock??Date.now,delegationStore=configuredDelegation?.store;
 if(tokenBudget&&(!(tokenBudget.budget instanceof SqliteAgentTokenBudget)&&!(tokenBudget.budget instanceof PostgresAgentTokenBudgetFoundation)||!Number.isSafeInteger(tokenBudget.maxTokensPerCall)||tokenBudget.maxTokensPerCall<1))throw Error('Invalid token budget');
 const budgetStore=tokenBudget?.budget,maxTokensPerCall=tokenBudget?.maxTokensPerCall,maxCostMicrosPerCall=tokenBudget?.maxCostMicrosPerCall,sharedConfig=tokenBudget?.sharedCost;
 const budgetCost=budgetStore?.hasCostLimit()?await budgetStore.costSummary():undefined;
 if(tokenBudget&&(budgetCost?(!Number.isSafeInteger(maxCostMicrosPerCall)||maxCostMicrosPerCall!<1||maxCostMicrosPerCall!>budgetCost.limit):maxCostMicrosPerCall!==undefined))throw Error('Invalid token budget');
 if(sharedConfig!==undefined&&(!sharedConfig||!(sharedConfig.ledger instanceof PostgresAgentSharedCost)||!budgetCost||!sharedConfig.actor||!validId(sharedConfig.actor.tenantId)||!validId(sharedConfig.actor.principalId)||sharedConfig.actor.tenantId!==tenantId||!sharedConfig.ledger.isBoundTo(tenantId,budgetCost.currency)))throw Error('Invalid shared cost budget');
 const sharedLedger=sharedConfig?.ledger,sharedActor=sharedConfig?{tenantId:sharedConfig.actor.tenantId,principalId:sharedConfig.actor.principalId}:undefined;
 if(approval&&(!actionJournal||(!(approval.store instanceof SqliteAgentApprovals)&&!(approval.store instanceof PostgresAgentApprovalsFoundation))||typeof approval.leaseToken!=='string'||!Number.isSafeInteger(approval.expiresAt)||typeof approval.required!=='function'))throw Error('Invalid approval policy');
 if(actionJournal&&(!(actionJournal.journal instanceof SqliteAgentActionJournal)&&!(actionJournal.journal instanceof PostgresAgentActionJournalFoundation)||!Number.isSafeInteger(actionJournal.maxAttempts)||actionJournal.maxAttempts<1||actionJournal.maxAttempts>20||typeof actionJournal.prepareInput!=='function'))throw Error('Invalid action journal');
 const sharedJournal=actionJournal?.journal instanceof PostgresAgentActionJournalFoundation,sharedBudget=budgetStore instanceof PostgresAgentTokenBudgetFoundation,sharedCheckpoint=checkpoint?.saver instanceof PostgresAgentCheckpointerFoundation;
 if(sharedJournal||sharedBudget||sharedCheckpoint||sharedRunLease!==undefined){const s={tenantId,agentId},runId=checkpoint?.threadId;if(!validId(sharedRunLease)||!validId(runId)||!(actionJournal?.journal instanceof PostgresAgentActionJournalFoundation)||!(budgetStore instanceof PostgresAgentTokenBudgetFoundation)||!(checkpoint?.saver instanceof PostgresAgentCheckpointerFoundation)||(grant&&(!(delegationStore instanceof PostgresAgentDelegationsFoundation)||!delegationStore.isBoundTo(s,runId)||!delegationStore.sharesJournalDatabase(actionJournal.journal)||grant.runId!==runId||grant.revision===undefined))||(approval&&(!(approval.store instanceof PostgresAgentApprovalsFoundation)||approval.leaseToken!==sharedRunLease||!approval.store.isBoundTo(s,runId)||!actionJournal.journal.sharesDatabase(approval.store)))||!actionJournal.journal.matchesLease(s,runId,sharedRunLease)||!budgetStore.matchesLease(s,runId,sharedRunLease)||!checkpoint.saver.matchesLease(s,runId,sharedRunLease)||!actionJournal.journal.sharesDatabase(budgetStore)||!actionJournal.journal.sharesDatabase(checkpoint.saver))throw Error('Invalid shared run integration');}else if(approval?.store instanceof PostgresAgentApprovalsFoundation||delegationStore!==undefined)throw Error('Invalid shared run integration');
 const definition=await getDefinition(tenantId,agentId);
 if(!definition||definition.version!==expectedVersion||!definition.manifest.lifecycle.enabled||definition.manifest.tenantId!==tenantId||definition.manifest.agentId!==agentId||(definition.manifest.instructions!==undefined&&(typeof definition.manifest.instructions!=='string'||definition.manifest.instructions.length<1||definition.manifest.instructions.length>16000))||(definition.manifest.lifecycle.maxTurns!==undefined&&(!Number.isSafeInteger(definition.manifest.lifecycle.maxTurns)||definition.manifest.lifecycle.maxTurns<1||definition.manifest.lifecycle.maxTurns>10)))throw Error('Agent definition unavailable');
 const snapshot=structuredClone(definition),identity:AgentIdentity={tenantId,agentId,definitionVersion:expectedVersion,servicePrincipalId:snapshot.manifest.servicePrincipalId};
 const manifestTurns=snapshot.manifest.lifecycle.maxTurns,effectiveMaxTurns=Math.min(maxTurns??4,manifestTurns??10);
 if(sharedActor&&sharedActor.principalId!==identity.servicePrincipalId)throw Error('Invalid shared cost actor');
 let runSignal:AbortSignal|undefined,pendingActionId:string|undefined,currentRunId:string|undefined;
 const current=async()=>{const signal=runSignal;if(signal?.aborted)throw Error('Agent run aborted');const latest=signal&&getDefinitionWithSignal?await getDefinitionWithSignal(tenantId,agentId,signal):await getDefinition(tenantId,agentId);if(signal?.aborted)throw Error('Agent run aborted');if(!latest||latest.version!==expectedVersion||!latest.manifest.lifecycle.enabled||latest.manifest.tenantId!==tenantId||latest.manifest.agentId!==agentId||latest.manifest.servicePrincipalId!==identity.servicePrincipalId)throw Error('Agent definition changed');};
 if(await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');await current();
 if(snapshot.manifest.allowedCapabilities.length>50)throw Error('Too many configured tools');
 const bindings=new Map<string,Binding>(),names=new Set<string>();
 for(const binding of options.bindings){
  if(!binding||typeof binding.operationId!=='string'||typeof binding.toolName!=='string'||typeof binding.description!=='string'||bindings.has(binding.operationId)||names.has(binding.toolName))throw Error('Invalid configured tool');
  const entry={operationId:binding.operationId,toolName:binding.toolName,description:binding.description};bindings.set(entry.operationId,entry);names.add(entry.toolName);
 }
 const traced=async<T>(kind:'model'|'capability',operation:()=>Promise<T>):Promise<T>=>{if(!tracer)return operation();let span;let parent;try{parent=otelContext.active();span=tracer.startSpan(`agent.${kind}`,{kind:SpanKind.INTERNAL},parent);}catch{return operation();}let pending:Promise<T>|undefined;const begin=()=>{if(!pending)pending=Promise.resolve().then(operation);};try{try{otelContext.with(trace.setSpan(parent,span),begin);}catch{}if(!pending)begin();const result=await pending!;try{span.setAttribute('app_mixer.agent.operation.outcome','succeeded');}catch{}return result;}catch(error){try{span.setAttribute('app_mixer.agent.operation.outcome','failed');span.setAttribute('error.type',kind==='model'?'agent_model_failed':'agent_capability_failed');span.setStatus({code:SpanStatusCode.ERROR});}catch{}throw error;}finally{try{span.end();}catch{}}};
 const observed=async<T>(kind:'model'|'capability',operation:()=>Promise<T>):Promise<T>=>{if(!observeOperation)return traced(kind,operation);let start:number|undefined;try{start=performance.now();}catch{}let outcome:'succeeded'|'failed'='failed';try{const result=await traced(kind,operation);outcome='succeeded';return result;}finally{try{if(start!==undefined){const durationMs=performance.now()-start;if(Number.isFinite(durationMs)&&durationMs>=0){const result=observeOperation({kind,outcome,durationMs}) as unknown;if(result&&typeof (result as PromiseLike<unknown>).then==='function')void Promise.resolve(result).catch(()=>{});}}}catch{}}};
 const checkActive=async()=>{if(runSignal?.aborted)throw Error('Agent run aborted');await current();if(runSignal?.aborted)throw Error('Agent run aborted');if(grant){if(delegationStore){const state=await delegationStore.state({tenantId,principalId:identity.servicePrincipalId},grant,runSignal);if(runSignal?.aborted)throw Error('Agent run aborted');if(state==='expired')throw new AgentDelegationExpired();if(state!=='valid')throw Error('Delegation forbidden');}else{const now=delegationClock();if(!Number.isSafeInteger(now)||now<0||now>=grant.expiresAt)throw new AgentDelegationExpired();}}};
 const checkDelegation=async(operationId:string,input:unknown)=>{if(!grant)return;if(!delegationStore){const now=delegationClock();if(!Number.isSafeInteger(now)||now<0||now>=grant.expiresAt)throw new AgentDelegationExpired();}if(await delegationAuthorize!({...identity},{...grant},operationId,structuredClone(input))!==true)throw Error('Delegation forbidden');await checkActive();};
 const authority=grant?JSON.stringify([identity.servicePrincipalId,grant.principalId]):undefined;
 const tools=snapshot.manifest.allowedCapabilities.map(operationId=>{
  const binding=bindings.get(operationId);if(!binding)throw Error('Configured capability unavailable');
  return createCapabilityTool({name:binding.toolName,description:binding.description,invoke:async (input,context)=>observed('capability',async()=>{
   if(!runSignal||runSignal.aborted)throw Error('Agent run aborted');await checkActive();
   if(await authorizeCapability({...identity},operationId,structuredClone(input))!==true)throw Error('Agent capability forbidden');
   if(runSignal?.aborted)throw Error('Agent run aborted');await checkActive();
   await checkDelegation(operationId,input);await checkActive();
   const actor={tenantId,principalId:grant?.principalId??identity.servicePrincipalId,origin:'agent' as const};
   if(actionJournal){if(!context?.toolCallId)throw Error('Missing action ID');let required=false;
    if(approval){const decision=await approval.required({...identity},operationId,structuredClone(input));if(typeof decision!=='boolean')throw Error('Invalid approval policy result');required=decision;await checkActive();if(required){const request=await approval.store.request({tenantId,principalId:identity.servicePrincipalId},approval.leaseToken,context.toolCallId,operationId,input,approval.expiresAt,authority);if(request.status==='pending'){pendingActionId=context.toolCallId;throw new AgentApprovalRequired();}if(request.status!=='approved')throw Error('Approval unavailable');}}
    await checkDelegation(operationId,input);await checkActive();
    // The runtime's own checks run before the registry is called, so their failures had no effect either.
    return actionJournal.journal.invoke(context.toolCallId,operationId,input,actionJournal.maxAttempts,async (data,key)=>{let mapped:unknown;try{await checkActive();await checkDelegation(operationId,data);await checkActive();mapped=actionJournal.prepareInput(operationId,data,key);}catch(error){throw markNoEffect(error);}return registry.invoke(operationId,mapped,actor);},required,authority);}
   return registry.invoke(operationId,structuredClone(input),actor);
  })});
 });
 const model=await createModel(structuredClone(snapshot),[...tools]);if(!model||typeof model.invoke!=='function')throw Error('Invalid agent model');await current();
 let activeModel:ToolModel=model;if(budgetStore){const limited=model as Partial<LimitedToolModel & CostLimitedToolModel>,cost=budgetStore.hasCostLimit(),currency=budgetCost?.currency;if((cost?typeof limited.invokeLimitedCost!=='function':typeof limited.invokeLimited!=='function')||maxTokensPerCall!>snapshot.manifest.quotas.maxTokensPerRun)throw Error('Limited model required');activeModel={invoke:async(messages,options)=>{if(options?.signal?.aborted)throw Error('Agent run aborted');const callId=randomUUID(),reserved=maxTokensPerCall!;await budgetStore.reserve(callId,reserved,maxCostMicrosPerCall,sharedLedger?.binding());if(budgetStore instanceof PostgresAgentTokenBudgetFoundation){await checkActive();await budgetStore.assertLease();}if(sharedLedger){if(!currentRunId||!sharedActor)throw Error('Shared cost run unavailable');await sharedLedger.reserve(sharedActor,{agentId,runId:currentRunId,callId},maxCostMicrosPerCall!);await checkActive();if(await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');await checkActive();await budgetStore.assertLease();if(options?.signal?.aborted||runSignal?.aborted)throw Error('Agent run aborted');}else if(options?.signal?.aborted||runSignal?.aborted){await budgetStore.settle(callId,0,cost?0:undefined);throw Error('Agent run aborted');}let response;try{response=cost?await limited.invokeLimitedCost!(messages,{signal:options?.signal,maxTotalTokens:reserved,maxCostMicros:maxCostMicrosPerCall!,currency:currency!,callId}):await limited.invokeLimited!(messages,{signal:options?.signal,maxTotalTokens:reserved,callId});}catch(error){/* A refusal before anything was sent used nothing: release the reservation instead of leaving the run uncertain. */if(hadNoEffect(error))await budgetStore.settle(callId,0,cost?0:undefined);throw error;}if(!response||!Number.isSafeInteger(response.usedTokens)||response.usedTokens<0)throw Error('Invalid model token usage');const usedCost=cost?(response as {usedCostMicros?:number}).usedCostMicros:undefined;if(cost&&(!Number.isSafeInteger(usedCost)||usedCost!<0))throw Error('Invalid model cost usage');if(sharedLedger)await sharedLedger.settle(sharedActor!,{agentId,runId:currentRunId!,callId},usedCost!);await budgetStore.settle(callId,response.usedTokens,usedCost);if(response.usedTokens>reserved)throw Error('Model token limit exceeded');if(cost&&usedCost!>maxCostMicrosPerCall!)throw Error('Model cost limit exceeded');return response.message;}};}
 if(recheckModelAuthority){const underlying=activeModel,permit=async()=>{await checkActive();if(await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');await checkActive();};activeModel={invoke:async(messages,options)=>{await permit();const response=await underlying.invoke(messages,options);await permit();return response;}};}
 if(tracer||observeOperation){const untraced=activeModel;activeModel={invoke:(messages,options)=>observed('model',()=>untraced.invoke(messages,options))};}
 const adapter=new LangGraphAGUIAdapter(createToolCallingModel(activeModel,tools,{maxTurns:effectiveMaxTurns,checkpoint,systemPrompt:snapshot.manifest.instructions}),{direct:!!checkpoint});let used=false;
 return {pendingApproval:()=>pendingActionId?{actionId:pendingActionId}:undefined,async *run(input,runOptions={}){
  if(used)throw Error('Configured agent run already used');if(grant&&grant.runId!==input.runId)throw Error('Delegation run mismatch');if(checkpoint&&checkpoint.threadId!==input.runId)throw Error('Checkpoint run mismatch');if(actionJournal&&!actionJournal.journal.isBoundTo({tenantId,agentId},input.runId))throw Error('Action journal run mismatch');if(approval&&!approval.store.isBoundTo({tenantId,agentId},input.runId))throw Error('Approval run mismatch');if(budgetStore&&!budgetStore.isBoundTo({tenantId,agentId},input.runId,snapshot.manifest.quotas.maxTokensPerRun))throw Error('Token budget run mismatch');used=true;currentRunId=input.runId;
  const deadline=AbortSignal.timeout(snapshot.manifest.lifecycle.runTimeoutMs);
  runSignal=runOptions.signal?AbortSignal.any([deadline,runOptions.signal]):deadline;
  await current();
  if(runSignal.aborted||await authorizeRun({...identity})!==true)throw Error('Agent run forbidden');
  if(runSignal.aborted)throw Error('Agent run aborted');await current();if(runSignal.aborted)throw Error('Agent run aborted');
  yield* adapter.run(input,{signal:runSignal});
 }};
}
export type {AgentIdentity as ConfiguredAgentIdentity,Binding as ConfiguredAgentBinding,Options as ConfiguredAgentOptions,Delegation as AgentDelegation,DelegationOptions as AgentDelegationOptions};
