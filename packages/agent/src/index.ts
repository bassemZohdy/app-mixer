import {AgentApprovalRequired} from './approval-required.js';
import {AgentDelegationExpired} from './delegation-expired.js';
import { randomUUID } from 'node:crypto';
import { EventType, type Event } from '@ag-ui/core';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, START, END, getWriter } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';

export type ChatMessage = {role:'user'|'assistant'; content:string};
export type RunInput = {threadId:string; runId:string; messages:ChatMessage[]};
export interface StreamingModel {
  stream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
}
export type OpenAIModelConfig = {model:string; apiKey:string; baseURL?:string; systemPrompt?:string};

/** The provider and credentials are configured by the host, never by a conversation message. */
export function createOpenAIModel(config: OpenAIModelConfig): StreamingModel {
  if (!config.model || !config.apiKey) throw Error('Model and API key are required');
  const model = new ChatOpenAI({model:config.model, apiKey:config.apiKey,
    ...(config.baseURL ? {configuration:{baseURL:config.baseURL}} : {})});
  return {
    async *stream(messages, signal) {
      const input: BaseMessage[] = [];
      if (config.systemPrompt) input.push(new SystemMessage(config.systemPrompt));
      for (const message of messages) input.push(message.role === 'user' ? new HumanMessage(message.content) : new AIMessage(message.content));
      const chunks = await model.stream(input, {signal});
      for await (const chunk of chunks) {
        if (typeof chunk.content === 'string') yield chunk.content;
        else for (const part of chunk.content) if (part.type === 'text' && typeof part.text === 'string') yield part.text;
      }
    }
  };
}

export function validateRunInput(input: RunInput): void {
  if (!input || typeof input.threadId !== 'string' || !input.threadId.trim() || input.threadId.length > 256 ||
      typeof input.runId !== 'string' || !input.runId.trim() || input.runId.length > 256 ||
      !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 100 ||
      input.messages.some(message => !message || !['user','assistant'].includes(message.role) ||
        typeof message.content !== 'string' || message.content.length > 100000)) throw Error('Invalid run input');
  if (input.messages.at(-1)?.role !== 'user') throw Error('Last message must be from the user');
}
const State = Annotation.Root({messages:Annotation<ChatMessage[]>(), response:Annotation<string>()});

/** Streams AG-UI events from a LangGraph run. Conversation history is supplied per run. */
export class LangGraphAGUIAdapter {
  constructor(private readonly model: StreamingModel, private readonly options: {direct?:boolean} = {}) {}
  async *run(input: RunInput, options: {signal?:AbortSignal} = {}): AsyncGenerator<Event> {
    validateRunInput(input);
    const {threadId,runId} = input;
    const messageId = randomUUID();
    const graph = new StateGraph(State)
      .addNode('respond', async (state, config) => {
        const writer = getWriter(config);
        if (!writer) throw Error('Streaming writer unavailable');
        for await (const delta of this.model.stream(state.messages, config.signal)) {
          if (typeof delta !== 'string') throw Error('Model returned a non-text chunk');
          if (delta) writer(delta);
        }
        return {response:''};
      })
      .addEdge(START,'respond').addEdge('respond',END).compile();
    yield {type:EventType.RUN_STARTED,threadId,runId};
    let started = false;
    try {
      const stream = this.options.direct ? this.model.stream(input.messages, options.signal) : await graph.stream({messages:input.messages}, {streamMode:'custom',signal:options.signal});
      for await (const delta of stream) {
        if (typeof delta !== 'string') throw Error('Invalid graph chunk');
        if (!started) { started = true; yield {type:EventType.TEXT_MESSAGE_START,messageId,role:'assistant'}; }
        yield {type:EventType.TEXT_MESSAGE_CONTENT,messageId,delta};
      }
      if (!started) yield {type:EventType.TEXT_MESSAGE_START,messageId,role:'assistant'};
      yield {type:EventType.TEXT_MESSAGE_END,messageId};
      yield {type:EventType.RUN_FINISHED,threadId,runId};
    } catch (error) {
      if (started) yield {type:EventType.TEXT_MESSAGE_END,messageId};
      yield error instanceof AgentApprovalRequired?{type:EventType.RUN_ERROR,message:'Human approval is required.',code:'AGENT_APPROVAL_REQUIRED'}:error instanceof AgentDelegationExpired?{type:EventType.RUN_ERROR,message:'Delegated authorization expired.',code:'AGENT_DELEGATION_EXPIRED'}:{type:EventType.RUN_ERROR,message:'The agent could not complete this run.',code:'AGENT_RUN_FAILED'};
    }
  }
}

