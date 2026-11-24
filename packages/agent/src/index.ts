import { AgentApprovalRequired } from './runs/approval-required.js';
import { AgentDelegationExpired } from './runs/delegation-expired.js';
import { randomUUID } from 'node:crypto';
import { EventType, type Event } from '@ag-ui/core';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, START, END, getWriter } from '@langchain/langgraph';
import { openAIChat } from './openai-chat.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type RunInput = { threadId: string; runId: string; messages: ChatMessage[] };
export interface StreamingModel {
  stream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
}
export type OpenAIModelConfig = { model: string; apiKey: string; baseURL?: string; systemPrompt?: string };

/** The provider and credentials are configured by the host, never by a conversation message. */
export function createOpenAIModel(config: OpenAIModelConfig): StreamingModel {
  if (!config.model || !config.apiKey) throw Error('Model and API key are required');
  const fields = { model: config.model, apiKey: config.apiKey, ...(config.baseURL ? { configuration: { baseURL: config.baseURL } } : {}) };
  return {
    async *stream(messages, signal) {
      const input: BaseMessage[] = [];
      if (config.systemPrompt) input.push(new SystemMessage(config.systemPrompt));
      for (const message of messages) input.push(message.role === 'user' ? new HumanMessage(message.content) : new AIMessage(message.content));
      const chunks = await (await openAIChat(fields)).stream(input, { ...(signal !== undefined ? { signal } : {}) });
      for await (const chunk of chunks) {
        if (typeof chunk.content === 'string') yield chunk.content;
        else for (const part of chunk.content) if (part.type === 'text' && typeof part.text === 'string') yield part.text;
      }
    }
  };
}

export function validateRunInput(input: RunInput): void {
  if (
    !input ||
    typeof input.threadId !== 'string' ||
    !input.threadId.trim() ||
    input.threadId.length > 256 ||
    typeof input.runId !== 'string' ||
    !input.runId.trim() ||
    input.runId.length > 256 ||
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > 100 ||
    input.messages.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 100000)
  )
    throw Error('Invalid run input');
  if (input.messages.at(-1)?.role !== 'user') throw Error('Last message must be from the user');
}
const State = Annotation.Root({ messages: Annotation<ChatMessage[]>(), response: Annotation<string>() });

/** Streams AG-UI events from a LangGraph run. Conversation history is supplied per run. */
export class LangGraphAGUIAdapter {
  constructor(
    private readonly model: StreamingModel,
    private readonly options: { direct?: boolean } = {}
  ) {}
  async *run(input: RunInput, options: { signal?: AbortSignal } = {}): AsyncGenerator<Event> {
    validateRunInput(input);
    const { threadId, runId } = input;
    const messageId = randomUUID();
    const graph = new StateGraph(State)
      .addNode('respond', async (state, config) => {
        const writer = getWriter(config);
        if (!writer) throw Error('Streaming writer unavailable');
        for await (const delta of this.model.stream(state.messages, config.signal)) {
          if (typeof delta !== 'string') throw Error('Model returned a non-text chunk');
          if (delta) writer(delta);
        }
        return { response: '' };
      })
      .addEdge(START, 'respond')
      .addEdge('respond', END)
      .compile();
    yield { type: EventType.RUN_STARTED, threadId, runId };
    let started = false;
    try {
      const stream = this.options.direct
        ? this.model.stream(input.messages, options.signal)
        : await graph.stream({ messages: input.messages }, { streamMode: 'custom', ...(options.signal !== undefined ? { signal: options.signal } : {}) });
      for await (const delta of stream) {
        if (typeof delta !== 'string') throw Error('Invalid graph chunk');
        if (!started) {
          started = true;
          yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' };
        }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta };
      }
      if (!started) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' };
      yield { type: EventType.TEXT_MESSAGE_END, messageId };
      yield { type: EventType.RUN_FINISHED, threadId, runId };
    } catch (error) {
      if (started) yield { type: EventType.TEXT_MESSAGE_END, messageId };
      yield error instanceof AgentApprovalRequired
        ? { type: EventType.RUN_ERROR, message: 'Human approval is required.', code: 'AGENT_APPROVAL_REQUIRED' }
        : error instanceof AgentDelegationExpired
          ? { type: EventType.RUN_ERROR, message: 'Delegated authorization expired.', code: 'AGENT_DELEGATION_EXPIRED' }
          : { type: EventType.RUN_ERROR, message: 'The agent could not complete this run.', code: 'AGENT_RUN_FAILED' };
    }
  }
}

