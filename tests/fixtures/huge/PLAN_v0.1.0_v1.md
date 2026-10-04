# PLAN_v0.1.0_v1 - walking skeleton

Status: draft
Plan version: 1 (stream v0.1.0)
Artifact directory: `.git/pi-plans/plans/2026-10-04-demo-product/`
Language: `en`

## Original Request

Deliver the walking skeleton of the demo product: a CLI that stores and lists
records in memory, end to end.

## Tasks

- `Task-1`: CLI entry point — files: src/cli.ts; wave: 1
- `Task-2`: in-memory store — deps: Task-1; files: src/store.ts; wave: 2

### Execution Waves

- wave 1: Task-1 — the entry point has no dependency
- wave 2: Task-2 — the store needs the dispatch contract

## Verification Checks

- [ ] `VC-001` covers `Task-1`; pass condition: `src/cli.ts` exports `run`; evidence: exported symbol; metric: not quantified.
- [ ] `VC-002` covers `Task-2`; pass condition: `src/store.ts` keeps records across calls; evidence: test case `store-roundtrip`; metric: 0 failures.

## Evidence

- Reference implementation for the command layer: https://github.com/example/cli-kit
- Reference implementation for the record store: https://github.com/example/tiny-store

## Deferred to v0.2.0

- `D-v0.1.0-1`: file persistence — reason: needs the store backend seam first.
- `D-v0.1.0-2`: multi-user namespaces — reason: depends on persistence layout.

## Revision Ledger

- `PLAN_v1`: initial version plan for the walking skeleton.