export { createAGUIServer } from './transport.js';
export type { AgentTransportTracingOptions } from './transport-tracing.js';
export { DevelopmentAgent, createProposalClient } from './development.js';
export type { DraftSnapshot, ProposalResult, ProposalClient } from './development.js';
export { createCapabilityTool } from './capability-tool.js';
export { createOpenAIToolModel, createToolCallingModel } from './tool-model.js';
export type { ToolModel, LimitedToolModel, CostLimitedToolModel } from './tool-model.js';
export {SqliteAgentDefinitions,validateAgentManifest} from './persistent-definitions.js';
export {PostgresAgentDefinitions} from './postgres-agent-definitions.js';
export {PostgresAgentRunSlots} from './postgres-run-slots.js';
export {checkIdempotencyContract} from './idempotency-contract.js';
export type {IdempotencyContractOptions,IdempotencyContractFinding,IdempotencyContractReport} from './idempotency-contract.js';
export type {PostgresAgentRunSlotsOptions,AgentRunSlotLimits} from './postgres-run-slots.js';
export type {PostgresAgentDefinitionsOptions,AgentDefinitionActor,AgentDefinitionAccess,PostgresAgentDefinitionQuery,AgentDefinitionAudit,AgentDefinitionTenantLimits} from './postgres-agent-definitions.js';
export type {PersistentAgentManifest,AgentDefinitionVersion} from './persistent-definitions.js';
export {createConfiguredAgentRun} from './configured-runtime.js';
export type {ConfiguredAgentIdentity,ConfiguredAgentBinding,ConfiguredAgentOptions,ConfiguredAgentOperationObservation,AgentDelegation,AgentDelegationOptions} from './configured-runtime.js';
export {SqliteAgentRuns} from './durable-runs.js';
export type {DurableAgentRun,AgentRunScope,AgentRunStatus} from './durable-runs.js';
export {DurableAgentWorker} from './durable-worker.js';
export type {DurableAgentWorkerOptions,DurableAgentWorkerOutcome} from './durable-worker.js';
export {SqliteAgentCheckpointer} from './sqlite-checkpointer.js';
export type {AgentCheckpointerOptions} from './sqlite-checkpointer.js';
export {SqliteAgentActionJournal} from './action-journal.js';
export type {AgentAction,AgentActionJournalOptions,AgentActionStatus,ActionVerification,ActionVerificationRequest,AgentActionPage,ActionVerificationPass,ActionReconciliationEvidence,ActionReconciliationEvent} from './action-journal.js';
export {SqliteAgentTriggers} from './agent-triggers.js';
export type {TriggerRecord,AgentTriggerInput,AgentTriggerEnqueueOptions} from './agent-triggers.js';
export {SqliteAgentTriggerRetention} from './agent-trigger-retention.js';
export {AgentTriggerRetentionWorker} from './agent-trigger-retention-worker.js';
export {SqliteTriggerRetentionMetrics} from './agent-trigger-retention-metrics.js';
export type {TriggerRetentionMetricsOptions,TriggerRetentionMetricsSnapshot} from './agent-trigger-retention-metrics.js';
export type {AgentTriggerRetentionWorkerOptions} from './agent-trigger-retention-worker.js';
export type {AgentTriggerRetentionActor,AgentTriggerRetentionOptions,TriggerRedactionCandidate} from './agent-trigger-retention.js';
export {createAgentEventIngress} from './event-ingress.js';
export type {AgentEventIngressOptions,AgentEventSourceIdentity,AgentEventRequest,AgentEventWakeupTarget,AgentEventIngressObservation} from './event-ingress.js';
export {SqliteAgentSchedules} from './agent-schedules.js';
export type {AgentSchedule,AgentScheduleRule,AgentScheduleConfig,AgentScheduleFireOptions,AgentScheduleCursor,AgentSchedulePage} from './agent-schedules.js';
export {SqliteAgentScheduleHistory} from './agent-schedule-history.js';
export type {AgentScheduleEvent,AgentScheduleHistoryOptions,AgentScheduleHistoryActor} from './agent-schedule-history.js';
export {AgentScheduleWorker} from './schedule-worker.js';
export type {AgentScheduleWorkerOptions,AgentScheduleWakeupTarget} from './schedule-worker.js';
export {SqliteAgentMemory} from './agent-memory.js';
export type {AgentMemoryRecord,AgentMemoryAuditEvent,AgentMemoryScope,AgentMemoryActor,AgentMemoryProvenance,AgentMemoryAction,AgentMemoryOptions} from './agent-memory.js';
export {AgentSemanticMemory} from './semantic-memory.js';
export type {AgentMemoryEmbedder,SemanticMemoryRecord,SemanticMemoryHit,SemanticMemorySearchOptions as AgentMemorySearchOptions} from './semantic-memory.js';
export {evaluateAgentMemoryRetrieval} from './memory-retrieval-evaluation.js';
export type {MemoryEvaluationCase,MemoryEvaluationResult,MemoryEvaluationReport} from './memory-retrieval-evaluation.js';
export {registerSemanticMemorySearch} from './semantic-memory-capability.js';
export type {SemanticMemorySearchOptions} from './semantic-memory-capability.js';
export {SqliteAgentApprovals} from './agent-approvals.js';
export type {AgentApproval,AgentApprovalActor,AgentApprovalStatus,AgentApprovalAccess,AgentApprovalsOptions} from './agent-approvals.js';

