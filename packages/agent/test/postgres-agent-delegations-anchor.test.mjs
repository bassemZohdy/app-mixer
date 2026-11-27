// TASK-047.4: the shared delegation store with an event anchor held outside the database, so a revoked grant stays revoked (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentTriggerFoundation } from '../dist/postgres/postgres-trigger-foundation.js';
import { PostgresAgentRunLifecycleFoundation } from '../dist/postgres/postgres-run-lifecycle-foundation.js';
import { PostgresAgentDelegationsFoundation } from '../dist/postgres/postgres-agent-delegations-foundation.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const scope = { tenantId: 'tenant', agentId: 'agent' },
  operator = { tenantId: 'tenant', principalId: 'operator' },
  rolledBack = /Agent delegations were rolled back/,
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
const store = (db, extra = {}) => new PostgresAgentDelegationsFoundation({ scope, runId: 'run', authorize: () => true, query: db.query, transaction: db.transaction, ...extra });
const grant = { ...scope, runId: 'run', grantId: 'grant', principalId: 'person', permissionVersion: 'v1', expiresAt: Date.now() + 15000, revision: 1 };

test('TASK-047.4 an anchored delegation store adds an index on its event ids and nothing else; one without an anchor does not', async () => {
  const anchored = fake(),
    plain = fake();
  await store(anchored, { versionAnchor: mapAnchor().anchor }).initialize();
  await store(plain).initialize();
  assert.deepEqual(
    anchored.statements.filter(sql => !plain.statements.includes(sql)),
    ['CREATE INDEX IF NOT EXISTS app_mixer_shared_delegation_events_newest ON app_mixer_shared_delegation_events(tenant_id,agent_id,id)']
  );
});

test('TASK-047.4 every answer and change of a restored delegation store is refused, so a revoked grant is never valid again, and an unreadable anchor fails closed', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-delegations', 'tenant', 'agent');
  let stored = 8;
  const db = fake(() => stored),
    delegations = store(db, { versionAnchor: anchor });
  assert.equal(await delegations.get(operator, 'grant'), undefined);
  assert.equal(marks.get(key), 8, 'a database ahead of the anchor catches it up');
  assert.match(
    db.statements.find(sql => /max\(id\)/i.test(sql)),
    /FROM app_mixer_shared_delegation_events /
  );
  stored = 5;
  const before = db.statements.length;
  for (const refused of [
    () => delegations.get(operator, 'grant'),
    () => delegations.verify(operator, grant),
    () => delegations.state(operator, grant),
    () => delegations.issue(operator, { ...grant, revision: undefined }),
    () => delegations.renew(operator, 'grant', 1, 'v2', Date.now() + 20000),
    () => delegations.revoke(operator, 'grant', 1),
    () => delegations.historyPage(operator, 'grant')
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
  await assert.rejects(unreadable.verify(operator, grant), /Agent delegations anchor unavailable/);
  assert.throws(() => store(db, { versionAnchor: {} }), /Invalid delegation configuration/);
  assert.throws(() => store(db, { onAnchorError: 1 }), /Invalid delegation configuration/);
});

test('TASK-047.4 PostgreSQL delegation store anchors every event and refuses a rewound history', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'delegations_anchor_' + randomUUID().replaceAll('-', ''),
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
      { marks, anchor } = mapAnchor(),
      key = agentAnchorKey('agent-delegations', 'tenant', 'agent'),
      newest = async () => Number((await config.query('SELECT COALESCE(max(id),0) AS v FROM app_mixer_shared_delegation_events', [])).rows[0].v),
      plain = new PostgresAgentDelegationsFoundation({ ...config, scope, runId, authorize: () => true }),
      delegations = new PostgresAgentDelegationsFoundation({ ...config, scope, runId, authorize: () => true, versionAnchor: anchor }),
      base = { ...scope, runId, principalId: 'person', permissionVersion: 'v1', expiresAt: Date.now() + 30000 };
    await plain.initialize();
    await plain.issue(operator, { ...base, grantId: 'before' });
    await delegations.initialize();
    await delegations.initialize();
    assert.equal((await delegations.get(operator, 'before')).revision, 1);
    assert.equal(marks.get(key), await newest(), 'the first check caught the anchor up to the existing events');
    const issued = await delegations.issue(operator, { ...base, grantId: 'g1' });
    assert.equal(marks.get(key), await newest(), 'issue advances the anchor');
    const renewed = await delegations.renew(operator, 'g1', 1, 'v2', Date.now() + 30000);
    assert.equal(marks.get(key), await newest(), 'renew advances the anchor');
    await delegations.revoke(operator, 'g1', renewed.revision);
    assert.equal(marks.get(key), await newest(), 'revoke advances the anchor');
    assert.equal(await delegations.verify(operator, issued.grant), false);
    const revoked = marks.get(key);
    marks.set(key, revoked + 5); // a database behind the anchor
    await assert.rejects(delegations.verify(operator, renewed.grant), rolledBack);
    await assert.rejects(delegations.issue(operator, { ...base, grantId: 'g2' }), rolledBack);
    assert.equal(await newest(), revoked, 'the refused issue wrote nothing');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
