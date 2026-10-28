# ADR-0002 — Optional Control Plane and independent Data Plane

**Status:** Accepted · **Date:** 2026-10-28

## Context
Applications must run independently, yet optionally benefit from centralized development and governance.

## Decision
The Data Plane serves locally published immutable definitions without a central Control Plane connection. Development Mode is a Control Plane responsibility. The Control Plane may be co-located for local development, remote via an optional authenticated connector, or absent during runtime.

## Consequences
Published packages must be locally retrievable and compatible. Remote publication needs authenticated promotion and integrity checks. Control Plane failure must not stop ordinary runtime pages.

## Validation
Disconnect Control Plane and LLM; published pages and available business API actions remain functional.
