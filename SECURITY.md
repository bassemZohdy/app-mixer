# Security policy

App Mixer is pre-release repository software (see `docs/foundation-review.md` and `TODO.md` for what is and is not production ready). Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting for this repository (`Security` tab, `Report a vulnerability`) instead of opening a public issue. Include the affected package, the version or commit, and steps to reproduce.

Reports are acknowledged on a best-effort basis. Fixes are developed in a private branch and released with a `CHANGELOG.md` entry under `### Fixed`.

In scope: authentication and authorization, tenant isolation, the capability registry, agent action and approval handling, the offline queue and extension integrity checks. Out of scope: problems that need a malicious host application, an attacker who already holds host credentials, or a deployment that ignores the hardening guidance in `docs/`.
