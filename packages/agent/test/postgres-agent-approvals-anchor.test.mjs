// TASK-047.4: the shared approval store with an event anchor held outside the database (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentTriggerFoundation } from '../dist/postgres/postgres-trigger-foundation.js';
import { PostgresAgentRunLifecycleFoundation } from '../dist/postgres/postgres-run-lifecycle-foundation.js';
import { PostgresAgentApprovalsFoundation } from '../dist/postgres/postgres-agent-approvals-foundation.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const scope = { tenantId: 'tenant', agentId: 'agent' },
  service = { tenantId: 'tenant', principalId: 'service' },
  rolledBack = /Agent approvals were rolled back/,
  mapAnchor = () => {
    const marks = new Map();
    return { marks, anchor: { read: key => marks.get(key) ?? 0, advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value)) } };
  };

function fake(storedId = () => 0) {
  const statements = [],
    query = async (sql, args) => {
      statements.push(sql);
      if (/max\(id\)/i.test(sql)) {
        assert.deepEqual(args, ['tenant', 'agent']);
        return { rows: [{ stored: String(storedId()) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}
const store = (db, extra = {}) => new PostgresAgentApprovalsFoundation({ scope, runId: 'run', authorize: () => true, query: db.query, transaction: db.transaction, ...extra });

test('TASK-047.4 an anchored approval store adds an index on its event ids and nothing else; one without an anchor does not', async () => {
  const anchored = fake(),
    plain = fake();
  await store(anchored, { versionAnchor: mapAnchor().anchor }).initialize();
  await store(plain).initialize();
  assert.deepEqual(
    anchored.statements.filter(sql => !plain.statements.includes(sql)),
    ['CREATE INDEX IF NOT EXISTS app_mixer_shared_approval_events_newest ON app_mixer_shared_approval_events(tenant_id,agent_id,id)']
  );
});

test('TASK-047.4 every answer and change of a restored approval store is refused, nothing is written, and an unreadable anchor fails closed', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-approvals', 'tenant', 'agent');
  let stored = 8;
  const db = fake(() => stored),
    approvals = store(db, { versionAnchor: anchor });
  assert.equal(await approvals.get(service, 'a1'), undefined);
  assert.equal(marks.get(key), 8, 'a database ahead of the anchor catches it up');
  assert.match(
    db.statements.find(sql => /max\(id\)/i.test(sql)),
    /FROM app_mixer_shared_approval_events /
  );
  stored = 5;
  const before = db.statements.length;
  for (const refused of [
    () => approvals.get(service, 'a1'),
    () => approvals.list(service),
    () => approvals.history(service, 'a1'),
    () => approvals.request(service, 'lease', 'a1', 'pay', { n: 1 }, Date.now() + 30000),
    () => approvals.decide(service, 'a1', 'approved'),
    () => approvals.expire(service, 'a1')
  ])
    await assert.rejects(refused(), rolledBack);
  assert.equal(db.statements.slice(before).filter(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)).length, 0, 'a refused call writes nothing');
  assert.equal(marks.get(key), 8, 'a refusal never lowers the anchor');
  const unreadable = store(db, {
    versionAnchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.get(service, 'a1'), /Agent approvals anchor unavailable/);
  assert.throws(() => store(db, { versionAnchor: {} }), /Invalid shared approval configuration/);
  assert.throws(() => store(db, { onAnchorError: 1 }), /Invalid shared approval configuration/);
});

test('TASK-047.4 PostgreSQL approval store anchors every event and refuses a rewound history', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'approvals_anchor_' + randomUUID().replaceAll('-', ''),
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
    const config = { query: (sql, args) => pool.query(sql, args), transaction },
      triggers = new PostgresAgentTriggerFoundation(config),
      lifecycle = new PostgresAgentRunLifecycleFoundation(config);
    await triggers.initialize();
    await lifecycle.initialize();
    const { runId } = await triggers.enqueue(
        scope,
        { sourceId: 'manual', principalId: 'person', eventId: 'one', eventType: 'manual', payload: {} },
        { definitionVersion: 1, maxAttempts: 3, runTimeoutMs: 60000, maxPending: 10 }
      ),
      claim = await lifecycle.claim(scope, runId, 1, 'worker', 30000, 10),
      { marks, anchor } = mapAnchor(),
      key = agentAnchorKey('agent-approvals', 'tenant', 'agent'),
      newest = async () => Number((await config.query('SELECT COALESCE(max(id),0) AS v FROM app_mixer_shared_approval_events', [])).rows[0].v),
      plain = new PostgresAgentApprovalsFoundation({ ...config, scope, runId, authorize: () => true }),
      approvals = new PostgresAgentApprovalsFoundation({ ...config, scope, runId, authorize: () => true, versionAnchor: anchor });
    await plain.initialize();
    await plain.request(service, claim.leaseToken, 'before', 'pay', { n: 0 }, Date.now() + 30000);
    await approvals.initialize();
    await approvals.initialize();
    assert.equal((await approvals.get(service, 'before')).status, 'pending');
    assert.equal(marks.get(key), await newest(), 'the first check caught the anchor up to the existing events');
    await approvals.request(service, claim.leaseToken, 'a1', 'pay', { n: 1 }, Date.now() + 30000);
    assert.equal(marks.get(key), await newest(), 'a request advances the anchor');
    await approvals.decide(service, 'a1', 'approved');
    assert.equal(marks.get(key), await newest(), 'a decision advances the anchor');
    const decided = marks.get(key);
    marks.set(key, decided + 5); // a database behind the anchor
    await assert.rejects(approvals.get(service, 'a1'), rolledBack);
    await assert.rejects(approvals.history(service, 'a1'), rolledBack);
    await assert.rejects(approvals.request(service, claim.leaseToken, 'a2', 'pay', { n: 2 }, Date.now() + 30000), rolledBack);
    assert.equal(await newest(), decided, 'the refused request wrote nothing');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
