# Changelog

All notable changes to App Mixer are tracked here. Version numbers describe repository development, not released production features.

## [Unreleased] — 2026-10-28
### Fixed
- The offline queue's rollback anchor now detects selective substitution or deletion of individual item envelopes, not only whole-partition restores. The counter record carries an authenticated digest of every envelope, checked at open, on `list()` and before each write.
- Run and schedule configuration must be own plain data; schedules reject inherited fields with the controlled error instead of a raw TypeError.
- Agent manifests must be plain JSON data; values that satisfied validation through inherited fields, accessors or class instances are now rejected.
- Extension integrity digests must now use the canonical base64 spelling; non-canonical spellings that decoded to the same bytes were previously accepted.
### Added
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
