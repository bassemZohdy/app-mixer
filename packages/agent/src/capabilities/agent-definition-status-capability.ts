import { PostgresAgentDefinitions } from '../postgres/postgres-agent-definitions.js';
import type { AgentRunScope } from '../runs/durable-runs.js';
import { capabilityWiring, type CapabilityActor, type CapabilityRegistry } from './capability-wiring.js';
type Actor = CapabilityActor;
type Snapshot = { version: number; enabled: boolean };
type Registry = CapabilityRegistry;
type Options = {
  definitions: PostgresAgentDefinitions;
  scope: AgentRunScope;
  operationId: string;
  path: string;
  authorize: (actor: Actor, action: 'access' | 'read', definition: Snapshot | null, signal: AbortSignal) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxPending?: number;
};
const valid = (input: unknown): boolean =>
  !!input &&
  typeof input === 'object' &&
  !Array.isArray(input) &&
  Object.keys(input).length === 1 &&
  Object.hasOwn(input, 'query') &&
  !!(input as { query?: unknown }).query &&
  typeof (input as { query: unknown }).query === 'object' &&
  !Array.isArray((input as { query: unknown }).query) &&
  Object.keys((input as { query: object }).query).length === 0;
/** Authorized, fixed-agent status without exposing the underlying manifest. */
export function registerAgentDefinitionStatus(registry: Registry, options: Options): void {
  if (!registry || typeof registry.register !== 'function' || !options || !(options.definitions instanceof PostgresAgentDefinitions)) throw Error('Invalid definition status capability');
  const { definitions, operationId, path, authorize } = options,
    { scope, bounded } = capabilityWiring('definition status', 'Definition status unavailable', registry, options);
  const permit = (actor: Actor, action: 'access' | 'read', definition: Snapshot | null) =>
    bounded(async signal => (await authorize({ ...actor }, action, definition ? { ...definition } : null, signal)) === true);
  registry.register(
    { operationId, method: 'GET', path, summary: 'Read one agent status' },
    {
      authorize: actor => actor.tenantId === scope.tenantId && permit({ tenantId: actor.tenantId, principalId: actor.principalId }, 'access', null),
      validate: valid,
      execute: async (input, actor) => {
        if (!valid(input)) throw Error('Invalid capability input');
        const who = { tenantId: actor.tenantId, principalId: actor.principalId };
        try {
          const current = await bounded(signal => definitions.getWithSignal(who, scope.agentId, signal));
          if (!current) throw Error('Definition status not found');
          const state = { version: current.version, enabled: current.manifest.lifecycle.enabled };
          if (!(await permit(who, 'read', state)) || !(await permit(who, 'read', state)) || !(await permit(who, 'access', null))) throw Error('Capability forbidden');
          const latest = await bounded(signal => definitions.getWithSignal(who, scope.agentId, signal));
          if (!latest || latest.version !== state.version || latest.manifest.lifecycle.enabled !== state.enabled) throw Error('Definition status changed');
          return { agentId: scope.agentId, ...state };
        } catch (error) {
          if (error instanceof Error && error.message === 'Agent definition access denied') throw Error('Capability forbidden');
          if (error instanceof Error && error.message === 'Agent definition changed during read') throw Error('Definition status changed');
          throw error;
        }
      }
    }
  );
}
export type { Options as AgentDefinitionStatusCapabilityOptions };
