---
name: plan-huge
description: Create a huge Pi plan for multi-version product builds. Use when the effort is bigger than plan-big — an abstract overall plan (mission per version, architecture, file map, user experience, final objective), then one plan-big-style plan per product version (2 to 10 versions), each planned, reviewed, executed, and execution-reviewed before the next version is planned; exclude direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Plan Huge

Use this skill when a user wants to build a product step by step across
multiple product versions and the whole effort is bigger than a single
`plan-big` plan.

## Pi Setup

Read `../../references/pi-planning-workflow.md`, `../../references/state-and-config.md`, and `../../references/huge-plan-artifact-template.md` — all normative — and follow their setup, state, `language`, and reviewer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi-plans/`. Ask every question with the `ask_choice` tool; batch related questions into one `questions: [...]` form call (2-8 items, recommended option first per question), while scope confirmation and the execution handoff stay single-question calls with `autoComplete: false`. Run refinement rounds with the `refine` tool. Every option you write carries a `description` of the form `✓ <advantage> / ✗ <drawback>` in the configured language, kept terse — the user weighs what each option gains against what it costs. The tool appends the `Other…` and `Auto-complete` rows itself; never author them, and keep both the scope confirmation and the execution handoff free of `Auto-complete` (`autoComplete: false`).

## Stage Order

One run, one flat artifact directory, many plan files. The run is started once
(`plans` action `start-run` with `skill: "plan-huge"`) after read-only repo
inspection.

1. **Overall planning** — write `PLAN_overall_v1.md` per
   `references/huge-plan-artifact-template.md`: the version table, overall
   architecture, file map (path / responsibility / version), expected user
   experience, and the final objective. Question depth: at least 10
   `ask_choice` questions. Reviewer default: one `refine` round with
   `reviewers: 3` plus tailored `directions` (see the shared workflow); the user may extend rounds at the merged accept/execute
   question. Record the boundary with `plans` (`record-checkpoint`,
   transition `overall-plan-written`).
2. **Accept the overall plan** — the merged accept/execute question offers
   `✓ Accept & execute now`; for the overall stream, accepting starts the
   `v0.1.0` planning round and never execution. Record it with `plans`
   (`record-checkpoint`, transition `overall-accepted`).
3. **Version planning** — plan **only** the current version:
   `PLAN_vX.Y.Z_v1.md` in the same artifact directory, structured exactly like
   a `plan-big` plan plus the huge-only sections (`## Deferred to vX.Y.Z`,
   `## Evidence`). Question depth: 5-10 questions. Then the same reviewer
   treatment as step 1 (`refine` with `reviewers: 3` and tailored `directions` by default). Recording
   the plan is mandatory: `plans` (`record-checkpoint`, transition
   `version-plan-written`) is what runs the deferred gate and the reference
   lint and what stores this version's round.
4. **Execution and execution review** — identical to `plan-big`: the merged
   accept/execute question, the `execute_plan` tool, task progress through
   `plans_update_task`, and the independent execution reviewer verifying every
   verification check.
5. **Next version** — when a version completes, the run returns to planning
   (non-terminal) and the loop continues at step 3 for the next row of the
   version table, until the last version has executed and passed review. Only
   then does the run become terminal (`done`).

## Entry From plan-with-refs

A huge build that also needs external references enters here through
`plan-with-refs`, which fixes the plan's shape after analyzing them. Keep that
same run: never start a new run and never restart the existing one — its
recorded `skill` stays `plan-with-refs`, and this skill's stage order,
question depth, checkpoint transitions and gates apply unchanged. The
reference analyses and adoption answers already recorded in `REF_ANALYSIS.md`
are the evidence for the overall plan and every version; do not download those
references again. Append a reference only when a version introduces a new
technology or when a key design decision is genuinely contested.

## Checkpoint Transitions

Every stage boundary is a `plans` `record-checkpoint` call; skipping one
disables the gate that rides on it:

