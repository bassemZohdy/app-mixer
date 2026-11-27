// TASK-047.3: the PostgreSQL memory store with a version anchor held outside the database, so an erasure cannot be undone by a restore (ADR 0014).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAgentMemory } from '../dist/index.js';
import { agentAnchorKey } from '../../shared/dist/index.js';

const actor = { tenantId: 'tenant', principalId: 'admin' },
  scope = { kind: 'semantic', tenantId: 'tenant', agentId: 'agent', owner: { kind: 'organization', id: 'org' } },
  provenance = { kind: 'run', id: 'run' },
  keep = () => ({ expiresAt: Date.now() + 60000, provenance }),
  sequence = 'app_mixer_agent_memory_version',
  rolledBack = /Agent memory was rolled back/,
  mapAnchor = () => {
    const marks = new Map();
    return { marks, anchor: { read: key => marks.get(key) ?? 0, advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value)) } };
  };

// A database whose newest memory version is `storedVersion()`; every statement is recorded and a write returns the versions it drew.
function fake(storedVersion = () => 0, drawn = [11]) {
  const statements = [],
    query = async (sql, args) => {
      statements.push(sql);
      if (/max\(version\)/i.test(sql)) {
        assert.deepEqual(args, ['tenant', 'agent']);
        return { rows: [{ stored: String(storedVersion()) }], rowCount: 1 };
      }
      if (/FOR UPDATE/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/COUNT\(\*\) AS history/.test(sql)) return { rows: [{ history: '0', live: '0' }], rowCount: 1 };
      if (/COUNT\(\*\) AS count/.test(sql)) return { rows: [{ count: '0' }], rowCount: 1 };
      if (/^INSERT INTO app_mixer_agent_memories /.test(sql)) return { rows: [{ version: String(drawn.at(-1)) }], rowCount: 1 };
      if (/^UPDATE app_mixer_agent_memories /.test(sql)) return { rows: drawn.map((version, index) => ({ memory_id: 'k' + index, version: String(version) })), rowCount: drawn.length };
      return { rows: [], rowCount: 0 };
    };
  return { statements, query, transaction: operation => operation(query) };
}
const store = (db, extra = {}) =>
  new PostgresAgentMemory({ enabled: true, maxEntries: 5, maxTtlMs: 3600000, authorize: () => true, audit: true, textIndex: true, query: db.query, transaction: db.transaction, ...extra });

test('TASK-047.3 an anchored memory store adds its version column and index on initialize; one without an anchor does not', async () => {
  const anchored = fake(),
    plain = fake();
  await store(anchored, { versionAnchor: mapAnchor().anchor }).initialize();
  const sql = anchored.statements.join('\n');
  assert.match(sql, new RegExp(`CREATE SEQUENCE IF NOT EXISTS ${sequence}`));
  assert.match(sql, new RegExp(`ALTER TABLE app_mixer_agent_memories ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval\\('${sequence}'\\)`));
  assert.match(sql, /CREATE INDEX IF NOT EXISTS app_mixer_agent_memories_newest ON app_mixer_agent_memories\s*\(tenant_id,agent_id,version\)/);
  await store(plain).initialize();
  assert.doesNotMatch(plain.statements.join('\n'), /SEQUENCE|app_mixer_agent_memories_newest|\bversion BIGINT/);
});

test('TASK-047.3 every answer and write of a restored memory store is refused, nothing is written, and an unreadable anchor fails closed', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-memory', 'tenant', 'agent');
  let stored = 20;
  const db = fake(() => stored),
    memory = store(db, { versionAnchor: anchor });
  assert.equal(await memory.get(actor, scope, 'k1'), undefined);
  assert.equal(marks.get(key), 20, 'a database ahead of the anchor catches it up');
  assert.match(
    db.statements.find(sql => /max\(version\)/i.test(sql)),
    /FROM app_mixer_agent_memories /
  );
  stored = 15;
  const before = db.statements.length;
  for (const refused of [
    () => memory.get(actor, scope, 'k1'),
    () => memory.list(actor, scope),
    () => memory.put(actor, scope, 'k1', 'v', { expectedRevision: null, ...keep() }),
    () => memory.delete(actor, scope, 'k1', 1),
    () => memory.purgeExpired(actor, scope),
    () => memory.eraseScope(actor, scope),
    () => memory.eraseScopeOnce(actor, scope, 'request-1'),
    () => memory.getErasureRequest(actor, scope, 'request-1'),
    () => memory.auditHistory(actor, scope),
    () => memory.searchSemanticText(actor, scope, 'text', 'model'),
    () => memory.verifySearchHits(actor, scope, [{ id: 'k1', revision: 1 }])
  ])
    await assert.rejects(refused(), rolledBack);
  assert.equal(db.statements.slice(before).filter(sql => /^(INSERT|UPDATE|DELETE) /.test(sql) && !/memory_scopes/.test(sql)).length, 0, 'a refused call writes no memory');
  assert.equal(marks.get(key), 20, 'a refusal never lowers the anchor');
  const unreadable = store(db, {
    versionAnchor: {
      read: () => {
        throw Error('disk gone');
      },
      advance: () => {}
    }
  });
  await assert.rejects(unreadable.get(actor, scope, 'k1'), /Agent memory anchor unavailable/);
  assert.throws(() => store(db, { versionAnchor: {} }), /Invalid memory configuration/);
  assert.throws(() => store(db, { onAnchorError: 1 }), /Invalid memory configuration/);
});

