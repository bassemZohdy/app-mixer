# Plan: fixes and enhancements from local verification (2026-11-13)

## Goal

A definition the Control Plane publishes always renders, a draft can be repaired, and the generated app and local tools fail clearly and are pleasant to run.

## Scope

The 13 findings of the 2026-11-13 local run: core validation and patches, publish, the generated server, page and chat, the review page, the local stack and the CLI.

## Out of scope

Table rendering, the React Native, Flutter and Angular adapters, Kubernetes, production authorization, and anything the run did not exercise (Compose, PostgreSQL).

## Lanes

- definitions: packages/core validation, patches, publish and proposal endpoints; independent of workspace
- workspace: the generated app (packages/cli, packages/web); independent of definitions; shares files with FEAT-004 and TASK-008, so do not run in parallel with them
- main: everything else

## Decisions

- Text, Input and Card properties are validated on every draft change; a Table stays a valid draft type but is refused at publish until a renderer maps it.
- Publishing a draft equal to the latest publication returns that publication and creates no version.
- Page navigation uses the URL hash, because the generated server serves only /.

## Open questions

## Revisions
