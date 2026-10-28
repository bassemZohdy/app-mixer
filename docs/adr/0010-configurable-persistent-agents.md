# ADR 0010: Configurable independent persistent agents

Status: **Accepted product direction** (implementation details proposed)
Date: 2026-10-28

## Context
App Mixer needs persistent, proactive and durable runtime agents. Binding every agent to one human user would prevent organization-level agents and service-triggered execution.

## Decision
An agent is an independently identified, tenant-scoped configurable resource. Its ownership/association is configurable (organization, team, application, service or individual); user context is optional, and impersonation/delegation is never assumed. Retain the independent Data Plane and optional Control Plane. Implement lifecycle, triggers, durable runs, scoped memory, human approval and an action journal around the default LangGraph.js orchestrator. All execution routes use the existing policy-enforced capability registry. Prefer sleep/reactivation to an always-on LLM process. No new workflow engine is mandated.

## Consequences and boundaries
Agent definition, run, principal, delegated user, memory scope, trigger and business transaction are distinct concepts. Recovery needs durable checkpoints and external idempotency/reconciliation; neither AG-UI nor A2UI supplies persistence. Scope access per tenant/agent and explicitly authorized actors. Support no-login service execution while requiring policy for sensitive actions. Keep local SQLite possible and production stores configurable. Preserve immutable application publication, offline/staged transaction boundaries and normal page operation during agent outages.

Detailed requirements and verification cases: [persistent agents specification](../specs/persistent-agents.md).