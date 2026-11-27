import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresOfflineRequestKeys, PostgresOfflineExecutions, CapabilityRegistry, registerSharedOfflineDispatch, offlineExecutionAnchorKey } from '../dist/index.js';
const scope = { tenantId: 'tenant', applicationId: 'app' },
  payload = { order: 42 };

test('shared execution rejects invalid scopes and fails closed on unavailable storage', async () => {
  const keys = new PostgresOfflineRequestKeys({
      query: async () => {
        throw Error('offline');
      }
    }),
    journal = new PostgresOfflineExecutions({
      query: async () => {
        throw Error('offline');
      },
      requestKeys: keys
    });
  await assert.rejects(journal.get(scope, 'user', 'bad'), /Invalid/);
  await assert.rejects(
    journal.execute(scope, 'user', 'save', payload, randomUUID(), async () => 1),
    /offline/
  );
  await assert.rejects(journal.markUncertain(scope, 'user', randomUUID(), 'bad'), /Invalid/);
  assert.throws(() => new PostgresOfflineExecutions({ query: () => {}, requestKeys: {} }), /Invalid/);
});

test('PostgreSQL shared execution serializes dispatch and safely reconciles uncertainty', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 30000 }, async () => {
  const schema = 'app_mixer_exec_' + randomUUID().replaceAll('-', ''),
    url = process.env.APP_MIXER_TEST_POSTGRES_URL,
    admin = new pg.Pool({ connectionString: url }),
    a = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }),
    b = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const keysA = new PostgresOfflineRequestKeys({ query: (sql, args) => a.query(sql, args) }),
      keysB = new PostgresOfflineRequestKeys({ query: (sql, args) => b.query(sql, args) }),
      first = new PostgresOfflineExecutions({ query: (sql, args) => a.query(sql, args), requestKeys: keysA }),
      second = new PostgresOfflineExecutions({ query: (sql, args) => b.query(sql, args), requestKeys: keysB });
    await keysA.initialize();
    await first.initialize();
    const key = await keysA.allocate(scope, 'user', 'save', 'one', payload);
    let started,
      release,
      calls = 0;
    const entered = new Promise(r => (started = r)),
      gate = new Promise(r => (release = r)),
      pending = first.execute(scope, 'user', 'save', payload, key, async value => {
        calls++;
        assert.deepEqual(value, payload);
        started();
        await gate;
        return { receipt: 'ok' };
      });
    await entered;
    await assert.rejects(
      second.execute(scope, 'user', 'save', payload, key, async () => {
        calls++;
      }),
      /in progress/
    );
    assert.equal((await second.get(scope, 'user', key)).status, 'running');
    assert.equal(await second.get(scope, 'other', key), undefined);
    release();
    assert.deepEqual(await pending, { receipt: 'ok' });
    assert.deepEqual(
      await second.execute(scope, 'user', 'save', payload, key, async () => {
        calls++;
      }),
      { receipt: 'ok' }
    );
    assert.equal(calls, 1);
    await assert.rejects(
      second.execute(scope, 'user', 'save', { order: 99 }, key, async () => {}),
      /forbidden/
    );
    const lost = await keysA.allocate(scope, 'user', 'save', 'lost', payload);
    await assert.rejects(
      first.execute(scope, 'user', 'save', payload, lost, async () => {
        throw Error('private provider error');
      }),
      /outcome uncertain/
    );
    const uncertain = await second.get(scope, 'user', lost);
    assert.equal(uncertain.status, 'uncertain');
    await assert.rejects(
      second.execute(scope, 'user', 'save', payload, lost, async () => {
        calls++;
      }),
      /outcome uncertain/
    );
    await assert.rejects(second.reconcile(scope, 'user', lost, randomUUID(), { outcome: 'applied', result: { receipt: 'verified' } }), /changed/);
    await second.reconcile(scope, 'user', lost, uncertain.attemptToken, { outcome: 'applied', result: { receipt: 'verified' } });
    assert.deepEqual(
      await first.execute(scope, 'user', 'save', payload, lost, async () => {
        calls++;
      }),
      { receipt: 'verified' }
    );
    assert.equal(calls, 1);
    const fenced = await keysA.allocate(scope, 'user', 'save', 'fenced', payload);
    let staleStarted, finishStale;
    const staleEntered = new Promise(r => (staleStarted = r)),
      staleGate = new Promise(r => (finishStale = r)),
      stale = first.execute(scope, 'user', 'save', payload, fenced, async () => {
        staleStarted();
        await staleGate;
        return { receipt: 'stale' };
      });
    await staleEntered;
    const old = await first.get(scope, 'user', fenced);
    await second.markUncertain(scope, 'user', fenced, old.attemptToken);
    await second.reconcile(scope, 'user', fenced, old.attemptToken, { outcome: 'not_applied' });
    assert.deepEqual(await second.execute(scope, 'user', 'save', payload, fenced, async () => ({ receipt: 'new' })), { receipt: 'new' });
    finishStale();
    await assert.rejects(stale, /outcome uncertain/);
    assert.deepEqual((await first.get(scope, 'user', fenced)).result, { receipt: 'new' });
    await assert.rejects(first.markUncertain(scope, 'user', fenced, old.attemptToken), /changed/);
    let permitted = true;
    const front = new CapabilityRegistry(() => {}),
      external = new CapabilityRegistry(() => {});
    external.register(
      { operationId: 'save', method: 'POST', path: '/save' },
      {
        authorize: () => true,
        validate: () => true,
        execute: async () => {
          calls++;
          return { receipt: 'direct' };
        }
      }
    );
    registerSharedOfflineDispatch(front, external, keysA, {
      candidate: { operationId: 'offline.dispatch', method: 'POST', path: '/dispatch' },
      applicationId: 'app',
      targetOperationId: 'save',
      executions: first,
      authorize: () => permitted,
      authorizePayload: () => true,
      validatePayload: () => true
    });
    const actor = { tenantId: 'tenant', principalId: 'user', origin: 'ui' };
    assert.deepEqual(await front.invoke('offline.dispatch', { idempotencyKey: key, payload }, actor), { receipt: 'ok' });
    assert.equal(calls, 1);
    permitted = false;
    await assert.rejects(front.invoke('offline.dispatch', { idempotencyKey: key, payload }, actor), /forbidden/);
    assert.equal(calls, 1);
  } finally {
    await Promise.allSettled([a.end(), b.end()]);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

function anchoredFixture(options = {}) {
  const marks = new Map(),
    anchor = options.anchor ?? { read: name => marks.get(name) ?? 0, advance: (name, value) => marks.set(name, Math.max(marks.get(name) ?? 0, value)) },
    statements = [];
  let stored = 0,
    version = 100;
  const state = {
      marks,
      statements,
      get stored() {
        return stored;
      },
      set stored(value) {
        stored = value;
      }
    },
    query = async (sql, args) => {
      statements.push(sql);
      if (/SELECT 1 AS valid FROM app_mixer_offline_request_keys/.test(sql)) return { rows: [{ valid: 1 }], rowCount: 1 };
      if (/max\(version\)/i.test(sql)) {
        assert.deepEqual(args, ['tenant', 'app']);
        return { rows: [{ stored: String(stored) }], rowCount: 1 };
      }
      if (/^(INSERT|UPDATE) /.test(sql)) {
        stored = ++version;
        const attempt = /^INSERT/.test(sql) ? args[5] : args[4];
        return { rows: [{ attempt_token: attempt, version: String(version) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    keys = new PostgresOfflineRequestKeys({ query }),
    journal = new PostgresOfflineExecutions({ query, requestKeys: keys, versionAnchor: anchor, onAnchorError: options.onAnchorError });
  return { state, journal, query, keys, plain: new PostgresOfflineExecutions({ query, requestKeys: keys }) };
}

test('TASK-052.2 an executions store with a version anchor advances it per change and refuses once the database is behind it', async () => {
  const { state, journal, plain } = anchoredFixture(),
    key = randomUUID(),
    anchorKey = offlineExecutionAnchorKey('tenant', 'app'),
    attempt = randomUUID();
  assert.notEqual(anchorKey, offlineExecutionAnchorKey('tenant', 'other'));
  assert.notEqual(anchorKey, offlineExecutionAnchorKey('tenant2', 'app'));
  assert.deepEqual(await journal.execute(scope, 'user', 'save', payload, key, async () => ({ ok: 1 })), { ok: 1 });
  assert.equal(state.marks.get(anchorKey), 102, 'the claim and the completion each drew a version; the anchor holds the last');
  const written = state.statements.filter(sql => /^(INSERT|UPDATE) /.test(sql));
  assert.ok(written.length >= 2 && written.every(sql => /nextval\('app_mixer_offline_execution_version'\)/.test(sql) && /version/.test(sql.split('RETURNING')[1] ?? '')));
  await journal.markUncertain(scope, 'user', key, attempt);
  assert.equal(state.marks.get(anchorKey), 103);
  await journal.reconcile(scope, 'user', key, attempt, { outcome: 'not_applied' });
  assert.equal(state.marks.get(anchorKey), 104);
  state.stored = 101; // a restored database whose newest execution of the scope is older than the anchor
  const before = state.statements.length;
  for (const refused of [
    () => journal.get(scope, 'user', key),
    () => journal.execute(scope, 'user', 'save', payload, key, async () => ({ ok: 1 })),
    () => journal.markUncertain(scope, 'user', key, attempt),
    () => journal.reconcile(scope, 'user', key, attempt, { outcome: 'not_applied' })
  ])
    await assert.rejects(refused(), /Offline executions were rolled back/);
  assert.equal(state.statements.slice(before).filter(sql => /^(INSERT|UPDATE) /.test(sql)).length, 0, 'a refused call writes nothing');
  assert.equal(state.marks.get(anchorKey), 104, 'a refusal never lowers the anchor');
  assert.equal(state.statements.slice(before).filter(sql => /nextval/.test(sql)).length, 0);
  // The same database without an anchor keeps today's statements: no version, no sequence.
  state.stored = 0;
  const unanchoredBefore = state.statements.length;
  await plain.execute(scope, 'user', 'save', payload, randomUUID(), async () => ({ ok: 2 }));
  assert.equal(state.statements.slice(unanchoredBefore).filter(sql => /version|nextval/.test(sql)).length, 0);
});

test('TASK-052.2 anchored initialize adds the version column and sequence; unanchored initialize does not', async () => {
  const anchored = anchoredFixture(),
    unanchored = anchoredFixture();
  await anchored.journal.initialize();
  const sql = anchored.state.statements.join('\n');
  assert.match(sql, /CREATE SEQUENCE IF NOT EXISTS app_mixer_offline_execution_version/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval\('app_mixer_offline_execution_version'\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS app_mixer_offline_executions_newest ON app_mixer_offline_executions \(tenant_id,application_id,version\)/);
  await unanchored.plain.initialize();
  assert.doesNotMatch(unanchored.state.statements.join('\n'), /version|SEQUENCE/i);
});

test('TASK-052.2 version anchor failures fail closed, are reported after a commit and are validated', async () => {
  const unreadable = anchoredFixture({
    anchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.journal.get(scope, 'user', randomUUID()), /Offline executions anchor unavailable/);
  const errors = [],
    broken = anchoredFixture({
      anchor: {
        read: () => 0,
        advance: () => {
          throw Error('cannot write anchor');
        }
      },
      onAnchorError: error => errors.push(error.message)
    });
  assert.deepEqual(await broken.journal.execute(scope, 'user', 'save', payload, randomUUID(), async () => ({ ok: 1 })), { ok: 1 });
  assert.ok(errors.length >= 1 && errors.every(message => message === 'cannot write anchor'), 'a failed advance is reported and the committed change stays');
  const { query, keys } = anchoredFixture();
  assert.throws(() => new PostgresOfflineExecutions({ query, requestKeys: keys, versionAnchor: {} }), /Invalid/);
  assert.throws(() => new PostgresOfflineExecutions({ query, requestKeys: keys, onAnchorError: 1 }), /Invalid/);
});

test('TASK-052.2 PostgreSQL anchored executions migrate an existing table and anchor every state change', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 30000 }, async () => {
  const schema = 'app_mixer_exec_anchor_' + randomUUID().replaceAll('-', ''),
    admin = new pg.Pool({ connectionString: process.env.APP_MIXER_TEST_POSTGRES_URL }),
    pool = new pg.Pool({ connectionString: process.env.APP_MIXER_TEST_POSTGRES_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const query = (sql, args) => pool.query(sql, args),
      marks = new Map(),
      anchor = { read: name => marks.get(name) ?? 0, advance: (name, value) => marks.set(name, Math.max(marks.get(name) ?? 0, value)) },
      anchorKey = offlineExecutionAnchorKey('tenant', 'app'),
      keys = new PostgresOfflineRequestKeys({ query }),
      plain = new PostgresOfflineExecutions({ query, requestKeys: keys }),
      anchored = new PostgresOfflineExecutions({ query, requestKeys: keys, versionAnchor: anchor });
    await keys.initialize();
    await plain.initialize();
    const before = await keys.allocate(scope, 'user', 'save', 'before', payload);
    assert.deepEqual(await plain.execute(scope, 'user', 'save', payload, before, async () => ({ ok: 0 })), { ok: 0 });
    await anchored.initialize(); // the existing row gains its version
    await anchored.initialize(); // and initializing again changes nothing
    const versions = async () => (await query('SELECT idempotency_key,version FROM app_mixer_offline_executions ORDER BY version')).rows.map(row => Number(row.version));
    assert.equal((await versions()).length, 1);
    assert.deepEqual(await anchored.get(scope, 'user', before), { status: 'succeeded', attemptToken: (await anchored.get(scope, 'user', before)).attemptToken, result: { ok: 0 } });
    assert.equal(marks.get(anchorKey), (await versions())[0], 'the first check caught the anchor up to the migrated row');
    const key = await keys.allocate(scope, 'user', 'save', 'two', payload);
    await assert.rejects(
      anchored.execute(scope, 'user', 'save', payload, key, async () => {
        throw Error('provider timed out');
      }),
      /outcome uncertain/
    );
    const uncertain = await anchored.get(scope, 'user', key);
    assert.equal(uncertain.status, 'uncertain');
    const afterUncertain = marks.get(anchorKey);
    assert.equal(afterUncertain, Math.max(...(await versions())), 'the anchor holds the newest version after claim and markUncertain');
    await anchored.reconcile(scope, 'user', key, uncertain.attemptToken, { outcome: 'not_applied' });
    assert.ok(marks.get(anchorKey) > afterUncertain, 'reconcile drew a new version');
    assert.equal((await anchored.get(scope, 'user', key)).status, 'ready');
    assert.deepEqual(await anchored.execute(scope, 'user', 'save', payload, key, async () => ({ ok: 2 })), { ok: 2 });
    assert.equal(marks.get(anchorKey), Math.max(...(await versions())));
    // A database behind the anchor is refused.
    marks.set(anchorKey, Math.max(...(await versions())) + 5);
    await assert.rejects(anchored.get(scope, 'user', key), /Offline executions were rolled back/);
    await assert.rejects(
      anchored.execute(scope, 'user', 'save', payload, key, async () => ({ ok: 3 })),
      /Offline executions were rolled back/
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
