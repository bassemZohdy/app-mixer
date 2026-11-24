import { isIdentifier } from '../validation.js';

/** The principal every capability wrapper acts for. */
export type CapabilityActor = { tenantId: string; principalId: string };
/** The registration surface every capability wrapper wires into. */
export type CapabilityRegistry = {
  register: (
    candidate: { operationId: string; method: string; path: string; summary?: string },
    binding: {
      authorize: (actor: CapabilityActor) => boolean | Promise<boolean>;
      validate: (input: unknown) => boolean;
      execute: (input: unknown, actor: CapabilityActor) => unknown | Promise<unknown>;
    }
  ) => void;
};
type WiringOptions = {
  scope: { tenantId: string; agentId: string };
  operationId: string;
  path: string;
  authorize: (...args: never[]) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxPending?: number;
};
/**
 * The fixed scope, operation identifier, route, authorization hook and bounded-execution limiter the capability wrappers share.
 * Throws the wrapper's own invalid-capability error when the shared options are malformed, and its unavailable error when a
 * bounded execution times out or the pending cap is reached.
 */
export function capabilityWiring(
  invalid: string,
  unavailable: string,
  registry: { register?: unknown },
  options: WiringOptions
): { scope: { tenantId: string; agentId: string }; bounded: <T>(fn: (signal: AbortSignal) => T | Promise<T>) => Promise<T> } {
  if (
    !registry ||
    typeof registry.register !== 'function' ||
    !options ||
    !options.scope ||
    !isIdentifier(options.scope.tenantId) ||
    !isIdentifier(options.scope.agentId) ||
    typeof options.operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId) ||
    typeof options.path !== 'string' ||
    !options.path.startsWith('/') ||
    options.path.length > 1024 ||
    /[\u0000-\u001f]/.test(options.path) ||
    typeof options.authorize !== 'function' ||
    (options.timeoutMs === undefined) !== (options.maxPending === undefined) ||
    (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30000)) ||
    (options.maxPending !== undefined && (!Number.isInteger(options.maxPending) || options.maxPending < 1 || options.maxPending > 100))
  )
    throw Error(`Invalid ${invalid} capability`);
  const scope = { tenantId: options.scope.tenantId, agentId: options.scope.agentId },
    { timeoutMs, maxPending } = options;
  let pending = 0;
  const bounded = async <T>(fn: (signal: AbortSignal) => T | Promise<T>): Promise<T> => {
    const controller = new AbortController();
    if (timeoutMs === undefined) return await fn(controller.signal);
    if (pending >= maxPending!) throw Error(unavailable);
    pending++;
    const task = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Error(unavailable);
      return fn(controller.signal);
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
            reject(Error(unavailable));
          }, timeoutMs);
        })
      ]);
      if (controller.signal.aborted) throw Error(unavailable);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return { scope, bounded };
}
