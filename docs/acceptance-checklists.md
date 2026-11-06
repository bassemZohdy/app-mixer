# Acceptance checklists for the open P2 and P3 tasks

Each open task in [TODO.md](../TODO.md) is partly built and verified locally. A task may be checked off only when every item under **Still to prove** has evidence attached. **Verified locally** names what the repository's own tests already establish, so it is not repeated on the target. Items need a real system (cluster, devices, identity provider, provider account); none can be established by the unit and local integration tests alone.

Evidence means a dated record that a reviewer can re-check: a CI run URL, a command transcript with the exact versions, or an audit export. A claim without evidence does not count.

## P2: portability and advanced data

### P2-01 Adapters and parity
- **Verified locally:** shared layout, binding, action and rejection fixtures run against the web, native and Flutter renderers; React, Angular, React Native for Web, Flutter VM and Flutter on Chrome in CI; a 1,500-message renderer fuzz test.
- **Still to prove:**
  - [ ] Broader React Native device tests on Android and iOS beyond the current nested-binding, rejection and bound-field-action cases.
  - [ ] Flutter exact layout dimensions, typography and accessibility parity against the web reference, measured on devices.
  - [x] Every catalog component and behavior present in the web catalog has a fixture exercised on all four adapters (2026-11-06). The fixtures cover all six components and every enum value, typing, bindings, actions and rejections. They run against the web renderer, the React and Angular bridges, the React Native store and its components through react-native-web, and the Flutter store. Flutter widgets and React Native on devices are checked separately (the items above).
- **Evidence:** CI run URLs per platform and a parity table listing each catalog component against each adapter.
- **Current fixture coverage** (shared fixtures in `adapters/flutter/test/fixtures/`; web and React Native store run in `packages/native/test/parity.test.mjs`, Flutter VM in `adapters/flutter/test/renderer_test.dart`):

  | Component | Shared fixtures that render it | Web | React Native store and components | Flutter VM | React, Angular |
  | --- | --- | --- | --- | --- | --- |
  | Text | bindings, layout, actions, text-field, variants (all seven variants and the default) | yes | yes | yes | yes (CI smoke) |
  | Column | layout, text-field, variants (every `justify` and `align` value) | yes | yes | yes | yes (CI smoke) |
  | Row | layout, variants (every `justify` and `align` value) | yes | yes | yes | yes (CI smoke) |
  | Card | layout | yes | yes | yes | yes (CI smoke) |
  | TextField | text-field (render, input, variant, removal); variants (both variants and the default); rejections | yes | yes | yes | yes (CI smoke) |
  | Button | actions; variants (every variant accepted and kept; no adapter draws them differently); rejections | yes | yes | yes | yes (CI smoke) |

  The React and Angular bridges replay the layout, variants, text-field, bindings, actions and rejections fixtures in their CI smoke tests (`.github/scripts/react-smoke.mjs` and `angular-smoke.mjs`, with real React 19.2 and Angular 19.2 in jsdom), comparing the DOM with the same expected trees through `.github/scripts/fixture-tree.mjs`. `native-web-smoke.mjs` replays the same six fixtures through the React Native components rendered by react-native-web 0.21, reading layout from their inline styles and text variants from their text styles. The React Native column covers the shared store and the components on react-native-web, not React Native on a device.

