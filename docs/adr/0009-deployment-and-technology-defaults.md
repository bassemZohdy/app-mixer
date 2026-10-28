# ADR-0009 — Cloud-native deployment and initial defaults

**Status:** Proposed · **Date:** 2026-10-28

## Context
App Mixer should be easy to start locally but support independently deployable cloud-native components.

## Proposal
Use TypeScript/Node.js as the initial implementation stack, potentially LangGraph.js as default agent runtime and SQLite as lightweight local persistence. Provide Docker Compose development profile and optional Kubernetes production packaging. LLM, database, identity and cache providers remain configurable. Do not mandate microservices or Kubernetes locally.

## Alternatives and open questions
Agent runtime adapter choice; SQLite versus other embedded stores; production DB/cache adapters; precise AG-UI/A2UI version compatibility; Helm versus plain manifests; license verification.

## Decision gate
Promote this ADR to Accepted only after a working vertical slice, reproducible tests, dependency/license checks and deployment evidence.
