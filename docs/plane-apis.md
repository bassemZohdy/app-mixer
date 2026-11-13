# Local Control Plane and Data Plane APIs

The core package exposes independent Node HTTP servers backed by a definition repository. These are local-development APIs, not production deployment components. Bind both servers to loopback; the Data Plane has no authentication, and the Control Plane's shared bearer token is not an identity, authorization, audit, or approval system. Use a long random secret, keep it out of source control and logs, and do not expose either server to untrusted networks. TLS, scoped permissions, tenancy, audit, and operational controls remain future work.

Each plane can use its own `SqliteApplicationStore` connection to the same local database and application ID. The Data Plane can run with no Control Plane process. The database must be initialized with the same application ID, and only published versions are served. Each process should close its own server and store during shutdown. SQLite and the Node synchronous API are intended for the local prototype; they block the event loop and are not a production scaling solution.

```js
import { randomBytes } from 'node:crypto';
import { SqliteApplicationStore, createControlPlane, createDataPlane } from '@app-mixer/core';

const initial = { id: 'demo', schemaVersion: 1, revision: 0, pages: [] };
const controlStore = new SqliteApplicationStore('./app.sqlite', initial);
const dataStore = new SqliteApplicationStore('./app.sqlite', initial);
// In a real process, supply this through a secret mechanism and share it only with the developer client.
const controlToken = randomBytes(32).toString('hex');
const control = createControlPlane(controlStore, controlToken);
const data = createDataPlane(dataStore);
control.listen(3001, '127.0.0.1');
data.listen(3002, '127.0.0.1');
```

Control requests require `Authorization: Bearer <token>`. JSON mutations require `Content-Type: application/json`, accept bodies up to 1 MiB, and reject unexpected fields and unsupported patches.

| Plane | Method and path | Behavior |
| --- | --- | --- |
| Control | `GET /draft` | Current draft. |
| Control | `GET /preview` | Current draft definition for a preview client; it does not render a preview. |
| Control | `POST /draft/patches` | JSON `{ "baseRevision": 0, "patches": [...] }`; patches are atomic. |
| Control | `POST /publish` | JSON `{ "expectedRevision": 0 }`; creates an immutable version. |
| Data | `GET /application` | Latest published version and definition; 404 before publication. |
| Data | `GET /application/versions/:version` | A specific published version. |

Patch operations: `addPage` (`page`), `setPageTitle` (`pageId`, `title`), `setPageDescription` (`pageId`, `description`; schema version 2), `addComponent` (`pageId`, `component`), `removeComponent` (`pageId`, `componentId`), `setComponentProps` (`pageId`, `componentId`, `props`; replaces all of the component's properties), `removePage` (`pageId`), `setExtensions` and `setExtensionOperations`. `removeComponent`, `setComponentProps` and `removePage` correct a draft. A patch that names an unknown page or component returns 400 and leaves the draft unchanged. Development proposals accept the same operations.

A stale revision returns 409. Bad requests return 400; unauthorized requests return 401. No Data Plane route reads drafts or changes definitions. Optional local proposal endpoints and a review UI provide separate agent and developer tokens; see [development proposals](development-proposals.md). Complete schema, capability and permission validation and production authorization remain separate roadmap items.

## Error codes

Expected refusals in `@app-mixer/core` (validation, missing resource, conflict, limit, denied access, an unavailable dependency) are thrown as `AppMixerError(code, message, {cause?})`, with `code` one of `invalid` (400), `denied` (403), `not_found` (404), `conflict` (409), `limit` (429) or `unavailable` (503); `httpStatus(error)` returns the status. The control plane and the capability server answer with the error's own message and the status of its code.

Host-supplied repositories, providers and capability executors, and the agent package, report these refusals with a plain `Error` whose message is exactly one of the documented messages (the table in `packages/core/src/errors.ts`); `refusalStatus(error)` maps those too, so they keep the status they always had. Any other error is a 500 whose message is never returned to the client.

## Server limits and TLS policy

Every HTTP server created by `@app-mixer/core` and `@app-mixer/agent` (control and Data Plane, capability server, metrics servers, the AG-UI, approval, event-ingress and notice-receiver servers and the generated `server.mjs`) applies `limitServer`: 10 s for request headers, 30 s for a whole request, 5 s keep-alive and a 30 s socket idle timeout (no bytes in either direction). Node only checks expired connections every 30 s, which is why the idle timeout is the prompt cut-off for a client that stalls mid-request. The AG-UI event-stream server has no idle timeout because a stream can be silent while a model works. Override the values by calling `limitServer(server, {headersTimeoutMs, requestTimeoutMs, keepAliveTimeoutMs, idleTimeoutMs})` on the returned server before `listen`; `deploy/kubernetes/data-plane.mjs` does so with tighter values.

The HTTPS variants and the credential reloader use `TLS_POLICY`: TLS 1.2 or later, only ECDHE key exchange with AES-GCM or ChaCha20-Poly1305 suites (TLS 1.3 suites are unaffected) and the server's cipher order. A client or certificate that needs a different suite must terminate TLS at a proxy.
