# PLAN_overall_v1 - demo product

Status: draft
Plan version: 1
Artifact directory: `.git/pi-plans/plans/2026-10-04-demo-product/`
Language: `en`

## Original Request

Build a small demo product in three progressive versions, each one a running
vertical slice, starting from a walking skeleton.

## Versions

- `v0.1.0`: walking skeleton — done: the CLI runs end to end on a sample input.
- `v0.2.0`: persistence — done: data survives a process restart.
- `v0.3.0`: multi-user — done: two users see isolated data.

## Architecture

One CLI process, a thin command layer over a store module, with a JSON file as
the first persistence backend. Later versions replace the store internals
without touching the command layer.

## File Map

| Path | Responsibility | Version |
| --- | --- | --- |
| src/cli.ts | argument parsing and command dispatch | v0.1.0 |
| src/store.ts | in-memory record store with a pluggable backend | v0.1.0 |
| src/persist.ts | JSON file backend for the store | v0.2.0 |
| src/accounts.ts | per-user namespaces | v0.3.0 |

## User Experience

One command per action, no configuration required, errors printed on stderr
with a non-zero exit code.

## Final Objective

A dependable local tool where three people can keep private records without a
server, with the same command surface from the first version on.
