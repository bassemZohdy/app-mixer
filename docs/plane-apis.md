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

A stale revision returns 409. Bad requests return 400; unauthorized requests return 401. No Data Plane route reads drafts or changes definitions. Optional local proposal endpoints provide separate agent and developer tokens; see [development proposals](development-proposals.md). Complete schema, capability and permission validation and production authorization remain separate roadmap items.
