import { PostgresAgentDefinitions } from '../postgres/postgres-agent-definitions.js';
import type { AgentRunScope } from '../runs/durable-runs.js';
import { capabilityWiring, type CapabilityActor, type CapabilityRegistry } from './capability-wiring.js';
type Actor = CapabilityActor;
type Registry = CapabilityRegistry;
type Options = {
  definitions: PostgresAgentDefinitions;
  scope: AgentRunScope;
  operationId: string;
  path: string;
  limit: number;
  authorize: (actor: Actor, signal: AbortSignal) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxPending?: number;
};
function parse(input: unknown): { after?: number } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'query')) return;
  const query = (input as { query?: unknown }).query;
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => key !== 'after')) return;
  const after = (query as { after?: unknown }).after;
  if (after !== undefined && (!Number.isSafeInteger(after) || Number(after) < 0)) return;
  return after === undefined ? {} : { after: after as number };
}
/** Separately authorized, fixed-agent reads of the shared definition audit. */
export function registerAgentDefinitionControlHistory(registry: Registry, options: Options): void {
  if (
    !registry ||
    typeof registry.register !== 'function' ||
    !options ||
    !(options.definitions instanceof PostgresAgentDefinitions) ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw Error('Invalid definition control history capability');
  const { definitions, operationId, path, limit, authorize } = options,
    { scope, bounded } = capabilityWiring('definition control history', 'Definition control history unavailable', registry, options);
  const permit = (actor: Actor) => bounded(async signal => (await authorize({ ...actor }, signal)) === true);
  registry.register(
    { operationId, method: 'GET', path, summary: 'Read one agent control audit' },
    {
      authorize: actor => actor.tenantId === scope.tenantId && permit({ tenantId: actor.tenantId, principalId: actor.principalId }),
      validate: input => !!parse(input),
      execute: async (input, actor) => {
        const query = parse(input);
        if (!query) throw Error('Invalid capability input');
        const who = { tenantId: actor.tenantId, principalId: actor.principalId };
        try {
          const result = await bounded(signal => definitions.controlHistoryWithSignal(who, scope.agentId, { ...query, limit }, signal));
          if (!(await permit(who))) throw Error('Capability forbidden');
          return result;
        } catch (error) {
          if (error instanceof Error && error.message === 'Agent definition access denied') throw Error('Capability forbidden');
          throw error;
        }
      }
    }
  );
}
export type { Options as AgentDefinitionControlHistoryCapabilityOptions };
