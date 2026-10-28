# App Mixer

**App Mixer** is an early-stage open-source, API-first, greenfield framework for agent-native applications. It combines conventional pages with a conversational interface. **Status: foundation prototype; not production ready.**

## Getting started

Requires Node.js 22+ and npm.

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

`packages/core` implements an in-memory versioned application definition prototype. `packages/cli` scaffolds a minimal standalone HTTP application. The CLI is for developer tooling only. The future Control Plane is optional; the Data Plane must execute published apps independently.

This project is independent of Super App Agent, open-workflow-agent and open-workflow-agentic. Angular, React, React Native and Flutter adapters, persistent storage, offline sync, OpenAPI integration, server/client caches, authorization and Kubernetes packaging are future work.

License intention: Apache-2.0; verify full license text and third-party licensing before distribution.