export { createAGUIServer } from './transport.js';
export type { AgentTransportTracingOptions } from './transport-tracing.js';
export { DevelopmentAgent, createProposalClient } from './development.js';
export type { DraftSnapshot, ProposalResult, ProposalClient } from './development.js';
export { createCapabilityTool } from './capability-tool.js';
export { createOpenAIToolModel, createOpenAILimitedToolModel, createToolCallingModel } from './tool-model.js';
export type { OpenAIPricing, OpenAILimitedOptions } from './tool-model.js';
export type { ToolModel, LimitedToolModel, CostLimitedToolModel } from './tool-model.js';
export { SqliteAgentDefinitions, validateAgentManifest } from './persistent-definitions.js';
export { PostgresAgentDefinitions } from './postgres/postgres-agent-definitions.js';
export { PostgresAgentRunSlots } from './postgres/postgres-run-slots.js';
export { checkIdempotencyContract, IdempotencyContractInterruptedError, IdempotencyContractExecutionError } from './webhooks/idempotency-contract.js';
export type { IdempotencyContractOptions, IdempotencyContractFinding, IdempotencyContractReport } from './webhooks/idempotency-contract.js';
export type { PostgresAgentRunSlotsOptions, AgentRunSlotLimits } from './postgres/postgres-run-slots.js';
export type {
  PostgresAgentDefinitionsOptions,
  AgentDefinitionActor,
  AgentDefinitionAccess,
  PostgresAgentDefinitionQuery,
  AgentDefinitionAudit,
  AgentDefinitionControlAudit,
  AgentDefinitionTenantLimits
} from './postgres/postgres-agent-definitions.js';
export type { PersistentAgentManifest, AgentDefinitionVersion } from './persistent-definitions.js';
export { createConfiguredAgentRun } from './configured-runtime.js';
export type { ConfiguredAgentIdentity, ConfiguredAgentBinding, ConfiguredAgentOptions, ConfiguredAgentOperationObservation, AgentDelegation, AgentDelegationOptions } from './configured-runtime.js';
export { SqliteAgentRuns } from './runs/durable-runs.js';
export type { DurableAgentRun, AgentRunScope, AgentRunStatus } from './runs/durable-runs.js';
export { DurableAgentWorker } from './runs/durable-worker.js';
export type { DurableAgentWorkerOptions, DurableAgentWorkerOutcome } from './runs/durable-worker.js';
export { SqliteAgentCheckpointer } from './runs/sqlite-checkpointer.js';
export type { AgentCheckpointerOptions } from './runs/sqlite-checkpointer.js';
export { SqliteAgentActionJournal, markNoEffect, hadNoEffect } from './runs/action-journal.js';
export type {
  AgentAction,
  AgentActionJournalOptions,
  AgentActionStatus,
  ActionVerification,
  ActionVerificationRequest,
  AgentActionPage,
  ActionVerificationPass,
  ActionReconciliationEvidence,
  ActionReconciliationEvent
} from './runs/action-journal.js';
export { SqliteAgentTriggers } from './runs/agent-triggers.js';
export type { TriggerRecord, AgentTriggerInput, AgentTriggerEnqueueOptions } from './runs/agent-triggers.js';
export { SqliteAgentTriggerRetention } from './runs/agent-trigger-retention.js';
export { AgentTriggerRetentionWorker } from './runs/agent-trigger-retention-worker.js';
export { SqliteTriggerRetentionMetrics } from './runs/agent-trigger-retention-metrics.js';
export type { TriggerRetentionMetricsOptions, TriggerRetentionMetricsSnapshot } from './runs/agent-trigger-retention-metrics.js';
export type { AgentTriggerRetentionWorkerOptions } from './runs/agent-trigger-retention-worker.js';
export type { AgentTriggerRetentionActor, AgentTriggerRetentionOptions, TriggerRedactionCandidate } from './runs/agent-trigger-retention.js';
export { createAgentEventIngress } from './webhooks/event-ingress.js';
export type { AgentEventIngressOptions, AgentEventSourceIdentity, AgentEventRequest, AgentEventWakeupTarget, AgentEventIngressObservation } from './webhooks/event-ingress.js';
export { SqliteAgentSchedules } from './runs/agent-schedules.js';
export type { AgentSchedule, AgentScheduleRule, AgentScheduleConfig, AgentScheduleFireOptions, AgentScheduleCursor, AgentSchedulePage } from './runs/agent-schedules.js';
export { SqliteAgentScheduleHistory } from './runs/agent-schedule-history.js';
export type { AgentScheduleEvent, AgentScheduleHistoryOptions, AgentScheduleHistoryActor } from './runs/agent-schedule-history.js';
export { AgentScheduleWorker } from './runs/schedule-worker.js';
export type { AgentScheduleWorkerOptions, AgentScheduleWakeupTarget } from './runs/schedule-worker.js';
export { SqliteAgentMemory } from './memory/agent-memory.js';
export type { AgentMemoryRecord, AgentMemoryAuditEvent, AgentMemoryScope, AgentMemoryActor, AgentMemoryProvenance, AgentMemoryAction, AgentMemoryOptions } from './memory/agent-memory.js';
export { AgentSemanticMemory } from './memory/semantic-memory.js';
export type { AgentMemoryEmbedder, SemanticMemoryRecord, SemanticMemoryHit, SemanticMemorySearchOptions as AgentMemorySearchOptions } from './memory/semantic-memory.js';
export { evaluateAgentMemoryRetrieval } from './memory/memory-retrieval-evaluation.js';
export type { MemoryEvaluationCase, MemoryEvaluationResult, MemoryEvaluationReport } from './memory/memory-retrieval-evaluation.js';
export { registerSemanticMemorySearch } from './capabilities/semantic-memory-capability.js';
export type { SemanticMemorySearchOptions } from './capabilities/semantic-memory-capability.js';
export { SqliteAgentApprovals } from './runs/agent-approvals.js';
export type { AgentApproval, AgentApprovalActor, AgentApprovalStatus, AgentApprovalAccess, AgentApprovalsOptions } from './runs/agent-approvals.js';

