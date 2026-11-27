// TASK-047.4: the PostgreSQL cost budget with a version anchor held outside the database, so spent money is not forgotten by a restore (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentRuns, PostgresAgentCostBudget } from '../dist/index.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const scope = { tenantId: 'tenant', agentId: 'agent' },
  sequence = 'app_mixer_agent_cost_version',
  rolledBack = /Agent cost budget was rolled back/,
  mapAnchor = () => {
    const marks = new Map();
    return { marks, anchor: { read: key => marks.get(key) ?? 0, advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value)) } };
  };

function fake(storedVersion = () => 0, drawn = 7) {
  const statements = [],
    query = async (sql, args) => {
      statements.push(sql);
      if (/max\(version\)/i.test(sql)) {
        assert.deepEqual(args, ['tenant', 'agent']);
        return { rows: [{ stored: String(storedVersion()) }], rowCount: 1 };
      }
      if (/^INSERT INTO app_mixer_agent_cost_budgets /.test(sql)) return { rows: [{ version: String(drawn) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}
const store = (db, extra = {}) => new PostgresAgentCostBudget({ enabled: true, query: db.query, transaction: db.transaction, ...extra });

test('TASK-047.4 an anchored cost budget adds its version column and index to the budgets and the call ledger; one without an anchor does not', async () => {
  const anchored = fake(),
    plain = fake();
  await store(anchored, { versionAnchor: mapAnchor().anchor }).initialize();
  const sql = anchored.statements.join('\n');
  assert.match(sql, new RegExp(`CREATE SEQUENCE IF NOT EXISTS ${sequence}`));
  for (const table of ['app_mixer_agent_cost_budgets', 'app_mixer_agent_cost_calls']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval\\('${sequence}'\\)`));
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${table}_newest ON ${table}\\s*\\(tenant_id,agent_id,version\\)`));
  }
  await store(plain).initialize();
  assert.doesNotMatch(plain.statements.join('\n'), /SEQUENCE|_newest|\bversion BIGINT/);
});

test('TASK-047.4 every answer and change of a restored cost budget is refused, reads both tables, and an unreadable anchor fails closed', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-cost-budget', 'tenant', 'agent');
  let stored = 12;
  const db = fake(() => stored),
    budget = store(db, { versionAnchor: anchor });
  await assert.rejects(budget.summary(scope), /Cost budget unavailable/);
  assert.equal(marks.get(key), 12, 'a database ahead of the anchor catches it up');
  assert.match(
    db.statements.find(sql => /max\(version\)/i.test(sql)),
    /app_mixer_agent_cost_budgets[\s\S]*app_mixer_agent_cost_calls/,
    'one statement reads the newest version of both tables'
  );
  stored = 9;
  const before = db.statements.length;
  for (const refused of [
    () => budget.summary(scope),
    () => budget.configure(scope, { currency: 'USD', maxMicrosPerDay: 5000 }),
    () => budget.reserve(scope, 'r1', 'lease', 'c1', 100),
    () => budget.settle(scope, 'r1', 'lease', 'c1', 90),
    () => budget.reconcile(scope, 'r1', 'c1', 90)
  ])
    await assert.rejects(refused(), rolledBack);
  assert.equal(db.statements.slice(before).filter(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)).length, 0, 'a refused call writes nothing');
  assert.equal(marks.get(key), 12, 'a refusal never lowers the anchor');
  const unreadable = store(db, {
    versionAnchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.summary(scope), /Agent cost budget anchor unavailable/);
  assert.throws(() => store(db, { versionAnchor: {} }), /Invalid cost budget configuration/);
  assert.throws(() => store(db, { onAnchorError: 1 }), /Invalid cost budget configuration/);
});

test('TASK-047.4 configuring a budget draws its version in the same statement and advances the anchor; without an anchor the statement is unchanged', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-cost-budget', 'tenant', 'agent'),
    errors = [],
    db = fake(() => 0, 7);
  await store(db, { versionAnchor: anchor }).configure(scope, { currency: 'USD', maxMicrosPerDay: 5000 });
  const upsert = db.statements.find(sql => /^INSERT INTO app_mixer_agent_cost_budgets /.test(sql));
  assert.match(upsert, new RegExp(`max_micros_per_day=EXCLUDED.max_micros_per_day,version=nextval\\('${sequence}'\\) RETURNING version$`));
  assert.equal(marks.get(key), 7);
  await store(fake(() => 0, 8), {
    versionAnchor: {
      read: () => 0,
      advance: () => {
        throw Error('cannot write anchor');
      }
    },
    onAnchorError: error => errors.push(error.message)
  }).configure(scope, { currency: 'USD', maxMicrosPerDay: 5000 });
  assert.deepEqual(errors, ['cannot write anchor'], 'a change that committed is never undone by a failing anchor');
  const plain = fake();
  await store(plain).configure(scope, { currency: 'USD', maxMicrosPerDay: 5000 });
  assert.doesNotMatch(plain.statements.join('\n'), /version/, 'an unanchored budget keeps its statements');
});

test('TASK-047.4 PostgreSQL cost budget migrates existing tables and anchors every reservation and settlement', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'agent_cost_anchor_' + randomUUID().replaceAll('-', ''),
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
      key = agentAnchorKey('agent-cost-budget', 'tenant', 'agent'),
      runs = new PostgresAgentRuns({ enabled: true, query, transaction }),
      plain = new PostgresAgentCostBudget({ enabled: true, query, transaction }),
      budget = new PostgresAgentCostBudget({ enabled: true, query, transaction, versionAnchor: anchor }),
      newest = async table => Number((await query(`SELECT COALESCE(max(version),0) AS v FROM ${table}`)).rows[0].v),
      both = async () => Math.max(await newest('app_mixer_agent_cost_budgets'), await newest('app_mixer_agent_cost_calls'));
    await runs.initialize();
    await plain.initialize();
    await plain.configure(scope, { currency: 'USD', maxMicrosPerDay: 5000 });
    await budget.initialize(); // the existing budget gains its version
    await budget.initialize();
    assert.ok((await newest('app_mixer_agent_cost_budgets')) > 0);
    assert.equal((await budget.summary(scope)).limit, 5000);
    assert.equal(marks.get(key), await both(), 'the first check caught the anchor up');
    await budget.configure(scope, { currency: 'USD', maxMicrosPerDay: 6000 });
    assert.equal(marks.get(key), await both(), 'configure advances the anchor');
    const created = await runs.create(scope, 'r1', { definitionVersion: 1, maxAttempts: 3, deadline: Date.now() + 600000 }),
      claim = await runs.claim(scope, 'r1', created.revision, 'worker', 600000, { maxConcurrentRuns: 10 });
    await budget.reserve(scope, 'r1', claim.leaseToken, 'call-1', 400);
    assert.equal(marks.get(key), await both(), 'a reservation advances the anchor');
    assert.ok((await newest('app_mixer_agent_cost_calls')) > 0);
    await budget.settle(scope, 'r1', claim.leaseToken, 'call-1', 350);
    assert.equal(marks.get(key), await both(), 'a settlement advances the anchor');
    assert.equal((await budget.summary(scope)).committed, 350);
    // A restored ledger: the call versions are older than the anchor, so the forgotten spend is not served as free.
    await query('UPDATE app_mixer_agent_cost_calls SET version=1');
    await query('UPDATE app_mixer_agent_cost_budgets SET version=1');
    await assert.rejects(budget.summary(scope), rolledBack);
    await assert.rejects(budget.reserve(scope, 'r1', claim.leaseToken, 'call-2', 100), rolledBack);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
