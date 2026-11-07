# Acceptance checklists for the open P2 and P3 tasks

Each open task in [TODO.md](../TODO.md) is partly built and verified locally. A task may be checked off only when every item under **Still to prove** has evidence attached. **Verified locally** names what the repository's own tests already establish, so it is not repeated on the target. Items need a real system (cluster, devices, identity provider, provider account); none can be established by the unit and local integration tests alone.

Evidence means a dated record that a reviewer can re-check: a CI run URL, a command transcript with the exact versions, or an audit export. A claim without evidence does not count.

## P2: portability and advanced data

### P2-01 Adapters and parity
- **Verified locally:** shared layout, binding, action and rejection fixtures run against the web, native and Flutter renderers; React, Angular, React Native for Web, Flutter VM and Flutter on Chrome in CI; a 1,500-message renderer fuzz test.
- **Still to prove:**
  - [ ] Broader React Native device tests on Android and iOS beyond the current nested-binding, rejection and bound-field-action cases.
  - [ ] Flutter exact layout dimensions, typography and accessibility parity against the web reference, measured on devices.
  - [ ] Every catalog component and behavior present in the web catalog has a fixture exercised on all four adapters.
- **Evidence:** CI run URLs per platform and a parity table listing each catalog component against each adapter.

### P2-02 Extension SDK and compatibility manifests
- **Verified locally:** manifest and configuration validation, package digest verification (canonical spelling only), approval pinning and revocation lifecycle, hostile-key tests.
- **Still to prove:**
  - [ ] Full SDK integration in a generated application using a third-party package built outside this repository.
  - [ ] Production operational verification of the shared approval store: revocation latency under load and behaviour during a database outage.
- **Evidence:** a transcript of installing, approving, using and revoking an external package, and a revocation-latency measurement.

### P2-03 Internal data provider and staged external transactions
- **Verified locally:** SQLite provider, per-record authorization, staged submission that never auto-retries a possibly applied effect, process-kill recovery, JSON Schema validation and forms.
- **Still to prove:**
  - [ ] Broader JSON Schema-driven forms for the schema features the form editor still rejects.
  - [ ] Verification of staged outcomes against at least one real external provider, including an ambiguous timeout.
- **Evidence:** the list of unsupported keywords with the decision for each, and a provider sandbox transcript showing an ambiguous result reconciled without a duplicate effect.

### P2-04 Offline-first queue
- **Verified locally:** durable queue, deduplication, bounded retries, conflict and uncertain states, process-kill recovery, encrypted browser storage with key rotation and cross-tab fencing, PostgreSQL shared keys.
- **Still to prove:**
  - [ ] Offline provisioning of a device that has never been online.
  - [ ] Mobile storage on iOS and Android, including eviction and backup/restore.
  - [ ] Rollback protection for the offline stores that lack it, and detection of selective tampering.
  - [ ] Migration of clients older than the fixed-version IndexedDB fence.
  - [ ] Production identity for shared request keys.
- **Evidence:** device recordings or logs for each scenario and a migration test against a retained legacy client build.

### P2-05 Schema migration, rollback and promotion
- **Verified locally:** immutable publication rollback, promotion with provenance and optimistic concurrency, bounded versioned data migrations, signed promotion artifacts, process-kill and cross-process race tests.
- **Still to prove:**
  - [ ] General schema evolution beyond the explicit 1-to-2 and 2-to-1 definition migrations.
  - [ ] Larger and online migrations on a production-sized dataset with writers active.
  - [ ] Independent operation of the signing audit (separate trust domain from the signer).
  - [ ] Production authorization of promotion.
- **Evidence:** a migration run report with row counts, duration and writer error rate, and an independent audit verification transcript.

### P2-06 Persistent-agent entity and manifest
- **Verified locally:** manifest validation, immutable tenant-scoped versions, optimistic concurrency, PostgreSQL store with audit and quotas, process-kill tests.
- **Still to prove:**
  - [ ] Production identity for administrators and service principals.
  - [ ] Distributed run-quota enforcement across nodes.
