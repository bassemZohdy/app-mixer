# Foundation review

This review covers the initial in-memory store and generated local HTTP scaffold, not production readiness. Reviewed against the lockfile and source on 2026-10-28.

## Licenses

The project is licensed under Apache-2.0; the full license is in `LICENSE`. The locked third-party dependencies are TypeScript 5.9.3 (Apache-2.0), @types/node 22.20.5 (MIT), and undici-types 6.21.0 (MIT), all development dependencies. These licenses are compatible with distribution under Apache-2.0, subject to retaining applicable third-party notices when redistributing their material. Recheck the lockfile and notices when dependencies change.

## Security and runtime findings

- Generated apps bind to loopback by default and expose only two fixed GET paths. The browser inserts definition strings using `textContent`, not HTML. The scaffold provides no authentication, authorization, TLS, rate limiting, or security headers and is intended for local development only.
- Project names are restricted to lowercase alphanumerics and hyphens, preventing path traversal. Existing targets are rejected; an atomic directory creation prevents overwriting an existing directory.
- Drafts and publications are cloned to prevent accidental mutation. Patches are applied to a candidate and validated before commit; unknown patch operations are rejected. Runtime validation is minimal, however, and TypeScript types do not validate untrusted JSON. A future API must implement strict schema validation, payload limits, authentication, authorization, and concurrency controls before exposing this store.
- The store is in memory: data and published versions disappear on restart. It provides no cross-process concurrency, durability, audit, tenant isolation, or version rollback. It must not be used as a production repository.
- The generated server does not currently shut down gracefully, enforce request timeouts, or include operational health endpoints. Its HTML and definition are static files; no agent, external API, or secrets handling is implemented.

Reassess these findings when APIs, external data, agents, or deployment features are introduced.
