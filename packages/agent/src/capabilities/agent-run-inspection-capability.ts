import { SqliteAgentRuns, type AgentRunScope } from '../runs/durable-runs.js';
import { PostgresAgentRunLifecycleFoundation } from '../postgres/postgres-run-lifecycle-foundation.js';
import { isIdentifier } from '../validation.js';
import { capabilityWiring, type CapabilityActor, type CapabilityRegistry } from './capability-wiring.js';
type Actor = CapabilityActor;
type Snapshot = { runId: string; revision: number; status: string; attempts: number; maxAttempts: number; deadline: number; archived: boolean };
type Registry = CapabilityRegistry;
type Options = {
  runs: SqliteAgentRuns | PostgresAgentRunLifecycleFoundation;
  scope: AgentRunScope;
  runId: string;
  operationId: string;
  path: string;
  authorize: (actor: Actor, action: 'access' | 'read', run: Snapshot | null, signal: AbortSignal) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxPending?: number;
};
const id = isIdentifier;
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
/** Inspect only a host-selected run after independent scope and record authorization. */
export function registerAgentRunInspection(registry: Registry, options: Options): void {
  if (
    !registry ||
    typeof registry.register !== 'function' ||
    !options ||
    (!(options.runs instanceof SqliteAgentRuns) && !(options.runs instanceof PostgresAgentRunLifecycleFoundation)) ||
    !id(options.runId)
  )
    throw Error('Invalid run inspection capability');
  const { runs, runId, operationId, path, authorize, timeoutMs, maxPending } = options,
    { scope } = capabilityWiring('run inspection', 'Run inspection unavailable', registry, options);
  let pending = 0;
  const permit = async (actor: Actor, action: 'access' | 'read', run: Snapshot | null): Promise<boolean> => {
    const controller = new AbortController(),
      invoke = () => authorize({ ...actor }, action, run ? { ...run } : null, controller.signal);
    if (timeoutMs === undefined) return (await invoke()) === true;
    if (pending >= maxPending!) throw Error('Run inspection unavailable');
    pending++;
    const task = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Error('Run inspection unavailable');
      return invoke();
    });
    void task.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error('Run inspection unavailable'));
          }, timeoutMs);
        })
      ]);
      if (controller.signal.aborted) throw Error('Run inspection unavailable');
      return result === true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  registry.register(
    { operationId, method: 'GET', path, summary: 'Inspect one agent run' },
    {
      authorize: actor => actor.tenantId === scope.tenantId && permit({ tenantId: actor.tenantId, principalId: actor.principalId }, 'access', null),
      validate: valid,
      execute: async (input, actor) => {
        if (!valid(input)) throw Error('Invalid capability input');
        const who = { tenantId: actor.tenantId, principalId: actor.principalId },
          run = await runs.get(scope, runId);
        if (!run) throw Error('Run inspection not found');
        const snapshot: Snapshot = { runId, revision: run.revision, status: run.status, attempts: run.attempts, maxAttempts: run.maxAttempts, deadline: run.deadline, archived: run.archived };
        if (!(await permit(who, 'read', snapshot)) || !(await permit(who, 'read', snapshot)) || !(await permit(who, 'access', null))) throw Error('Capability forbidden');
        const current = await runs.get(scope, runId);
        if (!current || current.revision !== snapshot.revision) throw Error('Run inspection changed');
        return snapshot;
      }
    }
  );
}
export type { Options as AgentRunInspectionCapabilityOptions, Snapshot as AgentRunInspectionSnapshot };