- **Evidence:** a multi-node quota test that exceeds the limit from two nodes simultaneously and a record that exactly the limit was admitted.

### P2-07 Lifecycle manager and durable run registry
- **Verified locally:** run registry, lease claim, renewal and fencing, expiry, pause, resume and cancel, process-kill lease recovery, PostgreSQL run slots.
- **Still to prove:**
  - [ ] Production scheduling of workers.
  - [ ] A shared (non-SQLite) run registry.
  - [ ] Safe replay of external effects after recovery against a real provider.
  - [ ] Production coordination between nodes, including node failure.
- **Evidence:** a node-failure test report showing runs recovered exactly once and no duplicated external effect.

### P2-08 Event, webhook and scheduler activation
- **Verified locally:** signed ingress with key rotation and deduplication; GitHub, Shopify, GitLab, Stripe, Slack, Twilio, Linear, PagerDuty and Standard Webhooks adapters; cron schedules with time zones, names and exclusions; process-kill schedule tests.
- **Still to prove:**
  - [ ] Each provider adapter against that provider's live or sandbox delivery, including a retry.
  - [ ] Additional providers the product commits to supporting.
  - [ ] Distributed coordination of schedule firing across nodes.
  - [ ] Each provider adapter against that provider's live or sandbox delivery, including a retry. Locally, the Standard Webhooks specification vector and Slack's documented signing example (and Twilio's, among the SDK fixtures) authenticate through their adapters ([agent-event-ingress.md](agent-event-ingress.md#vendor-published-signature-examples)); no provider has delivered to an adapter.
  - [ ] Additional providers the product commits to supporting. Discord interactions and the SendGrid Event Webhook were added as the first asymmetric-signature adapters ([agent-event-ingress.md](agent-event-ingress.md)). Still to do: the owner must list the providers the product commits to.
  - [ ] Each provider adapter against that provider's live or sandbox delivery, including a retry. Locally, the Standard Webhooks specification vector and Slack's documented signing example (and Twilio's, among the SDK fixtures) authenticate through their adapters ([agent-event-ingress.md](agent-event-ingress.md#vendor-published-signature-examples)); GitHub has now delivered a `ping` and a `push` test event (twice) to its adapter through a temporary tunnel, with the repeated body deduplicated and a wrong signature refused ([agent-event-ingress.md](agent-event-ingress.md#live-github-delivery)); the other twelve providers have not delivered to an adapter.
  - [x] Additional providers the product commits to supporting. Discord interactions and the SendGrid Event Webhook were added as the first asymmetric-signature adapters ([agent-event-ingress.md](agent-event-ingress.md)). The owner listed the providers on 2026-11-07: every current adapter, which is the thirteen named in [agent-event-ingress.md](agent-event-ingress.md#supported-providers).
  - [x] Distributed coordination of schedule firing across nodes. `PostgresAgentSchedules` fires each occurrence once across nodes; two processes with one killed mid-run fire every one-second occurrence exactly once with no gaps ([agent-schedules.md](agent-schedules.md#shared-schedules-across-nodes)). Handing a fired run to an executor is at least once until a shared run registry exists (P2-07). `PostgresAgentRuns.create` now refuses a second run for a reclaimed request.
- **Evidence:** one captured live delivery per provider verified by the adapter, and a two-node schedule test showing a single fire per occurrence.

### P2-09 Action journal and reconciliation
- **Verified locally:** lease-fenced journal with stable keys, explicit reconciliation, recovery workers, evidence records, process-kill and cross-process race tests, idempotency conformance helper.
- **Still to prove:**
  - [ ] Production scheduling of the recovery worker.
  - [ ] Provider-specific verification for each provider the agents may call.
  - [ ] Production storage and verification against real providers.
- **Evidence:** a provider conformance run (using the idempotency contract helper) per provider, and a recovery transcript from a real ambiguous failure.

### P2-10 Memory adapters, isolation, retention and provenance
- **Verified locally:** SQLite and PostgreSQL adapters, scope isolation, retention, deletion, erase, audit, hybrid and indexed search, evaluation helper (recall, precision, reciprocal rank, nDCG).
- **Still to prove:**
  - [ ] Production deployment and the chosen isolation strategy (shared index versus scoped indexes).
  - [ ] A representative, reviewed evaluation set and the quality thresholds that must hold, with exact-search comparison for the approximate index.
  - [ ] Production deployment and the chosen isolation strategy (shared index versus scoped indexes). The trade-off is now measured locally ([agent-memory.md](agent-memory.md#measured-shared-versus-scoped-vector-indexes)): with 20 to 50 tenants a shared index finds 0.90 to 0.91 of exact search results and per-tenant indexes 0.998, at the same latency. The owner must choose, accounting for the per-scope index count, and test in production.
  - [ ] Production deployment of the chosen isolation strategy. The owner chose per-tenant (scoped) indexes on 2026-11-07 ([agent-memory.md](agent-memory.md#decision-per-tenant-indexes)); what remains is deploying them in production and measuring at production sizes. The trade-off is now measured locally ([agent-memory.md](agent-memory.md#measured-shared-versus-scoped-vector-indexes)): with 20 to 100 tenants (up to 20,000 memories) a shared index finds 0.90 to 0.91 of exact search results and per-tenant indexes 0.998, at the same query latency; loading 20,000 memories took twice as long with 100 per-tenant indexes (329 s against 165 s). The owner must choose, accounting for the per-scope index count, and test in production.
  - [ ] Production deployment of the chosen isolation strategy. The owner chose per-tenant (scoped) indexes on 2026-11-07 ([agent-memory.md](agent-memory.md#decision-per-tenant-indexes)); what remains is deploying them in production and measuring at production sizes. The trade-off is now measured locally ([agent-memory.md](agent-memory.md#measured-shared-versus-scoped-vector-indexes)): with 20 to 50 tenants a shared index finds 0.90 to 0.91 of exact search results and per-tenant indexes 0.998, at the same latency. The owner must choose, accounting for the per-scope index count, and test in production.
  - [ ] A representative, reviewed evaluation set and the quality thresholds that must hold, with exact-search comparison for the approximate index. A draft labelled set (40 memories, 24 keyword, paraphrase, multi-answer and distractor cases) now runs every mode on PostgreSQL with pgvector among 900 distractors, against proposed floors. The HNSW index finds 0.992 of the exact results, and the gate fails when the index degrades. Still pending: owner review of the labels, the production embedder, and agreed thresholds ([agent-memory.md](agent-memory.md#draft-evaluation-set)).
- **Evidence:** the labelled dataset (reviewed), the evaluation report for each mode, and the agreed thresholds.

## P3: production

### P3-01 Identity, authorization, audit and isolation
- **Verified locally:** RS256 and ES256 (P-256) JWT authentication, key rotation, JWKS refresh with staleness limits, revocation, capability audit, TLS credential reload.
- **Still to prove:**
  - [ ] Deployment-grade availability of revocation and audit stores.
  - [ ] Certificate issuance and trust rotation in the target environment.
  - [ ] Deployment-grade availability of revocation and audit stores. The revocation store survives a primary failover in a local drill: an acknowledged revocation is still in force on the promoted synchronous standby and lookups deny while no primary exists ([kubernetes-data-plane.md](kubernetes-data-plane.md#failover-drill)). The release-floor registry, the extension approvals and the capability and authentication-failure audit logs survive the same drill, and an audit write fails while no primary exists. Automatic failover, detection time and a production cluster are not exercised, and the promotion-signing audit belongs to the signer (P2-05).
  - [ ] Certificate issuance and trust rotation in the target environment. With cert-manager and a private CA in a kind cluster, both Data Plane pods pick up a renewed certificate (new serial and key) and a CA rotation with no restart, and clients holding the CA bundle keep verifying throughout ([kubernetes-data-plane.md](kubernetes-data-plane.md#certificates-issued-by-cert-manager)). Still to do: the target environment's issuer and trust distribution.
  - [ ] Identity provisioning and deprovisioning through the real identity provider.
  - [ ] Deployment-grade availability of revocation and audit stores. The revocation store survives a primary failover in a local drill: an acknowledged revocation is still in force on the promoted synchronous standby and lookups deny while no primary exists ([kubernetes-data-plane.md](kubernetes-data-plane.md#failover-drill)). The release-floor registry, the extension approvals and the capability and authentication-failure audit logs survive the same drill, and an audit write fails while no primary exists. Automatic failover, detection time and a production cluster are not exercised, and the promotion-signing audit belongs to the signer (P2-05).
  - [ ] Certificate issuance and trust rotation in the target environment. With cert-manager and a private CA in a kind cluster, both Data Plane pods pick up a renewed certificate (new serial and key) and a CA rotation with no restart, and clients holding the CA bundle keep verifying throughout ([kubernetes-data-plane.md](kubernetes-data-plane.md#certificates-issued-by-cert-manager)). Still to do: the target environment's issuer and trust distribution.
  - [ ] Identity provisioning and deprovisioning through the real identity provider. Keycloak works end to end; a second provider, Ory Hydra, is refused only because it marks access tokens `typ: JWT` instead of `at+jwt` ([jwt-capability-auth.md](jwt-capability-auth.md#identity-provider-requirements)). The production provider is still to be checked against the same requirements.
- **Evidence:** an outage drill (store down, requests fail closed), a certificate rotation transcript, and a deprovisioning test showing access ends within the stated bound.

### P3-02 Observability and operational controls
- **Verified locally:** liveness and readiness probes, draining, bounded metrics with fixed labels (fuzz-tested), scrape server, optional OpenTelemetry spans, cluster tests for scope, tenant and outages.
- **Verified locally:** liveness and readiness probes, draining, bounded metrics with fixed labels (fuzz-tested), scrape server, optional OpenTelemetry spans, cluster tests for scope, tenant and outages. One trace exported over OTLP to a real OpenTelemetry Collector container spans a browser-originated span, the generated workspace process, the Data Plane, the capability service and the Control Plane, with no tokens or inputs in the export ([collector test](data-plane-observability.md#collector-integration-test)). Prometheus alert rules for the Data Plane and agent metrics, one runbook per alert ([runbooks.md](runbooks.md)), a test that every rule uses only emitted metrics and label values, and a failure drill in which a real Prometheus scrapes the real metrics servers and fires scrape-failure, schedule-backlog, overdue-run, uncertain-action and stuck-draining alerts; a real Alertmanager routes them through the example routing tree to page and ticket webhook receivers and sends resolved notices after recovery. Both container tests pass on Windows and on Linux as an unprivileged user. A Grafana dashboard for the exported metrics ships in `deploy/observability/grafana-dashboard.json`; its queries are checked against the emitted metrics and parse in a real Prometheus, but it has not been imported into a production Grafana.
- **Verified locally:** liveness and readiness probes, draining, bounded metrics with fixed labels (fuzz-tested), scrape server, optional OpenTelemetry spans, cluster tests for scope, tenant and outages. One trace exported over OTLP to a real OpenTelemetry Collector container spans a browser-originated span, the generated workspace process, the Data Plane, the capability service and the Control Plane, with no tokens or inputs in the export ([collector test](data-plane-observability.md#collector-integration-test)). Prometheus alert rules for the Data Plane and agent metrics, one runbook per alert ([runbooks.md](runbooks.md)), a test that every rule uses only emitted metrics and label values, and a failure drill in which a real Prometheus scrapes the real metrics servers and fires scrape-failure, schedule-backlog, overdue-run, uncertain-action and stuck-draining alerts, then resolves them after recovery. Both container tests pass on Windows and on Linux as an unprivileged user.
- **Verified locally:** liveness and readiness probes, draining, bounded metrics with fixed labels (fuzz-tested), scrape server, optional OpenTelemetry spans, cluster tests for scope, tenant and outages. One trace exported over OTLP to a real OpenTelemetry Collector container spans a browser-originated span, the generated workspace process, the Data Plane, the capability service and the Control Plane, with no tokens or inputs in the export ([collector test](data-plane-observability.md#collector-integration-test)). Prometheus alert rules for the Data Plane and agent metrics, one runbook per alert ([runbooks.md](runbooks.md)), a test that every rule uses only emitted metrics and label values, and a failure drill in which a real Prometheus scrapes the real metrics servers and fires scrape-failure, schedule-backlog, overdue-run, uncertain-action and stuck-draining alerts; a real Alertmanager routes them through the example routing tree to page and ticket webhook receivers and sends resolved notices after recovery. Both container tests pass on Windows and on Linux as an unprivileged user.
- **Verified locally:** liveness and readiness probes, draining, bounded metrics with fixed labels (fuzz-tested), scrape server, optional OpenTelemetry spans, cluster tests for scope, tenant and outages. One trace exported over OTLP to a real OpenTelemetry Collector container spans a browser-originated span, the generated workspace process, the Data Plane, the capability service and the Control Plane, with no tokens or inputs in the export ([collector test](data-plane-observability.md#collector-integration-test)). Prometheus alert rules for the Data Plane and agent metrics, one runbook per alert ([runbooks.md](runbooks.md)), a test that every rule uses only emitted metrics and label values, and a failure drill in which a real Prometheus scrapes the real metrics servers and fires scrape-failure, schedule-backlog, overdue-run, uncertain-action and stuck-draining alerts; a real Alertmanager routes them through the example routing tree to page and ticket webhook receivers and sends resolved notices after recovery. Both container tests pass on Windows and on Linux as an unprivileged user. A Grafana dashboard for the exported metrics ships in `deploy/observability/grafana-dashboard.json`; its queries are checked against the emitted metrics and parse in a real Prometheus, and a Grafana 11.6 container imports it and runs every panel query against the drill's Prometheus without error ([runbooks.md](runbooks.md)); it has not been imported into a production Grafana.
- **Still to prove:**
  - [ ] Cross-service tracing from browser through Data Plane, capabilities and Control Plane in a real collector.
  - [ ] Production transport and deployment integration of metrics and traces.
  - [ ] The operational controls (alerts, runbooks) the product promises.
  - [ ] Alert delivery to a real on-call rotation and ticketing system, and a production dashboard instance. Routing is proven only to local webhook receivers, and the dashboard has not been imported into a production Grafana.
  - [ ] Alert delivery: Alertmanager routing to an on-call rotation, and dashboards. The rules and runbooks exist; nothing is routed.
  - [ ] Alert delivery to a real on-call rotation and ticketing system, and dashboards. Routing is proven only to local webhook receivers.
  - [ ] Alert delivery to a real on-call rotation and ticketing system, and a production dashboard instance. Routing is proven only to local webhook receivers, and the dashboard has been imported only into a local Grafana container, not a production instance.
- **Evidence:** a trace screenshot or export spanning all services and an alert fired in a failure drill.

### P3-03 Optional remote Control Plane connector
- **Verified locally:** authenticated discovery, digest and identity checks, optimistic promotion, signed delivery with replay and older-source rejection, SQLite and PostgreSQL rollout journals, poller backoff and jitter.
- **Still to prove:**
  - [ ] Production scheduling of the poller.
  - [ ] Comprehensive rollback protection across all stores.
  - [ ] Disconnected replication.
  - [ ] Comprehensive rollback protection across all stores. The connector's promotion floor can now be anchored outside the target database; other stores still rely on their own database's history. A restore test now measures the gap: restoring an older backup re-activates revoked tokens, lowers the release floor, re-grants revoked approvals and rewinds the audit log without detection ([kubernetes-data-plane.md](kubernetes-data-plane.md#restoring-an-older-backup)). Closing it needs an anchor outside each database, which is not built.
  - [x] Disconnected replication. Signed, version-bound promotion documents carried as files apply on a target with no network in order exactly once. Replayed, older, altered, relabelled, foreign or untrusted documents are refused, and a target restored behind its host-held floor is refused ([remote-control-connector.md](remote-control-connector.md#disconnected-replication)).
  - [ ] Production identity for source and target.
- **Evidence:** a source outage and recovery transcript, and a replay attempt rejected on the production target.

### P3-04 Kubernetes production deployment
- **Verified locally:** replicated Data Plane package, signed releases with a release floor, JWT and TLS variants, probes, draining, admission guard, kind rollout and recovery check, manifest hardening policy test.
- **Still to prove:**
  - [ ] Production identity provisioning and certificate operations.
  - [ ] High availability of the revocation and release-floor stores.
  - [ ] Independent rollback protection.
  - [ ] Broader admission enforcement beyond the example policy.
  - [ ] High availability of the revocation and release-floor stores. Both stores have a local failover drill on a synchronous standby (see P3-01): the revocation and the release floor survive promotion. Automatic failover and a production cluster do not.
  - [ ] Independent rollback protection. Measured, not solved: see P3-03 and the restore test.
  - [x] Broader admission enforcement beyond the example policy. Namespace-wide policies stop bare, relabelled or debugged Data Plane pods. They also block other workload kinds carrying the Data Plane template, rogue or exposed Services selecting it, and unpinned, privileged or host-access pods. A real API server passes 35 checks ([kubernetes-data-plane.md](kubernetes-data-plane.md)).
  - [ ] Control Plane, workers and durable stores deployed to the target cluster, validated there.
  - [ ] High availability of the revocation and release-floor stores. Both stores have a local failover drill on a synchronous standby (see P3-01): the revocation and the release floor survive promotion. Automatic failover and a production cluster do not.
  - [ ] Independent rollback protection. Measured, and solved only for the release floor as a library option (see P3-03 and the restore test).
  - [x] Broader admission enforcement beyond the example policy. Namespace-wide policies stop bare, relabelled or debugged Data Plane pods. They also block other workload kinds carrying the Data Plane template, rogue or exposed Services selecting it, and unpinned, privileged or host-access pods. A real API server passes 35 checks ([kubernetes-data-plane.md](kubernetes-data-plane.md)).
  - [ ] Control Plane, workers and durable stores deployed to the target cluster, validated there. An attempt on OpenShift Local did not get as far as deploying: the node was out of memory at 11 GB ([kubernetes-data-plane.md](kubernetes-data-plane.md#openshift-not-verified)).
- **Evidence:** a target-cluster validation run (rollout, node drain, pod loss, store failover) with versions recorded.

### P3-05 Service principals and delegated user identity
- **Verified locally:** scoped delegation with expiry and revocation checks, revisioned grant registry, request inbox and notification outbox, process-kill grant tests.
- **Still to prove:**
  - [ ] Production delivery of requests and notices.
  - [ ] Production identity for delegated users.
- **Evidence:** an end-to-end delegation with the real identity provider, including expiry and revocation taking effect during a run.

### P3-06 Durable human approval and consent
- **Verified locally:** SQLite approvals with expiry, history and exact-action gating, notification outbox, HTTPS receiver with scoped JWT, process-kill approval tests.
- **Still to prove:**
  - [ ] Production delivery of approval notices.
  - [ ] Production identity for approvers.
- **Evidence:** a real approver completing an approval through the production channel, with the audit record exported.

### P3-07 Trace, metrics, audit, quotas and budgets
- **Verified locally:** concurrency and daily-run limits, token and cost reservation ledger with uncertain-call reconciliation, lifecycle history, authorized gauges, cross-process reservation race test.
- **Still to prove:**
  - [ ] Provider-specific enforcement of limits on each model provider used.
  - [ ] Production-wide cost controls across nodes.
  - [ ] Provider-specific enforcement of limits on each model provider used. For OpenAI-compatible providers, `createOpenAILimitedToolModel` sends an output cap, refuses oversize prompts before dispatch, disables retries and uses the provider's reported usage; a real model server stopped at the cap and its reported usage added up ([durable-agent-runs.md](durable-agent-runs.md#optional-local-model-token-budget)). Still to do: the provider(s) the product will use in production, and any non-OpenAI-compatible provider.
  - [x] Production-wide cost controls across nodes. `PostgresAgentCostBudget` caps an agent's daily spend across every run and node sharing one PostgreSQL primary. Four processes with 16 concurrent callers admit exactly the budget in every one of 31 rounds, and a provider overrun stops all nodes ([durable-agent-runs.md](durable-agent-runs.md#shared-cost-budget-across-nodes)).
  - [ ] Production trace propagation and retention.
  - [ ] Broader metrics and production coordination.
- **Evidence:** a provider overrun test showing the provider-side cap holds and a multi-node cost test showing the budget is not exceeded.

### P3-08 Durable-store portability and crash acceptance
- **Verified locally:** process-kill tests for actions, token reservations, schedules, run leases, approvals, definitions, delegations, publication, the offline queue and staged submissions; PostgreSQL memory, definition and promotion kill tests; kind pod-deletion tests.
- **Still to prove:**
  - [ ] Production stores (not local SQLite or single-node kind).
  - [ ] Real provider contracts under crash.
  - [ ] Node failure and production pod recovery.
  - [ ] Production stores (not local SQLite or single-node kind). The PostgreSQL suites (the same 23 files as the main CI job, 64 tests) pass on PostgreSQL 14, 15, 16 and 17 with pgvector 0.8.7 (`postgres-versions.yml`, weekly); managed services and other engines are untested. A local PostgreSQL primary and standby (not a managed service) already survive a primary kill under load; see the node-failure item.
  - [ ] Production stores (not local SQLite or single-node kind). The PostgreSQL suites (the same 23 files as the main CI job, 65 tests in CI) pass on PostgreSQL 14, 15, 16 and 17 with pgvector 0.8.7 (`postgres-versions.yml`, weekly); managed services and other engines are untested. A local PostgreSQL primary and standby (not a managed service) already survive a primary kill under load; see the node-failure item.
  - [ ] Production stores (not local SQLite or single-node kind). The PostgreSQL suites (the same 23 files as the main CI job, 65 tests in CI) pass on PostgreSQL 14, 15, 16 and 17 with pgvector 0.8.7 (`postgres-versions.yml`, weekly); managed services and other engines are untested. The unit tests (993, 61 of them opt-in and skipped) and the same PostgreSQL suites also pass on native Linux arm64 runners (`arm64.yml`, weekly); a real arm64 node pool is untested. A local PostgreSQL primary and standby (not a managed service) already survive a primary kill under load; see the node-failure item.
  - [x] Real provider contracts under crash. Staged submissions and journaled actions are killed or lose responses against a real S3-compatible provider (SeaweedFS, signed requests), and the provider passes the idempotency contract check ([agent-action-journal.md](agent-action-journal.md#crash-recovery-against-a-real-provider), [business-data.md](business-data.md)).
  - [ ] Node failure and production pod recovery. Locally: survivor processes recover workers killed mid-dispatch on the shared PostgreSQL run registry exactly once, and a kind Deployment recovers a crashed worker pod with no duplicated effect ([durable-agent-runs.md](durable-agent-runs.md#scheduling-workers-on-the-shared-registry)). A kind cluster with two worker nodes also loses a whole node (container killed) while a worker holds runs: the Deployment replaces the pod, the surviving worker recovers the runs and every effect is applied once ([durable-agent-runs.md](durable-agent-runs.md)). A worker frozen with SIGSTOP past its lease, taken over and then resumed also dispatches and completes nothing (`postgres-run-nodes.test.mjs`). The PostgreSQL primary is also killed under a running two-worker workload and a synchronous standby promoted; all runs finish with every effect applied once (`postgres-run-failover.test.mjs`). Still to do: take down a node in production, and a real network partition between a node and the database.
- **Evidence:** the same crash scenarios replayed against the production stores with a node taken down, and the recovery outcomes compared with the local expectations.
