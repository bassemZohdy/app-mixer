// TASK-021: every background worker's swallowed store or callback failure reaches its error hook, and a throwing hook is ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteAgentRuns,
  SqliteAgentTriggers,
  SqliteAgentDefinitions,
  SqliteAgentActionJournal,
  SqliteAgentTokenBudget,
  SqliteAgentApprovals,
  SqliteAgentNotices,
  SqliteAgentNoticeDelivery,
  SqliteAgentSchedules,
  SqliteAgentMemory,
  SqliteAgentTriggerRetention,
  SqliteAgentWakeupRetention,
  AgentBudgetRecovery,
  AgentBudgetRecoveryWorker,
  AgentTriggerRetentionWorker,
  AgentWakeupRetentionWorker,
  AgentMemoryRetentionWorker,
  AgentNoticeDeliveryWorker,
  AgentScheduleWorker,
  AgentActionRecoveryWorker,
  DurableAgentWorker,
  createAgentEventIngress
} from '../dist/index.js';

const scope = { tenantId: 'tenant', agentId: 'agent' },
  actor = { tenantId: 'tenant', principalId: 'operator' },
  reviewer = { tenantId: 'tenant', principalId: 'reviewer' },
  service = { tenantId: 'tenant', principalId: 'service' };
const manifest = {
    manifestVersion: 1,
    tenantId: 'tenant',
    agentId: 'agent',
    name: 'Agent',
    owner: { kind: 'organization', id: 'org' },
    administrators: ['admin'],
    servicePrincipalId: 'svc',
    model: { provider: 'local', model: 'test' },
    allowedCapabilities: [],
    lifecycle: { enabled: true, maxAttempts: 2, runTimeoutMs: 60000 },
    quotas: { maxConcurrentRuns: 1, maxTokensPerRun: 100, maxRunsPerDay: 10 }
  },
  definitions = new SqliteAgentDefinitions(':memory:');
definitions.save('tenant', manifest, 0);
const temp = () => mkdtempSync(join(tmpdir(), 'worker-hooks-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('TASK-021 the durable worker reports a failing lease renewal, and a throwing hook is ignored', async () => {
  const runs = new SqliteAgentRuns(':memory:');
  try {
    runs.create(scope, 'one', { definitionVersion: 1, maxAttempts: 2, deadline: Date.now() + 10000 });
    const renew = runs.renew.bind(runs),
      hook = [],
      base = {
        runs,
        definitions,
        workerId: 'worker',
        leaseMs: 600,
        pollMs: 10,
        authorizeStart: () => true,
        execute: async () => {
          await delay(40);
          return 'succeeded';
        }
      };
    runs.renew = (...args) => {
      throw Error('lease store exploded');
    };
    const worker = new DurableAgentWorker({ ...base, onError: (error, workerScope, runId, stage) => hook.push({ message: error.message, runId, stage, tenant: workerScope.tenantId }) }),
      outcome = await worker.runOnce(scope, 'one');
    assert.equal(outcome.status, 'uncertain', 'a failed renewal fences the run as uncertain');
    assert.ok(hook.length >= 1, 'the renewal failure reaches the hook');
    assert.deepEqual({ ...hook[0], message: hook[0].message }, { message: 'lease store exploded', runId: 'one', stage: 'renewLease', tenant: 'tenant' });
    runs.renew = renew;
    runs.create(scope, 'two', { definitionVersion: 1, maxAttempts: 2, deadline: Date.now() + 10000 });
    runs.renew = (...args) => {
      throw Error('lease store exploded');
    };
    const ignoring = new DurableAgentWorker({
        ...base,
        onError: () => {
          throw Error('hook exploded');
        }
      }),
      ignored = await ignoring.runOnce(scope, 'two');
    assert.equal(ignored.status, 'uncertain', 'a throwing hook does not change the outcome');
  } finally {
    runs.close();
  }
});