### P2-02 Extension SDK and compatibility manifests
- **Verified locally:** manifest and configuration validation, package digest verification (canonical spelling only), approval pinning and revocation lifecycle, hostile-key tests.
- **Still to prove:**
  - [x] Full SDK integration in a generated application using a third-party package built outside this repository. A package packed with `npm pack` outside the repository is installed into a generated app with npm, approved with a pinned digest of its tarball, published, rendered, used as a tool and revoked ([extensions.md](extensions.md#installing-a-third-party-package); the test's diagnostics are the transcript).
  - [ ] Production operational verification of the shared approval store: revocation latency under load and behaviour during a database outage.
- **Evidence:** a transcript of installing, approving, using and revoking an external package, and a revocation-latency measurement.

### P2-03 Internal data provider and staged external transactions
- **Verified locally:** SQLite provider, per-record authorization, staged submission that never auto-retries a possibly applied effect, process-kill recovery, JSON Schema validation and forms.
- **Still to prove:**
  - [x] Broader JSON Schema-driven forms for the schema features the form editor still rejects. Annotations, `default`, `readOnly`, `date`/`date-time`/`email` formats, discriminated unions, conflict-free `allOf` merging, scalar key/value dictionaries and object-array item titles are supported. Every remaining unsupported keyword has an owner decision (accepted 2026-11-06) in [business-data.md](business-data.md#json-schema-keywords-the-form-does-not-support).
  - [x] Verification of staged outcomes against at least one real external provider, including an ambiguous timeout. A self-hosted S3-compatible object store (SeaweedFS, signed requests) behind a fault-injecting proxy: lost responses, lost requests and a lost response after `not_applied` all reconcile with exactly one object per intent ([business-data.md](business-data.md)). The CI job log of that step is the transcript; a hosted SaaS sandbox was not used.
- **Evidence:** the list of unsupported keywords with the decision for each, and a provider sandbox transcript showing an ambiguous result reconciled without a duplicate effect.

### P2-04 Offline-first queue
- **Verified locally:** durable queue, deduplication, bounded retries, conflict and uncertain states, process-kill recovery, encrypted browser storage with key rotation and cross-tab fencing, a rollback anchor with an authenticated digest of all queue envelopes, PostgreSQL shared keys.
- **Still to prove:**
  - [ ] Offline provisioning of a device that has never been online.
  - [ ] Mobile storage on iOS and Android, including eviction and backup/restore.
  - [x] Rollback protection verified against a real host floor (a server record or platform secure storage) in a browser. A real headless browser with a restored copy of its own profile is refused by the queue and the request-identity store against floors held by a server ([offline-queue.md](offline-queue.md#real-browser-restore-test)). The queue, request-identity and generation databases all detect restored or partly restored storage when given a rollback anchor; the identity stores' counters are not authenticated because those stores hold no key.
  - [x] Migration of clients older than the fixed-version IndexedDB fence. Retained builds of the first and last version-1 clients and the last version-2 client write queue and publication data that the current client opens, resumes and rotates, after which those builds are fenced out (`packages/web/test/offline-legacy-clients.test.mjs`).
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
  - [x] Distributed run-quota enforcement across nodes. Two processes with separate PostgreSQL pools exceed the concurrency and daily limits at the same instant for 20 rounds (1,200 attempts); every round admits exactly the limit and the database records exactly that ([durable-agent-runs.md](durable-agent-runs.md#shared-run-slots)).
- **Evidence:** a multi-node quota test that exceeds the limit from two nodes simultaneously and a record that exactly the limit was admitted.

### P2-07 Lifecycle manager and durable run registry
- **Verified locally:** run registry, lease claim, renewal and fencing, expiry, pause, resume and cancel, process-kill lease recovery, PostgreSQL run slots.
- **Still to prove:**
  - [ ] Production scheduling of workers.
  - [x] A shared (non-SQLite) run registry. `PostgresAgentRuns` keeps runs and a lease-fenced action journal on one PostgreSQL primary. Workers killed mid-dispatch are recovered exactly once by racing survivor processes, with no duplicated external effect ([durable-agent-runs.md](durable-agent-runs.md#shared-run-registry-across-nodes)).
  - [x] Safe replay of external effects after recovery against a real provider. A worker killed before the write, after an applied write with a lost response, or after recording, recovers against a real S3-compatible provider with exactly one effect ([agent-action-journal.md](agent-action-journal.md#crash-recovery-against-a-real-provider)).
  - [ ] Production coordination between nodes, including node failure. Separate processes sharing PostgreSQL pass the node-failure test locally and in CI; a production multi-node deployment is still unproven.
- **Evidence:** a node-failure test report showing runs recovered exactly once and no duplicated external effect.

### P2-08 Event, webhook and scheduler activation
- **Verified locally:** signed ingress with key rotation and deduplication; GitHub, Shopify, GitLab, Stripe, Slack, Twilio, Linear, PagerDuty, Sentry, Paddle and Standard Webhooks adapters; cron schedules with time zones, names and exclusions; process-kill schedule tests; a two-process race test showing schedule workers that share one store fire each occurrence once.
- **Still to prove:**
  - [ ] Each provider adapter against that provider's live or sandbox delivery, including a retry.
  - [ ] Additional providers the product commits to supporting.
  - [x] Distributed coordination of schedule firing across nodes. `PostgresAgentSchedules` fires each occurrence once across nodes; two processes with one killed mid-run fire every one-second occurrence exactly once with no gaps ([agent-schedules.md](agent-schedules.md#shared-schedules-across-nodes)). Handing a fired run to an executor is at least once until a shared run registry exists (P2-07). `PostgresAgentRuns.create` now refuses a second run for a reclaimed request.
- **Evidence:** one captured live delivery per provider verified by the adapter, and a two-node schedule test showing a single fire per occurrence.

### P2-09 Action journal and reconciliation
- **Verified locally:** lease-fenced journal with stable keys, explicit reconciliation, recovery workers, a worker host that drains them on shutdown, evidence records, process-kill and cross-process race tests, idempotency conformance helper.
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
- **Evidence:** the labelled dataset (reviewed), the evaluation report for each mode, and the agreed thresholds.

## P3: production

### P3-01 Identity, authorization, audit and isolation
- **Verified locally:** RS256 and ES256 (P-256) JWT authentication, key rotation, JWKS refresh with staleness limits, revocation, capability audit, TLS credential reload.
- **Still to prove:**
  - [ ] Deployment-grade availability of revocation and audit stores.
  - [ ] Certificate issuance and trust rotation in the target environment.
  - [ ] Identity provisioning and deprovisioning through the real identity provider.
- **Evidence:** an outage drill (store down, requests fail closed), a certificate rotation transcript, and a deprovisioning test showing access ends within the stated bound.

### P3-02 Observability and operational controls
- **Verified locally:** liveness and readiness probes, draining, bounded metrics with fixed labels (fuzz-tested), scrape server, optional OpenTelemetry spans, cluster tests for scope, tenant and outages. One trace exported over OTLP to a real OpenTelemetry Collector container spans a browser-originated span, the generated workspace process, the Data Plane, the capability service and the Control Plane, with no tokens or inputs in the export ([collector test](data-plane-observability.md#collector-integration-test)). Prometheus alert rules for the Data Plane and agent metrics, one runbook per alert ([runbooks.md](runbooks.md)), a test that every rule uses only emitted metrics and label values, and a failure drill in which a real Prometheus scrapes the real metrics servers and fires scrape-failure, schedule-backlog, overdue-run, uncertain-action and stuck-draining alerts; a real Alertmanager routes them through the example routing tree to page and ticket webhook receivers and sends resolved notices after recovery. Both container tests pass on Windows and on Linux as an unprivileged user.
- **Still to prove:**
  - [x] Cross-service tracing that starts in a real browser with a browser OpenTelemetry SDK: headless Chrome or Edge runs the web SDK and the collector receives one connected trace (2026-11-06). App Mixer ships no browser instrumentation; the traced page is the test's.
  - [ ] Production transport and deployment integration of metrics and traces.
  - [ ] Alert delivery to a real on-call rotation and ticketing system, and dashboards. Routing is proven only to local webhook receivers.
- **Evidence:** a trace screenshot or export spanning all services and an alert fired in a failure drill.

### P3-03 Optional remote Control Plane connector
- **Verified locally:** authenticated discovery, digest and identity checks, optimistic promotion, signed delivery with replay and older-source rejection, SQLite and PostgreSQL rollout journals, poller backoff and jitter.
- **Still to prove:**
  - [ ] Production scheduling of the poller.
  - [ ] Comprehensive rollback protection across all stores. The connector's promotion floor can now be anchored outside the target database; other stores still rely on their own database's history.
  - [ ] Disconnected replication.
  - [ ] Production identity for source and target.
- **Evidence:** a source outage and recovery transcript, and a replay attempt rejected on the production target.

### P3-04 Kubernetes production deployment
- **Verified locally:** replicated Data Plane package, signed releases with a release floor, JWT and TLS variants, probes, draining, admission guard, kind rollout and recovery check, manifest hardening policy test.
- **Still to prove:**
  - [ ] Production identity provisioning and certificate operations.
  - [ ] High availability of the revocation and release-floor stores.
  - [ ] Independent rollback protection.
  - [ ] Broader admission enforcement beyond the example policy.
  - [ ] Control Plane, workers and durable stores deployed to the target cluster, validated there.
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
- **Verified locally:** concurrency and daily-run limits, token and cost reservation ledger with uncertain-call reconciliation, lifecycle history, authorized gauges (including schedule backlog and actions awaiting reconciliation), cross-process reservation race test.
- **Still to prove:**
  - [ ] Provider-specific enforcement of limits on each model provider used.
  - [ ] Production-wide cost controls across nodes.
  - [ ] Production trace propagation and retention.
  - [ ] Broader metrics and production coordination.
- **Evidence:** a provider overrun test showing the provider-side cap holds and a multi-node cost test showing the budget is not exceeded.

### P3-08 Durable-store portability and crash acceptance
- **Verified locally:** process-kill tests for actions, token reservations, schedules, run leases, approvals, definitions, delegations, publication, the offline queue and staged submissions; PostgreSQL memory, definition and promotion kill tests; kind pod-deletion tests.
- **Still to prove:**
  - [ ] Production stores (not local SQLite or single-node kind).
  - [x] Real provider contracts under crash. Staged submissions and journaled actions are killed or lose responses against a real S3-compatible provider (SeaweedFS, signed requests), and the provider passes the idempotency contract check ([agent-action-journal.md](agent-action-journal.md#crash-recovery-against-a-real-provider), [business-data.md](business-data.md)).
  - [ ] Node failure and production pod recovery.
- **Evidence:** the same crash scenarios replayed against the production stores with a node taken down, and the recovery outcomes compared with the local expectations.
