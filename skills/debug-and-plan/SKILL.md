---
name: debug-and-plan
description: Diagnose failures before creating a Pi plan. MUST USE for bugs, CI failures, test failures, regressions, incidents, broken behavior, root cause, RCA, or debug-why requests before deciding whether to plan; preserve language, reviewer, and criticizer settings in `.git/pi_plans/config.json`; exclude ordinary feature planning, direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Debug And Plan

Use this skill for problem or failure inputs that need diagnosis before planning.

## Pi Setup

Read `../../references/pi-planning-workflow.md` and `../../references/state-and-config.md` — both normative — and follow their setup, state, `language`, and reviewer/criticizer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi_plans/`. Ask every question with the `ask_choice` tool; run refinement rounds with the `refine` tool.

## Diagnostic Workflow

1. Inspect available evidence first: repository files, logs, tests, command output, stack traces, recent diffs, CI output, environment details, and user-provided symptoms.
2. Produce an in-message RCA summary before asking whether to plan. Use at most 5 Whys. Stop with `unknown` when evidence is insufficient; do not invent a cause.
3. Ask one `ask_choice` question in the configured language whose preamble includes the RCA summary, with these options:
   1. `Create the scoped fix plan` — recommended when evidence supports a planning path.
   2. `Stop after RCA` — keep the diagnosis only.
   3. `Other` / 4. `Auto-complete` are added by the tool.
4. On opt-out, stop after the summary; do not write `PROBLEM_ANALYSIS.md`.
5. On opt-in (or `Auto-complete` choosing the recommendation), select the smallest fitting planning skill and follow that skill exactly: first-turn planning question, final scope confirmation, `PLAN_v1.md`, refinement, and the execution handoff (ask_choice with `autoComplete: false`, then the `execute_plan` tool).

## Level Selection

- `plan-small`: clear root cause, obvious fix shape, few local files, limited risk.
- `plan-normal`: multi-file fix, external API or dependency behavior, compatibility concerns, or research needed.
- `plan-big`: cross-system failure, unclear root cause, redesign pressure, or high safety/recoverability risk.

Do not ask the user to choose the level unless the evidence supports two materially different planning depths and the tradeoff cannot be resolved from the repo.

## PROBLEM_ANALYSIS.md

After opt-in, create the selected planning run's `.git/pi_plans` state and public artifact directory (`plans` action `start-run`), then write `PROBLEM_ANALYSIS.md` before `PLAN_v1.md`. Include: original problem; symptoms and reproduction status; evidence inspected; RCA summary and 5 Whys (ending early with `unknown` when evidence stops); suspected root cause and confidence; planning skill selected and why; language, reviewer, and criticizer settings used; open diagnostic gaps the plan must address. Pass the original problem, RCA summary, evidence, and `PROBLEM_ANALYSIS.md` path into the selected planning skill.
