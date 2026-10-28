# ADR-0001 — Greenfield scope and CLI responsibility

**Status:** Accepted · **Date:** 2026-10-28

## Context
The framework must be reusable without becoming a brownfield migration platform. The CLI resembles Angular CLI and must not act as a production administrator.

## Decision
Initial scope supports **newly scaffolded applications only**. CLI handles creation and normal developer build/tooling tasks. Conversational application authoring, approval and publication belong to Development Mode in the Control Plane.

## Consequences
Simpler templates and contracts; existing-application retrofit is deferred. Generated code belongs to the developer. No runtime CLI dependency.

## Validation
A scaffolded application launches locally; publishing is not performed by CLI commands.
