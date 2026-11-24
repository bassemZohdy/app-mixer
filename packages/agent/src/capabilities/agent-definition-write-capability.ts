import { PostgresAgentDefinitions } from '../postgres/postgres-agent-definitions.js';
import { validateAgentManifest, type PersistentAgentManifest } from '../persistent-definitions.js';
import type { AgentRunScope } from '../runs/durable-runs.js';
import { capabilityWiring, type CapabilityActor, type CapabilityRegistry } from './capability-wiring.js';
type Actor = CapabilityActor;
type Registry = CapabilityRegistry;
type Options = {
  definitions: PostgresAgentDefinitions;
  scope: AgentRunScope;
  operationId: string;
  path: string;
  authorize: (actor: Actor, action: 'access' | 'write', manifest: PersistentAgentManifest | null, signal: AbortSignal) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxPending?: number;
};
function parse(input: unknown, scope: AgentRunScope): { expectedVersion: number; manifest: PersistentAgentManifest } | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'expectedVersion') || !Object.hasOwn(input, 'manifest')) return;
    const value = input as { expectedVersion: unknown; manifest: unknown };
    if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0 || Number(value.expectedVersion) >= Number.MAX_SAFE_INTEGER) return;
    const manifest = validateAgentManifest(value.manifest);
    if (manifest.tenantId !== scope.tenantId || manifest.agentId !== scope.agentId) return;
    return { expectedVersion: value.expectedVersion as number, manifest };
  } catch {
    return;
  }
}
/** Create or update a host-fixed agent through the shared versioned and audited store. */
export function registerAgentDefinitionWrite(registry: Registry, options: Options): void {
  if (!registry || typeof registry.register !== 'function' || !options || !(options.definitions instanceof PostgresAgentDefinitions)) throw Error('Invalid definition write capability');
  const { definitions, operationId, path, authorize, timeoutMs, maxPending } = options,
    { scope } = capabilityWiring('definition write', 'Definition write unavailable', registry, options);
  let pending = 0;
  const permit = async (actor: Actor, action: 'access' | 'write', manifest: PersistentAgentManifest | null): Promise<boolean> => {
    const controller = new AbortController(),
      invoke = () => authorize({ ...actor }, action, manifest ? structuredClone(manifest) : null, controller.signal);
    if (timeoutMs === undefined) return (await invoke()) === true;
    if (pending >= maxPending!) throw Error('Definition write unavailable');
    pending++;
    const task = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Error('Definition write unavailable');
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
            reject(Error('Definition write unavailable'));
          }, timeoutMs);
        })
      ]);
      if (controller.signal.aborted) throw Error('Definition write unavailable');
      return result === true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  registry.register(
    { operationId, method: 'POST', path, summary: 'Write one agent definition' },
    {
      authorize: actor => actor.tenantId === scope.tenantId && permit({ tenantId: actor.tenantId, principalId: actor.principalId }, 'access', null),
      validate: input => !!parse(input, scope),
      execute: async (input, actor) => {
        const safe = parse(input, scope);
        if (!safe) throw Error('Invalid capability input');
        const who = { tenantId: actor.tenantId, principalId: actor.principalId };
        if (!(await permit(who, 'access', null)) || !(await permit(who, 'write', safe.manifest)) || !(await permit(who, 'write', safe.manifest))) throw Error('Capability forbidden');
        try {
          const result = await definitions.save(who, safe.manifest, safe.expectedVersion);
          return { agentId: scope.agentId, version: result.version };
        } catch (error) {
          if (error instanceof Error && error.message === 'Agent definition access denied') throw Error('Capability forbidden');
          if (
            error instanceof Error &&
            ['Agent version conflict', 'Agent quota exceeds tenant limit', 'Agent model turn limit required or exceeds tenant limit', 'Agent version limit reached', 'Agent limit reached'].includes(
              error.message
            )
          )
            throw Error('Definition write conflict');
          throw error;
        }
      }
    }
  );
}
export type { Options as AgentDefinitionWriteCapabilityOptions };