test('TASK-021 event ingress reports failing authenticate, authorize, observe and traceParent callbacks, and a throwing hook is ignored', async () => {
  const dir = temp(),
    path = join(dir, 'runs.sqlite'),
    registry = new SqliteAgentRuns(path),
    triggers = new SqliteAgentTriggers(path),
    seen = [];
  let server;
  try {
    registry.close();
    const url = async options => {
        server = createAgentEventIngress({ triggers, definitions, maxPending: 10, clock: () => 100, ...options });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return `http://127.0.0.1:${server.address().port}/events`;
      },
      closeServer = async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        server = undefined;
      },
      post = (endpoint, authorization) =>
        fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
          body: JSON.stringify({ agentId: 'agent', eventId: 'evt', eventType: 'message', payload: { value: 1 } })
        });
    let endpoint = await url({
      authenticate: () => {
        throw Error('authenticate exploded');
      },
      authorize: () => true,
      onError: (error, stage) => seen.push([error.message, stage])
    });
    assert.equal((await post(endpoint, 'Bearer valid')).status, 401);
    await delay(20);
    assert.deepEqual(seen, [['authenticate exploded', 'authenticate']], 'a failing authentication callback reaches the hook and the request is still refused');
    await closeServer();
    seen.length = 0;
    endpoint = await url({
      authenticate: () => ({ tenantId: 'tenant', principalId: 'sender', sourceId: 'source' }),
      authorize: () => {
        throw Error('authorize exploded');
      },
      onError: (error, stage) => seen.push([error.message, stage])
    });
    assert.equal((await post(endpoint, 'Bearer valid')).status, 403);
    await delay(20);
    assert.deepEqual(seen, [['authorize exploded', 'authorize']]);
    await closeServer();
    seen.length = 0;
    endpoint = await url({
      authenticate: () => ({ tenantId: 'tenant', principalId: 'sender', sourceId: 'source' }),
      authorize: () => true,
      traceParent: () => {
        throw Error('traceParent exploded');
      },
      observe: () => {
        throw Error('observe exploded');
      },
      onError: (error, stage) => seen.push([error.message, stage])
    });
    assert.equal((await post(endpoint, 'Bearer valid')).status, 202);
    await delay(20);
    assert.deepEqual(
      seen.sort(),
      [
        ['observe exploded', 'observe'],
        ['traceParent exploded', 'traceParent']
      ],
      'the request succeeds and both swallowed callback failures reach the hook'
    );
    await closeServer();
    endpoint = await url({
      authenticate: () => {
        throw Error('authenticate exploded');
      },
      authorize: () => true,
      onError: () => {
        throw Error('hook exploded');
      }
    });
    assert.equal((await post(endpoint, 'Bearer valid')).status, 401, 'a throwing hook does not change the response');
    assert.equal((await post(endpoint, 'Bearer valid')).status, 401, 'the ingress keeps serving after a throwing hook');
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    triggers.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TASK-021 the budget recovery worker reports a failing reference callback, and a throwing hook is ignored', async () => {
  const dir = temp(),
    path = join(dir, 'runs.sqlite'),
    runs = new SqliteAgentRuns(path);
  try {
    let run = runs.create(scope, 'run', { definitionVersion: 1, maxAttempts: 2, deadline: 1000 }, 0);
    run = runs.claim(scope, 'run', run.revision, 'worker', 100, 1);
    const budget = new SqliteAgentTokenBudget(path, { scope, runId: 'run', leaseToken: run.leaseToken, maxTokens: 100, clock: () => 2 });
    budget.reserve('a', 20);
    run = runs.settle(scope, 'run', run.revision, run.leaseToken, 'uncertain', 3);
    const recovery = new AgentBudgetRecovery({ budget, target: { scope, runId: 'run', maxTokens: 100 }, authorize: () => true, verify: () => ({ usedTokens: 5 }) }),
      seen = [],
      options = {
        runs,
        recovery,
        scope,
        runId: 'run',
        actor,
        reference: () => {
          throw Error('reference callback exploded');
        },
        maxPerPass: 5,
        pollMs: 100,
        onError: (error, callId) => seen.push([error.message, callId])
      };
    assert.equal(await new AgentBudgetRecoveryWorker(options).runOnce(), 0);
    assert.deepEqual(seen, [['reference callback exploded', 'a']]);
    assert.equal(
      await new AgentBudgetRecoveryWorker({
        ...options,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
    budget.close();
  } finally {
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TASK-021 the trigger and wakeup retention workers report a failing authorization callback, and a throwing hook is ignored', async () => {
  const dir = temp(),
    path = join(dir, 'runs.sqlite');
  let runs = new SqliteAgentRuns(path),
    triggers = new SqliteAgentTriggers(path),
    triggerRetention,
    wakeupRetention;
  try {
    const event = { sourceId: 'webhook', principalId: 'sender', eventId: 'event', eventType: 'message', payload: { secret: 'private' } },
      settings = { definitionVersion: 1, maxAttempts: 2, deadline: 10000, maxPending: 10 };
    let run = runs.create(scope, 'run', { definitionVersion: 1, maxAttempts: 2, deadline: 10000 }, 0);
    run = runs.request(scope, 'run', run.revision, 'pause', 1);
    run = runs.resumeWithTrigger(scope, 'run', run.revision, event, 2).run;
    runs.request(scope, 'run', run.revision, 'cancel', 3);
    const triggerEvent = { ...event, eventId: 'trigger' },
      triggered = triggers.enqueue(scope, triggerEvent, settings, 1),
      triggerRun = runs.get(scope, triggered.runId);
    runs.request(scope, triggered.runId, triggerRun.revision, 'cancel', 2);
    const triggerOptions = {
        retention: (triggerRetention = new SqliteAgentTriggerRetention(path, { scope, authorize: () => true, authorizeDiscovery: () => true })),
        actor,
        minAgeMs: 20,
        maxPerPass: 5,
        pollMs: 100,
        clock: () => 100,
        authorize: () => {
          throw Error('trigger authorize exploded');
        },
        onError: () => {}
      },
      triggerSeen = [];
    triggerOptions.onError = (error, runId) => triggerSeen.push([error.message, runId]);
    assert.equal(await new AgentTriggerRetentionWorker(triggerOptions).runOnce(), 0);
    assert.equal(triggerSeen.length, 1, 'the failing trigger authorization reaches the hook');
    assert.match(triggerSeen[0][0], /trigger authorize exploded/);
    assert.equal(triggerSeen[0][1], triggered.runId);
    assert.equal(
      await new AgentTriggerRetentionWorker({
        ...triggerOptions,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
    const wakeupOptions = {
        retention: (wakeupRetention = new SqliteAgentWakeupRetention(path, { scope, authorizeScope: () => true, authorize: () => true, authorizeDiscovery: () => true })),
        actor,
        minAgeMs: 20,
        maxPerPass: 5,
        pollMs: 100,
        clock: () => 100,
        authorize: () => {
          throw Error('wakeup authorize exploded');
        },
        onError: () => {}
      },
      wakeupSeen = [];
    wakeupOptions.onError = (error, runId) => wakeupSeen.push([error.message, runId]);
    assert.equal(await new AgentWakeupRetentionWorker(wakeupOptions).runOnce(), 0);
    assert.equal(wakeupSeen.length, 1, 'the failing wakeup authorization reaches the hook');
    assert.equal(wakeupSeen[0][0], 'wakeup authorize exploded');
    assert.equal(wakeupSeen[0][1], 'run');
    assert.equal(
      await new AgentWakeupRetentionWorker({
        ...wakeupOptions,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
  } finally {
    triggerRetention?.close();
    wakeupRetention?.close();
    runs.close();
    triggers.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TASK-021 the memory retention worker reports a failing authorization callback, and a throwing hook is ignored', async () => {
  const memory = new SqliteAgentMemory(':memory:', { enabled: true, audit: true, maxEntries: 10, maxTtlMs: 1000, clock: () => 100, authorize: () => true }),
    memoryScope = { tenantId: 'tenant', agentId: 'one', owner: { kind: 'organization', id: 'org' }, kind: 'episodic' };
  try {
    await memory.put(actor, memoryScope, 'note', { x: 1 }, { expectedRevision: null, expiresAt: 200, provenance: { kind: 'run', id: 'run' } });
    const options = {
        memory,
        actor: { ...actor },
        scopes: [structuredClone(memoryScope)],
        authorize: () => {
          throw Error('memory authorize exploded');
        },
        maxScopesPerPass: 1,
        pollMs: 100,
        onError: () => {}
      },
      seen = [];
    options.onError = (error, failed) => seen.push([error.message, failed.agentId]);
    assert.equal(await new AgentMemoryRetentionWorker(options).runOnce(), 0);
    assert.deepEqual(seen, [['memory authorize exploded', 'one']]);
    assert.equal(
      await new AgentMemoryRetentionWorker({
        ...options,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
  } finally {
    memory.close();
  }
});

test('TASK-021 the notice delivery worker reports a failing send, and a throwing hook is ignored', async () => {
  const dir = temp(),
    path = join(dir, 'db');
  let runs, outbox, approvals;
  try {
    runs = new SqliteAgentRuns(path);
    let run = runs.create(scope, 'run', { definitionVersion: 1, maxAttempts: 3, deadline: 1000 }, 0);
    run = runs.claim(scope, 'run', run.revision, 'worker', 300, 10);
    approvals = new SqliteAgentApprovals(path, { scope, runId: 'run', clock: () => 10, authorize: () => true });
    await approvals.request(service, run.leaseToken, 'action', 'lookup', {}, 90);
    outbox = new SqliteAgentNoticeDelivery(path, { scope, clock: () => 10, authorizeList: () => true, authorize: () => true });
    await outbox.queue(reviewer, 1, 'first');
    const options = {
        outbox,
        actor: { ...reviewer },
        maxPerPass: 10,
        pollMs: 100,
        send: () => {
          throw Error('send exploded');
        },
        onError: () => {}
      },
      seen = [];
    options.onError = (error, id) => seen.push([error.message, id]);
    assert.equal(await new AgentNoticeDeliveryWorker(options).runOnce(), 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'Notice delivery outcome uncertain', 'a failing send is reported as the store-level uncertain outcome');
    assert.equal(typeof seen[0][1], 'number');
    assert.equal(
      await new AgentNoticeDeliveryWorker({
        ...options,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
  } finally {
    approvals?.close();
    outbox?.close();
    runs?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TASK-021 the schedule worker reports a failing authorization callback, and a throwing hook is ignored', async () => {
  const dir = temp(),
    path = join(dir, 'db.sqlite'),
    runs = new SqliteAgentRuns(path),
    triggerRegistry = new SqliteAgentTriggers(path),
    schedules = new SqliteAgentSchedules(path);
  try {
    schedules.save(scope, 'timer', { enabled: true, principalId: 'scheduler', rule: { kind: 'interval', intervalMs: 1000 } }, 0, 0);
    const options = {
        schedules,
        scope,
        definitions,
        authorize: () => {
          throw Error('schedule authorize exploded');
        },
        maxPending: 5,
        maxPerPass: 2,
        pollMs: 100,
        clock: () => 1000,
        onError: () => {}
      },
      seen = [];
    options.onError = error => seen.push(error.message);
    assert.equal(await new AgentScheduleWorker(options).runOnce(), 0);
    assert.deepEqual(seen, ['schedule authorize exploded']);
    assert.equal(
      await new AgentScheduleWorker({
        ...options,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
    assert.equal(runs.list(scope).length, 0, 'nothing fired');
  } finally {
    schedules.close();
    triggerRegistry.close();
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TASK-021 the action recovery worker reports a failing evidence callback, and a throwing hook is ignored', async () => {
  const dir = temp(),
    path = join(dir, 'runs.sqlite'),
    runs = new SqliteAgentRuns(path);
  try {
    let run = runs.create(scope, 'run', { definitionVersion: 1, maxAttempts: 3, deadline: 10000 }, 0);
    run = runs.claim(scope, 'run', run.revision, 'worker', 100, 10);
    const journal = new SqliteAgentActionJournal(path, { scope, runId: 'run', leaseToken: run.leaseToken, clock: () => 10 });
    await assert.rejects(
      journal.invoke('a', 'op', {}, 2, async () => {
        throw Error('lost');
      }),
      /uncertain/
    );
    runs.settle(scope, 'run', run.revision, run.leaseToken, 'uncertain', 20);
    const options = {
        journal,
        maxPerPass: 2,
        pollMs: 100,
        onError: () => {},
        authorize: () => true,
        evidence: () => {
          throw Error('evidence callback exploded');
        },
        verify: async () => ({ outcome: 'applied' })
      },
      seen = [];
    options.onError = (error, actionId) => seen.push([error.message, actionId]);
    assert.equal(await new AgentActionRecoveryWorker(options).runOnce(), 0);
    assert.deepEqual(seen, [['evidence callback exploded', 'a']]);
    assert.equal(
      await new AgentActionRecoveryWorker({
        ...options,
        onError: () => {
          throw Error('hook exploded');
        }
      }).runOnce(),
      0,
      'a throwing hook is ignored'
    );
    journal.close();
  } finally {
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
