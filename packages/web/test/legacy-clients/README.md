# Retained legacy offline clients

Compiled, unmodified builds of `packages/web/src/offline*.ts` at three commits, kept so
`offline-legacy-clients.test.mjs` can check that data they wrote migrates to the current client and that they are
fenced out afterwards. Do not edit them; add a new directory when another storage format ships.

| Directory | Commit | IndexedDB version |
| --- | --- | --- |
| `v1-first-10deb32a` | 10deb32a, first encrypted browser queue (#95) | 1 |
| `v1-last-1acdff71` | 1acdff71, last client before the version fence (#155) | 1 |
| `v2-last-d968546e` | d968546e, last client before shared databases (#157) | 2 |

Rebuild one with `git show <commit>:packages/web/src/<file>.ts` for each offline source, then
`npx tsc --target ES2022 --module ES2022 --moduleResolution bundler --lib ES2022,DOM --skipLibCheck --strict --outDir <dir> <files>`.
