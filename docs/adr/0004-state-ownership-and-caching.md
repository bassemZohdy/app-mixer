# ADR-0004 — Explicit state ownership and two-level caching

**Status:** Accepted · **Date:** 2026-10-28

## Context
Agent, frontend, published pages, business data and offline operations must not create competing authoritative state.

## Decision
Definitions belong to publication repository; drafts to Control Plane; agent sessions/checkpoints to agent store; business data to owning provider; transient UI state to frontend; pending operations to durable sync store. Server and client caches contain derived, compatible published definitions/assets, never authoritative records.

## Consequences
Cache keys and invalidation require version, schema, tenant and authorization context. Physical databases may be shared locally while logical ownership remains separate.

## Validation
Clear caches and recover definitions; prevent cross-user cache leakage; render published pages without LLM.
