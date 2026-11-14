# LangGraph and AG-UI adapter

`@app-mixer/agent` provides an initial text-only adapter. `LangGraphAGUIAdapter` executes a LangGraph node using a host-supplied streaming model and emits AG-UI 1.0 run and text events. The included `createOpenAIModel` configures an OpenAI-compatible provider. Applications can inject another `StreamingModel`; model selection, credentials, endpoint, and any system prompt are controlled by trusted host configuration, not the conversation.

```js
import { LangGraphAGUIAdapter, createOpenAIModel } from '@app-mixer/agent';

const model = createOpenAIModel({
  model: process.env.LLM_MODEL,
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL, // optional, trusted configuration
});
const agent = new LangGraphAGUIAdapter(model);
for await (const event of agent.run({
  threadId: 'conversation-1', runId: 'run-1',
  messages: [{role:'user',content:'Hello'}]
})) {
  // Send events over an authenticated application transport.
}
```

A run requires a nonempty user/assistant message history ending in a user message. Callers own conversation storage and supply history for each run; the adapter does not persist or isolate conversations. An `AbortSignal` can be passed as the second argument to `run`. It is propagated to the model; cancellation depends on the model honoring it. Model failures emit a sanitized `RUN_ERROR`, and partial text messages are closed first. Do not expose raw provider errors, credentials, or untrusted `baseURL` configuration to clients.

The initial optional tool-calling mode can execute only host-configured capability tools through a bounded LangGraph loop. It has no approval flow, durable agent state, capability authorization, or multimodal handling. The transport accepts the text-only subset of AG-UI run input and rejects unsupported nonempty state, tools, context, and other features. It is not a production security boundary. The initial P1-04 integration covers text chat; broader protocol and production capabilities remain future work.

## Local SSE endpoint

`createAGUIServer(agent, token)` exposes `POST /agent` using `text/event-stream`. The request uses the AG-UI run input format, including message IDs, and requires `Authorization: Bearer <token>` and JSON content type. Provide at least 32 characters of cryptographically random token, and bind the server to loopback. The endpoint propagates disconnect cancellation and respects output backpressure. It is a local-development shared-secret guard, not production identity, scoped authorization, audit, rate limiting, or tenant isolation. It does not send CORS headers; a remote browser client needs an explicitly secured deployment design.

```js
import { createAGUIServer } from '@app-mixer/agent';
const server = createAGUIServer(agent, process.env.AGENT_TOKEN);
server.listen(3003, '127.0.0.1');
```

The endpoint rejects unsupported input fields instead of silently discarding them. It accepts user and assistant text messages only, empty tools/context, and an empty or absent state. Durable per-user conversation state remains future work.

## Generated app chat

Start the local agent server separately, then start the generated app with `AGENT_URL=http://127.0.0.1:3003/agent` and the same `AGENT_TOKEN` in its environment. `npm run dev` loads a `.env` file from the project folder when one exists (copy `.env.example`; the project's `.gitignore` names `.env`), and values already in the environment win; running `node server.mjs` directly does not load it. Its server proxies same-origin chat requests to the loopback agent and keeps the token server-side. Without configuration, chat is disabled; if the agent stops, the workspace remains available and chat reports an error. The conversation history is held in the browser only and is lost on reload. This local proxy is not a production authentication or authorization system. The generated server (`AGENT_URL`, `CAPABILITY_URL`, `DATA_PLANE_URL`, `PORT`) exits with one line naming the setting when it is set but invalid, when a URL's token (`AGENT_TOKEN`, `CAPABILITY_TOKEN`) has fewer than 32 characters, or when the port is in use; an unset or empty setting leaves the feature off. If a message cannot be sent (the agent is stopped or refuses the request), the generated chat puts the text back in its input and marks the logged line `(not sent)`, so submitting again after the agent returns sends it; a reply that began and then failed is marked `(incomplete)` and the input stays empty.

## Capability tools

Trusted host code can bind `createCapabilityTool` instances to `createOpenAIToolModel` and `createToolCallingModel`, then pass the latter to `LangGraphAGUIAdapter`. Bind tools per authenticated actor and tenant; do not let model output choose identity or permissions. The host must route each tool through the authorized capability registry. Only configure read-only, explicitly approved operations until durable action journaling, idempotency and human approval are implemented. The loop limits model turns and tool calls, rejects unknown tools and does not retry failed tool calls. It yields the final text as one chunk rather than streaming model tokens or exposing tool events. Tool results are sent to the configured model provider, so apply data-sharing policy before enabling them.

## Subpath entries

The root `@app-mixer/agent` entry loads LangChain, LangGraph, AG-UI and the OpenAI client at import time. A host that only runs webhooks or durable stores can import `@app-mixer/agent/webhooks` (event ingress, signed-webhook authentication and the provider webhook adapters) or `@app-mixer/agent/stores` (runs, journals, approvals, memory, definitions, schedules, triggers, notices and their workers, PostgreSQL variants and operational metrics) and pay for none of those packages. The entries re-export the same bindings as the root; the model runtime (`LangGraphAGUIAdapter`, `createAGUIServer`, `createConfiguredAgentRun`, the tool-calling model, capability tools, the SQLite checkpointer and delegation grants) stays on the root entry. `test/subpath-exports.test.mjs` checks the import graph of both entries and that every export outside the model runtime is reachable from a subpath; add new exports to `src/webhooks.ts` or `src/stores.ts`.
