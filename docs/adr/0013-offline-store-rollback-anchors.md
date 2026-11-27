# ADR 0013: Anchor the offline executions and recovery stores; leave request keys and slots unanchored

Status: **Proposed** (TASK-052; accepted when the owner confirms the verdict for each store)
Date: 2026-11-27

## Context
A database restored from an older backup goes back in time without telling the stores in it. The restore characterization
(`packages/core/test/postgres-restore-rollback.test.mjs`, TASK-051) records what that undoes for the four PostgreSQL offline
stores. [Restoring an older backup](../kubernetes-data-plane.md#restoring-an-older-backup) has the table. The stores that already
guard against it (`PostgresJwtRevocations`, `PostgresExtensionApprovals`, the audits, the release floor) hold a number outside the
database and refuse to answer while the database is behind it (`checkAgainstAnchor` in `packages/core/src/file-sequence-anchor.ts`).

The four stores differ in what a rewind costs:

| Store | What a rewind undoes | Can it repeat an external effect or lose evidence? |
| --- | --- | --- |
| `PostgresOfflineRequestKeys` | A key issued after the backup becomes unknown | No. The device is refused and retries with a new key |
| `PostgresOfflineSlots` | A reset after the backup is undone and the retired key is valid again | No effect on its own: running it goes through executions |
| `PostgresOfflineExecutions` | An execution finished after the backup is forgotten | Yes. A device that starts over runs the operation again |
| `PostgresOfflineRecovery` | A reconciliation after the backup is undone | Yes. The outcome is uncertain again and the evidence is gone |

## Decision
1. **`PostgresOfflineExecutions` and `PostgresOfflineRecovery` accept an anchor.** They are where an external effect is recorded and
   where the evidence for an uncertain one lives. Each takes the same options as `PostgresJwtRevocations`: an anchor
   (`AuditSequenceAnchor`) and an error handler. Without an anchor they behave as today.
2. **`PostgresOfflineRequestKeys` and `PostgresOfflineSlots` stay unanchored, and say why.** A rewind of either one is refused or
   retried, never repeated: `PostgresOfflineExecutions.execute` verifies the key and then claims the execution, so an effect only
   happens through the anchored store. After a whole-database restore the executions anchor refuses first when any execution was
   acknowledged after the backup. The remaining loss is bounded: keys issued after the backup are unknown, and a slot reset after
   the backup makes its retired key valid again, which can run an abandoned form once if it never ran before. That residue is
   recorded in the operator steps below.
3. **Executions carry a version from a sequence.** A `version BIGINT` column takes its value from a PostgreSQL sequence on every
   insert and every update (claim, completion, `markUncertain`, `reconcile`). A status can move backwards (`reconcile` with
   `not_applied` returns to `ready`), so a row count or a status cannot serve as the counter. The sequence does not lock, so writers
   do not queue behind a shared epoch row, the cost the revocation epoch pays and a per-submission path cannot afford. The check
   reads `max(version)` for the tenant and application through an index and compares it with the anchor.
4. **Recovery events use their own id.** The table is append-only with a `BIGSERIAL` id, the shape of the capability audit
   sequence. The check compares `max(id)` for the tenant and application with the anchor. No new column is needed.
5. **One anchor per tenant and application** for each store (`offline-executions-<digest>`, `offline-recovery-<digest>`, built like
   the existing key helpers). Every call checks the anchor before it answers and advances it after a committed change. A failed
   advance is reported to the error handler and leaves the change committed, as for the other stores.

## Consequences
- After a restore, the two stores refuse (`Offline executions were rolled back`, `Offline recovery was rolled back`) until the
  anchor is reconciled. A lowered anchor is deliberate and goes through `scripts/anchor-admin.mjs`, which learns the two key kinds.
- Re-applying what was lost has no source of truth inside the database. The operator reconciles every key that was live at the
  restore point against the external system by its idempotency key, records the outcome through `PostgresOfflineRecovery` and
  then lowers the anchor. An execution that cannot be verified stays uncertain.
- Every execution costs one anchor write per state change. The anchor is a file on storage a restore cannot reach.
- The check assumes a restore of the whole database. A restore of single tables is not detected.

## Alternatives refused
- A per-application epoch row bumped in each statement, as for revocations. It serialises every submission of an application.
- Anchoring all four stores. Request keys and slots hold no effect, and anchoring them would refuse healthy traffic after a
  restore to guard against a retry.
- Documenting why executions cannot be anchored. They can, with a sequence and an index.