export { createAgentApprovalServer } from './runs/approval-server.js';
export { AgentWorkerHost } from './worker-host.js';
export type { AgentHostedWorker, AgentWorkerHostState, AgentWorkerHostStopResult, AgentWorkerHostOptions } from './worker-host.js';
export { AgentError, agentErrorStatus } from './errors.js';
export type { AgentErrorCode } from './errors.js';
export type { AgentApprovalServerOptions } from './runs/approval-server.js';

export { SqliteAgentDelegations } from './runs/agent-delegations.js';
export type { AgentDelegationActor, AgentDelegationAccess, AgentDelegationRecord, AgentDelegationStoreOptions } from './runs/agent-delegations.js';

export { SqliteAgentNotices } from './runs/agent-notices.js';
export type { AgentNotice, AgentNoticeActor, AgentNoticeAccess, AgentNoticeOptions } from './runs/agent-notices.js';
export { SqliteAgentNoticeDelivery } from './runs/agent-notice-delivery.js';
export { AgentNoticeDeliveryWorker } from './runs/notice-delivery-worker.js';
export { createAgentNoticeHttpsTransport, createAgentNoticeHttpsVerifier } from './runs/notice-https-transport.js';
export type { AgentNoticeHttpsTransportOptions, AgentNoticeHttpsDestination } from './runs/notice-https-transport.js';
export { SqliteAgentNoticeReceiver, createAgentNoticeReceiverServer } from './runs/notice-https-receiver.js';
export type { ReceivedAgentNotice, AgentNoticeReceiverOptions, AgentNoticeReceiverActor, AgentNoticeReceiverAccess, AgentNoticeReceiverServerOptions } from './runs/notice-https-receiver.js';
export type { AgentNoticeDeliveryWorkerOptions } from './runs/notice-delivery-worker.js';
export type {
  AgentNoticeDelivery,
  AgentNoticeMessage,
  AgentNoticeDeliveryEvent,
  AgentNoticeDeliveryOptions,
  AgentNoticeDeliveryActor,
  AgentNoticeDeliveryAccess
} from './runs/agent-notice-delivery.js';

