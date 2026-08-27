---
name: plan-normal
description: Create a researched Pi plan before implementation. Use for broad or risky repo changes needing 5 to 10 planning questions, web research, reviewer or criticizer refinement, and bounded refinement; exclude direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Plan Normal

Use this skill when the user wants a substantive plan before a repository change.

## Pi Setup

Read `../../references/pi-planning-workflow.md` and `../../references/state-and-config.md` — both normative — and follow their setup, state, `language`, and reviewer/criticizer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi_plans/`. Ask every question with the `ask_choice` tool; run refinement rounds with the `refine` tool.

## Depth Contract

- Inspect the target Git repo read-only before the first product question.
- Ask 5 to 10 planning questions, one at a time, each via `ask_choice` (recommended option first; the tool adds `Other` second-last and `Auto-complete` last).
- Use web research whenever outside library behavior, ecosystem precedent, UX convention, protocol semantics, or compatibility affects the recommendation (websearch skill when installed; otherwise `curl`/`gh` via bash), and cite sources in the plan.
- Ask the final scope confirmation, then write `PLAN_v1.md` per `../../references/plan-artifact-template.md`.
- After each plan version, ask the merged accept/execute question via `ask_choice` with `autoComplete: false` — never run `refine` unless the user picked another round at that question. Default sequence: one `Reviewer` round, then one `Criticizer` round; afterwards the recommended option is `✓ Accept & execute now` in the merged accept/execute question. Up to five rounds total, continuing only for high-priority findings or unresolved criticizer questions; surface at most five per round. Then the merged accept/execute question (ask_choice with `autoComplete: false`: ✓ Accept & execute now / Accept, don't execute yet / another round) and the `execute_plan` tool.

## Fit

Multi-file changes, architecture boundaries, user-facing workflows, external APIs, dependency upgrades, compatibility risk, or web-evidence-shaped plans. Escalate to `plan-big` when open-ended, cross-system, strategically ambiguous, or likely beyond ten planning decisions.
