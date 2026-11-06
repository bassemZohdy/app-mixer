# Changelog

All notable changes to App Mixer are tracked here. Version numbers describe repository development, not released production features.

## [Unreleased] — 2026-10-28
### Fixed
- The PostgreSQL memory store quotes the identifiers it must place in index predicates and expressions through one validating helper (`sqlLiteral`) instead of interpolating them, and a test checks that every quoting character is refused.
- `PostgresAgentSchedules.fireDue` bounds its rescans (`maxScans`) and reports `scans` and `backlog`, so heavy contention or a long catch-up no longer rescans the due list without limit.
- `DevelopmentAgent` works on schema version 2 drafts (page descriptions, extension references and operations, `Extension` components); it previously refused every draft that was not version 1, including applications migrated to version 2.
- `DevelopmentProposals` no longer refuses new proposals forever after 100 have been created: only pending proposals count toward the limit and settled ones are evicted beyond a `settledLimit` bound.
- Capability refusals that happen before any effect (not found, forbidden, invalid input, a throwing policy, a failed attempt audit, and the configured runtime's own activity and delegation checks) no longer leave the agent action `uncertain` and the run awaiting operator reconciliation: `CapabilityRegistry` marks such errors with `Symbol.for('app-mixer.effect') === 'none'`, and both action journals return the action to `ready` (or `failed` once attempts are exhausted) and rethrow the original error. Unmarked dispatch errors stay uncertain.
- The CLI runs as a command on Windows: the entry was detected with a forward-slash suffix of `process.argv[1]`, so `node packages\cli\dist\index.js create demo` exited 0 without creating anything. The entry is now compared by resolved path.
- The offline queue's rollback anchor now detects selective substitution or deletion of individual item envelopes, not only whole-partition restores. The counter record carries an authenticated digest of every envelope, checked at open, on `list()` and before each write.
- Run and schedule configuration must be own plain data; schedules reject inherited fields with the controlled error instead of a raw TypeError.
- Agent manifests must be plain JSON data; values that satisfied validation through inherited fields, accessors or class instances are now rejected.
- Extension integrity digests must now use the canonical base64 spelling; non-canonical spellings that decoded to the same bytes were previously accepted.
### Added
- A generated documentation index (`npm run docs` writes `docs/README.md`), linked from the README, and a test that every Markdown file under `docs/` is reachable from the README; the stale M0 roadmap, requirements and architecture stubs were removed (the specifications under `docs/specs` remain) and the README status paragraph was refreshed.
- CI hygiene: superseded runs on the same ref are cancelled, every job has a timeout, and the Kubernetes, agent pod recovery, Flutter and React Native workflows also run on pushes to `main` and weekly; a test checks all three.
- `CONTRIBUTING.md` (build, test and the opt-in test matrix with the commands CI runs), `SECURITY.md`, `.github/CODEOWNERS`, `.nvmrc` and issue and pull request templates; a test fails when a documented opt-in variable goes missing from the guide.
- `npm run todo` (`scripts/todo-progress.mjs`) derives the TODO progress header, bar and phase table from the task checkboxes; `--check` fails when the file is stale, and a test enforces it.
- A shared accessibility and typography reference checked on the web renderer (real browser accessibility tree), React Native through react-native-web, and Flutter in the VM and on Android and iOS emulators. Flutter headings now expose their level, and React Native headings pass `aria-level`.
- An opt-in end-to-end identity test against Keycloak (run in CI): delegation, expiry and revocation during a run, revocation at the provider, approval through the review API and HTTPS notice delivery, all with provider-issued tokens.
- A draft labelled memory evaluation set (pending owner review) and a PostgreSQL test that reports every retrieval mode among 900 distractors, compares HNSW with exact search and checks proposed floors.
- Discord interactions (Ed25519) and SendGrid Event Webhook (ECDSA P-256, with key rotation) adapters for agent event ingress, covered by ingress tests and the hostile-input fuzz test.
- Disconnected replication: `exportDisconnectedPromotion` writes a signed, version-bound promotion document for transfer on removable media, and `createDisconnectedPromotionImporter` applies it on a target with no connection to the source, refusing replays, older, altered or foreign documents and restored targets.
- Offline provisioning for devices that have never been online: `signOfflineProvisioning` and `verifyOfflineProvisioning` in core, and `openOfflineProvisioning` in `@app-mixer/web/offline-provisioning`, which verifies a signed grant and release with WebCrypto Ed25519 without network access. Tested in Node and in a real headless browser across a restart.
- Namespace-wide Kubernetes admission policies around the Data Plane Deployment: only the controllers create Data Plane ReplicaSets and pods, pods cannot be relabelled into the Data Plane or debugged, only the approved ClusterIP Service selects it, and every pod uses pinned, unprivileged images without host access. 35 checks run against a real API server in the Kubernetes workflow.
- `PostgresAgentCostBudget` caps an agent's daily model spend across runs and nodes on the shared PostgreSQL run registry. Reservations are lease-fenced and admitted under one per-agent lock, a provider overrun stops every node, and runs with open reservations settle as uncertain. A four-process race admits exactly the budget every time.
- `PostgresRunSupervisor` schedules durable-run workers on the shared PostgreSQL registry. Each pass recovers expired leases after a grace period, verifies interrupted actions and retries or fails runs, then claims runs and executes them with lease renewal. It drains on stop. A two-replica Kubernetes Deployment test in kind crashes a worker mid-run and rolls the Deployment, and every external effect is applied exactly once.
- An operational test of the shared extension approval store: two nodes under concurrent load see a revocation on every check that starts after it commits (latency recorded), and a node that loses its database fails closed and then sees a revocation made during the outage.
- `PostgresAgentRuns` and `PostgresAgentActionJournal` share the run registry and a lease-fenced action journal across nodes on one PostgreSQL primary, with database-time leases, cross-node concurrency and daily limits, and duplicate run IDs refused. A test kills two workers mid-dispatch and shows racing survivors recover each run exactly once with no duplicated external effect.
- `PostgresAgentSchedules` shares schedules across nodes on one PostgreSQL primary: firing locks the schedule and records one durable run request per occurrence, `fireDue` polls with catch-up, and run requests are claimed under database-time leases. A two-process test with one node killed shows each occurrence fired once with no gaps.
- A multi-node quota test (PostgreSQL CI job) releases two processes with separate pools against one agent's concurrency and daily run limits at the same instant over 20 rounds and checks that exactly the limit is admitted and recorded each time.
- A test installs a third-party extension package (built and packed outside the repository) into a generated app with npm, approves it with a pinned tarball digest, publishes, renders and invokes it, then revokes it; its diagnostics are the lifecycle transcript.
- An opt-in process-kill test (`APP_MIXER_TEST_S3=docker`, run in CI) kills a worker before, during and after a journaled action's write to a real S3-compatible provider and checks that recovery reconciles it with exactly one effect; the provider also passes the idempotency contract check.
- An opt-in test (`APP_MIXER_TEST_S3=docker`, run in CI) submits staged intents to a real S3-compatible provider (SeaweedFS, SigV4) through a proxy that loses responses or requests, and checks that every ambiguous outcome reconciles with exactly one object per intent.
- Retained builds of the first and last IndexedDB version-1 offline clients and the last version-2 client, with a test that their queued work and cached publications migrate to the current client, resume, rotate keys, and that those builds are fenced out afterwards.
- An opt-in real-browser test (`APP_MIXER_TEST_BROWSER=1`, run in CI) restores an older copy of a headless Chrome or Edge profile and checks that the offline queue and request-identity store refuse it against server-held rollback floors, with a control showing the same profile opens without the floor.
- Record forms merge `allOf` parts when merging cannot change what the schema accepts and reject the rest, edit objects with a scalar `additionalProperties` schema or one `patternProperties` schema as key/value entries, and use an object-array item's `title` as its legend. Every remaining unsupported keyword now has a recorded owner decision.
- Optional `promotionFloorAnchor` for the remote Control Plane connector detects a restored or replaced target database by comparing its retained promotion floor with a host-held floor before fetching.
- Agent metrics can report due-but-unfired schedules with the oldest one's age, and journaled actions by state, so a stalled schedule or recovery worker is visible.
- `AgentWorkerHost` runs schedule, recovery and notice workers in one process, rolls back a partial start, drains them in parallel with a bounded stop on SIGTERM or SIGINT, and exposes readiness.
- Shared TextField fixture (rendering, data-model updates, user input, the long-text variant and removal) checked on the web renderer, the React Native store and the Flutter VM renderer, plus a component-by-adapter parity table in the acceptance checklists.
- The offline request-identity and shared-generation stores accept the queue's `rollbackAnchor` and detect a restored profile, a substituted row or a deleted counter.
- Prometheus alert rules (`deploy/observability/prometheus-alerts.yml`) and a runbook per alert (`docs/runbooks.md`), an example Alertmanager routing tree (`deploy/observability/alertmanager-example.yml`), a test tying each rule to emitted metrics, and a failure drill through real Prometheus and Alertmanager (opt-in locally, run in CI).
- The React Native components (through react-native-web) replay the same six shared fixtures.
- The React and Angular bridge smoke tests replay the shared layout, variants, text-field, bindings, actions and rejections fixtures.
- Shared variants fixture covering every catalog enum value (Text and TextField variants, every Row and Column `justify` and `align`, Button variants) on the web renderer, the React Native store and the Flutter VM renderer.
- Collector integration test variant in which the trace starts in real headless Chrome or Edge running the OpenTelemetry web SDK.
- Collector integration test exporting one OTLP trace across browser, workspace, Data Plane, capabilities and Control Plane to a pinned OpenTelemetry Collector container (opt-in locally, run in CI); the exporter packages are CLI development dependencies only.
- JSON Schema record forms show a scalar property's `description` as accessible help text in the editor and preview.
- JSON Schema record forms support `$comment`, `deprecated`, `examples`, object and array `description`, scalar array item `title`, `default` for new records, `readOnly`, `format` `date`/`date-time`/`email` (also checked by the server validator through `RECORD_FORMATS`), and one discriminated `oneOf`/`anyOf` per object.
- Two-process race test showing schedule workers that share one store fire each due occurrence exactly once.
- Credential fuzz test for JWT-authenticated capability calls.
- Hostile HTTP fuzz test for the Control Plane and Data Plane boundaries.
- Hostile-source fuzz test for the remote Control Plane connector.
- Hostile-input fuzz test covering all eleven webhook adapters.
- Sentry integration webhook adapter for agent event ingress (signed body, installation pinning, resource from signed data) with tests.
- Paddle Billing webhook adapter for agent event ingress (ts-bound signature, rotation, replay window, signed event-ID deduplication) with tests.
- Acceptance checklists for the 18 open P2/P3 tasks (what remains to be proven on real systems, and the evidence required).
- Cross-process race tests, a web renderer fuzz test and metrics/digest fuzz tests.
- Process-kill acceptance tests for publication/rollback, the offline queue and staged external submissions; Kubernetes workload manifest policy test.
- Process-kill acceptance tests for SQLite agent definition versions and delegation grants.
- Process-kill acceptance tests for durable approvals (request and decision persistence, single decision, expiry).
- Process-kill acceptance test for durable run lease expiry, recovery and old-token fencing.
- Process-kill acceptance test for agent schedule firing before and after commit.
- Agent schedule cron accepts 7 as Sunday and three-letter month/weekday names, with tests.
- ES256 (P-256) access-token verification and JWKS key selection for JWT capability authentication, with validation and algorithm-confusion tests.
- Linear webhook adapter for agent event ingress (signed body, replay window, workspace pinning) with tests.
- Binary-relevance nDCG (`ndcg`, `meanNdcg`) in the agent memory retrieval evaluation report, with a hand-computed test.
- PagerDuty v3 webhook adapter for agent event ingress (multi-signature rotation, signed event-ID deduplication) with tests.
- Initial TypeScript monorepo with core application definitions and greenfield CLI.
- In-memory draft validation, revision-aware typed patches and publication.
- Minimal standalone HTTP web shell with static workspace and chat placeholder.
- Unit tests for core and scaffolding (execution not yet verified).
- Consolidated requirements, architecture, application model, decisions and milestone plan under `docs/specs/`.
- Root TODO and CHANGELOG.

### Not implemented
AG-UI/A2UI runtime integration, real agent, durable database, two-level caching, OpenAPI capabilities, production security, offline synchronization, multi-framework renderers and deployment profiles.

## [0.0.0] — Project inception
Greenfield-only, open-source, API-first Agentic Application Framework concept established.
