# Local business data and staged operations

`SqliteDataProvider` is an optional, synchronous local `DataProvider` for JSON object records. Records are scoped by tenant, application, collection and ID. `put` creates when `expectedRevision` is `null` or replaces only the specified current revision. `delete` requires the current revision. Deleted records retain a tombstone revision, so a stale writer cannot overwrite a recreated record. Values are copied, constrained to JSON-compatible data, and limited to 10,000 values, 40 levels and 1 MiB of serialized UTF-8. The provider persists in a logically separate table from definitions, and publishing never invokes it.

`SqliteStagedOperations` stores explicit, durable external-operation intents. `stage` generates an operation ID and stable idempotency key; it does not execute the operation. A caller may provide a stable request key to make staging retries return the existing intent within the same tenant and application. Reusing that key with a different operation or payload is rejected. The key is separate from the generated external idempotency key and must not contain secrets. An omitted key creates a new intent each time. `submit` atomically claims a staged intent and invokes the named `CapabilityRegistry` operation with `{idempotencyKey, payload}` and the submitting principal's context. The host's capability must validate and authorize this input, and the external service must actually honor the idempotency key to prevent duplicate external effects. The registry's normal audit policy applies. No worker or publication automatically submits staged intents.

On an error, including authorization or audit failure, the outcome is conservatively marked `uncertain` because the external effect may have occurred. An interrupted process can leave a record `submitting`. Only after the host has established that the submitting process is no longer active may it call `recoverAbandoned` to mark that record uncertain. An authorized operator must independently verify the external outcome before `reconcile`: `applied` marks it succeeded; `not_applied` makes it eligible for a new explicit submission with the same key. There is no automatic retry or built-in external reconciliation.

These are local primitives, not HTTP endpoints or a complete production data service. Direct methods do not authenticate or authorize callers: hosts must check access to the tenant, application, operation, records and recovery decisions, and use capability policy and audit for submission. The SQLite database and its backups require host-managed access control, encryption and lifecycle. A bounded local collection migration is available as described in [data migration](data-migration.md); richer collection queries, offline synchronization, distributed worker coordination, and automatic expiry remain open. A local paginated listing capability is described below. A host must close each store when finished and must not close it while a submission is in flight.

`registerDataCapability(registry, provider, options)` connects one `get`, `put`, or `delete` operation to the standard authenticated capability server and agent interface. The host supplies the candidate, fixed application and collection, an authorization function and an input validator. The tenant comes from the authenticated invocation context, not the request payload. Inputs have exact shapes: `get` takes `{id}`, `put` takes `{id, expectedRevision, value}`, and `delete` takes `{id, expectedRevision}`. Missing records return null. The host may register separate operations for each collection and policy.

The host can additionally supply `authorizeRecord(context, input)` to apply a record-level check after input validation and before the provider operation. It receives isolated copies of the validated input and actor context; only a return value of `true` permits execution. Denials use the registry's normal denied audit event, while policy errors fail closed. Without this callback, authorization is collection-level. A policy that reads mutable external state is not atomic with the subsequent provider call; enforce any such invariant inside a transactional provider. The host still supplies authentication, audit, validation and appropriate permissions. Staging uses the separate adapter below; reconciliation remains a host-operated administrative action.

`registerStagedCapability` exposes one of `stage`, `get`, or `submit` through the existing authenticated capability server. The host fixes the application and external capability ID at registration and supplies authorization and input validation. Stage accepts `{payload, requestKey?}`; get and submit accept `{id}`. A staged ID belonging to another tenant, application or external capability cannot be retrieved or submitted through that binding. Optional input authorization can further restrict access, but must be supplied by the host where needed. Submission invokes the external capability with the same authenticated tenant and principal and repeats that capability's authorization, validation and audit; the internal dispatch is marked `service`, which is not accepted as an origin by the HTTP server. The registry does not distinguish UI, agent or service in its policy or audit. Administrative recovery and reconciliation are intentionally not exposed by this adapter.

The capability HTTP endpoint reports revision and data-schema version conflicts, staging request conflicts and attempts to submit a non-staged intent as HTTP 409. The host remains responsible for deciding how clients resolve each conflict.

