# Evidence lane notes

Detail moved out of `TODO.md` so each task stays within the 4-line schema. Each section holds what a task's old `In repo:`, `Checked with evidence:` and `Blocked on:` lines said. The boxes themselves live in `docs/acceptance-checklists.md`.

## TASK-024

- In repo: done: every catalog component is in the shared fixtures (TASK-042) and web, React Native, Flutter and Angular all replay the six of them (TASK-049, TASK-050; the component-by-adapter table is in docs/a2ui-renderer.md#cross-adapter-fixture-parity)
- Blocked on: Android and iOS devices for React Native tests beyond the nested-binding, rejection and bound-field-action cases; devices for Flutter layout, typography and accessibility parity against the web reference

## TASK-025

- Checked with evidence: the full SDK integration with a third-party package built outside the repository (third-party-extension.test.mjs, ported from the hardening branch on 2026-11-26; 1 of 2 boxes)
- Blocked on: the production environment; revocation latency under load and the behaviour during a database outage are measured locally and in CI (two nodes, 32 concurrent checks, the failover drill; postgres-extension-approval-operations.test.mjs), the box needs the same measurement in production

## TASK-026

- In repo: done: TASK-043 (every rejected JSON Schema keyword with a decision in docs/business-data.md#keywords-the-form-editor-rejects, and `default` and `readOnly` built and tested; the P2-03 box is checked)
- Blocked on: a provider sandbox; staged outcomes against a real external provider, including an ambiguous timeout reconciled without a duplicate effect

## TASK-027

- Checked with evidence: the migration of clients older than the IndexedDB version fence (offline-legacy-clients.test.mjs)
- In repo: done: TASK-044 (the browser-side stores are inventoried in docs/offline-queue.md#rollback-anchor; both web stores bind a partition digest into anchored v2 counters and detect deletion and substitution on the next open, read or write; the P2-04 box is checked) and TASK-051 (the restore test characterizes the four PostgreSQL offline stores: every acknowledgement given after the backup is undone without detection); next: TASK-052 (decide anchors for those stores)
- Blocked on: a device for offline provisioning of a never-online device; iOS and Android devices for storage under eviction and backup/restore; production identity for shared request keys

## TASK-028

- In repo: done: TASK-045 (ADR 0012 refuses a general definition-migration registry and records how a version 3 ships) and TASK-046 (`PostgresPromotionSigningAudit` with an operator credential, an append-only service role and a key holder refused; both P2-05 boxes are checked)
- Blocked on: production; an online migration on a production-sized dataset with writers active, and production authorization of promotion

## TASK-029

- Checked with evidence: distributed run-quota enforcement across nodes (postgres-run-quota-nodes.test.mjs)
- Blocked on: production identity for administrators and service principals

## TASK-030

- Checked with evidence: the shared PostgreSQL run registry (postgres-run-nodes.test.mjs, postgres-run-lifecycle-foundation.test.mjs)
- Blocked on: production scheduling of workers and coordination between nodes including node failure; a provider account for the safe replay of external effects after recovery

## TASK-031

- Checked with evidence: the provider list (2 of 3 boxes)
- Blocked on: provider accounts; a live or sandbox delivery, including a retry, captured for each of the twelve adapters that have not yet delivered (GitHub has delivered ping and push)

## TASK-032

- Blocked on: production scheduling of the recovery worker and production storage; provider accounts for the conformance run of each provider the agents may call

## TASK-033

- Blocked on: the owner's review of the draft evaluation labels, the production embedder and the agreed thresholds; production deployment of the chosen per-tenant indexes and measurement at production sizes

## TASK-034

- Blocked on: the target environment; deployment-grade availability (automatic failover) of the revocation and audit stores, the target's certificate issuer and trust distribution, and the production identity provider checked against docs/jwt-capability-auth.md#identity-provider-requirements

## TASK-035

- Blocked on: production; transport and deployment integration of metrics and traces, alert delivery to a real on-call rotation and ticketing system, and a production Grafana instance importing deploy/observability/grafana-dashboard.json

## TASK-036

- Checked with evidence: disconnected replication (1 of 5 boxes)
- In repo: TASK-047 (every security-relevant PostgreSQL store anchored outside its database; today revocations, approvals, the audits and the release floor have library anchors, the agent stores none)
- Blocked on: production scheduling of the poller and production identity for source and target

## TASK-037

- Checked with evidence: broader admission enforcement (1 of 7 boxes)
- In repo: TASK-047; the Data Plane already keeps its release-floor and revocation-epoch anchors on a PersistentVolumeClaim in the signed-jwt-tls-revocation-fresh-anchor-example overlay, enforced by the admission policy
- Blocked on: the target cluster; identity and certificate operations, automatic failover of the revocation and release-floor stores, and the validation run (the OpenShift Local attempt stopped at 11 GB of node memory)

## TASK-038

- Blocked on: production delivery of requests and notices, and production identity for delegated users

## TASK-039

- Blocked on: production delivery of approval notices, and production identity for approvers

## TASK-040

- Checked with evidence: the shared cost budget across nodes (1 of 5 boxes)
- Blocked on: production; provider-side limits on each production provider (OpenAI-compatible providers are done), trace propagation and retention, and broader metrics and coordination

## TASK-041

- Checked with evidence: real provider contracts under crash (staged-s3-provider.test.mjs and action-s3-provider-crash.test.mjs against SeaweedFS, ported from the hardening branch on 2026-11-26; 1 of 4 boxes); weekly: PostgreSQL 14 to 17 with pgvector, Linux arm64
- Blocked on: production; managed stores, a node taken down in production, a real network partition between a node and the database, and an arm64 node pool