- `overall-plan-written` — after writing/revising `PLAN_overall_vN.md`
  (validates the version table; a controlled revision records its reason and
  affected versions). Add `overall-review-consolidated` with the round id
  after the overall reviewer round.
- `overall-accepted` — after the user accepts the overall plan (moves the run
  to the first version's planning round).
- `version-plan-written` — after writing/revising the current version's plan.
  This transition runs the deferred gate (every previous item absorbed or
  dropped with its own recorded confirmation) and the GitHub reference lint,
  and it stores the version's round.
- `version-review-consolidated` — after the version's reviewer round; it is
  what moves the run to the execution handoff.
- `version-completed` — only when a version's execution must be closed
  outside the normal completion path; the ordinary completion archives the
  version automatically and returns the run to planning.

## Contracts

- **Version table** (`## Versions`): 2-10 rows, first row exactly `v0.1.0`,
  strictly ascending `v0.Y.Z` labels, each row a mission plus a `done:`
  completion criterion. The tooling refuses to record an overall plan that
  violates this. Each version is a running vertical slice, not a layer.
- **Deferred ledger** (`## Deferred to vX.Y.Z`): every item is
  ``- `D-<this version>-<n>`: <summary> — reason: <why>``. Ids are
  version-scoped and never reused; the last version may write
  `## Deferred to none`. When planning the next version, process every item
  from the previous plan one by one: absorb it (write it into this version's
  tasks) or drop it. A drop needs a recorded user confirmation — ask one
  batched `ask_choice` question whose `questionId` is
  `huge-deferred-<version>--<itemId>` (double dash: the checkpoint
  question-id grammar forbids `:`), and only a `user` answer counts
  (`auto-complete` never does). The tooling refuses a version plan that
  leaves previous items unprocessed.
- **References** (`## Evidence`): every version plan cites 1-3 related
  open-source GitHub projects (at least one) whose ideas informed it, with a
  one-line takeaway each. A version plan with zero GitHub references gets a
  run notice visible in `/plans`; the check is advisory. Append a reference,
  download it, and run the `analyze_refs` tool only when a version introduces
  a new technology or when a key design decision is genuinely contested
  (respect `refs_root` from `plans` `show`).
- **Rounds and names**: `PLAN_overall_vN.md` for the overall stream and
  `PLAN_vX.Y.Z_vN.md` for a version stream, where the trailing `vN` is the
  revision round of that stream. Never write a plain `PLAN_vN.md` into a huge
  artifact directory — the legacy name belongs to ordinary runs and is
  invisible to the huge parsers.
- **Controlled overall revision**: to change the architecture mid-flight,
  write `PLAN_overall_v(N+1).md`, record the reason and the affected versions,
  and only change versions that have not started. The current version keeps
  its identity from the run checkpoint; never renumber completed versions.
- **Review budget**: ask for the execution-review budget and termination
  condition once, on the first version's handoff; every later version
  inherits them (the user can still change them). Do not re-ask by default.
- **VC evidence form**: write every verification check so it can be judged
  from the worktree with read-only tools (file X contains symbol/case Y
  asserting Z). The execution reviewer has no shell, so command output is
  corroboration, never the primary evidence.

## Gates

- The overall plan is never executable: `execute_plan` hard-rejects
  `PLAN_overall_vN.md` and points at the current version plan.
- An explicit `planPath` handed to `execute_plan` must belong to this run's
  version stream and be that stream's latest round; a stale round or an
  already-completed version is refused.
- Between versions the run stays non-terminal (`planning` with next action
  `plan-next-version`, then `accepted` while a version plan awaits its
  handoff, `executing` during execution). `done` appears only after the last
  version.
- Plan files use the `plan-big` task grammar; the `### Execution Waves`
  subsection is authoritative, and lint notices are hard-rejected at the
  execution gate.

## Fit

Multi-version product builds where the user wants to plan, build, and verify
one version at a time while keeping one coherent overall architecture. Use
`plan-big` for a single large change, `plan-with-refs` when references must
shape the plan before any version is chosen, and `plan-huge` when the work
spans at least two product versions.
