// TASK-047.2.2: the PostgreSQL run registry with a version anchor held outside the database (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentRuns } from '../dist/index.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const scope = { tenantId: 'tenant', agentId: 'agent' },
  config = () => ({ definitionVersion: 1, maxAttempts: 3, deadline: Date.now() + 600000 }),
  sequence = 'app_mixer_agent_run_version',
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
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}

test('TASK-047.2.2 a run registry with a version anchor adds the version column on initialize; one without does not', async () => {
  const anchored = fake(),
    plain = fake();
  await new PostgresAgentRuns({ enabled: true, query: anchored.query, transaction: anchored.transaction, versionAnchor: mapAnchor().anchor }).initialize();
  const sql = anchored.statements.join('\n');
  assert.match(sql, new RegExp(`CREATE SEQUENCE IF NOT EXISTS ${sequence}`));
  assert.match(sql, new RegExp(`ALTER TABLE app_mixer_agent_runs ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval\\('${sequence}'\\)`));
  assert.match(sql, /CREATE INDEX IF NOT EXISTS app_mixer_agent_runs_newest ON app_mixer_agent_runs\s*\(tenant_id,agent_id,version\)/);
  await new PostgresAgentRuns({ enabled: true, query: plain.query, transaction: plain.transaction }).initialize();
  assert.doesNotMatch(plain.statements.join('\n'), /SEQUENCE|app_mixer_agent_runs_newest|\bversion BIGINT/);
});

test('TASK-047.2.2 every read of a restored run registry is refused, an unreadable anchor fails closed and options are validated', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-runs', 'tenant', 'agent');
  let stored = 10;
  const db = fake(() => stored),
    runs = new PostgresAgentRuns({ enabled: true, query: db.query, transaction: db.transaction, versionAnchor: anchor });
  assert.equal(await runs.get(scope, 'r1'), undefined);
  assert.equal(marks.get(key), 10, 'a database ahead of the anchor catches it up');
  stored = 7;
  for (const refused of [() => runs.get(scope, 'r1'), () => runs.queued(scope), () => runs.expiredLeases(scope), () => runs.uncertain(scope), () => runs.create(scope, 'r2', config())])
    await assert.rejects(refused(), /Agent runs were rolled back/);
  assert.equal(marks.get(key), 10, 'a refusal never lowers the anchor');
  const unreadable = new PostgresAgentRuns({
    enabled: true,
    query: db.query,
    transaction: db.transaction,
    versionAnchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.get(scope, 'r1'), /Agent runs anchor unavailable/);
  assert.throws(() => new PostgresAgentRuns({ enabled: true, query: db.query, transaction: db.transaction, versionAnchor: {} }), /Invalid agent run registry configuration/);
  assert.throws(() => new PostgresAgentRuns({ enabled: true, query: db.query, transaction: db.transaction, onAnchorError: 1 }), /Invalid agent run registry configuration/);
});

test('TASK-047.2.2 PostgreSQL run registry migrates an existing table and anchors every transition', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'agent_runs_anchor_' + randomUUID().replaceAll('-', ''),
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
      key = agentAnchorKey('agent-runs', 'tenant', 'agent'),
      plain = new PostgresAgentRuns({ enabled: true, query, transaction }),
      anchored = new PostgresAgentRuns({ enabled: true, query, transaction, versionAnchor: anchor });
    await plain.initialize();
    await plain.create(scope, 'before', config());
    await anchored.initialize(); // the existing run gains its version
    await anchored.initialize(); // and initializing again changes nothing
    const versions = async () => (await query('SELECT run_id,version FROM app_mixer_agent_runs ORDER BY version')).rows.map(row => Number(row.version));
    assert.equal((await versions()).length, 1);
    assert.equal((await anchored.get(scope, 'before')).status, 'queued');
    assert.equal(marks.get(key), (await versions())[0], 'the first check caught the anchor up to the migrated run');
    const created = await anchored.create(scope, 'r1', config());
    assert.equal(marks.get(key), Math.max(...(await versions())), 'create advances the anchor');
    const claimed = await anchored.claim(scope, 'r1', created.revision, 'worker', 60000, { maxConcurrentRuns: 10 }),
      afterClaim = marks.get(key);
    assert.ok(afterClaim > Math.max(...(await versions())) - 1 && afterClaim === Math.max(...(await versions())), 'a claim draws a new version and the anchor holds it');
    const renewed = await anchored.renew(scope, 'r1', claimed.revision, claimed.leaseToken, 60000);
    assert.ok(marks.get(key) > afterClaim, 'a renewal advances the anchor');
    await anchored.settle(scope, 'r1', renewed.revision, claimed.leaseToken, 'succeeded');
    assert.equal(marks.get(key), Math.max(...(await versions())));
    marks.set(key, Math.max(...(await versions())) + 5); // a database behind the anchor
    await assert.rejects(anchored.get(scope, 'r1'), /Agent runs were rolled back/);
    await assert.rejects(anchored.create(scope, 'r2', config()), /Agent runs were rolled back/);
    await assert.rejects(anchored.queued(scope), /Agent runs were rolled back/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
