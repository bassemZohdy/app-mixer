// Characterizes what restoring an OLDER PostgreSQL backup silently undoes (P3-03, P3-04 "rollback protection"). The stores keep no
// anchor outside their own database, so a restored database looks internally consistent. This test records the current behaviour so
// that the operator guidance in docs/kubernetes-data-plane.md stays true: when any of these assertions starts to fail, a store gained
// rollback detection and the guidance should be updated. Opt-in: APP_MIXER_TEST_POSTGRES_RESTORE=docker (one PostgreSQL container).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresJwtRevocations, PostgresPublicationReleaseRegistry, PostgresExtensionApprovals, PostgresCapabilityAudit, createFileSequenceAnchor, capabilityAuditAnchorKey } from '../dist/index.js';
import { PostgresOfflineRequestKeys, PostgresOfflineSlots, PostgresOfflineExecutions, PostgresOfflineRecovery, offlineRecoveryAnchorKey } from '../dist/index.js';

const run = promisify(execFile),
  enabled = process.env.APP_MIXER_TEST_POSTGRES_RESTORE === 'docker',
  image = 'pgvector/pgvector:0.8.7-pg16',
  password = 'restore-test-only';
const docker = (...args) => run('docker', args, { maxBuffer: 10 ** 7 }).then(result => result.stdout.trim());
const issuer = 'https://identity.example.test/',
  claims = jti => ({ iss: issuer, jti }),
  release = { tenantId: 'tenant', applicationId: 'app', environment: 'prod' },
  digestOf = version => String(version).padStart(64, '0');
const admin = { tenantId: 'tenant', principalId: 'admin' },
  approvalScope = { tenantId: 'tenant', applicationId: 'demo' },
  reference = { id: 'example.report', version: '1.0.0', scope: 'application' },
  operation = { extensionId: 'example.report', kind: 'tool', name: 'lookup' };
async function waitFor(description, check, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await delay(500);
  }
  throw Error(`Timed out waiting for ${description}`);
}

