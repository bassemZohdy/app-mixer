# ADR 0012: Definition migrations stay explicit; no general migration registry

Status: **Accepted**
Date: 2026-11-26

## Context
Application definitions have schema versions 1 and 2. Version 2 adds a required page `description` (an empty string means none). The Control Plane offers exactly two migrations, both written as code in `ApplicationStore.previewDraftMigration` in `packages/core/src/index.ts`: 1 to 2 adds empty descriptions, and 2 to 1 is refused with a conflict unless every description is empty, so no content is lost. `migrateDraft` commits the previewed candidate under the expected revision; `POST /draft/migrate` and `POST /draft/migrate/preview` expose both, and a custom repository that does not implement them gets 501 (`packages/core/src/planes.ts`). `packages/core/test/definition-migration.test.mjs` covers both directions, the lossless refusal, the isolated preview and the Control Plane; `definition-migration-crash.test.mjs` pins the SQLite kill points, and `packages/agent/test/development.test.mjs` carries a migrated draft through proposal, review, approval, publication and the generated workspace.

The schema version is not only the migration's concern. `validate()` in `packages/core/src/index.ts` decides which versions exist and what each one's pages must look like; `development-ui.ts` renders version 2 descriptions in the review UI; `promotion.ts` accepts versions 1 and 2 in promotion packages; the generated workspace (`packages/cli/templates/workspace.mjs`) validates and renders by version, selected with `PUBLICATION_SCHEMA_VERSION`; and the development agent's prompt (`packages/agent/src/development.ts`) lists the page shape and the `setPageDescription` patch for version 2. [docs/definition-migration.md](../definition-migration.md) states that the two paths are intentionally not a general registry. The P2-05 checklist asks for a decision on "general schema evolution beyond the explicit 1-to-2 and 2-to-1 definition migrations". Business-data migrations are a separate mechanism with plans, rehearsals and digests (`packages/core/src/data-migration-capabilities.ts`) and are not what this ADR is about.

## Decision
Refuse a general, versioned definition-migration registry. Keep one explicit, tested migration per version pair, and keep a draft moving one version at a time. Record how a schema version 3 ships, below, so the next version is a deliberate change rather than a new abstraction.

1. The migration is the small part of a version. A registry would replace about fifteen lines in one function and leave the five other places that switch on the version untouched, because each new version changes what a valid definition is and how every reader renders it. Those stay per-version code whatever the migration looks like.
2. Definition migrations are not mechanical. The 2 to 1 step is allowed only when it loses nothing, the preview must apply the same refusal, and the crash tests pin the commit points. A registry would need a per-step lossless contract, preview semantics, chaining rules and validation of registered steps: an abstraction whose first customer does not exist.
3. One step at a time is the deployment model. A publication is a version that readers have been deployed for (the Data Plane, generated workspaces, offline caches pinned to `PUBLICATION_SCHEMA_VERSION`), and a rollback creates a new publication with the earlier schema rather than downgrading the draft. Chained migrations such as 1 to 3 would invite skipping the version readers saw.
4. Two versions exist and a third is not proposed.

## How a schema version 3 definition ships
Each step names where version 2 did it, so the change is a known shape:

1. Write the delta in [docs/definition-migration.md](../definition-migration.md): the fields version 3 adds or requires, how a version 2 reader must react (refuse, never guess) and the exact condition under which 3 to 2 loses nothing.
2. `validate()` in `packages/core/src/index.ts`: accept `3` beside 1 and 2 and add the version 3 rules, leaving versions 1 and 2 valid exactly as they are.
3. `previewDraftMigration`: add 2 to 3 (fill the new fields with their empty values) and 3 to 2 (refused unless the lossless condition holds); keep refusing 1 to 3 and 3 to 1 with the existing `Unsupported schema migration` conflict, and keep the revision check, `validate(candidate)` and the isolated preview as they are.
4. The review UI in `development-ui.ts` renders the new fields; the patch validator and the development agent's tool list (`packages/agent/src/development.ts`) gain the version 3 counterpart of `setPageDescription`.
5. The generated workspace in `packages/cli/templates/workspace.mjs` accepts and renders version 3, and `PUBLICATION_SCHEMA_VERSION=3` selects it; the offline publication host scope takes the matching version.
6. `promotion.ts` accepts version 3 in promotion packages; the publication guard and rollback keep validating definitions by version.
7. Tests: both directions and the lossless refusal in `definition-migration.test.mjs`, the kill points in `definition-migration-crash.test.mjs`, a version 3 definition through proposal, review, approval, publication and the generated workspace as `packages/agent/test/development.test.mjs` does for version 2, and the Control Plane preview.
8. Deploy readers first, then migrate drafts, then publish, in the order [docs/definition-migration.md](../definition-migration.md) already states. Historical publications stay immutable and are never rewritten.

## Consequences
- No new API. The Control Plane keeps `{expectedRevision, targetVersion}` with single-step semantics, and custom repositories keep the optional `migrateDraft` and `previewDraftMigration`.
- A version 3 costs a deliberate change in the six places above, each of which already switches on the version; a registry would not have removed any of them.
- **Trigger to revisit:** a third schema version being proposed, or a second definition family needing migrations. Then evaluate a registry that still refuses lossy steps, keeps the preview, and moves one version at a time.