export { SqliteAgentTokenBudget } from './runs/agent-token-budget.js';
export type { AgentSharedCostBinding, AgentTokenUsage, AgentCostUsage, AgentTokenBudgetOptions, AgentBudgetReconciliationEvidence, AgentBudgetReconciliationEvent } from './runs/agent-token-budget.js';

export { SqliteAgentRunHistory } from './runs/agent-run-history.js';
export { SqliteAgentRunMetrics } from './runs/agent-run-metrics.js';
export type {
  AgentRunMetricStatus,
  AgentActionMetricStatus,
  AgentActionMetric,
  AgentScheduleMetric,
  AgentApprovalMetricStatus,
  AgentApprovalMetric,
  AgentNoticeDeliveryMetricStatus,
  AgentNoticeDeliveryMetric,
  AgentMemoryMetricState,
  AgentMemoryMetric,
  AgentCostMetric,
  AgentTokenMetric,
  AgentRunMetricsActor,
  AgentRunMetricsSnapshot,
  AgentRunMetricsOptions,
  AgentRunOperationalMetric,
  AgentActionBacklogMetric,
  AgentBudgetBacklogMetric
} from './runs/agent-run-metrics.js';
export { createAgentMetricsServer } from './agent-metrics-server.js';
export type { AgentMetricsServerOptions } from './agent-metrics-server.js';
export type { AgentRunEvent, AgentRunHistoryActor, AgentRunHistoryAccess, AgentRunHistoryOptions } from './runs/agent-run-history.js';

export { createSignedWebhookAuthenticator } from './webhooks/signed-webhook.js';
export type { SignedWebhookSource, SignedWebhookOptions } from './webhooks/signed-webhook.js';

export { createGitlabWebhookAdapter } from './webhooks/gitlab-webhook.js';
export type { GitlabWebhookOptions } from './webhooks/gitlab-webhook.js';
export { createGithubWebhookAdapter } from './webhooks/github-webhook.js';
export { createStripeWebhookAdapter } from './webhooks/stripe-webhook.js';
export { createStandardWebhookAdapter } from './webhooks/standard-webhook.js';
export type { StandardWebhookOptions } from './webhooks/standard-webhook.js';
export { createSlackWebhookAdapter } from './webhooks/slack-webhook.js';
export { createTwilioMessageWebhookAdapter } from './webhooks/twilio-webhook.js';
export type { TwilioMessageWebhookOptions } from './webhooks/twilio-webhook.js';
export { createShopifyWebhookAdapter } from './webhooks/shopify-webhook.js';
export { createPagerDutyWebhookAdapter } from './webhooks/pagerduty-webhook.js';
export { createSentryWebhookAdapter } from './webhooks/sentry-webhook.js';
export type { SentryWebhookOptions } from './webhooks/sentry-webhook.js';
export type { PagerDutyWebhookOptions } from './webhooks/pagerduty-webhook.js';
export type { ShopifyWebhookOptions } from './webhooks/shopify-webhook.js';
export type { SlackWebhookOptions } from './webhooks/slack-webhook.js';
export type { StripeWebhookOptions } from './webhooks/stripe-webhook.js';
export type { GithubWebhookOptions } from './webhooks/github-webhook.js';

