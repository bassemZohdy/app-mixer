# TODO — App Mixer

## Overall progress

**10 / 31 tasks complete (32%)**

`██████░░░░░░░░░░░░░░`

Progress counts checked items equally; a task is complete only after verification.

## P0: foundation verification
- [x] P0-01 Run clean npm install/build/test; fix failures
- [x] P0-02 Add CI workflow and generated-app smoke test
- [x] P0-03 Verify complete Apache-2.0 LICENSE and dependency license compatibility
- [x] P0-04 Capture product requirements, architecture, decisions and roadmap in docs/specs
- [x] P0-05 Review initial scaffold security and runtime behavior

## P1: working vertical slice
- [x] P1-01 SQLite definition repository and immutable published versions
- [x] P1-02 Isolated Control Plane and Data Plane APIs
- [x] P1-03 A2UI-compatible component registry and web renderer (initial six-component catalog; [scope and limitations](docs/a2ui-renderer.md))
- [x] P1-04 AG-UI adapter with configurable LLM and LangGraph.js (initial text-only integration; [scope and limitations](docs/agent-adapter.md))
- [x] P1-05 Development Agent typed patches, preview and approval/publish (local in-memory workflow; [scope and limitations](docs/development-proposals.md))
- [ ] P1-06 OpenAPI import and authorized capability registry (discovery and registry foundation: [scope and remaining work](docs/capability-registry.md))
- [ ] P1-07 Two-level published definition cache and invalidation
- [ ] P1-08 Docker Compose and agent-outage acceptance test

## P2: portability and advanced data
- [ ] P2-01 Angular/React/React Native/Flutter adapters and parity checks
- [ ] P2-02 Extension SDK and compatibility manifests
- [ ] P2-03 Internal data provider and staged external transactions
- [ ] P2-04 Offline-first queue, idempotency and conflict handling
- [ ] P2-05 Schema migration, rollback and environment promotion

## P3: production
- [ ] P3-01 Identity, authorization, audit and isolation
- [ ] P3-02 Observability and production operational controls
- [ ] P3-03 Optional remote Control Plane connector
- [ ] P3-04 Kubernetes production deployment

## P2: persistent agent foundation (new, pending)
- [ ] P2-06 Define configurable independent agent entity, scope/ownership and versioned manifest (PA-01)
- [ ] P2-07 Implement agent lifecycle manager, durable run registry, pause/resume/cancel and recovery (PA-02, PA-04)
- [ ] P2-08 Add event/webhook and scheduler activation, authenticated ingress, trigger dedup and concurrency limits (PA-03)
- [ ] P2-09 Build durable action intent/outcome journal, stable idempotency and uncertain-result reconciliation (PA-05)
- [ ] P2-10 Implement configurable memory adapters, isolation, retention and provenance (PA-06)

## P3: persistent agent security and operations (new, pending)
- [ ] P3-05 Support service principals and optional delegated user identity with policy checks and expiry handling (PA-07)
- [ ] P3-06 Durable human approval/consent, expiration and audited decisions (PA-08)
- [ ] P3-07 Agent trace/metrics/audit, quotas, budgets and administrative operational controls (PA-09)
- [ ] P3-08 Production durable-store/worker portability, crash/restart and tenant-isolation acceptance tests (PA-10)

Persistent-agent details: [requirements and architecture](docs/specs/persistent-agents.md), [ADR 0010](docs/adr/0010-configurable-persistent-agents.md). These are *planned* tasks, not implemented features.

A checked item means documentation or implementation is verified; future requirements are not completed merely by being described.
