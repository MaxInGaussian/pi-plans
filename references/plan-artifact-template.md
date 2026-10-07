# PLAN_vN - <topic>

Status: draft | reviewed | accepted
Plan version: N
Artifact directory: `<artifact_root>/YYYY-MM-DD-topic/`
State directory: `.git/pi-plans/runs/<run-id>/` (resolved git common dir)
Language: `<BCP47 tag>`

## Original Request

One paragraph summarizing the user's request.

## Tasks

- `Task-1`: <title> — deps: <Task-ids, optional>; files: <paths, optional>; wave: <number, optional>
- `Task-2`: <title> — deps: Task-1; files: src/a.ts, src/b.ts; wave: 2
  - `Task-2.1`: <subtask title> — deps: Task-1; files: src/a.ts
- `Task-3`: <title> — deps: Task-1, Task-2; files: src/c.ts; wave: 3

### Execution Waves

- wave 1: Task-1 — <why these can run first / in parallel>
- wave 2: Task-2 — <files disjoint within the wave; deps satisfied by earlier waves>
- wave 3: Task-3 — <serial finish>

## Verification Checks

- [ ] `VC-001` covers `Task-1`; pass condition: <observable condition>; evidence: <expected evidence>; metric: <threshold or "not quantified">.
- [ ] `VC-002` covers `Task-2` and `Task-2.1`; pass condition: …; evidence: …; metric: ….

## Execution Handoff Notes

Ordering, files to avoid, verification commands, and anything the executor must know. The handoff still requires explicit user approval (`ask_choice` with `autoComplete: false`, then the `execute_plan` tool) and is never auto-completed. Once approved, execution mode tracks every task through the `plans_update_task` tool (status + evidence); when all tasks are terminal, the independent execution reviewer verifies each check above before the run completes.

### Huge (plan-huge) version streams

A `plan-huge` version plan (`PLAN_vX.Y.Z_vN.md`) keeps the exact same body:
`## Original Request`, `## Tasks` (+ `### Execution Waves`), and
`## Verification Checks`. On top of that it may carry two huge-only auxiliary
sections, both parsed by `src/huge-plan.ts`:

- `## Deferred to vX.Y.Z` — the work intentionally left for the next version.
  One row per item: ``- `D-vX.Y.Z-n`: <summary> — reason: <why>``. Ids are
  version-scoped (`D-<this version>-<n>`), never reused, and the last version
  may write `## Deferred to none`. Collecting an item into the next version plan
  is `absorbed`; dropping it needs a recorded user confirmation whose
  `questionId` is `huge-deferred-<version>--<itemId>` (double dash — the
  checkpoint question-id grammar forbids `:`) with `source === "user"` in the
  run checkpoint (an `auto-complete` answer does not count).
- `## Evidence` — 1–3 GitHub project URLs that informed the version plan
  (at least one). A version plan with zero GitHub references gets a run notice
  (visible in `/plans`); the lint is advisory, never a hard block.

Huge streams also never reuse `PLAN_vN.md` for their revisions: the trailing
`vN` of `PLAN_vX.Y.Z_vN.md` is the round of that version stream, and the run
keeps them in the same flat artifact directory (`.git/pi-plans/plans/<date-topic>/`)
as `PLAN_overall_vN.md` plus one `PLAN_vX.Y.Z_vN.md` family per version.
See `references/huge-plan-artifact-template.md` for the overall-plan template.

## Revision Ledger

- `PLAN_v1`: <one line per revision: what changed and why>.

---

## Format specification (normative)

The plan body is exactly two sections plus the metadata header shown above:
`## Original Request` (one paragraph), `## Tasks`, and `## Verification Checks`.
Everything else the workflow needs lives in the run state (decisions ledger,
review rounds, refs), not in the plan file. `## Execution Handoff Notes` and
`## Revision Ledger` are the two permitted auxiliary sections.

### Tasks microsyntax

- Top-level task line: ``- `Task-N`: <title> — deps: <ids>; files: <paths>; wave: <n>``.
  The separator between title and metadata is an em dash `—` (tolerated: `——`, `--`, `–`).
  With no separator the whole body is the title (no fields).
- Fields are separated by `;` (tolerated `；`); multi-values by `,`
  (tolerated `，` `、`). All three fields are optional; missing `wave` values
  derive from deps (1 + max(dep wave)), and the `### Execution Waves`
  subsection wins over inline `wave:` on conflict (linted).
- Subtasks: one indented bullet level, ``- `Task-N.M`: <title> — …``. Only one
  nesting level is valid; deeper ids lint as drift. Subtasks may carry
  `deps:`/`files:`; the wave is inherited from the parent (inline `wave:` on a
  subtask is ignored with a lint notice).
- `### Execution Waves` rows: ``- wave <n>: Task-1, Task-2 — <rationale>``.
  The wave table is the authoritative parallel-execution order: within one
  wave, top-level tasks' file sets must be disjoint (children roll up to their
  parent), and every `deps:` target must sit in an earlier wave.

### Verification Checks microsyntax

- Row: ``- [ ] `VC-###` covers `Task-2` and `Task-3`; pass condition: …; evidence: …; metric: …``.
- `covers` accepts multiple targets and `Task-N.M` subtask ids; the clause ends
  at the first `;`. Checks covering zero tasks never enter the completion
  audit; a check whose covered tasks are ALL skipped passes as skipped-pass.
- Write each check so its condition can be judged from the worktree alone: a
  check whose evidence is not reachable with read-only tools comes back
  `undeterminable`, not `pass`, and an unreadable round never completes the run.
- A check that fails the audit rolls its covered tasks back to pending. The
  tasks keep the `evidence` from the attempt that was rolled back (re-reporting
  overwrites it), so evidence is the record of what was already tried — do not
  expect a clean slate, and do not re-report a rolled-back task until you have
  actually changed something. `skipReason` is cleared, because the audit
  overturned the skip. A rollback also clears the satisfied state of any other
  check covering the reopened work.

### Lint and compatibility

- Planning-time lint (`lintPlanIntoNotices`): zero parsed tasks under an
  existing `## Tasks` header, over-deep subtasks, non-consecutive top-level
  numbering, unknown dep/coverage targets, same-wave file overlaps,
  deps inside the same-or-later wave, inline-vs-subsection wave conflicts.
  Lint notices are advisory while planning and hard-rejected at the execution gate.
- Legacy compatibility: plans without `## Tasks` fall back to parsing
  `## Implementation Items` (`I-001` → `Task-1`, `covers \`I-001\`` normalizes
  the same way); checklist-only pre-0.5 artifacts synthesize one serial task
  per check. The execution gate surfaces an upgrade notice on fallback.

### Refinement

One Reviewer role: each round returns findings (`F-###`) and up to five
questions (`Q-1..Q-5`). Default sequences: plan-big → one round of three
concurrent reviewers (questions included); plan-normal → one round of two
concurrent reviewers; plan-small → one reviewer round. Multi-reviewer rounds
use directions the planner writes for the project (`refine` `directions`). The main agent asks every question with `ask_choice` and
records the answers before revising the plan.