export {createAgentApprovalServer} from './approval-server.js';
export type {AgentApprovalServerOptions} from './approval-server.js';

export {SqliteAgentDelegations} from './agent-delegations.js';
export type {AgentDelegationActor,AgentDelegationAccess,AgentDelegationRecord,AgentDelegationStoreOptions} from './agent-delegations.js';

export {SqliteAgentNotices} from './agent-notices.js';
export type {AgentNotice,AgentNoticeActor,AgentNoticeAccess,AgentNoticeOptions} from './agent-notices.js';
export {SqliteAgentNoticeDelivery} from './agent-notice-delivery.js';
export {AgentNoticeDeliveryWorker} from './notice-delivery-worker.js';
export {createAgentNoticeHttpsTransport,createAgentNoticeHttpsVerifier} from './notice-https-transport.js';
export type {AgentNoticeHttpsTransportOptions,AgentNoticeHttpsDestination} from './notice-https-transport.js';
export {SqliteAgentNoticeReceiver,createAgentNoticeReceiverServer} from './notice-https-receiver.js';
export type {ReceivedAgentNotice,AgentNoticeReceiverOptions,AgentNoticeReceiverActor,AgentNoticeReceiverAccess,AgentNoticeReceiverServerOptions} from './notice-https-receiver.js';
export type {AgentNoticeDeliveryWorkerOptions} from './notice-delivery-worker.js';
export type {AgentNoticeDelivery,AgentNoticeMessage,AgentNoticeDeliveryEvent,AgentNoticeDeliveryOptions,AgentNoticeDeliveryActor,AgentNoticeDeliveryAccess} from './agent-notice-delivery.js';

export {SqliteAgentTokenBudget} from './agent-token-budget.js';
export type {AgentSharedCostBinding,AgentTokenUsage,AgentCostUsage,AgentTokenBudgetOptions,AgentBudgetReconciliationEvidence,AgentBudgetReconciliationEvent} from './agent-token-budget.js';

export {SqliteAgentRunHistory} from './agent-run-history.js';
export {SqliteAgentRunMetrics} from './agent-run-metrics.js';
export type {AgentRunMetricStatus,AgentRunMetricsActor,AgentRunMetricsSnapshot,AgentRunMetricsOptions,AgentRunOperationalMetric,AgentActionBacklogMetric,AgentBudgetBacklogMetric} from './agent-run-metrics.js';
export {createAgentMetricsServer} from './agent-metrics-server.js';
export type {AgentMetricsServerOptions} from './agent-metrics-server.js';
export type {AgentRunEvent,AgentRunHistoryActor,AgentRunHistoryAccess,AgentRunHistoryOptions} from './agent-run-history.js';

