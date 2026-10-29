# Persistent Agents — requirements and architecture (proposed implementation)

Status: partially implemented. The local versioned definition store, host-authorized ephemeral runtime, durable run registry, host-driven worker, lease-fenced SQLite checkpoints, action journal and local authenticated event ingress are available; automatic recovery and the remaining capabilities are planned. Applies to Runtime/Data Plane. The agent is an **independent, configurable entity**, not intrinsically owned by an individual user. An agent may be bound at deployment to an organization, tenant, team, application, service identity, or individual user according to policy.

## Functional requirements
- PA-01 Agent identity and configuration: stable agent ID, tenant/organization scope, owner/administrators, runtime configuration, allowed capabilities, model/provider, lifecycle policy, quotas and optional user association. User binding is one configuration, never the hard-coded default.
- PA-02 Lifecycle manager: create/configure, enable, suspend, resume, cancel, archive and inspect durable agent runs; separate agent definition, scheduled activation and execution instance.
- PA-03 Event and scheduler triggers: cron/timer, webhook and typed domain events; deduplicate triggers, authorize sources and configure concurrency/backpressure. Agents sleep between invocations; a constantly running LLM loop is not required.
- PA-04 Durable execution: LangGraph.js checkpoints plus run status and recovery after process/pod failure, with bounded retries, deadlines, leases and cancellation.
- PA-05 Durable action layer: persist intent and outcome, stable idempotency keys across restart epochs, safe recovery for ambiguous external responses, retry policy and reconciliation/manual intervention. Checkpointing alone does not guarantee exactly-once external side effects.
- PA-06 Memory: scoped session, semantic, episodic and procedural memory as optional independently configurable stores; retention, provenance, deletion/export and access isolation.
- PA-07 Authority: service and delegated-user identities supported with least-privilege scoped authorization at **every** capability invocation; no implicit inherited permissions, tenant crossover or unattended privilege escalation. Expiring user delegation pauses affected steps and requests renewal.
- PA-08 Human approval: configurable approvals and consent for sensitive operations; survive restarts, expire safely and permit audited rejection/cancellation.
- PA-09 Operations: observable state transitions, correlation IDs, audit, metrics, tracing, budgets, token/cost limits and administrative controls.
- PA-10 Portability: local SQLite prototype, pluggable production durable store and deployable workers; no mandatory proprietary infrastructure or separate workflow engine.

## Architectural placement
- Optional Control Plane manages definitions/configuration and authorized administration; standalone Data Plane remains capable of running previously published agents without Control Plane connectivity.
- Data Plane hosts lifecycle manager, event ingress/scheduler, durable run/checkpoint store, memory adapters, action journal and workers. LangGraph.js remains the default execution orchestrator.
- AG-UI streams user-visible events, A2UI renders declarative views; neither is durable source of truth. Existing application publication and conventional pages remain independent of agent availability.
- Distinguish identity scopes: tenant ID, agent ID, run ID, actor/service principal, optional delegated user, permission snapshot/version. Propagate and verify all scopes at every boundary.
- Separate business data, staged/offline transactions, agent checkpoints, memories, trigger inbox and action journal logically even when co-located in SQLite during development.

## Delivery sequence and acceptance
1. Agree configuration schema, identity/scope and state-machine interfaces.
2. Prototype local persistent runs/checkpoint recovery and admin lifecycle.
3. Implement event/scheduled activation with deduplication, concurrency and authentication.
4. Implement durable action journal and fault injection; no duplicate external effects for supported idempotent operations.
5. Add scoped memory and HITL approvals; demonstrate cross-user/tenant isolation.
6. Productionize OIDC/delegation, durable scalable workers, budgets, tracing and backups.

Acceptance scenarios: independently configured organization agent executes without a logged-in user; separately configured personal agent cannot read organization-private memory without authorization; webhook and schedule reactivate paused agent; restart at each action boundary does not duplicate a committed side effect; expired delegation pauses until authorized renewal; an unavailable Control Plane does not halt independent published Data Plane runs; existing published UI works during agent outage.

See [persistent-agent definitions](../persistent-agent-definitions.md), [durable agent runs](../durable-agent-runs.md), [action journal](../agent-action-journal.md), [event ingress](../agent-event-ingress.md), [ADR 0010](../adr/0010-configurable-persistent-agents.md) and [TODO](../../TODO.md).