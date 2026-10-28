# ADR-0003 — Declarative definitions and controlled publication

**Status:** Accepted · **Date:** 2026-10-28

## Context
Conversationally generated pages must be portable, reproducible and safe.

## Decision
Persist a versioned application manifest, declarative UI definitions, and immutable published package. Development Agent proposes typed, atomic patches against a base draft revision. Validate schema, components, capabilities, permissions and compatibility; preview before authorized publication. Published versions are never edited in place.

## Consequences
Requires schema evolution, conflict detection, approval, rollback and integrity metadata. No arbitrary agent-generated executable code in definitions.

## Validation
Invalid patch leaves draft unchanged; stale revision conflicts; published version unaffected by draft edits.
