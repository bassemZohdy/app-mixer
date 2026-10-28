# Architecture baseline

App Mixer is a **greenfield** framework. The CLI scaffolds projects and performs development tooling only. The **Control Plane** owns development drafts, typed atomic patches, preview, approvals and publishing. A **Data Plane** serves published immutable application definitions, conventional pages and runtime agent interactions. A central Control Plane is an **optional plugin**, not a runtime dependency.

The intended event/UI standards are AG-UI and A2UI (integration pending). OpenAPI-first capability discovery must produce shared authorized operations for conventional buttons and agent tools. Application definitions, development drafts, conversation checkpoints, business data, frontend transient state and durable synchronization operations retain separate authoritative owners.

Planned extensibility: platform/development/application extensions, registered component catalog, integration adapters and cross-platform renderers. Cache published compatible page definitions at client and server layers, without making caches authoritative.

Deploy with Docker Compose locally and optional Kubernetes in production. No mandated microservices.
