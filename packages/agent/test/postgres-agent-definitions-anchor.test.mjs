// TASK-047.3: the PostgreSQL definition store with a version anchor held outside the database (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentDefinitions } from '../dist/index.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const actor = { tenantId: 'tenant', principalId: 'admin' },
  manifest = title => ({
    manifestVersion: 1,
    tenantId: 'tenant',
    agentId: 'agent',
    name: title,
    owner: { kind: 'organization', id: 'org' },
    administrators: ['admin'],
    servicePrincipalId: 'svc',
    model: { provider: 'local', model: 'test' },
    allowedCapabilities: ['lookup'],
    lifecycle: { enabled: true, maxAttempts: 2, runTimeoutMs: 60000 },
    quotas: { maxConcurrentRuns: 2, maxTokensPerRun: 100, maxRunsPerDay: 10 }
  }),
  mapAnchor = () => {
    const marks = new Map();
    return { marks, anchor: { read: key => marks.get(key) ?? 0, advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value)) } };
  };

function fake(storedVersion = () => 0) {
  const statements = [],
    query = async (sql, args) => {
      statements.push(sql);
      if (/max\(version\)/i.test(sql)) {
        assert.deepEqual(args, ['tenant', 'agent']);
        return { rows: [{ stored: String(storedVersion()) }], rowCount: 1 };
      }
      if (/FOR UPDATE/.test(sql)) return { rows: [{ agent_id: 'agent' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}
const store = (db, extra = {}) => new PostgresAgentDefinitions({ enabled: true, query: db.query, transaction: db.transaction, authorize: () => true, ...extra });

test('TASK-047.3 an anchored definition store changes no table on initialize, because the immutable version rows are its counter', async () => {
  const anchored = fake(),
    plain = fake();
  await store(anchored, { versionAnchor: mapAnchor().anchor }).initialize();
  await store(plain).initialize();
  assert.deepEqual(anchored.statements, plain.statements);
});

test('TASK-047.3 every read, listing and save of a restored definition store is refused, an unreadable anchor fails closed and options are validated', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-definitions', 'tenant', 'agent');
  let stored = 6;
  const db = fake(() => stored),
    definitions = store(db, { versionAnchor: anchor });
  assert.equal(await definitions.get(actor, 'agent'), undefined);
  assert.equal(marks.get(key), 6, 'a database ahead of the anchor catches it up');
  assert.match(db.statements.find(sql => /max\(version\)/i.test(sql)), /FROM app_mixer_agent_definitions /);
  stored = 4;
  for (const refused of [
    () => definitions.get(actor, 'agent'),
    () => definitions.get(actor, 'agent', 2),
    () => definitions.getWithSignal(actor, 'agent', new AbortController().signal),
    () => definitions.history(actor, 'agent'),
    () => definitions.controlHistory(actor, 'agent'),
    () => definitions.view(actor).get('tenant', 'agent'),
    () => definitions.save(actor, manifest('v7'), 6)
  ])
    await assert.rejects(refused(), /Agent definitions were rolled back/);
  assert.equal(marks.get(key), 6, 'a refusal never lowers the anchor');
  assert.equal(
    db.statements.filter(sql => /^INSERT INTO app_mixer_agent_definitions /.test(sql)).length,
    0,
    'a refused save writes nothing'
  );
  const unreadable = store(db, {
    versionAnchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.get(actor, 'agent'), /Agent definitions anchor unavailable/);
  assert.throws(() => store(db, { versionAnchor: {} }), /Invalid agent definition configuration/);
  assert.throws(() => store(db, { onAnchorError: 1 }), /Invalid agent definition configuration/);
});

test('TASK-047.3 PostgreSQL definition store anchors every saved version and refuses a rewound one', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'agent_definitions_anchor_' + randomUUID().replaceAll('-', ''),
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
      key = agentAnchorKey('agent-definitions', 'tenant', 'agent'),
      plain = new PostgresAgentDefinitions({ enabled: true, query, transaction, authorize: () => true }),
      anchored = new PostgresAgentDefinitions({ enabled: true, query, transaction, authorize: () => true, versionAnchor: anchor });
    await plain.initialize();
    await plain.save(actor, manifest('before'), 0);
    await anchored.initialize();
    assert.equal((await anchored.get(actor, 'agent')).version, 1);
    assert.equal(marks.get(key), 1, 'the first check caught the anchor up to the existing version');
    await anchored.save(actor, manifest('second'), 1);
    assert.equal(marks.get(key), 2, 'save advances the anchor');
    marks.set(key, 5); // a database behind the anchor
    await assert.rejects(anchored.get(actor, 'agent'), /Agent definitions were rolled back/);
    await assert.rejects(anchored.save(actor, manifest('fourth'), 2), /Agent definitions were rolled back/);
    assert.equal((await query('SELECT max(version) AS v FROM app_mixer_agent_definitions')).rows[0].v, '2', 'the refused save wrote nothing');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
