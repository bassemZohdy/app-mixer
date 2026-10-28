# Architecture Decision Register

| ID | Status | Direction |
|---|---|---|
| ADR-01 | Agreed product direction | Greenfield only; CLI for scaffolding/developer tooling |
| ADR-02 | Agreed product direction | Optional pluggable Control Plane; independent Data Plane |
| ADR-03 | Agreed product direction | Separate development and runtime agent permissions |
| ADR-04 | Agreed product direction | Typed atomic draft patches; immutable publication |
| ADR-05 | Agreed product direction | OpenAPI-first shared authorized capabilities |
| ADR-06 | Agreed product direction | AG-UI events and A2UI declarative UI |
| ADR-07 | Agreed product direction | Explicit state owners; two-level derived caches |
| ADR-08 | Agreed product direction | Optional internal data, staged writes and offline sync |
| ADR-09 | Agreed product direction | Scoped extension model; no arbitrary agent code |
| ADR-10 | Proposed implementation | TypeScript/Node.js, LangGraph.js default |
| ADR-11 | Proposed implementation | SQLite local, configurable production storage |
| ADR-12 | Proposed implementation | Apache-2.0 licensing; dependency review needed |

| ADR-13 | Agreed product direction | Configurable, independent persistent runtime agents; optional user binding; LangGraph.js with lifecycle, triggers, durable action layer ([ADR 0010](../adr/0010-configurable-persistent-agents.md)) |

Open decisions: renderer parity, protocol versions, identity delegation, offline conflict semantics, schema migration, cache invalidation, extension signing and central connector security.