Generated local apps include `capabilities.mjs`, which trusted browser code can import and call as `invokeCapability(operationId, input)`. To opt in, configure `CAPABILITY_URL` as the local capability server's `http://127.0.0.1:PORT/capabilities/` (or `localhost`) and `CAPABILITY_TOKEN` as the server-side bearer credential. The generated server checks the request's same origin, bounds request and response sizes, and sends a UI invocation to the loopback service without delivering the credential to the browser. The capability service must authenticate that token and map it to a trusted actor, and host registrations still determine authorization and validation. Calls return the capability result; failures expose an HTTP status on the thrown error, including 409 for known conflicts.

This integration is a local single-actor development profile. Same-origin checking is not user authentication; do not use the shared service credential to represent multiple users or expose the generated server to untrusted users. A production host needs real user authentication, per-user identity propagation, authorization and transport security. The generated app does not automatically register data capabilities; host code must configure the service and choose which operations the app can call.

Generated apps also include an optional `data-editor.mjs` host-owned extension factory. To install a record editor, configure matching get and put capabilities on the server and add a trusted entry to the generated `extensions.mjs`:

```js
import {createRecordEditor} from './data-editor.mjs';
export const installedExtensions = [{
  id: 'example.records', version: '1.0.0', scope: 'application',
  components: {'record-editor': createRecordEditor({getOperation: 'items.get', putOperation: 'items.put'})}
}];
```

The published application must reference that exact approved extension and declare a `record-editor` component; an optional `label` property sets its heading. The host fixes capability names in trusted code, not in the application definition. Users load an ID, edit a JSON object and explicitly save. A revision conflict retains the unsaved text, disables saving and asks the user to copy edits before loading the latest version. A control plane configured with the same trusted extension module serves an inert `data-editor.mjs` preview counterpart: controls are disabled and cannot invoke data capabilities. Without host-defined fields this is a basic JSON editor; an optional typed form is described below.

For explicitly staged external actions, generated apps include an optional `staged-editor.mjs` extension factory. A host can add it to the same trusted `extensions.mjs` registration:

```js
import {createStagedEditor} from './staged-editor.mjs';
// Add this entry to installedExtensions with the approved extension identity.
const stagedEditor = createStagedEditor({
  stageOperation: 'orders.stage', getOperation: 'orders.get', submitOperation: 'orders.submit'
});
```

Register `stagedEditor` under a declared component name such as `staged-editor`. The host supplies the stage, status and submit capabilities and their policies. The user enters a JSON object and stages it, then separately chooses Submit. A repeated stage with unchanged data during the current page session reuses its request key. The operation ID is visible so the user can check its status later. New transaction starts a distinct intent, even when the payload is unchanged; it does not cancel previous intents. On submission failure the editor disables submission and asks the user to check status; uncertain results require the host's administrative reconciliation. Preview controls are disabled. The in-memory request key does not survive a page reload; durable offline requests remain P2-04 work.

### Host-defined record forms

The same `createRecordEditor` factory accepts an optional trusted `fields` array to show a typed form instead of JSON:

```js
createRecordEditor({
  getOperation: 'items.get', putOperation: 'items.put',
  fields: [
    {key: 'name', label: 'Name', type: 'string', required: true, maxLength: 120},
    {key: 'quantity', label: 'Quantity', type: 'integer', min: 0},
    {key: 'active', label: 'Active', type: 'boolean'},
    {key: 'tier', label: 'Tier', type: 'string', options: ['standard', 'premium']}
  ]
});
```

This bounded local schema supports string, finite number, safe integer and boolean fields; string options, numeric minimum/maximum, string length and required fields are optional. The host chooses field names and constraints, and the application definition cannot override them. Fields have visible labels and required/optional markers, validation appears at the field and on save, and loading incompatible stored types fails without enabling save. Data outside the displayed fields is preserved. Clearing an optional field removes it when saved; an untouched existing empty string is preserved. A revision conflict keeps edits available for copying and disables save until a record is loaded again. The preview shows the same fields with disabled controls and performs no capability calls.

This is a bounded host-defined field schema, not full JSON Schema: nested editing, arrays and general schema composition remain open. The client form is convenience validation only. Hosts must apply their authoritative schema validation and authorization in the capability service, including constraints on fields not displayed by the form. Data is saved only when the user explicitly chooses Save.

### Enforcing the same rules on writes

A trusted host can also pass the same `fields` definition to the `put` registration of `registerDataCapability`. The capability validates its input shape, these field rules, and the host's existing `validate` callback before invoking the provider. For example:

```js
registerDataCapability(registry, provider, {
  candidate: {operationId: 'items.put', method: 'PUT', path: '/items'},
  applicationId: 'demo-app', collection: 'items', operation: 'put',
  authorize: actor => canWriteItems(actor),
  validate: input => additionalBusinessPolicy(input),
  fields, allowAdditionalFields: true
});
```

`createRecordFieldValidator(fields, options)` is also available for other trusted server paths. Schemas are validated and snapshotted at registration. Additional fields are allowed by default, matching the form's preservation of undisplayed data; set `allowAdditionalFields: false` for a closed record. Values must still meet the provider's bounded JSON restrictions. The server schema is host-owned: keep its configuration authoritative and do not trust a browser-supplied schema. Existing records are not automatically migrated or validated on read. JSON Schema-driven forms, nested editing and production schema governance remain separate work.

### JSON Schema validation on writes

A host can configure `jsonSchema` instead of `fields` on a `put` registration. The schema is snapshotted and compiled at registration as JSON Schema draft 2020-12; it can express nested objects and arrays, local references and conditional constraints. The capability enforces it in addition to the host's `validate` callback and normal authorization. `createRecordJsonSchemaValidator(schema)` exposes the same validator for other trusted server paths. For example:

```js
registerDataCapability(registry, provider, {
  candidate: {operationId: 'items.put', method: 'PUT', path: '/items'},
  applicationId: 'demo-app', collection: 'items', operation: 'put',
  authorize: canWriteItems, validate: additionalBusinessPolicy,
  jsonSchema: {
    type: 'object', required: ['name'], additionalProperties: false,
    properties: {name: {type: 'string', minLength: 1}, tags: {type: 'array', items: {type: 'string'}}}
  }
});
```

The generated editor and its inert preview can use that same host-owned schema via `createRecordEditor({getOperation: 'items.get', putOperation: 'items.put', jsonSchema})`. The current visual form accepts object schemas with `properties`, optional `required`, boolean `additionalProperties`, nested objects up to five levels, and string, number, integer or boolean leaf properties. Arrays of these scalar types and arrays of objects with nested objects and arrays use repeatable controls, including explicit inclusion of optional arrays. Object items preserve undisplayed properties unless the item is removed. Arrays support `minItems` and `maxItems`; the editor caps them at 50 items even if the schema has no maximum. String array items can contain empty strings. It supports up to 40 scalar fields and 40 nested objects. Optional objects have an Include checkbox; clearing it removes the entire object, including undisplayed fields. Required objects are included when their parent is included. Property `title`, nonempty string `enum` choices, numeric `minimum` and `maximum`, and string `minLength` and `maxLength` up to 1,048,576 are supported. Scalar, object and array properties, and scalar-array items, may use a two-type union with `null`; the editor provides an explicit null control and preserves the distinction among null, absence and other values. String enums may include null alongside nonempty string choices; an enum that excludes null does not permit it even if the type union includes null. Nullable object-array items remain unsupported. String lengths count Unicode code points. Required strings can be empty when the schema allows it; optional strings have an Include checkbox to distinguish an absent field from an empty value. Integer inputs are restricted to safe integers. Object-level `if`/`then`/`else` can conditionally require fields before saving: `if` supports `required` and scalar `const` or `enum` tests on declared properties, and each branch may contain only a `required` list. Fields remain visible and errors are reported at save time. Other conditional assertions are rejected. Object-level `dependentRequired` is checked before saving, including within object-array items. The form reports missing dependent properties; both trigger and dependent names must be declared in that object's `properties`. An empty string counts as present. Local JSON Pointer `$ref` values can reference definitions or other supported schema nodes; references are expanded at configuration with a depth and size limit. Percent-encoded fragments, remote references, cycles, and assertion siblings beside `$ref` are rejected; a `title` sibling is allowed. Unsupported keywords, arrays directly containing arrays, and other unsupported property types are rejected at configuration instead of being silently ignored. The editor preserves undisplayed existing fields; a closed schema may reject them on save. Configure the same schema at the capability boundary, which remains authoritative, and handle schema changes through migration. Object arrays can nest up to three levels; schema expansion is bounded to 200 nodes and loaded records to 10,000 checked schema values and object-array items. Other conditional schemas and broader JSON Schema-driven forms remain open.

