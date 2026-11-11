# Contributing

App Mixer is a Node.js workspace (`packages/*`, `adapters/*`). Use Node 22.22.2 or later (`.nvmrc` pins 22; CI also runs 22.22.2 and 24).

## Build and test

```sh
npm ci
npm run build          # web bundle first, then every workspace
npm test               # builds, then runs every default test with node --test
npm run lint           # typescript-eslint: floating and misused promises, awaiting non-promises, unused variables (eslint.config.mjs); CI runs it on Node 22
npm run previews       # copies the shared schema parser from the generated editor template into the control plane's inert preview; a test fails when it is stale
npm run docs           # regenerates docs/README.md after adding, renaming or retitling a document
```

Tests run against `dist`, so rebuild after editing `src`. Tests wait for conditions with `waitFor` from `scripts/wait-for.mjs` (real deadline, named failure) instead of fixed sleeps. Every change should come with a test that fails without it, a `CHANGELOG.md` entry under `### Added` or `### Fixed`, and updated documentation under `docs/`. Tasks are tracked in the task tree in `TODO.md` (the earlier roadmap is kept in `TODO.legacy.md`).

## Opt-in tests

Tests that need an external service are skipped unless their variable is set. CI runs all of them.

| Variable | Needs | Command CI runs (see `.github/workflows/ci.yml`) |
| --- | --- | --- |
| `APP_MIXER_TEST_POSTGRES_URL=postgresql://user:password@host:5432/db` | PostgreSQL 16 with `pgvector` (CI uses `pgvector/pgvector:0.8.7-pg16`) | The PostgreSQL steps of `.github/workflows/ci.yml` run the `postgres-*` test files |
| `APP_MIXER_TEST_BROWSER=1` | Chrome or Edge (headless, DevTools protocol) | The browser steps of `.github/workflows/ci.yml` |
| `APP_MIXER_TEST_HYDRA=docker` | Docker (pulls the Ory Hydra image) | `node --test packages/core/test/hydra-identity.test.mjs` |
| `APP_MIXER_TEST_PROMETHEUS=docker` | Docker (Prometheus) | `node --test packages/cli/test/alert-rules.test.mjs` |
| `APP_MIXER_TEST_OTEL_COLLECTOR=docker` | Docker (OpenTelemetry Collector) | `node --test packages/cli/test/otel-collector-trace.test.mjs` |
| `APP_MIXER_TEST_OLLAMA_CHAT_MODEL` (with `APP_MIXER_TEST_OLLAMA_URL`) | An Ollama server with that chat model pulled | `node --test packages/agent/test/openai-limited-model-provider.test.mjs` |
| `APP_MIXER_TEST_HA_FAILOVER=1` (with `APP_MIXER_TEST_HA_STANDBY_URL` and `APP_MIXER_TEST_POSTGRES_URL`) | A PostgreSQL primary with a synchronous standby | `node --test packages/agent/test/postgres-shared-failover.test.mjs` |
| `APP_MIXER_TEST_KIND_NODE_FAILURE=1` (with `APP_MIXER_TEST_KUBE_CONTEXT`, `APP_MIXER_TEST_POD_POSTGRES_URL`, `APP_MIXER_TEST_WORKER_IMAGE`, `APP_MIXER_TEST_FIRST_NODE` and `APP_MIXER_TEST_REPLACEMENT_NODE`) | A kind cluster with two worker nodes | The `kubernetes-node-recovery` workflow |
| `APP_MIXER_TEST_CONCURRENCY=1..32` | Nothing | `npm test` runs that many test files at once (default 2 on Windows, 8 elsewhere) |
| `APP_MIXER_TEST_POSTGRES_RESTORE=docker` | Docker (one PostgreSQL container) | `node --test packages/core/test/postgres-restore-rollback.test.mjs` |
| `APP_MIXER_TEST_POSTGRES_FAILOVER=docker` | Docker (PostgreSQL primary and synchronous standby) | `node --test packages/core/test/postgres-revocation-failover.test.mjs packages/agent/test/postgres-run-failover.test.mjs` |

## Code scanning

`codeql.yml` runs CodeQL (`security-extended` queries) weekly, on main and on pull requests that touch shipped code, deploy files, scripts or workflows. Test code and fixtures are excluded (`.github/codeql/codeql-config.yml`). Findings appear under Security > Code scanning. Fix a finding in shipped code; if one is a false positive, dismiss it there with the reason.

Open alerts after the first review (2026-11-08), all judged not to need a code change. They were not dismissed in the Security tab, because that is a repository security setting for the maintainer to change:
- `js/user-controlled-bypass` in `packages/agent/src/notice-https-receiver.ts` and `packages/core/src/planes.ts`: the request path chooses between two operations (`/notice/status` against receiving a notice, `/promotion/import` against the other promotion routes) after the caller is authenticated. Nothing is skipped.
- `js/request-forgery` in `.github/scripts/browser-shell-smoke.mjs`: a test proxy on loopback. It refuses a request whose URL leaves the app's origin; CodeQL does not recognise that check.
- `js/insecure-temporary-file` in `deploy/kubernetes/test-support/agent-recovery/run-supervisor.mjs`: a test-support script that runs only in the kind test pod.
- `js/file-access-to-http` in `scripts/check-provider-idempotency.mjs` (two alerts): reading a credential from the environment and sending it to the provider under test is the purpose of the script, and it refuses production endpoints.

The Docker Compose outage test runs with `node deploy/local/compose-smoke.mjs`. The Kubernetes (`kubernetes.yml`), agent pod recovery (`agent-pod-recovery.yml`), Flutter (`flutter*.yml`) and React Native device workflows need kind, an Android emulator or an iOS simulator; run them from GitHub with `gh workflow run <workflow>.yml --ref <branch>`. On Windows use Git Bash and set `MSYS_NO_PATHCONV=1` when passing paths to `kind` or `docker`.

## Pull requests

Keep commits focused, explain the reason for a change, and do not weaken a check to make a test pass. Report security problems privately as described in `SECURITY.md`.