export { DurableAgentDispatcher } from './runs/durable-dispatcher.js';
export type { DurableAgentDispatcherOptions } from './runs/durable-dispatcher.js';

export { registerAgentExpiredLeaseDiscovery } from './capabilities/agent-expired-lease-discovery.js';
export type { AgentExpiredLeaseDiscoveryOptions } from './capabilities/agent-expired-lease-discovery.js';
export { registerAgentLeaseRecovery } from './capabilities/agent-run-lease-recovery-capability.js';
export type { AgentLeaseRecoveryCapabilityOptions } from './capabilities/agent-run-lease-recovery-capability.js';
export { AgentRunLeaseRecoveryWorker } from './runs/agent-run-lease-recovery.js';
export { registerAgentRunControl } from './capabilities/agent-run-control-capability.js';
export { registerAgentRunInspection } from './capabilities/agent-run-inspection-capability.js';
export { registerAgentManualStart } from './capabilities/agent-manual-start-capability.js';
export { registerAgentDefinitionControl } from './capabilities/agent-definition-control-capability.js';
export { registerAgentDefinitionStatus } from './capabilities/agent-definition-status-capability.js';
export { registerAgentDefinitionHistory } from './capabilities/agent-definition-history-capability.js';
export { registerAgentDefinitionControlHistory } from './capabilities/agent-definition-control-history-capability.js';
export type { AgentDefinitionControlHistoryCapabilityOptions } from './capabilities/agent-definition-control-history-capability.js';
export { registerAgentDefinitionWrite } from './capabilities/agent-definition-write-capability.js';
export { registerAgentDefinitionRead } from './capabilities/agent-definition-read-capability.js';
export type { AgentDefinitionReadCapabilityOptions } from './capabilities/agent-definition-read-capability.js';
export type { AgentDefinitionWriteCapabilityOptions } from './capabilities/agent-definition-write-capability.js';
export type { AgentDefinitionHistoryCapabilityOptions } from './capabilities/agent-definition-history-capability.js';
export type { AgentDefinitionStatusCapabilityOptions } from './capabilities/agent-definition-status-capability.js';
export type { AgentDefinitionControlCapabilityOptions } from './capabilities/agent-definition-control-capability.js';
export type { AgentManualStartCapabilityOptions } from './capabilities/agent-manual-start-capability.js';
export type { AgentRunInspectionCapabilityOptions, AgentRunInspectionSnapshot } from './capabilities/agent-run-inspection-capability.js';
export type { AgentRunControlCapabilityOptions } from './capabilities/agent-run-control-capability.js';
export { SqliteAgentRunControlHistory } from './runs/agent-run-control-history.js';
export { registerAgentRunControlHistory } from './capabilities/agent-run-control-history-capability.js';
export type { AgentRunControlHistoryCapabilityOptions } from './capabilities/agent-run-control-history-capability.js';
export type { AgentRunControlEvent, AgentRunControlHistoryOptions, AgentRunControlHistoryActor } from './runs/agent-run-control-history.js';
export type { AgentRunLeaseRecoveryWorkerOptions, AgentLeaseRecoveryObservation } from './runs/agent-run-lease-recovery.js';
export { AgentLeaseRecoveryMetrics } from './runs/agent-lease-recovery-metrics.js';
export type { AgentLeaseRecoveryMetricsOptions } from './runs/agent-lease-recovery-metrics.js';
export type { ExpiredAgentLease, AgentRunLeaseRecoveryEvidence, AgentRunControlEvidence } from './runs/durable-runs.js';
export { SqliteAgentLeaseRecoveryHistory } from './runs/agent-run-lease-recovery-history.js';
export { registerAgentLeaseRecoveryHistory } from './capabilities/agent-run-lease-recovery-history-capability.js';
export type { AgentLeaseRecoveryHistoryCapabilityOptions } from './capabilities/agent-run-lease-recovery-history-capability.js';
export type { AgentRunLeaseRecoveryEvent, AgentRunLeaseRecoveryHistoryOptions, AgentRunLeaseRecoveryHistoryActor } from './runs/agent-run-lease-recovery-history.js';
export { AgentRunExpiryWorker } from './runs/agent-run-expiry.js';
export type { AgentRunExpiryWorkerOptions, AgentRunExpiryObservation } from './runs/agent-run-expiry.js';
export { AgentRunExpiryMetrics } from './runs/agent-run-expiry-metrics.js';
export type { AgentRunExpiryMetricsOptions } from './runs/agent-run-expiry-metrics.js';