export {createSignedWebhookAuthenticator} from './signed-webhook.js';
export type {SignedWebhookSource,SignedWebhookOptions} from './signed-webhook.js';

export {createGitlabWebhookAdapter} from './gitlab-webhook.js';
export type {GitlabWebhookOptions} from './gitlab-webhook.js';
export {createGithubWebhookAdapter} from './github-webhook.js';
export {createStripeWebhookAdapter} from './stripe-webhook.js';
export {createStandardWebhookAdapter} from './standard-webhook.js';
export type {StandardWebhookOptions} from './standard-webhook.js';
export {createSlackWebhookAdapter} from './slack-webhook.js';
export {createTwilioMessageWebhookAdapter} from './twilio-webhook.js';
export type {TwilioMessageWebhookOptions} from './twilio-webhook.js';
export {createShopifyWebhookAdapter} from './shopify-webhook.js';
export type {ShopifyWebhookOptions} from './shopify-webhook.js';
export type {SlackWebhookOptions} from './slack-webhook.js';
export type {StripeWebhookOptions} from './stripe-webhook.js';
export type {GithubWebhookOptions} from './github-webhook.js';

export {DurableAgentDispatcher} from './durable-dispatcher.js';
export type {DurableAgentDispatcherOptions} from './durable-dispatcher.js';

export {registerAgentExpiredLeaseDiscovery} from './agent-expired-lease-discovery.js';
export type {AgentExpiredLeaseDiscoveryOptions} from './agent-expired-lease-discovery.js';
export {registerAgentLeaseRecovery} from './agent-run-lease-recovery-capability.js';
export type {AgentLeaseRecoveryCapabilityOptions} from './agent-run-lease-recovery-capability.js';
export {AgentRunLeaseRecoveryWorker} from './agent-run-lease-recovery.js';
export {registerAgentRunControl} from './agent-run-control-capability.js';
export {registerAgentRunInspection} from './agent-run-inspection-capability.js';
export {registerAgentManualStart} from './agent-manual-start-capability.js';
export {registerAgentDefinitionControl} from './agent-definition-control-capability.js';
export {registerAgentDefinitionStatus} from './agent-definition-status-capability.js';
export {registerAgentDefinitionHistory} from './agent-definition-history-capability.js';
export {registerAgentDefinitionWrite} from './agent-definition-write-capability.js';
export {registerAgentDefinitionRead} from './agent-definition-read-capability.js';
export type {AgentDefinitionReadCapabilityOptions} from './agent-definition-read-capability.js';
export type {AgentDefinitionWriteCapabilityOptions} from './agent-definition-write-capability.js';
export type {AgentDefinitionHistoryCapabilityOptions} from './agent-definition-history-capability.js';
export type {AgentDefinitionStatusCapabilityOptions} from './agent-definition-status-capability.js';
export type {AgentDefinitionControlCapabilityOptions} from './agent-definition-control-capability.js';
export type {AgentManualStartCapabilityOptions} from './agent-manual-start-capability.js';
export type {AgentRunInspectionCapabilityOptions,AgentRunInspectionSnapshot} from './agent-run-inspection-capability.js';
export type {AgentRunControlCapabilityOptions} from './agent-run-control-capability.js';
export {SqliteAgentRunControlHistory} from './agent-run-control-history.js';
export {registerAgentRunControlHistory} from './agent-run-control-history-capability.js';
export type {AgentRunControlHistoryCapabilityOptions} from './agent-run-control-history-capability.js';
export type {AgentRunControlEvent,AgentRunControlHistoryOptions,AgentRunControlHistoryActor} from './agent-run-control-history.js';
export type {AgentRunLeaseRecoveryWorkerOptions,AgentLeaseRecoveryObservation} from './agent-run-lease-recovery.js';
export {AgentLeaseRecoveryMetrics} from './agent-lease-recovery-metrics.js';
export type {AgentLeaseRecoveryMetricsOptions} from './agent-lease-recovery-metrics.js';
export type {ExpiredAgentLease,AgentRunLeaseRecoveryEvidence,AgentRunControlEvidence} from './durable-runs.js';
export {SqliteAgentLeaseRecoveryHistory} from './agent-run-lease-recovery-history.js';
export {registerAgentLeaseRecoveryHistory} from './agent-run-lease-recovery-history-capability.js';
export type {AgentLeaseRecoveryHistoryCapabilityOptions} from './agent-run-lease-recovery-history-capability.js';
export type {AgentRunLeaseRecoveryEvent,AgentRunLeaseRecoveryHistoryOptions,AgentRunLeaseRecoveryHistoryActor} from './agent-run-lease-recovery-history.js';
export {AgentRunExpiryWorker} from './agent-run-expiry.js';
export type {AgentRunExpiryWorkerOptions,AgentRunExpiryObservation} from './agent-run-expiry.js';
export {AgentRunExpiryMetrics} from './agent-run-expiry-metrics.js';
export type {AgentRunExpiryMetricsOptions} from './agent-run-expiry-metrics.js';

