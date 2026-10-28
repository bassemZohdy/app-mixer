# App Mixer

**App Mixer** is an early-stage open-source, API-first, greenfield framework for agent-native applications. It combines conventional pages with a conversational interface. **Status: foundation prototype; not production ready.**

## Getting started

Requires Node.js 22.13+ and npm. The SQLite repository uses the experimental built-in `node:sqlite` API.

```bash
npm install
npm test
npm run build
node packages/cli/dist/index.js create demo-app
cd demo-app
npm run dev
```

Visit http://localhost:3000. The generated app has a workspace and chat placeholder. AG-UI, A2UI and a real agent are not yet integrated.

## Specifications and tracking

- [Requirements](docs/specs/requirements.md)
- [Architecture](docs/specs/architecture.md)
- [Application definition model](docs/specs/application-model.md)
- [Architecture decisions](docs/specs/decisions.md)
- [Initial implementation plan](docs/specs/implementation-plan.md)
- [TODO](TODO.md)
- [CHANGELOG](CHANGELOG.md)

## Repository

`packages/core` provides in-memory and SQLite-backed versioned application definition stores. The SQLite store persists drafts and immutable published versions; it is a local prototype, not a production security boundary. `packages/cli` scaffolds a minimal standalone HTTP application. The CLI is for developer tooling only. The future Control Plane is optional; the Data Plane must execute published apps independently.

This project is independent of Super App Agent, open-workflow-agent and open-workflow-agentic. Angular, React, React Native and Flutter adapters, offline sync, OpenAPI integration, server/client caches, authorization and Kubernetes packaging are future work.

Licensed under [Apache-2.0](LICENSE). See the [foundation review](docs/foundation-review.md) for dependency licenses and prototype limitations.