Only trusted hosts may configure schemas. Compilation is synchronous and does not fetch remote references; unresolved references, unknown keywords or formats and asynchronous schemas are rejected. Format plugins are not included. Schemas and records must also meet the provider's bounded JSON-object restrictions; boolean schemas are supported but records must be objects. AJV does not coerce values, apply defaults or remove fields. Regular expressions and complex schemas can be expensive on untrusted data, so hosts must review schemas and enforce their own request and resource limits. The schema is not stored with the collection and does not validate existing data or direct provider calls. Coordinate changes with migration, every writer and the editor. Broader JSON Schema-driven forms and production schema governance remain open.

## Local collection listing

`SqliteDataProvider.list(scope, collection, {after, limit})` returns live records in record-ID order, excluding tombstones. It uses keyset pagination, returns `nextAfter` when another page exists, and bounds each page to at most 100 records and approximately 512 KiB of record data; a single larger record is returned by itself so pagination can progress. Like the provider's other direct methods, this method does not authenticate or authorize the caller.

`registerDataListCapability` exposes listing through the authenticated capability registry. The host fixes the application and collection, supplies both collection-level `authorize` and a mandatory per-record `authorizeItem`, and provides a persistent secret 32-byte `cursorKey`. The operation accepts `{limit?, cursor?, expectedSchemaVersion?}` and returns `{items, nextCursor?}`. Each page scans at most `limit` records (default 50, maximum 100); because inaccessible records are filtered, an empty page can still have a continuation cursor. The cursor is authenticated and encrypted, fixed-size, and bound to the tenant, principal, application, collection, operation and, when supplied, the expected schema version. Keep the key on the server and retain it across restarts; rotating it invalidates outstanding cursors. The host's policy must authorize access to every returned record and audit denied access where required.

For example, with a host-managed key and policy functions:

```js
registerDataListCapability(registry, provider, {
  candidate: {operationId: 'items.list', method: 'GET', path: '/items'},
  applicationId: 'demo-app', collection: 'items', cursorKey,
  authorize: actor => canListItems(actor),
  authorizeItem: (actor, record) => canReadItem(actor, record)
});
```

Each page is a snapshot of the scanned records, not a consistent snapshot across pages. Concurrent writes may cause records to move or change between requests, and an asynchronous record policy is not atomic with changes in the provider or an external policy store. Enforce strict revocation or transactional row policy in a provider designed for it. The existence and number of pages can reveal approximate collection size even though hidden record IDs are not exposed in cursors. A single record near the provider's 1 MiB maximum can exceed the generated app proxy's response limit; hosts should use smaller records or a production transport suited to larger results. Filtering, arbitrary sorting, production indexing and distributed query capabilities remain open.

### Browsing records in the editor

A host can add `listOperation: 'items.list'` to `createRecordEditor` after registering an authorized list capability. The editor then offers Browse records and Next page controls. Selecting an ID explicitly loads that record through the separate get capability, which must apply its own authorization. Empty filtered pages can still have a next page. IDs are rendered as text, including IDs with surrounding spaces, and are sent unchanged to the get capability. A selected record is not automatically saved. If the current editor contains unsaved changes, selecting another listed record is blocked so the user can save or copy those changes first. The control-plane preview displays disabled browsing controls and makes no data calls.

The list capability's per-record policy and the get capability's policy both remain authoritative. Browsing does not provide a consistent cross-page snapshot or replace record-level access checks; see the listing limitations below.

### Editing migrated collections

For a collection migrated beyond version 0, trusted host code can configure `expectedSchemaVersion` on `createRecordEditor`, for example `createRecordEditor({getOperation: 'items.get', putOperation: 'items.put', expectedSchemaVersion: 1, fields})`. The editor includes that version in get, list and put requests; omission retains the version-0 behavior. The capability server reports a schema-version mismatch as HTTP 409. The editor preserves unsaved edits, disables save and asks for its configuration to be updated; revision conflicts retain their existing separate message.

The built-in SQLite get and list capabilities check an explicitly supplied version in the same read snapshot and return HTTP 409 on mismatch. A custom provider must explicitly support this contract; otherwise guarded reads fail closed. Omitting the version leaves reads unguarded for legacy callers. Version checks do not validate the content shape, and list authorization after the snapshot can race a later migration. The host must update the editor field definition and capability-side validation together with the migration, authorize the new shape, and configure the correct version before allowing reads or writes.