export { AgentActionRecoveryWorker } from './runs/action-recovery-worker.js';
export { createActionHttpsVerifier } from './runs/action-https-verifier.js';
export type { ActionHttpsVerifierOptions, ActionHttpsLookupContext } from './runs/action-https-verifier.js';
export type { AgentActionRecoveryWorkerOptions, AgentActionRecoveryObservation } from './runs/action-recovery-worker.js';

export { registerSemanticMemoryWrite } from './capabilities/semantic-memory-write-capability.js';
export type { SemanticMemoryWriteOptions, SemanticMemoryWriteInput, SemanticMemoryWriteMetadata } from './capabilities/semantic-memory-write-capability.js';

export { registerSemanticMemoryDelete } from './capabilities/semantic-memory-delete-capability.js';
export type { SemanticMemoryDeleteOptions, SemanticMemoryDeleteInput } from './capabilities/semantic-memory-delete-capability.js';

export { SqliteAgentExpiryHistory } from './runs/agent-expiry-history.js';
export type { AgentRunExpiryEvent, AgentRunExpiryHistoryOptions, AgentRunExpiryHistoryActor } from './runs/agent-expiry-history.js';
export type { AgentRunExpiryEvidence } from './runs/durable-runs.js';

export { registerSemanticMemoryRead } from './capabilities/semantic-memory-read-capability.js';
export type { SemanticMemoryReadOptions, SemanticMemoryReadInput } from './capabilities/semantic-memory-read-capability.js';

export { PostgresAgentMemory } from './postgres/postgres-agent-memory.js';
export type { PostgresAgentMemoryOptions, PostgresAgentMemoryQuery } from './postgres/postgres-agent-memory.js';

export { AgentMemoryRetentionWorker } from './memory/agent-memory-retention.js';
export type { AgentMemoryRetentionWorkerOptions } from './memory/agent-memory-retention.js';

export { AgentIngressMetrics } from './webhooks/agent-ingress-metrics.js';
export type { AgentIngressMetricsOptions } from './webhooks/agent-ingress-metrics.js';
export { SqliteAgentActionRecoveryDiscovery } from './runs/action-recovery-discovery.js';
export type { AgentActionRecoveryDiscoveryActor, AgentActionRecoveryDiscoveryOptions, AgentActionRecoveryCandidate, AgentActionRecoveryPage } from './runs/action-recovery-discovery.js';
export { registerActionRecoveryDiscovery } from './capabilities/action-recovery-discovery-capability.js';
export type { ActionRecoveryDiscoveryCapabilityOptions } from './capabilities/action-recovery-discovery-capability.js';
export { AgentActionRecoveryCoordinator } from './runs/action-recovery-coordinator.js';
export type { AgentActionRecoveryCoordinatorOptions, AgentActionRecoverySession, AgentActionRecoveryCoordinatorObservation } from './runs/action-recovery-coordinator.js';
export { SqliteAgentScheduleMetrics } from './runs/agent-schedule-metrics.js';
export type { AgentScheduleMetricsOptions, AgentScheduleMetricsSnapshot } from './runs/agent-schedule-metrics.js';

