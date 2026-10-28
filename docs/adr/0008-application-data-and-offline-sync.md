# ADR-0008 — Optional internal data, staging and offline synchronization

**Status:** Accepted · **Date:** 2026-10-28

## Context
New apps may have no external API yet, or may need staged submission and offline-first operation.

## Decision
Offer optional internal Application Data Store behind a Data Provider abstraction. Staged transactions wait for explicit submission; offline-enabled operations may synchronize automatically under application policy. Track durable operation status, stable idempotency, bounded retries, authorization and conflict resolution. Publishing application definitions does not submit business transactions.

## Consequences
Offline client storage needs secure platform-specific handling. External API remains authoritative for externally owned data; avoid uncontrolled replication.

## Validation
Explicitly staged operations do not auto-submit; replay does not duplicate effects; conflicts are visible and recoverable.
