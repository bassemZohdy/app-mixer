# App Mixer — Architecture Baseline v0.4

## Logical planes
**Developer tooling:** CLI scaffolding, build/test and extension development. **Control Plane (optional):** Development Mode, Development Agent, OpenAPI discovery, draft repository, patch validation, preview, approvals, publication. **Data Plane (required):** application shell, runtime agent, published definition repository, capability registry, internal/external data providers, sync and caches.

```text
CLI → generated project
          ├── Control Plane (optional, co-located or remote)
          │     Developer chat → typed draft patch → validation → preview → publish
          └── Data Plane (standalone)
                published definitions → client/server cache → native UI
                user chat → runtime agent → authorized capability registry → API/data provider
```

No mandated microservices. Control Plane outages must not disable locally published pages.

## Protocols and integration
AG-UI transports agent messages, events and state updates; it is not durable storage. A2UI represents declarative UI; it is not the persistent application lifecycle. Framework manifest owns pages, navigation, data bindings, permissions, compatibility and versions. OpenAPI is the initial API discovery contract; imported operations become candidate capabilities, not automatically authorized tools. MCP/AsyncAPI are optional later adapters.

## Data and cache
Authoritative repositories: draft, published definition, agent state, business data and durable staged/offline operation queue. These may share a physical SQLite database locally while remaining logically isolated. Server cache holds validated published definitions/metadata. Client cache holds compatible published definitions/assets, scoped to app version, tenant and permissions. Offline business operations require explicitly enabled secure local storage, idempotency, retry and conflict policy. Staged operations require explicit submit.

## Extension model
Unified manifest: extension ID/version, scope, runtime and renderer compatibility, registered components/tools/providers, permission and configuration schema. Trust installed code; never execute arbitrary model-generated code. Development and runtime agents have distinct authorities.

## Deployment
Standalone Data Plane; integrated local development via Docker Compose; centrally managed Data Plane via optional authenticated Control Plane connector. Kubernetes, health probes, observability, secrets, backups and scaling are production targets.

## Architecture invariants
Publishing is the only draft-to-runtime promotion. Runtime cannot modify published definitions. UI and agents use the same server-authorized capabilities. App publication never submits staged business transactions. Agent/LLM outage does not disable conventional published pages when their data providers remain available.
