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
import { PostgresAgentDefinitions, PostgresAgentRuns, PostgresAgentMemory, PostgresAgentCostBudget, PostgresAgentSharedCost } from '../../agent/dist/index.js';
import { PostgresAgentTriggerFoundation } from '../../agent/dist/postgres/postgres-trigger-foundation.js';
import { PostgresAgentRunLifecycleFoundation } from '../../agent/dist/postgres/postgres-run-lifecycle-foundation.js';
import { PostgresAgentApprovalsFoundation } from '../../agent/dist/postgres/postgres-agent-approvals-foundation.js';
import { PostgresAgentDelegationsFoundation } from '../../agent/dist/postgres/postgres-agent-delegations-foundation.js';

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
        // TASK-052.2: the same store with a version anchor held outside the database (ADR 0013).
        anchoredExecutions = new PostgresOfflineExecutions({ query, requestKeys: keys, versionAnchor: mapAnchor }),
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
      // TASK-052.2: a database that already holds executions gains the version column when the anchored store initializes.
      await anchoredExecutions.initialize();
      await docker('exec', '-u', 'postgres', name, 'sh', '-c', 'pg_dump -U postgres -Fc app > /tmp/backup.dump');
      // State B: acknowledged after the backup.
      await anchoredRevocations.revoke('revoked-after-backup', now + 3600000);
      await anchored.advanceFloor(release, 4);
      await anchoredApprovals.decide(admin, approvalScope, reference, operation, { allowed: false, expiresAt: 0, expectedRevision: 1 });
      for (const n of [4, 5]) await anchoredAudit.record(event(n));
      // State B, offline: a new request key is issued and executed, the ambiguous outcome is reconciled as not applied, and the slot is reset.
      const keyB = await keys.allocate(offlineScope, device, 'save', 'request-b', payload),
        slotKeyB = await slots.reset(offlineScope, device, 'form-1', slotKeyA);
      assert.deepEqual(await anchoredExecutions.execute(offlineScope, device, 'save', payload, keyB, dispatch), { ok: 1 });
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
      // TASK-052.2: with a version anchor the executions store refuses instead of forgetting the execution and letting a device run it again.
      await assert.rejects(anchoredExecutions.get(offlineScope, device, keyB), /Offline executions were rolled back/);
      await assert.rejects(anchoredExecutions.execute(offlineScope, device, 'save', payload, keyA, dispatch), /Offline executions were rolled back/);
      assert.equal(dispatches, 2, 'the refused call dispatched nothing');
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

