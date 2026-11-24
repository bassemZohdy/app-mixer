import { SqliteAgentTriggers } from '../runs/agent-triggers.js';
import { PostgresAgentTriggerFoundation } from '../postgres/postgres-trigger-foundation.js';
import type { AgentRunScope } from '../runs/durable-runs.js';
import { validateAgentManifest, type AgentDefinitionVersion } from '../persistent-definitions.js';
import { isIdentifier } from '../validation.js';
import { capabilityWiring, type CapabilityActor, type CapabilityRegistry } from './capability-wiring.js';
type Actor = CapabilityActor;
type Registry = CapabilityRegistry;
type Options = {
  triggers: SqliteAgentTriggers | PostgresAgentTriggerFoundation;
  scope: AgentRunScope;
  sourceId: string;
  operationId: string;
  path: string;
  maxPendingRuns: number;
  getDefinition: (tenantId: string, agentId: string, signal: AbortSignal) => AgentDefinitionVersion | undefined | Promise<AgentDefinitionVersion | undefined>;
  authorize: (actor: Actor, action: 'access' | 'start', definition: AgentDefinitionVersion | null, signal: AbortSignal) => boolean | Promise<boolean>;
  clock?: () => number;
  timeoutMs?: number;
  maxPending?: number;
};
const id = isIdentifier;
function parse(input: unknown): { requestId: string; definitionVersion: number } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'requestId') || !Object.hasOwn(input, 'definitionVersion')) return;
  const value = input as { requestId: unknown; definitionVersion: unknown };
  if (!id(value.requestId) || !Number.isSafeInteger(value.definitionVersion) || Number(value.definitionVersion) < 1) return;
  return { requestId: value.requestId, definitionVersion: value.definitionVersion as number };
}
/** Host-fixed manual run start with durable request deduplication. */
export function registerAgentManualStart(registry: Registry, options: Options): void {
  if (
    !registry ||
    typeof registry.register !== 'function' ||
    !options ||
    (!(options.triggers instanceof SqliteAgentTriggers) && !(options.triggers instanceof PostgresAgentTriggerFoundation)) ||
    !id(options.sourceId) ||
    options.sourceId.startsWith('schedule.') ||
    !Number.isInteger(options.maxPendingRuns) ||
    options.maxPendingRuns < 1 ||
    options.maxPendingRuns > 10000 ||
    typeof options.getDefinition !== 'function' ||
    (options.clock !== undefined && typeof options.clock !== 'function')
  )
    throw Error('Invalid manual start capability');
  const { triggers, sourceId, operationId, path, maxPendingRuns, getDefinition, authorize } = options,
    { scope, bounded } = capabilityWiring('manual start', 'Manual start unavailable', registry, options),
    clock = options.clock ?? Date.now;
  const permit = (actor: Actor, action: 'access' | 'start', definition: AgentDefinitionVersion | null) =>
    bounded(async signal => (await authorize({ ...actor }, action, definition ? structuredClone(definition) : null, signal)) === true);
  const lookup = async (expected: number): Promise<AgentDefinitionVersion> => {
    const result = await bounded(signal => getDefinition(scope.tenantId, scope.agentId, signal));
    if (!result || result.version !== expected) throw Error('Manual start conflict');
    const manifest = validateAgentManifest(result.manifest);
    if (manifest.tenantId !== scope.tenantId || manifest.agentId !== scope.agentId || !manifest.lifecycle.enabled) throw Error('Manual start conflict');
    return { version: result.version, manifest };
  };
  registry.register(
    { operationId, method: 'POST', path, summary: 'Start an agent run' },
    {
      authorize: actor => actor.tenantId === scope.tenantId && permit({ tenantId: actor.tenantId, principalId: actor.principalId }, 'access', null),
      validate: input => !!parse(input),
      execute: async (input, actor) => {
        const safe = parse(input);
        if (!safe) throw Error('Invalid capability input');
        const who = { tenantId: actor.tenantId, principalId: actor.principalId },
          definition = await lookup(safe.definitionVersion);
        if (!(await permit(who, 'access', null)) || !(await permit(who, 'start', definition))) throw Error('Capability forbidden');
        const current = await lookup(safe.definitionVersion);
        if (JSON.stringify(current) !== JSON.stringify(definition)) throw Error('Manual start conflict');
        if (!(await permit(who, 'start', current)) || !(await permit(who, 'access', null))) throw Error('Capability forbidden');
        const finalDefinition = await lookup(safe.definitionVersion);
        if (JSON.stringify(finalDefinition) !== JSON.stringify(definition)) throw Error('Manual start conflict');
        const event = { sourceId, principalId: who.principalId, eventId: safe.requestId, eventType: 'manual', payload: { definitionVersion: definition.version } },
          common = { definitionVersion: definition.version, maxAttempts: definition.manifest.lifecycle.maxAttempts, maxPending: maxPendingRuns };
        try {
          if (triggers instanceof PostgresAgentTriggerFoundation) return await triggers.enqueue(scope, event, { ...common, runTimeoutMs: definition.manifest.lifecycle.runTimeoutMs });
          const now = clock(),
            deadline = now + definition.manifest.lifecycle.runTimeoutMs;
          if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline)) throw Error('Manual start unavailable');
          return triggers.enqueue(scope, event, { ...common, deadline }, now);
        } catch (error) {
          if (error instanceof Error && error.message === 'Trigger identity conflict') throw Error('Manual start conflict');
          if (error instanceof Error && error.message === 'Trigger backlog full') throw Error('Manual start backlog full');
          throw error;
        }
      }
    }
  );
}
export type { Options as AgentManualStartCapabilityOptions };
