// TASK-047.2.3: the action journal of the PostgreSQL run registry shares its version stream, so a restored journal is refused (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentRuns } from '../dist/index.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const scope = { tenantId: 'tenant', agentId: 'agent' },
  config = () => ({ definitionVersion: 1, maxAttempts: 3, deadline: Date.now() + 600000 }),
  mapAnchor = () => {
    const marks = new Map();
    return { marks, anchor: { read: key => marks.get(key) ?? 0, advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value)) } };
  };

function fake(storedVersion = () => 0) {
  const statements = [],
    query = async (sql, args) => {
      statements.push(sql);
      if (/max\(version\)/i.test(sql)) return { rows: [{ stored: String(storedVersion()) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}

test('TASK-047.2.3 an anchored registry adds the version column and index to the action table; an unanchored one does not', async () => {
  const anchored = fake(),
    plain = fake();
  await new PostgresAgentRuns({ enabled: true, query: anchored.query, transaction: anchored.transaction, versionAnchor: mapAnchor().anchor }).initialize();
  const sql = anchored.statements.join('\n');
  assert.match(sql, /ALTER TABLE app_mixer_agent_actions ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval\('app_mixer_agent_run_version'\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS app_mixer_agent_actions_newest ON app_mixer_agent_actions\s*\(tenant_id,agent_id,version\)/);
  await new PostgresAgentRuns({ enabled: true, query: plain.query, transaction: plain.transaction }).initialize();
  assert.doesNotMatch(plain.statements.join('\n'), /app_mixer_agent_actions_newest|ALTER TABLE app_mixer_agent_actions/);
});

test('TASK-047.2.3 the journal refuses once the newest version of the runs and actions is behind the anchor, and the check covers both tables', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-runs', 'tenant', 'agent');
  let stored = 12;
  const db = fake(() => stored),
    runs = new PostgresAgentRuns({ enabled: true, query: db.query, transaction: db.transaction, versionAnchor: anchor }),
    journal = runs.journal(scope, 'r1', 'lease-token');
  assert.equal(await journal.get('a'), undefined);
  assert.equal(marks.get(key), 12);
  assert.match(
    db.statements.find(sql => /max\(version\)/i.test(sql)),
    /app_mixer_agent_runs[\s\S]*app_mixer_agent_actions/,
    'one statement reads the newest version of both tables'
  );
  stored = 9;
  const before = db.statements.length;
  await assert.rejects(journal.get('a'), /Agent runs were rolled back/);
  await assert.rejects(journal.unresolved(), /Agent runs were rolled back/);
  await assert.rejects(
    journal.invoke('a', 'send', { n: 1 }, 3, async () => ({ ok: true })),
    /Agent runs were rolled back/
  );
  await assert.rejects(journal.markUncertain('a'), /Agent runs were rolled back/);
  await assert.rejects(
    journal.reconcileWith('a', async () => ({ outcome: 'unknown' })),
    /Agent runs were rolled back/
  );
  assert.equal(db.statements.slice(before).filter(sql => /^(INSERT|UPDATE) /.test(sql)).length, 0, 'a refused call writes nothing');
  assert.equal(marks.get(key), 12, 'a refusal never lowers the anchor');
});

test(
  'TASK-047.2.3 PostgreSQL action journal migrates an existing table and anchors every action change on the run stream',
  { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 },
  async () => {
    const schema = 'agent_actions_anchor_' + randomUUID().replaceAll('-', ''),
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
      const first = await plain.create(scope, 'before', config()),
        lease = await plain.claim(scope, 'before', first.revision, 'worker', 600000, { maxConcurrentRuns: 10 });
      let dispatches = 0;
      const dispatch = async () => {
        dispatches++;
        return { ok: true };
      };
      await plain.journal(scope, 'before', lease.leaseToken).invoke('old', 'send', { n: 0 }, 3, dispatch);
      await anchored.initialize(); // the existing run and action gain their versions
      await anchored.initialize();
      const newest = async table => Number((await query(`SELECT COALESCE(max(version),0) AS v FROM ${table}`)).rows[0].v);
      assert.ok((await newest('app_mixer_agent_actions')) > 0);
      const journal = anchored.journal(scope, 'before', lease.leaseToken);
      assert.equal((await journal.get('old')).status, 'succeeded');
      assert.equal(marks.get(key), Math.max(await newest('app_mixer_agent_runs'), await newest('app_mixer_agent_actions')), 'the first check caught the anchor up across both tables');
      await journal.invoke('new', 'send', { n: 1 }, 3, dispatch);
      const actionsNewest = await newest('app_mixer_agent_actions');
      assert.equal(marks.get(key), actionsNewest, 'insert, dispatching and success each drew a version; the anchor holds the last');
      assert.ok(actionsNewest > (await newest('app_mixer_agent_runs')), 'the run stream advanced through the action table');
      // A restored action table (older versions) is refused, and a run read is refused too because they share the anchor.
      await query('UPDATE app_mixer_agent_actions SET version=1');
      await assert.rejects(journal.get('new'), /Agent runs were rolled back/);
      await assert.rejects(anchored.get(scope, 'before'), /Agent runs were rolled back/);
      assert.equal(dispatches, 2);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }
);