export {AgentActionRecoveryWorker} from './action-recovery-worker.js';
export {createActionHttpsVerifier} from './action-https-verifier.js';
export type {ActionHttpsVerifierOptions,ActionHttpsLookupContext} from './action-https-verifier.js';
export type {AgentActionRecoveryWorkerOptions,AgentActionRecoveryObservation} from './action-recovery-worker.js';

export {registerSemanticMemoryWrite} from './semantic-memory-write-capability.js';
export type {SemanticMemoryWriteOptions,SemanticMemoryWriteInput,SemanticMemoryWriteMetadata} from './semantic-memory-write-capability.js';

export {registerSemanticMemoryDelete} from './semantic-memory-delete-capability.js';
export type {SemanticMemoryDeleteOptions,SemanticMemoryDeleteInput} from './semantic-memory-delete-capability.js';

export {SqliteAgentExpiryHistory} from './agent-expiry-history.js';
export type {AgentRunExpiryEvent,AgentRunExpiryHistoryOptions,AgentRunExpiryHistoryActor} from './agent-expiry-history.js';
export type {AgentRunExpiryEvidence} from './durable-runs.js';

export {registerSemanticMemoryRead} from './semantic-memory-read-capability.js';
export type {SemanticMemoryReadOptions,SemanticMemoryReadInput} from './semantic-memory-read-capability.js';

export {PostgresAgentMemory} from './postgres-agent-memory.js';
export type {PostgresAgentMemoryOptions,PostgresAgentMemoryQuery} from './postgres-agent-memory.js';

export {AgentMemoryRetentionWorker} from './agent-memory-retention.js';
export type {AgentMemoryRetentionWorkerOptions} from './agent-memory-retention.js';

export {AgentIngressMetrics} from './agent-ingress-metrics.js';
export type {AgentIngressMetricsOptions} from './agent-ingress-metrics.js';
export {SqliteAgentActionRecoveryDiscovery} from './action-recovery-discovery.js';
export type {AgentActionRecoveryDiscoveryActor,AgentActionRecoveryDiscoveryOptions,AgentActionRecoveryCandidate,AgentActionRecoveryPage} from './action-recovery-discovery.js';
export {registerActionRecoveryDiscovery} from './action-recovery-discovery-capability.js';
export type {ActionRecoveryDiscoveryCapabilityOptions} from './action-recovery-discovery-capability.js';
export {AgentActionRecoveryCoordinator} from './action-recovery-coordinator.js';
export type {AgentActionRecoveryCoordinatorOptions,AgentActionRecoverySession,AgentActionRecoveryCoordinatorObservation} from './action-recovery-coordinator.js';
export {SqliteAgentScheduleMetrics} from './agent-schedule-metrics.js';
export type {AgentScheduleMetricsOptions,AgentScheduleMetricsSnapshot} from './agent-schedule-metrics.js';

export {createPaddleWebhookAdapter} from './paddle-webhook.js';
export type {PaddleWebhookOptions} from './paddle-webhook.js';

export {AgentBudgetRecovery} from './agent-budget-recovery.js';
export type {AgentBudgetRecoveryActor,AgentBudgetRecoveryTarget,AgentBudgetVerifiedUsage,AgentBudgetRecoveryOptions} from './agent-budget-recovery.js';

