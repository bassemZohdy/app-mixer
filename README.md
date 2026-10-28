# App Mixer

Open-source, API-first foundations for **greenfield agent-native applications**.

This repository is an early implementation, not a production-ready framework. The first slice contains a TypeScript CLI that scaffolds a minimal chat + workspace web application, a versioned application-definition runtime, and typed draft patches. The design keeps the **Control Plane optional** and the **Data Plane independently runnable**.

## Try it

Requires Node.js 22+ and npm.

```bash
npm install
npm test
npm run build
node packages/cli/dist/index.js create demo
cd demo
npm install
npm run dev
```

The scaffolded demo runs an HTTP server, with a static frontend at http://localhost:3000. A generated application can render published pages without invoking an LLM. The chat panel is an explicit placeholder until a real agent/AG-UI transport is integrated.

## Workspace

- `packages/core`: version-aware immutable definitions, drafts, validation, atomic typed patches and publication.
- `packages/cli`: greenfield scaffolding, with a small runnable vanilla web shell.
- `docs`: requirements, architecture, decisions, and roadmap.

## Principles

- CLI for scaffolding/development tooling only; not runtime administration.
- Development drafts and published runtime definitions have separate lifecycles.
- OpenAPI-first integration, pluggable extensions, provider-agnostic LLM configuration.
- The same authorized capabilities should eventually serve buttons and runtime agents.
- Two-level caching, optional internal storage, staged submissions and offline sync are design targets, **not implemented in this slice**.
- Angular, React, React Native and Flutter adapters are target platforms; the initial scaffold is framework-neutral vanilla web to prove the contracts.

No integration with the separate Super App Agent or workflow-engine projects.

## Status

Proof-of-foundation. Not yet production secure; do not expose generated development endpoints publicly without authentication and authorization.

License: Apache-2.0. See LICENSE.
