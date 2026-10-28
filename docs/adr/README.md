# Architecture Decision Records — App Mixer

This directory contains standalone Architecture Decision Records (ADRs). They document **decisions and rationale**, not proof that the corresponding feature has been implemented.

Status meanings: **Accepted** means the product architecture direction was agreed; **Proposed** means implementation details remain open; **Superseded** requires a replacement ADR. Record changes through new ADRs rather than silently rewriting decisions.

| ADR | Status | Topic |
|---|---|---|
| [0001](0001-greenfield-cli-boundary.md) | Accepted | Greenfield scope and CLI boundary |
| [0002](0002-optional-control-plane.md) | Accepted | Optional Control Plane and independent Data Plane |
| [0003](0003-declarative-application-lifecycle.md) | Accepted | Declarative definitions and publishing |
| [0004](0004-state-ownership-and-caching.md) | Accepted | State ownership and two-level caching |
| [0005](0005-api-first-capability-security.md) | Accepted | API-first shared capability layer |
| [0006](0006-agent-and-protocol-boundaries.md) | Accepted | Development/runtime agents, AG-UI and A2UI |
| [0007](0007-extensibility-and-platform-portability.md) | Accepted | Extension model and frontend portability |
| [0008](0008-application-data-and-offline-sync.md) | Accepted | Internal data, staged operations and offline sync |
| [0009](0009-deployment-and-technology-defaults.md) | Proposed | Deployment profiles and initial technology choices |

| [0010](0010-configurable-persistent-agents.md) | Accepted direction | Independent configurable persistent agents and durable activation/actions |

See [requirements](../specs/requirements.md), [architecture](../specs/architecture.md), [implementation plan](../specs/implementation-plan.md), [TODO](../../TODO.md), and [CHANGELOG](../../CHANGELOG.md).
