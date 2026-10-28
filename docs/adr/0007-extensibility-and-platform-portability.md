# ADR-0007 — Scoped extensions and native frontend portability

**Status:** Accepted · **Date:** 2026-10-28

## Context
The framework should be reusable across web/mobile and extensible like a component ecosystem without vendor lock-in.

## Decision
One extension manifest/SDK covers platform, development and application scopes with separate permissions. Components/tools/providers must be registered and approved. Target Angular, React, React Native and Flutter native adapters with a shared declarative contract and explicit compatibility declarations. Initial extensions are trusted static installs, not arbitrary agent-installed code.

## Consequences
Platform parity is a goal requiring evidence; unsupported components fail validation. Avoid mandatory iframes and proprietary SDKs.

## Validation
Compatibility checks identify unsupported components before publication; extensions cannot exceed declared scope.
