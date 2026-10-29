# Durable agent approvals

`SqliteAgentApprovals` stores an approval request for one tenant, agent, run and action in the same SQLite database as the run registry and action journal. A running worker with a valid lease may request approval for an operation and exact canonical input. The request also binds the run's definition version, requester and expiration; expiration must be within the run deadline and at most 24 hours away. A repeated matching request returns the existing decision. An action ID cannot be reused with different input or operation.

The host must authenticate actors and provide an authorization callback for request, read, list, decision, cancellation, expiration and history access. The callback receives tenant, agent, run, action and operation identifiers. An authorized human can approve or reject a pending request; cancellation can revoke a pending or approved request before a later dispatch. Competing decisions are serialized, and expired approvals cannot authorize dispatch. Explicit expiration, accepted decisions and requests are appended to immutable local event records with actor IDs and timestamps. Hosts remain responsible for auditing denied attempts and protecting the database and backups.

A configured agent can opt in with an approval policy and an action journal. For a tool call the host policy must return an explicit boolean. When approval is required, the runtime creates or checks the request and stops that invocation until it is approved. The action journal verifies the approval, exact input, operation, definition version and expiry in the same transaction that records dispatch. Approval does not bypass the capability registry's authorization, validation or audit. Cancellation or expiry cannot undo a call already dispatched; external idempotency and reconciliation are still required.

The current AG-UI adapter reports a stopped invocation as a generic run error. A host must inspect the approval list, stop the worker, resolve any uncertain prior actions, record the human decision, and explicitly reconcile and resume the run before retrying. Approval is not an automatic pause/resume workflow or notification service. The run deadline remains in force during review. The host must enforce human identity and decision authority, secure transport and storage, and ensure every protected operation is covered by its policy. Input and audit records are not encrypted. Production identity, durable notifications, and distributed approvals remain open.

## Local review interface

`createAgentApprovalServer` provides a local review page at `/review` and a scoped HTTP API. Bind it to `127.0.0.1`, not a public interface. Supply `authenticate(request)` to validate a reviewer credential and return the trusted tenant and principal, and `resolve(scope, runId)` to return the matching `SqliteAgentApprovals` instance. The server checks the returned store's binding; the store's authorization callback still controls list, read, history, decision and cancellation access. For example:

```js
const server = createAgentApprovalServer({
  authenticate: request => authenticateReviewer(request.headers.authorization),
  resolve: (scope, runId) => approvalStoreFor(scope, runId)
});
server.listen(8787, '127.0.0.1');
```

Open `http://127.0.0.1:8787/review`, enter the reviewer bearer token, agent ID and run ID, and load the requests. The page displays the exact input and operation and can approve, reject or cancel an eligible request. Tokens are kept in the page only, and all data responses are non-cacheable. Decisions require a matching local Origin and JSON content type. The server is intended for direct loopback access, not reverse proxies or production identity. The host must protect credentials and audit denied access. A decision does not resume a run; use the reconciliation workflow described above.


## Local request inbox

Approval creation and a delegation renewal wait each append a notice in the same SQLite transaction as the underlying change. `SqliteAgentNotices` provides a tenant- and agent-scoped inbox across runs. Hosts supply an authorization callback for list, individual read and acknowledgement, and must authenticate the actor. Notices contain only the run and action or grant identifiers, not approval inputs or credentials. The `actionable` flag is computed against the current approval, grant and run state; clients must still fetch and authorize the underlying record before acting. Acknowledgements are durable, per reviewer and independent of approval or renewal. Notices and acknowledgement receipts are immutable. Paginated listing may return an empty page with a `nextAfter` cursor when individual items are filtered by policy.

Optionally supply `resolveNotices(scope)` when constructing `createAgentApprovalServer` and open `/review`. Enter an agent ID and reviewer token, then load its notices; an approval notice can open the relevant run's approval list. Acknowledgement only marks the notice as seen. The local inbox does not send email, push notifications or other external messages, and existing requests created before this feature are not backfilled. The host remains responsible for identity, consent and delivery to appropriate reviewers, denied-attempt auditing, database protection and retention. Notice and receipt history currently grows until the database is retired; production retention and distributed delivery remain open.
