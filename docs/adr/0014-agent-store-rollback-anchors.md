# ADR 0014: Anchor the agent stores that record security, effect or money state

Status: **Accepted** (TASK-047.1 decided it, the owner confirmed the verdict for each store, TASK-047.2 to TASK-047.5 built six of the seven and FEAT-053 the last)
Date: 2026-11-27

## Context
[ADR 0013](0013-offline-store-rollback-anchors.md) anchored the offline executions and recovery stores. The agent stores
(`packages/agent/src/postgres`) keep no anchor. The restore test (`packages/core/test/postgres-restore-rollback.test.mjs`, TASK-047.1)
writes each store once before a backup and once after it, restores the backup, and records that every store answers as if nothing
had happened, with no sign of the gap. No store deletes rows (they insert or update, and the history tables refuse updates).

| Store | What a rewind undoes | Cost |
| --- | --- | --- |
| `PostgresAgentDefinitions` | The latest definition is replaced by an older one, with its administrators and capabilities | Security |
| `PostgresAgentRuns` | Claims, leases and run transitions are forgotten | Effect |
| Action journal (`PostgresAgentActionJournal`) | A finished action is forgotten and dispatched again | Effect repeated |
| `PostgresAgentMemory` | Writes and erasures are undone, so erased memory returns | Privacy |
| `PostgresAgentApprovalsFoundation` | A requested or decided approval is forgotten | Security |
| `PostgresAgentDelegationsFoundation` | A revoked delegation is valid again | Security |
| `PostgresAgentCostBudget`, `PostgresAgentSharedCost` | Reserved and settled amounts are forgotten | Money |

## Decision
1. **All seven accept an anchor.** Each rewind is a security, effect or money loss, and none can be refused or retried safely, so
   none is left unanchored (unlike the offline request keys and slots of ADR 0013). Each store takes an anchor
   (`AuditSequenceAnchor`) and an error handler, and without one behaves as today.
2. **Reuse the two counters ADR 0013 settled on.**
   - Stores with an append-only table whose id only grows (approvals events, delegation events) compare `max(id)`. Definitions
     compare `max(version)` of their immutable version rows. No new column is needed.
   - Stores whose rows change in place (runs, the action journal, memory, the cost budget and shared cost) gain a `version`
     column drawn from a sequence on every change, and compare `max(version)`. A sequence does not queue writers behind a shared
     epoch row, which a lease renewal or a reservation cannot afford.
3. **One anchor per tenant and agent** (shared cost: per tenant and budget), kept in a file outside the database, advanced after
   every committed change and checked before every answer. A refusal reads "<Store> was rolled back" and names the store.
4. **The run store and its action journal share one version stream** (they fence each other with the lease), and the cost budget
   gets its own, because the budget is reconciled apart from the run.
5. **Operator steps are those of ADR 0013:** keep refusing, re-establish what was lost from the provider and the change record,
   lower the anchor deliberately with `scripts/anchor-admin.mjs`, then record the evidence again.

## Consequences
- Four stores gain a column and an index on upgrade, which the anchored `initialize()` adds; an unanchored store is unchanged.
- The check assumes a restore of the whole database and that rows are never deleted; an operator who prunes the newest rows must
  lower the anchor. A write whose version was drawn just before a concurrent backup snapshot can go undetected.
- The work was TASK-047.2 to TASK-047.4 (runs and journal, definitions and memory, approvals, delegations and cost budget) and TASK-047.5
  (the operator tool and the docs). `scripts/anchor-admin.mjs` finds each anchor file with `key agent-<store> <tenant> <agent>`.
- `PostgresAgentSharedCost` (FEAT-053) keeps one anchor per tenant and budget on its own version stream (a `version` column on the call
  ledger; the budget row never changes) and refuses with "Shared cost was rolled back". `anchor-admin key agent-shared-cost <tenant> <budget>`
  finds its file.
- A listing cannot name an agent whose rows are all gone after a restore, so it does not notice that agent; a read of it is refused.
- A replayed memory erasure request (`eraseScopeOnce`) recorded only in the rewound database is forgotten, because it changes no memory row.

## Alternatives refused
- Anchoring only definitions, approvals and delegations. The action journal and budgets lose effects and money, which is worse.
- A per-store epoch row. It serialises lease renewals and cost reservations.
