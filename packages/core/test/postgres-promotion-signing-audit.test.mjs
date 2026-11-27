import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { ApplicationStore, PostgresPromotionSigningAudit, SqlitePromotionSigningAudit, createPostgresAuditedPromotionSigner, createPromotionPackage, signPromotionPackage } from '../dist/index.js';

// TASK-046: the signing audit is a trust domain separate from the signing key. Three database roles model it: the operator owns the audit, the
// release service may only append through the function and read, and a stranger holding nothing but the key is refused by PostgreSQL itself.
const url = process.env.APP_MIXER_TEST_POSTGRES_URL,
  GENESIS = '0'.repeat(64),
  definition = { id: 'demo', schemaVersion: 1, revision: 0, pages: [] },
  actor = { tenantId: 'tenant', principalId: 'release-bot' };
const importRecord = (signed, overrides = {}) => ({
  applicationId: 'demo',
  sourceEnvironment: signed.package.sourceEnvironment,
  sourceVersion: signed.package.sourceVersion,
  packageDigest: signed.package.digest,
  targetEnvironment: signed.targetEnvironment,
  evidence: { keyId: signed.keyId, signature: signed.signature, expectedVersion: signed.expectedVersion, signerPrincipal: signed.signerPrincipal },
  ...overrides
});

