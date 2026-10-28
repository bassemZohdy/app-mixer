# App Mixer — Requirements Baseline v0.4

Status: design target, not implementation evidence. Scope: greenfield only.

## Product
- REQ-01: CLI scaffolds new applications and supports developer build tasks only; runtime management is not a CLI concern.
- REQ-02: Scaffold a conversational interface plus persistent pages, workspace and navigation.
- REQ-03: Target Angular, React, React Native and Flutter through interchangeable renderers; parity must be verified.
- REQ-04: Development Mode provides conversational creation, preview, validation, approval and publication.
- REQ-05: Runtime Mode executes immutable published versions, independently of Development Agent and optional central Control Plane.
- REQ-06: Optional pluggable Control Plane; standalone, local-integrated and centrally managed deployments.
- REQ-07: Development Agent emits typed, atomic, revision-aware patches against drafts; never directly mutates published definitions.
- REQ-08: Versioned declarative application manifest: pages, routes, components, navigation, data sources, actions, permissions and lifecycle.
- REQ-09: AG-UI for agent/frontend event transport; A2UI for declarative UI representation. Pin and verify protocol versions.
- REQ-10: OpenAPI-first operation discovery; import does not automatically grant execution rights.
- REQ-11: One authorized capability layer serves buttons and agent tools with common validation, policy and audit.
- REQ-12: Configurable LLM, database, identity and API providers, without mandatory proprietary services.
- REQ-13: Optional internal business store; explicit staged transactions; separately configured offline-first sync.
- REQ-14: Client and server caches of compatible published definitions; no LLM needed to render published pages.
- REQ-15: Extensible component, tool and provider registries with platform/development/application scopes.
- REQ-16: Docker Compose development profile and optional Kubernetes production deployment.
- REQ-17: Developer-owned generated code, fully open-source framework and reusable SDKs.

## State ownership
Published definitions: versioned repository. Drafts: Control Plane. Agent sessions/checkpoints: agent store. Business entities: owning external API or internal store. Transient UI: frontend. Pending staged/offline operations: durable sync store. Caches and AG-UI events are not sources of truth.

## Nonfunctional
Server-side authorization for all agent and UI operations; distinct development/runtime permissions; tenant/user cache isolation; immutable publication; rollback; idempotent replay and conflict resolution; observability, accessibility, localization, configuration/secrets isolation, schema compatibility and crash recovery.

## Acceptance journey
CLI creates project → developer imports OpenAPI or selects internal data → development agent proposes validated draft patch → preview/approve/publish → runtime serves published page with agent offline → user operates via UI or chat → staged/offline data is reconciled according to policy → new version published and rollbackable.

## Explicit exclusions
Brownfield migration, new workflow engine, new LLM, new identity provider, arbitrary agent-generated executable code, mandatory centralized platform. Requirements are not claims of delivered features.

## Persistent runtime agents (planned)
- REQ-18: Agent is an independent configurable, tenant-scoped entity; association to organization/team/app/service/user is optional and policy-driven, not hard-wired to one user.
- REQ-19: Configurable agent lifecycle manager, durable run/checkpoint recovery, event/webhook/schedule activation and idle suspension.
- REQ-20: Durable action intent/outcome logging, stable idempotency across restarts, reconciliation and human approvals for sensitive actions.
- REQ-21: Scoped configurable memory with retention, audit, deletion and separation across tenants, agents and authorized actors.
- REQ-22: Service and optionally delegated-user identity, authorization at every capability call, consent expiry, budgets and observability.
- REQ-23: Local and production deployment portability with independently runnable Data Plane; no mandatory new workflow engine.

Full proposed design and acceptance criteria: [Persistent Agents](persistent-agents.md). None of REQ-18–23 is claimed implemented.
