# ADR-0006 — Agent responsibilities and protocol boundaries

**Status:** Accepted · **Date:** 2026-10-28

## Context
Development needs application-authoring authority; runtime conversations must not mutate published definitions.

## Decision
Separate logical Development Agent and Runtime Agent with distinct permissions. AG-UI is the preferred agent/frontend event transport; A2UI is the preferred declarative UI representation. Neither protocol is the authoritative application repository. Agent framework and LLM are pluggable.

## Consequences
Need adapters, protocol compatibility tests and separate capability scopes. A2UI does not replace navigation, publishing or application lifecycle definitions.

## Validation
Runtime agent cannot publish; ordinary pages remain functional when either agent is unavailable.