test('TASK-047.3 a write draws its version in the same statement and the anchor advances to the newest one it drew', async () => {
  const { marks, anchor } = mapAnchor(),
    key = agentAnchorKey('agent-memory', 'tenant', 'agent'),
    errors = [];
  const put = fake(() => 0, [9]),
    memory = store(put, { versionAnchor: anchor });
  await memory.put(actor, scope, 'k1', 'v', { expectedRevision: null, ...keep() });
  const insert = put.statements.find(sql => /^INSERT INTO app_mixer_agent_memories /.test(sql));
  assert.match(insert, new RegExp(`DO UPDATE SET .*deleted=FALSE,version=nextval\\('${sequence}'\\) RETURNING version$`));
  assert.equal(marks.get(key), 9);
  const erase = fake(() => 9, [10, 11, 12]);
  await store(erase, { versionAnchor: anchor }).eraseScope(actor, scope);
  assert.match(
    erase.statements.find(sql => /^UPDATE app_mixer_agent_memories /.test(sql)),
    new RegExp(`deleted=TRUE,version=nextval\\('${sequence}'\\) WHERE [\\s\\S]* RETURNING memory_id,version$`)
  );
  assert.equal(marks.get(key), 12, 'the newest of the versions drawn by one statement');
  const del = fake(() => 12, [13]);
  await store(del, { versionAnchor: anchor }).delete(actor, scope, 'k1', 1);
  assert.equal(marks.get(key), 13);
  const once = fake(() => 13, [14]);
  await store(once, { versionAnchor: anchor }).eraseScopeOnce(actor, scope, 'request-1');
  assert.equal(marks.get(key), 14);
  const purge = fake(() => 14, [15]);
  await store(purge, { versionAnchor: anchor }).purgeExpired(actor, scope);
  assert.equal(marks.get(key), 15);
  const broken = store(
    fake(() => 0, [20]),
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
  await broken.put(actor, scope, 'k2', 'v', { expectedRevision: null, ...keep() });
  assert.deepEqual(errors, ['cannot write anchor'], 'a write that committed is never undone by a failing anchor');
  const plain = fake(() => 0, [1]);
  await store(plain).put(actor, scope, 'k1', 'v', { expectedRevision: null, ...keep() });
  await store(plain).eraseScope(actor, scope);
  assert.doesNotMatch(plain.statements.join('\n'), /version/, 'an unanchored store keeps its statements');
});

test('TASK-047.3 PostgreSQL memory store migrates an existing table and refuses a rewound erasure', { skip: !process.env.APP_MIXER_TEST_POSTGRES_URL, timeout: 60000 }, async () => {
  const schema = 'agent_memory_anchor_' + randomUUID().replaceAll('-', ''),
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
      key = agentAnchorKey('agent-memory', 'tenant', 'agent'),
      options = { enabled: true, maxEntries: 5, maxTtlMs: 3600000, authorize: () => true, audit: true, query, transaction },
      plain = new PostgresAgentMemory(options),
      anchored = new PostgresAgentMemory({ ...options, versionAnchor: anchor }),
      newest = async () => Number((await query('SELECT COALESCE(max(version),0) AS v FROM app_mixer_agent_memories')).rows[0].v);
    await plain.initialize();
    await plain.put(actor, scope, 'old', 'v0', { expectedRevision: null, ...keep() });
    await anchored.initialize(); // the existing memory gains its version
    await anchored.initialize();
    assert.ok((await newest()) > 0);
    assert.equal((await anchored.get(actor, scope, 'old')).revision, 1);
    assert.equal(marks.get(key), await newest(), 'the first check caught the anchor up to the migrated memory');
    await anchored.put(actor, scope, 'k1', 'v1', { expectedRevision: null, ...keep() });
    assert.equal(marks.get(key), await newest(), 'put advances the anchor');
    await anchored.put(actor, scope, 'k1', 'v1b', { expectedRevision: 1, ...keep() });
    assert.equal(marks.get(key), await newest(), 'an update draws a new version too');
    await anchored.delete(actor, scope, 'k1', 2);
    assert.equal(marks.get(key), await newest());
    assert.equal(await anchored.eraseScope(actor, scope), 1, 'old is erased');
    const erased = await newest();
    assert.equal(marks.get(key), erased, 'erasure advances the anchor to the newest version it drew');
    assert.deepEqual((await anchored.list(actor, scope)).items, []);
    // A restored table: the versions are older than the anchor, so the erased memory is not served again.
    await query('UPDATE app_mixer_agent_memories SET version=1, revision=1, value=\'"v0"\', provenance=$1, expires_at=$2, deleted=FALSE', [JSON.stringify(provenance), Date.now() + 60000]);
    await assert.rejects(anchored.get(actor, scope, 'old'), rolledBack);
    await assert.rejects(anchored.list(actor, scope), rolledBack);
    await assert.rejects(anchored.put(actor, scope, 'k3', 'v', { expectedRevision: null, ...keep() }), rolledBack);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
