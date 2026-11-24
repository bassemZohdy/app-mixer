import { SqliteAgentLeaseRecoveryHistory } from '../runs/agent-run-lease-recovery-history.js';
import { PostgresAgentLeaseRecoveryHistoryFoundation } from '../postgres/postgres-lease-recovery-history-foundation.js';
import type { AgentRunScope } from '../runs/durable-runs.js';
import { capabilityWiring, type CapabilityActor, type CapabilityRegistry } from './capability-wiring.js';
type Actor = CapabilityActor;
type Registry = CapabilityRegistry;
type Options = {
  history: SqliteAgentLeaseRecoveryHistory | PostgresAgentLeaseRecoveryHistoryFoundation;
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
/** Register separately authorized evidence reads for one fixed tenant and agent. */
export function registerAgentLeaseRecoveryHistory(registry: Registry, options: Options): void {
  if (
    !registry ||
    typeof registry.register !== 'function' ||
    !options ||
    (!(options.history instanceof SqliteAgentLeaseRecoveryHistory) && !(options.history instanceof PostgresAgentLeaseRecoveryHistoryFoundation)) ||
    !options.history.isBoundTo(options.scope) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw Error('Invalid lease recovery history capability');
  const { history, operationId, path, limit, authorize } = options,
    { scope, bounded } = capabilityWiring('lease recovery history', 'Lease recovery history unavailable', registry, options);
  const permit = (actor: Actor) => bounded(async signal => (await authorize({ ...actor }, signal)) === true);
  registry.register(
    { operationId, method: 'GET', path, summary: 'Read agent lease recovery evidence' },
    {
      authorize: async actor => actor.tenantId === scope.tenantId && (await permit({ tenantId: actor.tenantId, principalId: actor.principalId })),
      validate: input => !!parse(input),
      execute: async (input, actor) => {
        const query = parse(input);
        if (!query) throw Error('Invalid capability input');
        const who = { tenantId: actor.tenantId, principalId: actor.principalId };
        try {
          const result = await bounded(signal => history.listWithSignal(who, { ...query, limit }, signal));
          if (!(await permit(who))) throw Error('Capability forbidden');
          return result;
        } catch (error) {
          if (error instanceof Error && error.message === 'Lease recovery history access denied') throw Error('Capability forbidden');
          throw error;
        }
      }
    }
  );
}
export type { Options as AgentLeaseRecoveryHistoryCapabilityOptions };
