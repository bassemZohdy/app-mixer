# Active Backlog

## 🌳 Task Tree

- [ ] **TASK-020** · P2 · mid · Enable noUncheckedIndexedAccess, noImplicitOverride, noFallthroughCasesInSwitch and exactOptionalPropertyTypes in tsconfig.base.json and fix what they report
  - Done when: every workspace compiles with the four flags on; `npm run build`
  - State: next: decompose
- [ ] **TASK-021** · P2 · mid · Review the 141 empty catch blocks (10 in web offline.ts, 7 in event-ingress.ts, 3 to 4 in each worker) and give background workers an optional error hook, as the remote connector's onAnchorError does
  - Done when: a failing store or callback in each worker reaches the hook, and a throwing hook is ignored; `npm run build && node --test packages/agent/test/worker-error-hooks.test.mjs`
  - State: next: decompose
- [ ] **TASK-022** · P2 · mid · Replace long positional parameter lists with options objects: createControlPlane (8), createCapabilityHttpsServer (6), createDevelopmentPlanes (6), createCapabilityServer (5)
  - Done when: the new signatures are covered, and unknown option keys are refused; `npm run build && node --test packages/core/test/planes.test.mjs packages/core/test/capability-server.test.mjs`
  - State: next: decompose
- [ ] **TASK-023** · P2 · mid · Group the 137 flat files in packages/agent/src into feature folders (runs, memory, webhooks, postgres, capabilities) and factor the wiring the capability wrapper files share
  - Done when: the package's public exports are unchanged; `npm run build && node --test packages/agent/test/package-entries.test.mjs`
  - Links: Depends: TASK-011
  - State: next: decompose
