# OpenAPI and capability registry: local foundation

`importOpenAPI` discovers operation IDs, methods and paths from an already parsed OpenAPI 3.0 or 3.1 JSON document. It produces candidates only. Discovery performs no HTTP calls, does not resolve path-item `$ref`, does not trust server URLs or credentials, and grants no permission to invoke an operation. Missing or duplicate operation IDs and unsupported path items are rejected. The importer does not yet interpret request/response schemas, security schemes, YAML, external references or operation-specific servers.

`CapabilityRegistry` requires a host-supplied audit sink and explicit authorization function, input validator and executor for each operation. It records attempts and outcomes without input or result payloads; a failed attempt audit blocks execution. A failed success audit occurs after execution and leaves the result uncertain, so callers must not automatically retry side-effecting operations. An unregistered capability cannot be invoked. Every invocation requires a tenant ID and principal ID from the trusted server; the same policy and validation run for UI and agent origins before execution. Input is cloned before validation and execution. These functions are trusted application code, not values supplied by a client or model.

This is a local foundation, not an authentication or production authorization solution. The caller must authenticate the actor and derive the invocation context server-side; never accept tenant or principal IDs from an untrusted client as proof of identity. A restricted GET binding validates supported primitive path/query parameters from an OpenAPI document. General OpenAPI schema validation, write operations, credential management, approval, and durable audit storage are not implemented. The provided local invocation server requires trusted host callbacks for authentication and authentication-failure audit; it does not implement identity itself. P1-06 remains open until these are implemented and verified for a sample REST operation through both UI and agent paths.


## Local invocation endpoint

`createCapabilityServer(registry, authenticate, auditFailure)` creates a server with `POST /capabilities/:operationId/invoke`. The host authentication callback derives `{tenantId, principalId}` from trusted credentials; clients cannot supply those fields in the request body. The body contains `{ "origin": "ui" | "agent", "input": ... }`. Both origins reach the same registry policy and validator. Authentication failures are sent to the required `auditFailure` callback; if that audit fails, access is blocked. Bind to loopback for development. The host must supply a secure authentication mechanism and durable audit sink for production.

The integration test binds an imported GET candidate to a local sample REST service via an explicitly registered trusted executor. It does not automatically execute arbitrary OpenAPI URLs. API and agent UI wiring and durable audit remain open.


## Restricted OpenAPI GET binding

`createOpenAPIGetBinding(document, operationId, {baseURL, authorize, headers})` creates a candidate and registry binding for one explicitly selected GET operation. The host supplies the trusted base URL, authorization policy and optional fixed headers. HTTPS is allowed for trusted configured hosts; plain HTTP is restricted to loopback. Imported server URLs and credentials are ignored. Redirects are rejected, the upstream request has a timeout, and JSON responses are limited to 1 MiB. No write operation or retry is performed.

The binding supports only primitive `string`, `integer`, `number`, and `boolean` path and query parameters with basic length or numeric bounds. Path strings are restricted to letters, digits, underscores and hyphens. Unsupported schemas, references, styles, request bodies, unknown input fields and invalid parameters are rejected. It is not a general OpenAPI validator or executor. Register the returned binding in a `CapabilityRegistry` with a durable audit sink and invoke through a host-authenticated boundary. Production DNS/network policy, credentials, tenant isolation and complete schema support remain future work.