export { createPaddleWebhookAdapter } from './webhooks/paddle-webhook.js';
export type { PaddleWebhookOptions } from './webhooks/paddle-webhook.js';

export { AgentBudgetRecovery } from './runs/agent-budget-recovery.js';
export type { AgentBudgetRecoveryActor, AgentBudgetRecoveryTarget, AgentBudgetVerifiedUsage, AgentBudgetRecoveryOptions } from './runs/agent-budget-recovery.js';

export { registerBudgetRecovery, registerBudgetRecoveryHistory, registerBudgetRecoveryPending } from './capabilities/agent-budget-recovery-capability.js';
export type { BudgetRecoveryCapabilityOptions, BudgetRecoveryHistoryCapabilityOptions, BudgetRecoveryPendingCapabilityOptions } from './capabilities/agent-budget-recovery-capability.js';

export { SqliteAgentBudgetRecoveryDiscovery } from './runs/agent-budget-recovery-discovery.js';
export type { AgentBudgetRecoveryCandidate, AgentBudgetRecoveryPage, AgentBudgetRecoveryDiscoveryActor, AgentBudgetRecoveryDiscoveryOptions } from './runs/agent-budget-recovery-discovery.js';
export { registerBudgetRecoveryDiscovery } from './capabilities/agent-budget-recovery-discovery-capability.js';
export type { BudgetRecoveryDiscoveryCapabilityOptions } from './capabilities/agent-budget-recovery-discovery-capability.js';

export { createBudgetHttpsVerifier } from './runs/budget-https-verifier.js';
export type { BudgetHttpsVerifierOptions, BudgetHttpsLookupContext } from './runs/budget-https-verifier.js';

export { AgentBudgetRecoveryWorker } from './runs/agent-budget-recovery-worker.js';
export type { AgentBudgetRecoveryWorkerOptions } from './runs/agent-budget-recovery-worker.js';

export { AgentBudgetRecoveryCoordinator } from './runs/agent-budget-recovery-coordinator.js';
export type { AgentBudgetRecoveryCoordinatorOptions, AgentBudgetRecoverySession } from './runs/agent-budget-recovery-coordinator.js';

export { PostgresAgentSharedCost } from './postgres/postgres-agent-shared-cost.js';
export type {
  PostgresAgentSharedCostOptions,
  SharedCostActor,
  SharedCostScope,
  SharedCostCall,
  SharedCostReservation,
  SharedCostSummary,
  SharedCostMetricsSnapshot,
  SharedCostReconciliation
} from './postgres/postgres-agent-shared-cost.js';

export { registerSharedCostPending } from './postgres/postgres-shared-cost-capability.js';
export type { SharedCostPendingCapabilityOptions } from './postgres/postgres-shared-cost-capability.js';

export { createPricedCostLimitedToolModel } from './priced-cost-model.js';
export type { PricedCostLimitedToolModelOptions } from './priced-cost-model.js';

export { createOpenAIPricedCostModel } from './openai-priced-cost-model.js';
export type { OpenAIPricedCostModelOptions } from './openai-priced-cost-model.js';

export { createOpenAICapabilityPricedModel } from './openai-capability-priced-model.js';
export type { OpenAICapabilityPricedModelOptions, OpenAICapabilityCountingRequest } from './openai-capability-priced-model.js';

export { PostgresAgentSharedCostMetrics } from './postgres/postgres-shared-cost-metrics.js';

export { ConfiguredAgentOperationMetrics } from './configured-agent-operation-metrics.js';
export type { ConfiguredAgentOperationMetricsOptions, ConfiguredAgentOperationMetricsSnapshot } from './configured-agent-operation-metrics.js';

