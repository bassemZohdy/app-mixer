// FEAT-053.1: the shared cost store with a version anchor held outside the database, so a restore cannot forget a reservation (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentSharedCost } from '../dist/index.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const actor = { tenantId: 'tenant', principalId: 'operator' },
  scope = { tenantId: 'tenant', budgetId: 'cycle-1', currency: 'USD', maxMicros: 1000 },
  call = callId => ({ agentId: 'agent', runId: 'run', callId }),
  sequence = 'app_mixer_shared_cost_version',
  rolledBack = /Shared cost was rolled back/,
  key = agentAnchorKey('agent-shared-cost', 'tenant', 'cycle-1'),
  mapAnchor = () => {
    const marks = new Map();
    return { marks, anchor: { read: name => marks.get(name) ?? 0, advance: (name, value) => marks.set(name, Math.max(marks.get(name) ?? 0, value)) } };
  };

// A database whose newest call version is `storedVersion()`; a write returns the version it drew.
function fake(storedVersion = () => 0, drawn = 5) {
  const statements = [],
    row = status => ({ agent_id: 'agent', run_id: 'run', call_id: 'c1', reserved_micros: '100', used_micros: status === 'settled' ? '90' : null, status, created_at: '1', version: String(drawn) }),
    query = async (sql, args) => {
      statements.push(sql);
      if (/max\(version\)/i.test(sql)) {
        assert.deepEqual(args, ['tenant', 'cycle-1']);
        return { rows: [{ stored: String(storedVersion()) }], rowCount: 1 };
      }
      if (/FOR UPDATE/.test(sql)) return { rows: [{ currency: 'USD', max_micros: '1000' }], rowCount: 1 };
      if (/COUNT\(\*\) AS calls/.test(sql)) return { rows: [{ calls: '0', total: '0', overruns: '0' }], rowCount: 1 };
      if (/^INSERT INTO app_mixer_shared_cost_calls /.test(sql)) return { rows: [row('reserved')], rowCount: 1 };
      if (/^UPDATE app_mixer_shared_cost_calls /.test(sql)) return { rows: [row('settled')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}
const store = (db, extra = {}) => new PostgresAgentSharedCost({ enabled: true, scope, authorize: () => true, query: db.query, transaction: db.transaction, ...extra });

test('FEAT-053.1 an anchored shared cost store adds its version column and index to the call ledger; one without an anchor does not', async () => {
  const anchored = fake(),
    plain = fake();
  await store(anchored, { versionAnchor: mapAnchor().anchor }).initialize();
  const sql = anchored.statements.join('\n');
  assert.match(sql, new RegExp(`CREATE SEQUENCE IF NOT EXISTS ${sequence}`));
  assert.match(sql, new RegExp(`ALTER TABLE app_mixer_shared_cost_calls ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval\\('${sequence}'\\)`));
  assert.match(sql, /CREATE INDEX IF NOT EXISTS app_mixer_shared_cost_calls_newest ON app_mixer_shared_cost_calls\s*\(tenant_id,budget_id,version\)/);
  await store(plain).initialize();
  assert.doesNotMatch(plain.statements.join('\n'), /SEQUENCE|_newest|\bversion BIGINT/);
});

test('FEAT-053.1 every answer and change of a restored shared cost store is refused, nothing is written, and an unreadable anchor fails closed', async () => {
  const { marks, anchor } = mapAnchor();
  let stored = 14;
  const db = fake(() => stored),
    cost = store(db, { versionAnchor: anchor });
  assert.equal(await cost.get(actor, call('c1')), undefined);
  assert.equal(marks.get(key), 14, 'a database ahead of the anchor catches it up');
  assert.match(
    db.statements.find(sql => /max\(version\)/i.test(sql)),
    /FROM app_mixer_shared_cost_calls /
  );
  stored = 9;
  const before = db.statements.length;
  for (const refused of [
    () => cost.get(actor, call('c1')),
    () => cost.summary(actor),
    () => cost.metricsSnapshot(actor),
    () => cost.pending(actor),
    () => cost.history(actor),
    () => cost.reserve(actor, call('c2'), 100),
    () => cost.settle(actor, call('c1'), 90),
    () => cost.reconcile(actor, call('c1'), 90, 'invoice-1')
  ])
    await assert.rejects(refused(), rolledBack);
  assert.equal(db.statements.slice(before).filter(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)).length, 0, 'a refused call writes nothing');
  assert.equal(marks.get(key), 14, 'a refusal never lowers the anchor');
  const unreadable = store(db, {
    versionAnchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.summary(actor), /Shared cost anchor unavailable/);
  assert.throws(() => store(db, { versionAnchor: {} }), /Invalid shared cost configuration/);
  assert.throws(() => store(db, { onAnchorError: 1 }), /Invalid shared cost configuration/);
});

test('FEAT-053.1 a reservation and a settlement draw their version in the same statement and advance the anchor; without an anchor the statements are unchanged', async () => {
  const { marks, anchor } = mapAnchor(),
    errors = [],
    reserve = fake(() => 0, 7);
  await store(reserve, { versionAnchor: anchor }).reserve(actor, call('c1'), 100);
  assert.match(
    reserve.statements.find(sql => /^INSERT INTO app_mixer_shared_cost_calls /.test(sql)),
    /RETURNING agent_id,run_id,call_id,reserved_micros,used_micros,status,created_at,version$/
  );
  assert.equal(marks.get(key), 7);
  const settle = fake(() => 7, 8);
  await store(settle, { versionAnchor: anchor }).settle(actor, call('c1'), 90);
  assert.match(
    settle.statements.find(sql => /^UPDATE app_mixer_shared_cost_calls /.test(sql)),
    new RegExp(`SET status='settled',used_micros=\\$6,version=nextval\\('${sequence}'\\) WHERE .* RETURNING .*created_at,version$`)
  );
  assert.equal(marks.get(key), 8);
  const reconcile = fake(() => 8, 9);
  await store(reconcile, { versionAnchor: anchor }).reconcile(actor, call('c1'), 90, 'invoice-1');
  assert.equal(marks.get(key), 9);
  const broken = store(
    fake(() => 0, 20),
    {
      versionAnchor: {
        read: () => 0,
        advance: () => {
          throw Error('cannot write anchor');
        }
      },
      onAnchorError: error => errors.push(error.message)
    }
  );
  await broken.reserve(actor, call('c1'), 100);
  assert.deepEqual(errors, ['cannot write anchor'], 'a reservation that committed is never undone by a failing anchor');
  const plain = fake();
  await store(plain).reserve(actor, call('c1'), 100);
  await store(plain).settle(actor, call('c1'), 90);
  assert.doesNotMatch(plain.statements.join('\n'), /version/, 'an unanchored store keeps its statements');
});

test('FEAT-053.1 PostgreSQL shared cost store migrates an existing ledger and refuses a rewound reservation', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'shared_cost_anchor_' + randomUUID().replaceAll('-', ''),
    url = process.env.APP_MIXER_TEST_POSTGRES_URL,
    admin = new pg.Pool({ connectionString: url }),
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }),
    transaction = async operation => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await operation((sql, args) => client.query(sql, args));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const query = (sql, args) => pool.query(sql, args),
      { marks, anchor } = mapAnchor(),
      options = { enabled: true, scope, authorize: () => true, query, transaction },
      plain = new PostgresAgentSharedCost(options),
      cost = new PostgresAgentSharedCost({ ...options, versionAnchor: anchor }),
      newest = async () => Number((await query('SELECT COALESCE(max(version),0) AS v FROM app_mixer_shared_cost_calls')).rows[0].v);
    await plain.initialize();
    await plain.reserve(actor, call('before'), 100);
    await cost.initialize(); // the existing reservation gains its version
    await cost.initialize();
    assert.ok((await newest()) > 0);
    assert.equal((await cost.get(actor, call('before'))).status, 'reserved');
    assert.equal(marks.get(key), await newest(), 'the first check caught the anchor up to the migrated call');
    await cost.reserve(actor, call('c1'), 200);
    assert.equal(marks.get(key), await newest(), 'a reservation advances the anchor');
    await cost.settle(actor, call('c1'), 150);
    assert.equal(marks.get(key), await newest(), 'a settlement advances the anchor');
    await cost.reconcile(actor, call('before'), 80, 'invoice-1');
    assert.equal(marks.get(key), await newest(), 'a reconciliation advances the anchor');
    assert.deepEqual([(await cost.summary(actor)).committedMicros, (await cost.summary(actor)).calls], [230, 2]);
    // A restored ledger: the call versions are older than the anchor, so the forgotten spend is not served as free.
    await query('UPDATE app_mixer_shared_cost_calls SET version=1');
    await assert.rejects(cost.summary(actor), rolledBack);
    await assert.rejects(cost.reserve(actor, call('c2'), 100), rolledBack);
    assert.equal((await query('SELECT count(*) AS n FROM app_mixer_shared_cost_calls')).rows[0].n, '2', 'the refused reservation wrote nothing');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
