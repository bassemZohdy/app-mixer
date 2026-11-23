# Active Backlog

## 🌳 Task Tree

- [ ] **TASK-022** · P2 · mid · Replace long positional parameter lists with options objects: createControlPlane (8), createCapabilityHttpsServer (6), createDevelopmentPlanes (6), createCapabilityServer (5)
- [ ] **TASK-022** · P2 · mid · Replace long positional parameter lists with options objects: createControlPlane (8), createCapabilityHttpsServer (6), createDevelopmentPlanes (6), createCapabilityServer (5)
  - Done when: the new signatures are covered, and unknown option keys are refused; `npm run build && node --test packages/core/test/planes.test.mjs packages/core/test/capability-server.test.mjs`
  - State: next: decompose
- [ ] **TASK-023** · P2 · mid · Group the 137 flat files in packages/agent/src into feature folders (runs, memory, webhooks, postgres, capabilities) and factor the wiring the capability wrapper files share
  - Done when: the package's public exports are unchanged; `npm run build && node --test packages/agent/test/package-entries.test.mjs`
  - Links: Depends: TASK-011
  - State: next: decompose