test('the shared PostgreSQL signing audit is a trust domain separate from the signing key', { skip: !url, timeout: 90000 }, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
    schema = `app_mixer_signing_${suffix}`,
    roles = { operator: `app_mixer_signing_op_${suffix}`, service: `app_mixer_signing_svc_${suffix}`, stranger: `app_mixer_signing_key_${suffix}` },
    admin = new pg.Pool({ connectionString: url }),
    pools = [];
  const as = role => {
    const connection = new URL(url);
    connection.username = role;
    connection.password = 'signing-test';
    const pool = new pg.Pool({ connectionString: connection.toString(), options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  };
  const dir = mkdtempSync(join(tmpdir(), 'app-mixer-signing-'));
  let now = 1000;
  const clock = () => now++;
  try {
    for (const name of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const name of Object.values(roles)) await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD 'signing-test'`);
    // Every role can see the schema, as in a public schema: what stops a key holder is the privilege on the function and the table, not the schema.
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles.operator}","${roles.service}","${roles.stranger}"`);
    await admin.query(`GRANT CREATE ON SCHEMA "${schema}" TO "${roles.operator}"`);
    // Provision with the operator's connection; the service's role is granted the one thing it may do.
    const operatorPool = as(roles.operator),
      servicePool = as(roles.service),
      strangerPool = as(roles.stranger),
      operator = new PostgresPromotionSigningAudit({ query: (sql, args) => operatorPool.query(sql, args) }),
      service = new PostgresPromotionSigningAudit({ clock, query: (sql, args) => servicePool.query(sql, args) }),
      stranger = new PostgresPromotionSigningAudit({ clock, query: (sql, args) => strangerPool.query(sql, args) });
    await assert.rejects(operator.initialize({ appendRole: 'not a role' }), /Invalid promotion signing audit provisioning/);
    await operator.initialize({ appendRole: roles.service });
    const { privateKey } = generateKeyPairSync('ed25519'),
      source = new ApplicationStore(definition);
    source.publish(0);
    const pkg = createPromotionPackage('dev', source.getPublished()),
      signed = signPromotionPackage(structuredClone(pkg), 'prod', 'release', privateKey, 0, 'release-bot');
    assert.deepEqual(await service.head(), { sequence: 0, hash: GENESIS });
    assert.deepEqual(await service.verify(), { valid: true, head: { sequence: 0, hash: GENESIS } });
    // A party holding only the key can sign, but cannot make the audit say so: without the credential the function refuses it.
    await assert.rejects(stranger.record(actor, signed), /permission denied for function/);
    // Neither the service nor the stranger may write the table directly, change it, or remove its protection; the service appends only through the function.
    for (const sql of [
      "INSERT INTO app_mixer_promotion_signing_audit VALUES (1,'0','1','tenant','release-bot','demo','dev',1,'0','prod','release',0,'release-bot','x','0')",
      'UPDATE app_mixer_promotion_signing_audit SET source_version=9 WHERE sequence=1',
      'DELETE FROM app_mixer_promotion_signing_audit WHERE sequence=1',
      'TRUNCATE app_mixer_promotion_signing_audit'
    ]) {
      await assert.rejects(servicePool.query(sql), /permission denied/);
      await assert.rejects(strangerPool.query(sql), /permission denied/);
    }
    await assert.rejects(servicePool.query('DROP TRIGGER app_mixer_promotion_signing_audit_no_change ON app_mixer_promotion_signing_audit'), /must be owner/);
    await assert.rejects(servicePool.query('DROP TABLE app_mixer_promotion_signing_audit'), /must be owner/);
    // The service records through the append function, and the entry equals what the SQLite audit records for the same signature.
    const signer = createPostgresAuditedPromotionSigner({ audit: service, actor, keyId: 'release', privateKey, signerPrincipal: 'release-bot' }),
      first = await signer(structuredClone(pkg), 'prod', 0),
      entry = (await service.list())[0];
    assert.equal(first.signature, signed.signature);
    assert.equal(entry.sequence, 1);
    assert.equal(entry.previousHash, GENESIS);
    assert.equal(entry.signature, signed.signature);
    assert.equal(entry.signerPrincipal, 'release-bot');
    assert.equal(entry.expectedVersion, 0);
    assert.equal(entry.packageDigest, pkg.digest);
    assert.deepEqual([entry.tenantId, entry.principalId], ['tenant', 'release-bot']);
    // The operator's own updates and deletes are stopped by the trigger; only dropping the trigger, which the operator may do, gets past it.
    await assert.rejects(operatorPool.query('UPDATE app_mixer_promotion_signing_audit SET source_version=9 WHERE sequence=1'), /append-only/);
    await assert.rejects(operatorPool.query('DELETE FROM app_mixer_promotion_signing_audit WHERE sequence=1'), /append-only/);
    assert.equal((await service.head()).sequence, 1);
    const sqlite = new SqlitePromotionSigningAudit(join(dir, 'audit.sqlite'), { clock: () => entry.recordedAt });
    try {
      sqlite.record(actor, first);
      assert.deepEqual(sqlite.list()[0], entry);
    } finally {
      sqlite.close();
    }
    // Two signatures recorded at once still chain in order: the function serialises appends and numbers them itself.
    source.apply(0, [{ op: 'addPage', page: { id: 'home', title: 'Home', route: '/', components: [] } }]);
    source.publish(1);
    const second = createPromotionPackage('dev', source.getPublished()),
      recorded = await Promise.all([signer(structuredClone(second), 'prod', 1), signer(structuredClone(second), 'staging', 1)]);
    const head = await service.head();
    assert.equal(head.sequence, 3);
    assert.deepEqual(await service.verify(), { valid: true, head });
    assert.deepEqual(
      (await service.list({ after: 1 })).map(item => item.signature),
      recorded.map(item => item.signature)
    );
    assert.deepEqual(await operator.verify({ sequence: 1, hash: entry.hash }), { valid: true, head });
    assert.equal((await operator.verify({ sequence: 1, hash: 'f'.repeat(64) })).error, 'Checkpoint mismatch at 1');
    assert.equal((await operator.verify({ sequence: 9, hash: 'f'.repeat(64) })).error, 'Checkpoint not found');
    // The stranger cannot even read the log.
    await assert.rejects(stranger.verify(), /permission denied|does not exist/);
    // A signature made with the key outside the service stays missing: the stranger could not record it, and a recorded signature claimed for
    // another target is a mismatch.
    const rogue = signPromotionPackage(structuredClone(second), 'prod', 'release', privateKey, 2, 'release-bot'),
      recordedImport = importRecord(recorded[0]);
    assert.deepEqual(await service.findUnaudited([recordedImport, importRecord(rogue), importRecord(recorded[0], { targetEnvironment: 'staging' })]), [
      { index: 1, reason: 'missing' },
      { index: 2, reason: 'mismatch' }
    ]);
    assert.deepEqual(await service.findUnaudited([]), []);
    // Validation is the JavaScript audit's, and the signer configuration is checked before any signature is made.
    await assert.rejects(service.record({ ...actor, tenantId: '../x' }, first), /Invalid promotion signing audit entry/);
    await assert.rejects(service.record(actor, { ...first, signature: 'short' }), /Invalid/);
    await assert.rejects(service.list({ limit: 1001 }), /Invalid promotion signing audit query/);
    await assert.rejects(service.verify({ sequence: 1, hash: 'nope' }), /Invalid promotion signing audit checkpoint/);
    await assert.rejects(service.findUnaudited([{ ...recordedImport, evidence: { signature: 'short' } }]), /Invalid promotion import records/);
    assert.throws(() => createPostgresAuditedPromotionSigner({ audit: {}, actor, keyId: 'release', privateKey }), /Invalid audited promotion signer/);
    assert.throws(() => new PostgresPromotionSigningAudit({ query: null }), /Invalid promotion signing audit configuration/);
    await assert.rejects(signer(structuredClone(pkg), 'prod'), /requires a target version/);
    assert.equal((await service.head()).sequence, 3);
    // Provisioning again is idempotent and keeps the entries.
    await operator.initialize({ appendRole: roles.service });
    assert.deepEqual(await service.verify(), { valid: true, head });
  } finally {
    for (const pool of pools) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const name of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
