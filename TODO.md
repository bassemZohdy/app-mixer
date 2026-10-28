# TODO — App Mixer

## Overall progress

**9 / 22 tasks complete (41%)**

`█████████░░░░░░░░░░░░░`

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
- [ ] P1-05 Development Agent typed patches, preview and approval/publish
- [ ] P1-06 OpenAPI import and authorized capability registry
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

A checked item means documentation or implementation is verified; future requirements are not completed merely by being described.
