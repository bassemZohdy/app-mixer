# Implementation Plan — initial milestones

## M0 Foundation
Verify npm install/build/tests and generated HTTP app. Add CI, complete license text, documentation and dependency review. Exit: reproducible green build.

## M1 Working agent-native slice
1. Durable SQLite draft and published definition repositories.
2. Control Plane draft/preview/publish APIs and independent Data Plane read API.
3. Registered A2UI-compatible web renderer.
4. Configurable LangGraph.js runtime agent and AG-UI streaming; deterministic mock tests.
5. Development Agent typed patch proposals and approval UI.
6. OpenAPI capability registry with server-side authorization and one sample REST API.
7. Server/client published-definition caching and LLM-outage test.
8. Docker Compose local profile.

Exit: scaffold → converse to create page → preview → publish → use page with LLM unavailable.

## M2 Portability and data
Angular, React, React Native and Flutter adapters; component compatibility tests; extension SDK; internal business store; staged transactions and offline synchronization; version migration and rollback.

## M3 Production hardening
OIDC, scoped authorization, audit, telemetry, tenant isolation, secure cache, offline conflict UX, optional central Control Plane connector and Kubernetes packaging.

Prioritize vertical end-to-end functionality over extra microservices. Do not claim features complete without tests and evidence.
