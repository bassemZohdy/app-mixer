# Active Backlog

## 🛤️ Lanes

- main: the default track
- evidence: legacy P2/P3 items that need dated external evidence before they can be checked off

## 🌳 Task Tree

- [ ] **TASK-024** · P2 · mid · Close the adapter and parity evidence gaps (legacy P2-01)
  - Done when: every Still-to-prove box of P2-01 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - In repo: done: every catalog component is in the shared fixtures (TASK-042) and web, React Native, Flutter and Angular all replay the six of them (TASK-049, TASK-050; the component-by-adapter table is in docs/a2ui-renderer.md#cross-adapter-fixture-parity)
  - Blocked on: Android and iOS devices for React Native tests beyond the nested-binding, rejection and bound-field-action cases; devices for Flutter layout, typography and accessibility parity against the web reference
  - State: next: the two device boxes wait for the devices

- [ ] **TASK-025** · P2 · mid · Close the extension SDK and compatibility manifest evidence gaps (legacy P2-02)
  - Done when: every Still-to-prove box of P2-02 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: the full SDK integration with a third-party package built outside the repository (third-party-extension.test.mjs, ported from the hardening branch on 2026-11-26; 1 of 2 boxes)
  - Blocked on: the production environment; revocation latency under load and the behaviour during a database outage are measured locally and in CI (two nodes, 32 concurrent checks, the failover drill; postgres-extension-approval-operations.test.mjs), the box needs the same measurement in production
  - State: next: measure in production

- [ ] **TASK-026** · P2 · mid · Close the internal data provider and staged transaction evidence gaps (legacy P2-03)
  - Done when: every Still-to-prove box of P2-03 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - In repo: done: TASK-043 (every rejected JSON Schema keyword with a decision in docs/business-data.md#keywords-the-form-editor-rejects, and `default` and `readOnly` built and tested; the P2-03 box is checked)
  - Blocked on: a provider sandbox; staged outcomes against a real external provider, including an ambiguous timeout reconciled without a duplicate effect
  - State: next: the provider sandbox

- [ ] **TASK-027** · P2 · mid · Close the offline-first queue evidence gaps (legacy P2-04)
  - Done when: every Still-to-prove box of P2-04 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: the migration of clients older than the IndexedDB version fence (offline-legacy-clients.test.mjs)
  - In repo: done: TASK-044 (the browser-side stores are inventoried in docs/offline-queue.md#rollback-anchor; both web stores bind a partition digest into anchored v2 counters and detect deletion and substitution on the next open, read or write; the P2-04 box is checked)
  - Blocked on: a device for offline provisioning of a never-online device; iOS and Android devices for storage under eviction and backup/restore; production identity for shared request keys
  - State: next: TASK-044

- [ ] **TASK-028** · P2 · mid · Close the schema migration, rollback and promotion evidence gaps (legacy P2-05)
  - Done when: every Still-to-prove box of P2-05 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - In repo: done: TASK-045 (ADR 0012 refuses a general definition-migration registry and records how a version 3 ships) and TASK-046 (`PostgresPromotionSigningAudit` with an operator credential, an append-only service role and a key holder refused; both P2-05 boxes are checked)
  - Blocked on: production; an online migration on a production-sized dataset with writers active, and production authorization of promotion
  - State: next: the two production boxes

- [ ] **TASK-029** · P2 · mid · Close the persistent-agent entity and manifest evidence gaps (legacy P2-06)
  - Done when: every Still-to-prove box of P2-06 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: distributed run-quota enforcement across nodes (postgres-run-quota-nodes.test.mjs)
  - Blocked on: production identity for administrators and service principals
  - State: next: provision the production identities

- [ ] **TASK-030** · P2 · mid · Close the lifecycle manager and durable run registry evidence gaps (legacy P2-07)
  - Done when: every Still-to-prove box of P2-07 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: the shared PostgreSQL run registry (postgres-run-nodes.test.mjs, postgres-run-lifecycle-foundation.test.mjs)
  - Blocked on: production scheduling of workers and coordination between nodes including node failure; a provider account for the safe replay of external effects after recovery
  - State: next: the node-failure report from production

- [ ] **TASK-031** · P2 · mid · Close the event, webhook and scheduler activation evidence gaps (legacy P2-08)
  - Done when: every Still-to-prove box of P2-08 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: the provider list (2 of 3 boxes)
  - Blocked on: provider accounts; a live or sandbox delivery, including a retry, captured for each of the twelve adapters that have not yet delivered (GitHub has delivered ping and push)
  - State: next: one provider account at a time, in the order of docs/agent-event-ingress.md#supported-providers

- [ ] **TASK-032** · P2 · mid · Close the action intent and outcome journal evidence gaps (legacy P2-09)
  - Done when: every Still-to-prove box of P2-09 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Blocked on: production scheduling of the recovery worker and production storage; provider accounts for the conformance run of each provider the agents may call
  - State: next: the provider conformance runs

- [ ] **TASK-033** · P2 · mid · Close the configurable memory adapter evidence gaps (legacy P2-10)
  - Done when: every Still-to-prove box of P2-10 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Blocked on: the owner's review of the draft evaluation labels, the production embedder and the agreed thresholds; production deployment of the chosen per-tenant indexes and measurement at production sizes
  - State: next: the owner reviews docs/agent-memory.md#draft-evaluation-set

- [ ] **TASK-034** · P2 · mid · Close the identity, authorization, audit and isolation evidence gaps (legacy P3-01)
  - Done when: every Still-to-prove box of P3-01 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Blocked on: the target environment; deployment-grade availability (automatic failover) of the revocation and audit stores, the target's certificate issuer and trust distribution, and the production identity provider checked against docs/jwt-capability-auth.md#identity-provider-requirements
  - State: next: the target environment

- [ ] **TASK-035** · P2 · mid · Close the observability and production operational control evidence gaps (legacy P3-02)
  - Done when: every Still-to-prove box of P3-02 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Blocked on: production; transport and deployment integration of metrics and traces, alert delivery to a real on-call rotation and ticketing system, and a production Grafana instance importing deploy/observability/grafana-dashboard.json
  - State: next: the production collector and alert routes

- [ ] **TASK-036** · P2 · mid · Close the optional remote Control Plane connector evidence gaps (legacy P3-03)
  - Done when: every Still-to-prove box of P3-03 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: disconnected replication (1 of 5 boxes)
  - In repo: TASK-047 (every security-relevant PostgreSQL store anchored outside its database; today revocations, approvals, the audits and the release floor have library anchors, the agent stores none)
  - Blocked on: production scheduling of the poller and production identity for source and target
  - State: next: TASK-047

- [ ] **TASK-037** · P2 · mid · Close the Kubernetes production deployment evidence gaps (legacy P3-04)
  - Done when: every Still-to-prove box of P3-04 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: broader admission enforcement (1 of 7 boxes)
  - In repo: TASK-047; the Data Plane already keeps its release-floor and revocation-epoch anchors on a PersistentVolumeClaim in the signed-jwt-tls-revocation-fresh-anchor-example overlay, enforced by the admission policy
  - Blocked on: the target cluster; identity and certificate operations, automatic failover of the revocation and release-floor stores, and the validation run (the OpenShift Local attempt stopped at 11 GB of node memory)
  - State: next: TASK-047

- [ ] **TASK-038** · P2 · mid · Close the service principal and delegated identity evidence gaps (legacy P3-05)
  - Done when: every Still-to-prove box of P3-05 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Blocked on: production delivery of requests and notices, and production identity for delegated users
  - State: next: the production identity provider

- [ ] **TASK-039** · P2 · mid · Close the durable human approval and consent evidence gaps (legacy P3-06)
  - Done when: every Still-to-prove box of P3-06 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Blocked on: production delivery of approval notices, and production identity for approvers
  - State: next: the production notice channel

- [ ] **TASK-040** · P2 · mid · Close the agent trace, metrics, quota and operational control evidence gaps (legacy P3-07)
  - Done when: every Still-to-prove box of P3-07 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: the shared cost budget across nodes (1 of 5 boxes)
  - Blocked on: production; provider-side limits on each production provider (OpenAI-compatible providers are done), trace propagation and retention, and broader metrics and coordination
  - State: next: the production provider list

- [ ] **TASK-041** · P2 · mid · Close the durable-store portability and tenant-isolation acceptance evidence gaps (legacy P3-08)
  - Done when: every Still-to-prove box of P3-08 in docs/acceptance-checklists.md is checked with attached evidence; `node --test packages/cli/test/process-files.test.mjs`
  - Links: Ref: docs/acceptance-checklists.md · Lane: evidence
  - Checked with evidence: real provider contracts under crash (staged-s3-provider.test.mjs and action-s3-provider-crash.test.mjs against SeaweedFS, ported from the hardening branch on 2026-11-26; 1 of 4 boxes); weekly: PostgreSQL 14 to 17 with pgvector, Linux arm64
  - Blocked on: production; managed stores, a node taken down in production, a real network partition between a node and the database, and an arm64 node pool
  - State: next: the production stores

- [ ] **TASK-047** · P3 · large · Anchor the agent stores outside their database, as the Data Plane stores already are
  - Done when: every PostgreSQL store under packages/agent/src/postgres that records security or money state (definitions, runs, the action journal, memory, approvals, delegations and the cost budget) accepts an anchor as PostgresJwtRevocations and PostgresPublicationReleaseRegistry do (docs/kubernetes-data-plane.md, Anchors), or its documentation names why it cannot; packages/core/test/postgres-restore-rollback.test.mjs covers each one and shows a restore refused until the anchor is reconciled; the sentence in docs/kubernetes-data-plane.md#restoring-an-older-backup that only the connector's promotion floor can be anchored is brought in line with the anchors the stores accept; the P3-03 and P3-04 rollback boxes cite the test
  - Links: Ref: docs/kubernetes-data-plane.md#restoring-an-older-backup · From: TASK-036, TASK-037 · Lane: main
  - State: next: extend the restore test's table to the agent stores and read which ones rewind undetected

- [ ] **TASK-051** · P3 · small · Characterize the PostgreSQL offline stores under a restored older backup
  - Done when: packages/core/test/postgres-restore-rollback.test.mjs extends its table to PostgresOfflineRequestKeys, PostgresOfflineSlots, PostgresOfflineExecutions and PostgresOfflineRecovery (what each acknowledges after the backup and what a restore undoes, for example a retired request key or a finished execution becoming pending again); docs/kubernetes-data-plane.md#restoring-an-older-backup lists the result; if a store rewinds undetected in a way that matters, the P3-03 and P3-04 rollback boxes name it and a follow-up decides an anchor as TASK-047 does for the agent stores; `APP_MIXER_TEST_POSTGRES_RESTORE=docker node --test packages/core/test/postgres-restore-rollback.test.mjs` passes
  - Links: Ref: docs/kubernetes-data-plane.md#restoring-an-older-backup · From: TASK-027 · Lane: main
  - State: next: read how the restore test builds its table and add the four stores