export { createTelegramWebhookAdapter } from './webhooks/telegram-webhook.js';
export type { TelegramWebhookOptions } from './webhooks/telegram-webhook.js';

export { createLinearWebhookAdapter } from './webhooks/linear-webhook.js';
export type { LinearWebhookOptions } from './webhooks/linear-webhook.js';

export { AgentActionRecoveryMetrics } from './runs/action-recovery-metrics.js';
export type { AgentActionRecoveryMetricsOptions } from './runs/action-recovery-metrics.js';

export { AgentCombinedMetrics } from './agent-combined-metrics.js';
export type { AgentCombinedMetricsOptions } from './agent-combined-metrics.js';

export { SqliteAgentWakeupRetention } from './runs/agent-wakeup-retention.js';
export type { AgentWakeupRetentionActor, AgentWakeupRetentionOptions, AgentWakeupRetentionTarget, AgentWakeupRedactionCandidate } from './runs/agent-wakeup-retention.js';
export { AgentWakeupRetentionWorker } from './runs/agent-wakeup-retention-worker.js';
export type { AgentWakeupRetentionWorkerOptions } from './runs/agent-wakeup-retention-worker.js';
export { SqliteWakeupRetentionMetrics } from './runs/agent-wakeup-retention-metrics.js';
export type { WakeupRetentionMetricsOptions, WakeupRetentionMetricsSnapshot } from './runs/agent-wakeup-retention-metrics.js';

export { registerAgentMemoryScopeErase } from './capabilities/agent-memory-erase-capability.js';
export type { AgentMemoryScopeEraseOptions } from './capabilities/agent-memory-erase-capability.js';

export { registerAgentMemoryErasureEvidence } from './capabilities/agent-memory-erasure-evidence-capability.js';
export type { AgentMemoryErasureEvidenceOptions } from './capabilities/agent-memory-erasure-evidence-capability.js';

export { createSquareWebhookAdapter } from './webhooks/square-webhook.js';
export type { SquareWebhookOptions } from './webhooks/square-webhook.js';

export { registerAgentDelegationCapability } from './capabilities/agent-delegation-capability.js';
export type { AgentDelegationCapabilityOptions, AgentDelegationCapabilityInput } from './capabilities/agent-delegation-capability.js';

export { createNotionWebhookAdapter } from './webhooks/notion-webhook.js';
export type { NotionWebhookOptions } from './webhooks/notion-webhook.js';

export { createDiscordWebhookAdapter } from './webhooks/discord-webhook.js';
export { createSendGridWebhookAdapter } from './webhooks/sendgrid-webhook.js';
export type { DiscordWebhookOptions } from './webhooks/discord-webhook.js';
export type { SendGridWebhookOptions } from './webhooks/sendgrid-webhook.js';
export { PostgresAgentRuns, PostgresAgentActionJournal } from './postgres/postgres-agent-runs.js';
export type { PostgresAgentRunsOptions, PostgresAgentRun, PostgresRunClaimLimits } from './postgres/postgres-agent-runs.js';
export { PostgresRunSupervisor } from './postgres/postgres-run-supervisor.js';
export type { PostgresRunSupervisorOptions, PostgresRunExecution, PostgresRunSupervisorEvent } from './postgres/postgres-run-supervisor.js';
export { PostgresAgentSchedules } from './postgres/postgres-agent-schedules.js';
export type { PostgresAgentSchedulesOptions, AgentScheduledRun, AgentScheduledRunClaim, AgentScheduleHistoryEvent, AgentScheduleFirePass } from './postgres/postgres-agent-schedules.js';
export { PostgresAgentCostBudget } from './postgres/postgres-agent-cost-budget.js';
export type { PostgresCostCall, PostgresCostSummary } from './postgres/postgres-agent-cost-budget.js';
