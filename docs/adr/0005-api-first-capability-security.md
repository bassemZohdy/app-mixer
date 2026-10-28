# ADR-0005 — OpenAPI-first shared authorized capability layer

**Status:** Accepted · **Date:** 2026-10-28

## Context
Traditional buttons and agents must use the same backend semantics and security policy.

## Decision
Use OpenAPI as the initial REST operation discovery contract. Imported operations are **candidates**, not automatically authorized tools. Register explicit capability mappings and enforce server-side authentication, authorization, validation, approval and auditing on every invocation, regardless of origin. Additional adapters such as MCP/AsyncAPI are optional.

## Consequences
Requires capability registry, operation policy, upstream credentials and consistent error handling.

## Validation
A UI button and an agent call to the same capability undergo identical authorization and validation.
