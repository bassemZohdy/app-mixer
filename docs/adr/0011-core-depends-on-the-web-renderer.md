# ADR 0011: The core package depends on the web renderer

Status: **Accepted** (revisit before the first publish)
Date: 2026-11-06

## Context
The code review (TODO P4-26/P4-41) noted that `@app-mixer/core` imports `@app-mixer/web`, while the intended layering has the renderer at the edge. There are exactly two reasons:

- the development Control Plane in `planes.ts` serves the review UI, and that UI renders proposal previews with the web renderer, so it reads the renderer's built source (`import.meta.resolve('@app-mixer/web')`) and serves it to the browser;
- `extension-adapters.ts` builds a renderer `ComponentRegistry` from approved extension manifests, which needs the registry classes.

The Data Plane, the capability layer, the stores and the agent package use neither; `@app-mixer/agent` does not depend on core at all.

## Decision
Keep the dependency, as an exact-version dependency (`0.1.0` in `core` and `cli`), and do not create a separate host package now. Moving the development UI and the extension adapters out of core would need a new package, a re-export compatibility layer for every importer (the CLI, the tests, the deployment scripts) and a new build step, to remove a dependency that only the optional development Control Plane uses.

## Consequences
- A host that deploys only the Data Plane still installs `@app-mixer/web` with core; the Data Plane image installs just those two workspaces (about 330 MB with the Node base image).
- Nothing in core's runtime paths for the Data Plane, capabilities or stores loads the renderer: the import is by two modules.
- **Trigger to revisit:** publishing `@app-mixer/core` to a registry, or a consumer that needs core without a DOM renderer. Then move `planes.ts` development-UI serving and `extension-adapters.ts` into a small `@app-mixer/host` package and re-export them from core for one release.
