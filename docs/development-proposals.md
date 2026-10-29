# Development proposals: local foundation

`DevelopmentProposals` accepts a base revision and a bounded list of supported typed patches. It validates the patch shape, applies the patches to a cloned in-memory draft to create an isolated preview, and retains the proposal as pending. Neither proposal nor preview modifies the draft or publishes anything.

A trusted host can explicitly approve a pending proposal, applying its stored patches to the draft through the repository's revision check. If the draft changed since the proposal was made, approval fails without applying the proposal. Rejecting a proposal does not modify the draft. Publication is a separate explicit repository operation, and still requires the expected draft revision. Returned proposals are copies; mutating them cannot alter the stored proposal.

This is an in-memory foundation, not an approval security boundary. Proposals and decisions disappear on process restart, The local development planes expose separate bearer-token protected proposal and control servers. The host must keep the developer token away from the agent; control-plane patch/publish endpoints remain directly accessible to developer-token holders. An initial Development Agent can ask a configured streaming model for JSON patches and submit them through the proposal-only endpoint. The endpoint validates every patch before storing it. A local review UI is available; durable proposal storage, persistent audit, production identity, and complete policy validation are not implemented. The initial P1-05 workflow is local and in memory; durable approval, audit and production security remain roadmap items. Existing validation covers the prototype manifest and patch types; it does not validate capability permissions or renderer compatibility.

## Separate local endpoints

`createDevelopmentPlanes(repository, developerToken, agentToken)` requires distinct tokens and returns `proposal` and `control` HTTP servers. Bind both to loopback and give the agent only the proposal token. The proposal server permits `POST /proposals` with `{ "baseRevision": 0, "patches": [...] }`; it cannot approve, modify drafts, or publish. The developer control server permits `GET /proposals/:id` to inspect the preview and `POST /proposals/:id/approve` or `/reject`. Approval changes the draft only; `POST /publish` remains a separate developer action. Tokens are a local guard, not production authorization. Proposals are in memory and are lost on restart; after 100 stored proposals the service rejects new ones until restarted.

## Development Agent

`DevelopmentAgent` uses a host-configured `StreamingModel` to produce a JSON patch proposal from a developer instruction and draft snapshot. `createProposalClient` accepts only a loopback proposal URL and the agent token; it cannot approve or publish. The model receives the supplied draft and instruction, so the host must not include secrets or data the selected provider should not receive. Model output is untrusted and must pass the proposal endpoint's validation. Responses and prompts are bounded, and the client does not follow redirects. Configure the model and endpoint from trusted host settings. Durable proposal storage remains future work.

## Local review UI

With the development planes running, open `http://127.0.0.1:<control-port>/development`. Enter the developer token and proposal ID, load the patch and preview, then explicitly approve or reject. Approval updates only the draft; a separate Publish button publishes the approved revision. A stale revision fails rather than publishing a different draft. The token is held in the page's memory, not persisted by the UI. Only use the page on a trusted local machine; the shared-token workflow is not production identity or authorization. When a Development Agent callback is configured, the UI can request a new proposal directly; it can also load an existing proposal by ID.


To connect a configured model to the local review flow, start both servers in a trusted host process:

```js
import { createDevelopmentPlanes } from '@app-mixer/core';
import { DevelopmentAgent, createProposalClient } from '@app-mixer/agent';
// repository and model are configured by the host; tokens come from a secret mechanism.
const agent = new DevelopmentAgent(model, createProposalClient('http://127.0.0.1:3004/proposals', agentToken));
const planes = createDevelopmentPlanes(repository, developerToken, agentToken,
  (instruction, draft) => agent.propose(instruction, draft));
planes.control.listen(3001, '127.0.0.1');
planes.proposal.listen(3004, '127.0.0.1');
```

The developer token protects the generation endpoint and must not be supplied to the model or proposal-only client. Generating a proposal sends the draft and instruction to the configured model; reviewing, approving, and publishing remain separate actions. The UI shows both the proposal JSON and a rendered preview using the same A2UI renderer as the generated app. It supports Text and host-installed extension components and disables approval when it cannot render the preview. The optional fifth argument to `createDevelopmentPlanes` is `{extensionModule: source}`, a trusted host-owned JavaScript module exporting `installedExtensions` in the generated-app format. It runs in the developer page and can access the developer token; never source it from a proposal or untrusted extension. It is served to the local browser and must contain no secrets. Keep this module aligned with the runtime's approved registrations; the preview does not establish approval or authorization. Omit it for an empty installation.

A host extension module that imports `./data-editor.mjs` can preview the generated record editor through the control plane. The preview factory validates the same component properties but renders disabled controls and never calls data capabilities. The same applies to `./staged-editor.mjs`: its preview disables staging, status checks and submission. The host must still supply the trusted extension registration and publication guard; preview does not establish approval.