export {registerBudgetRecovery,registerBudgetRecoveryHistory,registerBudgetRecoveryPending} from './agent-budget-recovery-capability.js';
export type {BudgetRecoveryCapabilityOptions,BudgetRecoveryHistoryCapabilityOptions,BudgetRecoveryPendingCapabilityOptions} from './agent-budget-recovery-capability.js';

export {SqliteAgentBudgetRecoveryDiscovery} from './agent-budget-recovery-discovery.js';
export type {AgentBudgetRecoveryCandidate,AgentBudgetRecoveryPage,AgentBudgetRecoveryDiscoveryActor,AgentBudgetRecoveryDiscoveryOptions} from './agent-budget-recovery-discovery.js';
export {registerBudgetRecoveryDiscovery} from './agent-budget-recovery-discovery-capability.js';
export type {BudgetRecoveryDiscoveryCapabilityOptions} from './agent-budget-recovery-discovery-capability.js';

export {createBudgetHttpsVerifier} from './budget-https-verifier.js';
export type {BudgetHttpsVerifierOptions,BudgetHttpsLookupContext} from './budget-https-verifier.js';

export {AgentBudgetRecoveryWorker} from './agent-budget-recovery-worker.js';
export type {AgentBudgetRecoveryWorkerOptions} from './agent-budget-recovery-worker.js';

export {AgentBudgetRecoveryCoordinator} from './agent-budget-recovery-coordinator.js';
export type {AgentBudgetRecoveryCoordinatorOptions,AgentBudgetRecoverySession} from './agent-budget-recovery-coordinator.js';

export {PostgresAgentSharedCost} from './postgres-agent-shared-cost.js';
export type {PostgresAgentSharedCostOptions,SharedCostActor,SharedCostScope,SharedCostCall,SharedCostReservation,SharedCostSummary,SharedCostMetricsSnapshot,SharedCostReconciliation} from './postgres-agent-shared-cost.js';

export {registerSharedCostPending} from './postgres-shared-cost-capability.js';
export type {SharedCostPendingCapabilityOptions} from './postgres-shared-cost-capability.js';

export {createPricedCostLimitedToolModel} from './priced-cost-model.js';
export type {PricedCostLimitedToolModelOptions} from './priced-cost-model.js';

export {createOpenAIPricedCostModel} from './openai-priced-cost-model.js';
export type {OpenAIPricedCostModelOptions} from './openai-priced-cost-model.js';

export {createOpenAICapabilityPricedModel} from './openai-capability-priced-model.js';
export type {OpenAICapabilityPricedModelOptions,OpenAICapabilityCountingRequest} from './openai-capability-priced-model.js';

export {PostgresAgentSharedCostMetrics} from './postgres-shared-cost-metrics.js';

export {ConfiguredAgentOperationMetrics} from './configured-agent-operation-metrics.js';
export type {ConfiguredAgentOperationMetricsOptions,ConfiguredAgentOperationMetricsSnapshot} from './configured-agent-operation-metrics.js';

export {createTelegramWebhookAdapter} from './telegram-webhook.js';
export type {TelegramWebhookOptions} from './telegram-webhook.js';

export {createLinearWebhookAdapter} from './linear-webhook.js';
export type {LinearWebhookOptions} from './linear-webhook.js';

export {AgentActionRecoveryMetrics} from './action-recovery-metrics.js';
export type {AgentActionRecoveryMetricsOptions} from './action-recovery-metrics.js';

export {AgentCombinedMetrics} from './agent-combined-metrics.js';
export type {AgentCombinedMetricsOptions} from './agent-combined-metrics.js';

export {SqliteAgentWakeupRetention} from './agent-wakeup-retention.js';
export type {AgentWakeupRetentionActor,AgentWakeupRetentionOptions,AgentWakeupRetentionTarget,AgentWakeupRedactionCandidate} from './agent-wakeup-retention.js';
export {AgentWakeupRetentionWorker} from './agent-wakeup-retention-worker.js';
export type {AgentWakeupRetentionWorkerOptions} from './agent-wakeup-retention-worker.js';
export {SqliteWakeupRetentionMetrics} from './agent-wakeup-retention-metrics.js';
export type {WakeupRetentionMetricsOptions,WakeupRetentionMetricsSnapshot} from './agent-wakeup-retention-metrics.js';