let auditAnchorDirectory;
test(
  "restoring an older backup silently undoes revocations, release floors, approval revocations, audit sequences and the offline stores' acknowledgements",
  { skip: !enabled && 'set APP_MIXER_TEST_POSTGRES_RESTORE=docker to run', timeout: 240000 },
  async t => {
    const name = 'am-restore-' + randomUUID().slice(0, 8);
    let pool;
    const psql = (sql, database = 'postgres') => docker('exec', '-u', 'postgres', name, 'psql', '-U', 'postgres', '-d', database, '-Atc', sql);
    try {
      await docker('run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=' + password, '-p', '127.0.0.1::5432', image);
      await waitFor('PostgreSQL', () => docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'));
      await psql('CREATE DATABASE app');
      const port = Number((await docker('port', name, '5432/tcp')).split('\n')[0].split(':').pop());
      const connect = () => new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'app', max: 2 });
      pool = connect();
      let now = 1700000000000;
      const query = (sql, args) => pool.query(sql, args);
      const revocations = new PostgresJwtRevocations({ issuer, clock: () => now, query }),
        releases = new PostgresPublicationReleaseRegistry({ query }),
        approvals = new PostgresExtensionApprovals({ query, clock: () => now, authorize: () => true }),
        audit = new PostgresCapabilityAudit({ clock: () => now, query });
      // A floor held outside the database (here a map; in production platform secure storage or a separate service).
      const held = new Map(),
        anchored = new PostgresPublicationReleaseRegistry({
          query,
          floorAnchor: {
            read: scope => held.get(scope.tenantId) ?? 0,
            advance: (scope, floor) => {
              held.set(scope.tenantId, Math.max(held.get(scope.tenantId) ?? 0, floor));
            }
          }
        });
      const marks = new Map(),
        mapAnchor = {
          read: key => marks.get(key) ?? 0,
          advance: (key, value) => {
            marks.set(key, Math.max(marks.get(key) ?? 0, value));
          }
        };
      const anchoredRevocations = new PostgresJwtRevocations({ issuer, clock: () => now, query, epochAnchor: mapAnchor }),
        anchoredApprovals = new PostgresExtensionApprovals({ query, clock: () => now, authorize: () => true, epochAnchor: mapAnchor });
      const anchoredAudit = new PostgresCapabilityAudit({
        clock: () => now,
        query,
        sequenceAnchor: createFileSequenceAnchor((auditAnchorDirectory = mkdtempSync(join(tmpdir(), 'restore-audit-anchor-'))))
      });
      const event = n => ({ invocationId: 'invocation-' + n, operationId: 'write', tenantId: 'tenant', principalId: 'user', outcome: 'attempt' });
      // TASK-051: the server side of the offline feature. A device's request key, its execution and the operator's reconciliation of an
      // ambiguous outcome are all acknowledgements the device or the operator relies on; a slot reset fences a stale generation.
      const offlineScope = { tenantId: 'tenant', applicationId: 'app' },
        device = 'device-1',
        keys = new PostgresOfflineRequestKeys({ query }),
        slots = new PostgresOfflineSlots({ query, requestKeys: keys }),
        executions = new PostgresOfflineExecutions({ query, requestKeys: keys }),
        recovery = new PostgresOfflineRecovery({ query, authorize: () => true, clock: () => now }),
        // TASK-052.1: the same store with an event anchor held outside the database (ADR 0013).
        anchoredRecovery = new PostgresOfflineRecovery({ query, authorize: () => true, clock: () => now, eventAnchor: mapAnchor }),
        operator = { tenantId: 'tenant', principalId: 'operator' },
        payload = { n: 1 };
      let dispatches = 0;
      const dispatch = async value => {
        dispatches++;
        return { ok: value.n };
      };
      await Promise.all([revocations.initialize(), releases.initialize(), approvals.initialize(), audit.initialize()]);
      await Promise.all([keys.initialize(), slots.initialize(), executions.initialize(), recovery.initialize()]);
      // State A: what the backup captures.
      await anchoredRevocations.revoke('revoked-in-backup', now + 3600000);
      for (const version of [1, 2, 3, 4]) await releases.register(release, version, digestOf(version));
      await releases.advanceFloor(release, 3);
      await anchoredApprovals.decide(admin, approvalScope, reference, operation, { allowed: true, expiresAt: now + 3600000, expectedRevision: 0 });
      for (const n of [1, 2, 3]) await audit.record(event(n));
      // State A, offline: a request key with a completed execution, a second key whose execution ended uncertain, and a slot with its first request key.
      const keyA = await keys.allocate(offlineScope, device, 'save', 'request-a', payload),
        keyU = await keys.allocate(offlineScope, device, 'save', 'request-u', payload),
        slotKeyA = await slots.open(offlineScope, device, 'form-1');
      assert.deepEqual(await executions.execute(offlineScope, device, 'save', payload, keyA, dispatch), { ok: 1 });
      await assert.rejects(
        executions.execute(offlineScope, device, 'save', payload, keyU, async () => {
          throw Error('provider timed out');
        }),
        /outcome uncertain/
      );
      const uncertain = await executions.get(offlineScope, device, keyU);
      assert.equal(uncertain?.status, 'uncertain');
      await docker('exec', '-u', 'postgres', name, 'sh', '-c', 'pg_dump -U postgres -Fc app > /tmp/backup.dump');
      // State B: acknowledged after the backup.
      await anchoredRevocations.revoke('revoked-after-backup', now + 3600000);
      await anchored.advanceFloor(release, 4);
      await anchoredApprovals.decide(admin, approvalScope, reference, operation, { allowed: false, expiresAt: 0, expectedRevision: 1 });
      for (const n of [4, 5]) await anchoredAudit.record(event(n));
      // State B, offline: a new request key is issued and executed, the ambiguous outcome is reconciled as not applied, and the slot is reset.
      const keyB = await keys.allocate(offlineScope, device, 'save', 'request-b', payload),
        slotKeyB = await slots.reset(offlineScope, device, 'form-1', slotKeyA);
      assert.deepEqual(await executions.execute(offlineScope, device, 'save', payload, keyB, dispatch), { ok: 1 });
      await anchoredRecovery.reconcile(
        operator,
        { scope: offlineScope, principalId: device, idempotencyKey: keyU },
        uncertain.attemptToken,
        { outcome: 'not_applied' },
        'provider console: request-u was never received'
      );
      assert.equal(dispatches, 2);
      assert.equal(await keys.verify(offlineScope, device, 'save', payload, keyB), true);
      assert.equal((await executions.get(offlineScope, device, keyB))?.status, 'succeeded');
      assert.equal((await executions.get(offlineScope, device, keyU))?.status, 'ready');
      assert.equal((await recovery.history(operator, { scope: offlineScope, principalId: device, idempotencyKey: keyU })).items.length, 1);
      assert.notEqual(slotKeyB, slotKeyA);
      assert.equal(await slots.open(offlineScope, device, 'form-1'), slotKeyB);
      assert.equal(await revocations.isTokenActive(claims('revoked-after-backup')), false);
      assert.equal(await releases.isAllowed(release, 3, digestOf(3)), false);
      assert.equal(await approvals.isAllowed(admin, approvalScope, reference, operation), false);
      assert.deepEqual(
        (await audit.list('tenant')).map(row => row.sequence),
        [1, 2, 3, 4, 5]
      );
      // Restore the older backup over the live database, as a recovery from a backup would.
      await pool.end();
      await psql('DROP DATABASE app WITH (FORCE)');
      await psql('CREATE DATABASE app');
      await docker('exec', '-u', 'postgres', name, 'pg_restore', '-U', 'postgres', '-d', 'app', '/tmp/backup.dump');
      pool = connect();
      const outcome = {
        revokedAfterBackupActiveAgain: await revocations.isTokenActive(claims('revoked-after-backup')),
        revokedInBackupStillRevoked: !(await revocations.isTokenActive(claims('revoked-in-backup'))),
        releaseBelowOldFloorAllowedAgain: await releases.isAllowed(release, 3, digestOf(3)),
        revokedApprovalAllowedAgain: await approvals.isAllowed(admin, approvalScope, reference, operation),
        auditSequences: (await audit.list('tenant')).map(row => row.sequence)
      };
      const offlineTarget = { scope: offlineScope, principalId: device, idempotencyKey: keyU },
        offline = {
          keyIssuedAfterBackupKnown: await keys.verify(offlineScope, device, 'save', payload, keyB),
          executionAfterBackup: (await executions.get(offlineScope, device, keyB))?.status ?? 'forgotten',
          reconciledOutcome: (await executions.get(offlineScope, device, keyU))?.status,
          recoveryEvents: (await recovery.history(operator, offlineTarget)).items.map(item => item.action),
          slotKeyAfterBackupResetStillCurrent: (await slots.open(offlineScope, device, 'form-1')) === slotKeyB,
          slotKeyBeforeResetValidAgain: (await slots.open(offlineScope, device, 'form-1')) === slotKeyA,
          // The pre-backup execution still deduplicates: replaying it returns the stored result without dispatching again.
          keyBeforeBackupStillDeduplicated: JSON.stringify(await executions.execute(offlineScope, device, 'save', payload, keyA, dispatch)) === JSON.stringify({ ok: 1 }) && dispatches === 2
        };
      // A replay of the post-backup request is refused rather than re-executed, because its key is gone too; the device would have to start over with a new key.
      await assert.rejects(executions.execute(offlineScope, device, 'save', payload, keyB, dispatch), /forbidden/);
      offline.replayOfForgottenRequestRefused = dispatches === 2;
      // With the floor anchored outside the database, the restore is detected and the check fails closed instead of allowing the release.
      await assert.rejects(anchored.isAllowed(release, 3, digestOf(3)), /Release floor was rolled back/);
      // Revocations and approvals with an outside epoch refuse to answer instead of re-activating the token or re-granting the approval.
      await assert.rejects(anchoredRevocations.isTokenActive(claims('revoked-after-backup')), /Revocations were rolled back/);
      await assert.rejects(anchoredApprovals.isAllowed(admin, approvalScope, reference, operation), /Extension approvals were rolled back/);
      // The audit sink with an outside high-water mark also refuses: recording would have reused sequence 4.
      await assert.rejects(anchoredAudit.record(event(6)), /Audit log was rolled back/);
      // TASK-052.1: with an event anchor the recovery store refuses instead of letting the uncertain outcome be reconciled again unseen.
      const recoveryTarget = { scope: offlineScope, principalId: device, idempotencyKey: keyU };
      await assert.rejects(anchoredRecovery.history(operator, recoveryTarget), /Offline recovery was rolled back/);
      await assert.rejects(anchoredRecovery.reconcile(operator, recoveryTarget, uncertain.attemptToken, { outcome: 'not_applied' }, 'again'), /Offline recovery was rolled back/);
      assert.equal((await executions.get(offlineScope, device, keyU))?.status, 'uncertain', 'the refused reconciliation changed nothing');
      t.diagnostic(JSON.stringify(outcome));
      t.diagnostic(JSON.stringify(offline));
      // Current behaviour: none of the stores notices that it went back in time.
      assert.equal(outcome.revokedAfterBackupActiveAgain, true, 'a token revoked after the backup is active again');
      assert.equal(outcome.revokedInBackupStillRevoked, true);
      assert.equal(outcome.releaseBelowOldFloorAllowedAgain, true, 'the release floor went back to the backup value');
      assert.equal(outcome.revokedApprovalAllowedAgain, true, 'an approval revoked after the backup is granted again');
      assert.deepEqual(outcome.auditSequences, [1, 2, 3], 'the audit log lost its last two events');
      // The offline stores rewind the same way: every acknowledgement given after the backup is gone, and nothing flags it.
      assert.equal(offline.keyIssuedAfterBackupKnown, false, 'a request key issued after the backup is unknown again');
      assert.equal(offline.executionAfterBackup, 'forgotten', 'the execution that completed after the backup is forgotten');
      assert.equal(offline.reconciledOutcome, 'uncertain', 'an outcome reconciled after the backup is uncertain again');
      assert.deepEqual(offline.recoveryEvents, [], 'the reconciliation evidence recorded after the backup is gone');
      assert.equal(offline.slotKeyAfterBackupResetStillCurrent, false, 'a slot reset after the backup is undone');
      assert.equal(offline.slotKeyBeforeResetValidAgain, true, 'the request key the reset retired is valid again');
      assert.equal(offline.keyBeforeBackupStillDeduplicated, true, 'an execution completed before the backup still deduplicates');
      assert.equal(offline.replayOfForgottenRequestRefused, true, 'a replay of the forgotten request is refused, not executed twice, because its key is gone too');
      await audit.record(event(6));
      assert.deepEqual(
        (await audit.list('tenant')).map(row => row.sequence),
        [1, 2, 3, 4],
        'sequence 4 is reused for a different event, with no sign of the gap'
      );
      // Recovery as documented: re-apply the lost state through the anchored write paths and the refusals clear by themselves.
      await anchored.advanceFloor(release, 4);
      assert.equal(await anchored.isAllowed(release, 4, digestOf(4)), true, 'the floor is back at its real value');
      assert.equal(await anchored.isAllowed(release, 3, digestOf(3)), false, 'a release below the real floor is refused again');
      await anchoredRevocations.revoke('revoked-after-backup', now + 3600000);
      assert.equal(await anchoredRevocations.isTokenActive(claims('revoked-after-backup')), false, 'the re-applied revocation is in force and the epoch caught up');
      assert.equal(await anchoredRevocations.isTokenActive(claims('revoked-in-backup')), false);
      assert.equal(await anchoredRevocations.isTokenActive(claims('never-revoked')), true);
      await anchoredApprovals.decide(admin, approvalScope, reference, operation, { allowed: false, expiresAt: 0, expectedRevision: 1 });
      assert.equal(await anchoredApprovals.isAllowed(admin, approvalScope, reference, operation), false, 'the re-applied approval revocation is in force');
      // The lost audit events cannot be re-applied, so the operator lowers that anchor deliberately with the tool, which demands a flag and a reason.
      const adminTool = fileURLToPath(new URL('../../../scripts/anchor-admin.mjs', import.meta.url)),
        auditFile = capabilityAuditAnchorKey('tenant') + '.sequence';
      const refused = spawnSync(process.execPath, [adminTool, auditAnchorDirectory, 'set', auditFile, '4'], { encoding: 'utf8' });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /without --allow-lower/);
      await assert.rejects(anchoredAudit.record(event(7)), /Audit log was rolled back/, 'still refusing until the anchor is lowered');
      const lowered = spawnSync(
        process.execPath,
        [adminTool, auditAnchorDirectory, 'set', auditFile, '4', '--allow-lower', '--reason', 'Restored from backup; events 4 and 5 were lost and are noted in the incident record'],
        { encoding: 'utf8' }
      );
      assert.equal(lowered.status, 0, lowered.stderr);
      await anchoredAudit.record(event(7));
      assert.deepEqual(
        (await audit.list('tenant')).map(row => row.sequence),
        [1, 2, 3, 4, 5],
        'recording resumes after the deliberate reset'
      );
    } finally {
      await pool?.end().catch(() => {});
      await docker('rm', '-fv', name).catch(() => {});
      if (auditAnchorDirectory) rmSync(auditAnchorDirectory, { recursive: true, force: true });
    }
  }
);
