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
export { DevelopmentAgent, createProposalClient } from './development.js';
export type { DraftSnapshot, ProposalResult, ProposalClient } from './development.js';
export { createCapabilityTool } from './capability-tool.js';
export { createOpenAIToolModel, createToolCallingModel } from './tool-model.js';
export type { ToolModel, LimitedToolModel } from './tool-model.js';
export {SqliteAgentDefinitions,validateAgentManifest} from './persistent-definitions.js';
export type {PersistentAgentManifest,AgentDefinitionVersion} from './persistent-definitions.js';
export {createConfiguredAgentRun} from './configured-runtime.js';
export type {ConfiguredAgentIdentity,ConfiguredAgentBinding,ConfiguredAgentOptions,AgentDelegation,AgentDelegationOptions} from './configured-runtime.js';
export {SqliteAgentRuns} from './durable-runs.js';
export type {DurableAgentRun,AgentRunScope,AgentRunStatus} from './durable-runs.js';
export {DurableAgentWorker} from './durable-worker.js';
export type {DurableAgentWorkerOptions,DurableAgentWorkerOutcome} from './durable-worker.js';
export {SqliteAgentCheckpointer} from './sqlite-checkpointer.js';
export type {AgentCheckpointerOptions} from './sqlite-checkpointer.js';
export {SqliteAgentActionJournal} from './action-journal.js';
export type {AgentAction,AgentActionJournalOptions,AgentActionStatus,ActionVerification,ActionVerificationRequest} from './action-journal.js';
export {SqliteAgentTriggers} from './agent-triggers.js';
export type {TriggerRecord,AgentTriggerInput,AgentTriggerEnqueueOptions} from './agent-triggers.js';
export {createAgentEventIngress} from './event-ingress.js';
export type {AgentEventIngressOptions,AgentEventSourceIdentity,AgentEventRequest} from './event-ingress.js';
export {SqliteAgentSchedules} from './agent-schedules.js';
export type {AgentSchedule,AgentScheduleRule,AgentScheduleConfig,AgentScheduleFireOptions} from './agent-schedules.js';
export {AgentScheduleWorker} from './schedule-worker.js';
export type {AgentScheduleWorkerOptions} from './schedule-worker.js';
export {SqliteAgentMemory} from './agent-memory.js';
export type {AgentMemoryRecord,AgentMemoryScope,AgentMemoryActor,AgentMemoryProvenance,AgentMemoryAction,AgentMemoryOptions} from './agent-memory.js';
export {AgentSemanticMemory} from './semantic-memory.js';
export type {AgentMemoryEmbedder,SemanticMemoryHit} from './semantic-memory.js';
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

export {SqliteAgentTokenBudget} from './agent-token-budget.js';
export type {AgentTokenUsage,AgentTokenBudgetOptions} from './agent-token-budget.js';

export {SqliteAgentRunHistory} from './agent-run-history.js';
export type {AgentRunEvent,AgentRunHistoryActor,AgentRunHistoryAccess,AgentRunHistoryOptions} from './agent-run-history.js';

export {createSignedWebhookAuthenticator} from './signed-webhook.js';
export type {SignedWebhookSource,SignedWebhookOptions} from './signed-webhook.js';
