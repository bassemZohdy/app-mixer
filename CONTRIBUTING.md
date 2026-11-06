# Contributing

App Mixer is a Node.js workspace (`packages/*`, `adapters/*`). Use Node 22.13 or later (`.nvmrc` pins 22; CI also runs 22.13.0 and 24).

## Build and test

```sh
npm ci
npm run build          # web bundle first, then every workspace
npm test               # builds, then runs every default test with node --test
npm run todo           # recomputes the progress table in TODO.md; a test fails when it is stale
npm run lint           # typescript-eslint: floating and misused promises, awaiting non-promises, unused variables (eslint.config.mjs); CI runs it on Node 22
npm run docs           # regenerates docs/README.md after adding, renaming or retitling a document
```

Tests run against `dist`, so rebuild after editing `src`. Every change should come with a test that fails without it, a `CHANGELOG.md` entry under `### Added` or `### Fixed`, and updated documentation under `docs/`. Tasks are tracked in `TODO.md`; tick the task and run `npm run todo`.

## Opt-in tests

Tests that need an external service are skipped unless their variable is set. CI runs all of them.

| Variable | Needs | Command CI runs (see `.github/workflows/ci.yml`) |
| --- | --- | --- |
| `APP_MIXER_TEST_POSTGRES_URL=postgresql://user:password@host:5432/db` | PostgreSQL 16 with `pgvector` (CI uses `pgvector/pgvector:0.8.7-pg16`) | The `postgres-revocations` job runs an explicit file list with `node --test --test-concurrency=3`; locally `node --test --test-concurrency=3 packages/core/test/postgres-*.test.mjs packages/agent/test/postgres-*.test.mjs packages/agent/test/memory-evaluation-set.test.mjs` covers the same tests |
| `APP_MIXER_TEST_BROWSER=1` | Chrome or Edge (headless, DevTools protocol) | `node --test packages/cli/test/browser-rollback-anchor.test.mjs packages/web/test/browser-offline-provisioning.test.mjs packages/web/test/browser-accessibility-parity.test.mjs packages/cli/test/csp.test.mjs` |
| `APP_MIXER_TEST_KEYCLOAK=docker` | Docker (pulls the Keycloak image) | `node --test packages/agent/test/keycloak-identity.test.mjs` |
| `APP_MIXER_TEST_S3=docker` | Docker (S3-compatible object store) | `node --test packages/core/test/staged-s3-provider.test.mjs packages/agent/test/action-s3-provider-crash.test.mjs` |
| `APP_MIXER_TEST_OTEL_COLLECTOR=docker` | Docker (OpenTelemetry Collector) | `node --test packages/cli/test/otel-collector-trace.test.mjs` |
| `APP_MIXER_TEST_PROMETHEUS=docker` | Docker (Prometheus) | `node --test packages/cli/test/alert-rules.test.mjs` |

The Docker Compose outage test runs with `node deploy/local/compose-smoke.mjs`. The Kubernetes (`kubernetes.yml`), agent pod recovery (`agent-pod-recovery.yml`), Flutter (`flutter*.yml`) and React Native device workflows need kind, an Android emulator or an iOS simulator; run them from GitHub with `gh workflow run <workflow>.yml --ref <branch>`. On Windows use Git Bash and set `MSYS_NO_PATHCONV=1` when passing paths to `kind` or `docker`.

## Pull requests

Keep commits focused, explain the reason for a change, and do not weaken a check to make a test pass. Report security problems privately as described in `SECURITY.md`.
