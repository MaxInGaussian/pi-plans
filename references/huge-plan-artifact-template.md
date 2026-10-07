# PLAN_overall_vN - <topic>

Status: draft | reviewed | accepted
Plan version: N
Artifact directory: `<artifact_root>/YYYY-MM-DD-topic/`
State directory: `.git/pi-plans/runs/<run-id>/` (resolved git common dir)
Language: `<BCP47 tag>`

## Original Request

One paragraph summarizing the user's request, the product goal, and the
version range agreed with the user (at least two, at most ten versions).

## Versions

The version table is the contract every later stage reads. One row per
product version, strictly ascending `v0.Y.Z` labels (first row `v0.1.0`,
`Y` grows, `Z` is a patch counter), each row a running vertical slice:

- `v0.1.0`: <mission of the first version> — done: <observable completion criterion>
- `v0.2.0`: <mission of the second version> — done: <observable completion criterion>
- `v0.3.0`: <mission> — done: <criterion>

Rules the tooling enforces when the overall plan is recorded: 2–10 rows,
first row exactly `v0.1.0`, strictly ascending labels, and a mission plus a
`done:` clause on every row.

## Architecture

The overall codebase shape: components, their responsibilities, and the
boundaries between them. Keep it abstract — enough to place every later
version, not an implementation plan. Note which version introduces which
component, and which seams later versions replace.

## File Map

Roughly define the functionality of the files: directories get a
responsibility, key files get a row. Later version plans must stay aligned
with this map; moving or renaming a file is a plan revision, not a detail.

| Path | Responsibility | Version |
| --- | --- | --- |
| src/… | <what this file or directory is for> | v0.1.0 |

## User Experience

What the user sees and does, end to end: the commands, screens, or APIs, the
errors they can hit, and the experience the first version must already
deliver (the walking skeleton) versus what later versions add.

## Final Objective

The ideal end state of the product after the last version: the capability
that makes it worth building, and the criteria that would let a reader say
the final version reached it.

---

## Format specification (normative)

The overall plan is a planning artifact, not an execution artifact. Its body
is exactly the sections above — `## Original Request` plus the five product
sections `## Versions`, `## Architecture`, `## File Map`,
`## User Experience`, `## Final Objective`; `## Revision Ledger` is the only
permitted auxiliary section.

- An overall plan must **never** contain `## Tasks` or
  `## Verification Checks` — those belong to per-version plans. The
  `execute_plan` tool hard-rejects `PLAN_overall_vN.md` and points at the
  current version plan instead.
- The run state lives in `.git/pi-plans/` (run registry, checkpoints,
  decisions, review rounds); the overall plan file itself carries no run
  state.
- Naming: `PLAN_overall_v1.md`, then `PLAN_overall_v2.md`, … after each
  reviewer round. The trailing `vN` is the round of the overall stream; per
  version plans use `PLAN_vX.Y.Z_vN.md` in the same artifact directory.
- A controlled revision of the overall plan produces
  `PLAN_overall_v(N+1).md`, records the reason and the affected versions in
  this section, and only affects versions that have not started. The current
  version keeps its identity from the run checkpoint.
- Acceptance semantics: an accepted overall plan starts the `v0.1.0`
  planning round; it never starts execution.
- Reviewer default: one round of three concurrent reviewers (tailored directions), extendable by
  the user through the merged accept/execute question.
