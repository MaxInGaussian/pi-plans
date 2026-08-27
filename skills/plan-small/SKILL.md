---
name: plan-small
description: Create a small Pi plan before implementation. Use for small scoped repo changes needing 1 to 3 planning questions and one criticizer refinement pass; exclude direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Plan Small

Use this skill when the user wants a compact plan before a repository change.

## Pi Setup

Read `../../references/pi-planning-workflow.md` and `../../references/state-and-config.md` — both normative — and follow their setup, state, `language`, and reviewer/criticizer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi_plans/`. Ask every question with the `ask_choice` tool; run the refinement round with the `refine` tool.

## Depth Contract

- Inspect the target Git repo read-only before the first product question.
- Ask 1 to 3 planning questions, one at a time, each via `ask_choice` (recommended option first; the tool adds `Other` second-last and `Auto-complete` last).
- Ask the final scope confirmation, then write `PLAN_v1.md` under the artifact root (normally the configured workspace root, default `./docs/pi-plans/YYYY-MM-DD-topic/`) per `../../references/plan-artifact-template.md`.
- After each plan version, ask the merged accept/execute question via `ask_choice` with `autoComplete: false` — never run `refine` unless the user picked another round at that question. Default: exactly one round, recommended mode `Criticizer`; afterwards the recommended option is `✓ Accept & execute now` in the merged accept/execute question (ask_choice with `autoComplete: false`: ✓ Accept & execute now / Accept, don't execute yet / another round), then the `execute_plan` tool.

## Fit

A few local files, clear ownership, low risk, focused verification. Escalate to `plan-normal` for external API semantics, dependency behavior, compatibility research, cross-module design, or more than three meaningful decisions.