// TASK-047.1: the agent stores. Each one is written once before a backup and once after it; restoring the backup shows what each store
// forgets without noticing. None of them accepts an anchor yet (ADR 0014 decides which should), so this records the gap the anchors close.
test(
  'restoring an older backup silently undoes what the agent stores acknowledged: definitions, memory, budgets, actions, approvals and delegations',
  { skip: !enabled && 'set APP_MIXER_TEST_POSTGRES_RESTORE=docker to run', timeout: 240000 },
  async () => {
    const name = 'am-restore-agent-' + randomUUID().slice(0, 8);
    let pool;
    const psql = (sql, database = 'postgres') => docker('exec', '-u', 'postgres', name, 'psql', '-U', 'postgres', '-d', database, '-Atc', sql);
    // Always the current pool, so the stores keep working after the database is replaced.
    const transaction = async operation => {
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
      await docker('run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=' + password, '-p', '127.0.0.1::5432', image);
      await waitFor('PostgreSQL', () => docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'));
      await psql('CREATE DATABASE app');
      const port = Number((await docker('port', name, '5432/tcp')).split('\n')[0].split(':').pop());
      const connect = () => new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'app', max: 4 });
      pool = connect();
      const base = { query: (sql, args) => pool.query(sql, args), transaction },
        scope = { tenantId: 'tenant', agentId: 'agent' },
        actor = { tenantId: 'tenant', principalId: 'admin' },
        operator = { tenantId: 'tenant', principalId: 'operator' },
        service = { tenantId: 'tenant', principalId: 'service' },
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
        memoryScope = { kind: 'semantic', tenantId: 'tenant', agentId: 'agent', owner: { kind: 'organization', id: 'org' } },
        provenance = { kind: 'run', id: 'run' },
        keep = () => ({ expiresAt: Date.now() + 60000, provenance });
      const definitions = new PostgresAgentDefinitions({ enabled: true, ...base, authorize: () => true }),
        runs = new PostgresAgentRuns({ enabled: true, ...base }),
        memory = new PostgresAgentMemory({ enabled: true, maxEntries: 5, maxTtlMs: 3600000, authorize: () => true, ...base }),
        budget = new PostgresAgentCostBudget({ enabled: true, ...base }),
        triggers = new PostgresAgentTriggerFoundation(base),
        lifecycle = new PostgresAgentRunLifecycleFoundation(base),
        sharedCost = new PostgresAgentSharedCost({ enabled: true, scope: { tenantId: 'tenant', budgetId: 'cycle-1', currency: 'USD', maxMicros: 1000 }, ...base, authorize: () => true });
      for (const store of [definitions, runs, memory, budget, triggers, lifecycle, sharedCost]) await store.initialize();
      // TASK-047.2.2: the same run registry with a version anchor held outside the database (ADR 0014); initializing it adds the column to the existing runs.
      const marks = new Map(),
        anchoredRuns = new PostgresAgentRuns({
          enabled: true,
          ...base,
          versionAnchor: {
            read: key => marks.get(key) ?? 0,
            advance: (key, value) => marks.set(key, Math.max(marks.get(key) ?? 0, value))
          }
        });
      await anchoredRuns.initialize();
      // TASK-047.3: the definitions and the memory with their own anchors; the memory gains its version column.
      const anchorOf = () => {
          const held = new Map();
          return { held, anchor: { read: key => held.get(key) ?? 0, advance: (key, value) => held.set(key, Math.max(held.get(key) ?? 0, value)) } };
        },
        definitionMarks = anchorOf(),
        memoryMarks = anchorOf(),
        anchoredDefinitions = new PostgresAgentDefinitions({ enabled: true, ...base, authorize: () => true, versionAnchor: definitionMarks.anchor }),
        anchoredMemory = new PostgresAgentMemory({ enabled: true, maxEntries: 5, maxTtlMs: 3600000, authorize: () => true, ...base, versionAnchor: memoryMarks.anchor }),
        erasedScope = { ...memoryScope, owner: { kind: 'user', id: 'person' } };
      await anchoredDefinitions.initialize();
      await anchoredMemory.initialize();
      // TASK-047.4: the cost budget with its own anchor; its budgets and call ledger gain their version column.
      const budgetMarks = anchorOf(),
        anchoredBudget = new PostgresAgentCostBudget({ enabled: true, ...base, versionAnchor: budgetMarks.anchor });
      await anchoredBudget.initialize();
      // State A: what the backup captures.
      await definitions.save(actor, manifest('Operations'), 0);
      await memory.put(actor, memoryScope, 'k1', 'v1', { expectedRevision: null, ...keep() });
      await anchoredMemory.put(actor, erasedScope, 'e1', 'personal', { expectedRevision: null, ...keep() });
      await budget.configure(scope, { currency: 'USD', maxMicrosPerDay: 5000 });
      for (const id of ['r1', 'r2']) await runs.create(scope, id, { definitionVersion: 1, maxAttempts: 3, deadline: Date.now() + 600000 });
      const claim = await runs.claim(scope, 'r2', (await runs.get(scope, 'r2')).revision, 'worker', 600000, { maxConcurrentRuns: 100 });
      const { runId } = await triggers.enqueue(
        scope,
        { sourceId: 'manual', principalId: 'person', eventId: 'one', eventType: 'manual', payload: {} },
        { definitionVersion: 1, maxAttempts: 3, deadline: Date.now() + 600000, maxPending: 10 }
      );
      const sharedClaim = await lifecycle.claim(scope, runId, 1, 'worker', 30000, 10),
        approvals = new PostgresAgentApprovalsFoundation({ ...base, scope, runId, authorize: () => true }),
        delegations = new PostgresAgentDelegationsFoundation({ ...base, scope, runId, authorize: who => who.principalId === 'operator' });
      await approvals.initialize();
      await delegations.initialize();
      // TASK-047.4: approvals and delegations compare the newest id of their event tables.
      const approvalMarks = anchorOf(),
        delegationMarks = anchorOf(),
        anchoredApprovals = new PostgresAgentApprovalsFoundation({ ...base, scope, runId, authorize: () => true, versionAnchor: approvalMarks.anchor }),
        anchoredDelegations = new PostgresAgentDelegationsFoundation({ ...base, scope, runId, authorize: who => who.principalId === 'operator', versionAnchor: delegationMarks.anchor });
      await anchoredApprovals.initialize();
      await anchoredDelegations.initialize();
      const grant = { tenantId: 'tenant', agentId: 'agent', runId, grantId: 'grant', principalId: 'person', permissionVersion: 'v1', expiresAt: Date.now() + 300000 },
        issued = await delegations.issue(operator, grant);
      await sharedCost.reserve(operator, { agentId: 'agent', runId: 'run', callId: 'call-a' }, 100);
      await docker('exec', '-u', 'postgres', name, 'sh', '-c', 'pg_dump -U postgres -Fc app > /tmp/agent-backup.dump');
      // State B: acknowledged after the backup.
      let dispatches = 0;
      const dispatch = async () => {
        dispatches++;
        return { ok: true };
      };
      await anchoredDefinitions.save(actor, manifest('Operations v2'), 1);
      await memory.put(actor, memoryScope, 'k1', 'v1b', { expectedRevision: 1, ...keep() });
      await memory.put(actor, memoryScope, 'k2', 'v2', { expectedRevision: null, ...keep() });
      assert.equal(await anchoredMemory.eraseScope(actor, erasedScope), 1, 'the personal memory is erased after the backup');
      await anchoredBudget.reserve(scope, 'r2', claim.leaseToken, 'call-1', 400);
      await anchoredRuns.journal(scope, 'r2', claim.leaseToken).invoke('action-2', 'send', { n: 2 }, 3, async () => ({ ok: true }));
      await anchoredRuns.request(scope, 'r1', (await anchoredRuns.get(scope, 'r1')).revision, 'cancel');
      assert.equal((await anchoredRuns.get(scope, 'r1')).status, 'cancelled', 'a queued run cancelled after the backup');
      await runs.journal(scope, 'r2', claim.leaseToken).invoke('action-1', 'send', { n: 1 }, 3, dispatch);
      await anchoredApprovals.request(service, sharedClaim.leaseToken, 'approval-1', 'pay', { amount: 10 }, Date.now() + 30000);
      await anchoredDelegations.revoke(operator, 'grant', (await delegations.get(operator, 'grant')).revision);
      await sharedCost.reserve(operator, { agentId: 'agent', runId: 'run', callId: 'call-b' }, 200);
      assert.equal(dispatches, 1);
      assert.equal((await definitions.get(actor, 'agent')).version, 2);
      assert.equal((await memory.list(actor, memoryScope)).items.length, 2);
      assert.equal((await budget.summary(scope)).reserved, 400);
      assert.equal((await runs.journal(scope, 'r2', claim.leaseToken).get('action-1')).status, 'succeeded');
      assert.equal((await approvals.get(service, 'approval-1')).status, 'pending');
      assert.equal(await delegations.verify(operator, issued.grant), false, 'the grant is revoked');
      assert.equal((await sharedCost.summary(operator)).reservedMicros, 300);
      // Restore the older backup over the live database.
      await pool.end();
      await psql('DROP DATABASE app WITH (FORCE)');
      await psql('CREATE DATABASE app');
      await docker('exec', '-u', 'postgres', name, 'pg_restore', '-U', 'postgres', '-d', 'app', '/tmp/agent-backup.dump');
      pool = connect();
      // TASK-047.2.2: with a version anchor the run registry refuses instead of letting the cancelled run be claimed and run again.
      await assert.rejects(anchoredRuns.get(scope, 'r1'), /Agent runs were rolled back/);
      await assert.rejects(anchoredRuns.queued(scope), /Agent runs were rolled back/);
      // TASK-047.2.3: and the action journal on the same version stream refuses instead of letting action-2 be dispatched again.
      await assert.rejects(anchoredRuns.journal(scope, 'r2', claim.leaseToken).get('action-2'), /Agent runs were rolled back/);
      await assert.rejects(anchoredRuns.journal(scope, 'r2', claim.leaseToken).invoke('action-2', 'send', { n: 2 }, 3, dispatch), /Agent runs were rolled back/);
      assert.equal(dispatches, 1, 'the refused journal dispatched nothing');
      // TASK-047.3: the anchored definitions refuse instead of serving the first version, and the anchored memory instead of returning the erased one.
      await assert.rejects(anchoredDefinitions.get(actor, 'agent'), /Agent definitions were rolled back/);
      await assert.rejects(anchoredDefinitions.save(actor, manifest('Operations v3'), 1), /Agent definitions were rolled back/);
      await assert.rejects(anchoredMemory.get(actor, erasedScope, 'e1'), /Agent memory was rolled back/);
      await assert.rejects(anchoredMemory.list(actor, erasedScope), /Agent memory was rolled back/);
      assert.equal((await memory.get(actor, erasedScope, 'e1')).value, 'personal', 'without the anchor the erased personal memory is served again');
      // TASK-047.4: the anchored approvals refuse instead of forgetting the request, the delegations instead of making the revoked grant valid, the budget instead of forgetting the spend.
      await assert.rejects(anchoredApprovals.get(service, 'approval-1'), /Agent approvals were rolled back/);
      await assert.rejects(anchoredDelegations.verify(operator, issued.grant), /Agent delegations were rolled back/);
      await assert.rejects(anchoredDelegations.get(operator, 'grant'), /Agent delegations were rolled back/);
      await assert.rejects(anchoredBudget.summary(scope), /Agent cost budget was rolled back/);
      await assert.rejects(anchoredBudget.reserve(scope, 'r2', claim.leaseToken, 'call-2', 400), /Agent cost budget was rolled back/);
      // Every store answers as if nothing happened, and nothing flags the gap.
      assert.equal((await definitions.get(actor, 'agent')).version, 1, 'the definition is back at its first version');
      assert.equal((await memory.list(actor, memoryScope)).items.length, 1, 'a memory written after the backup is gone');
      assert.equal((await memory.get(actor, memoryScope, 'k1')).revision, 1, 'an updated memory is back at its first revision');
      assert.equal((await budget.summary(scope)).reserved, 0, 'a budget reservation made after the backup is forgotten');
      assert.equal(await runs.journal(scope, 'r2', claim.leaseToken).get('action-1'), undefined, 'a completed action is forgotten');
      await runs.journal(scope, 'r2', claim.leaseToken).invoke('action-1', 'send', { n: 1 }, 3, dispatch);
      assert.equal(dispatches, 2, 'the forgotten action is dispatched again, repeating its external effect');
      assert.equal(await approvals.get(service, 'approval-1'), undefined, 'an approval requested after the backup is forgotten');
      assert.equal(await delegations.verify(operator, issued.grant), true, 'a delegation revoked after the backup is valid again');
      assert.equal((await delegations.get(operator, 'grant')).revision, 1);
      const summary = await sharedCost.summary(operator);
      assert.deepEqual([summary.reservedMicros, summary.calls], [100, 1], 'a shared cost reservation made after the backup is forgotten');
    } finally {
      await pool?.end().catch(() => {});
      await docker('rm', '-fv', name).catch(() => {});
    }
  }
);
