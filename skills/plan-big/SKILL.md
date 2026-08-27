---
name: plan-big
description: Create a large Pi plan before implementation. Use for open-ended or high-risk repo efforts needing 10 or more planning questions, web research, concurrent reviewer or criticizer refinement, and refinement until convergence; exclude direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Plan Big

Use this skill when the user wants a large, high-risk, or open-ended plan before a repository change.

## Pi Setup

Read `../../references/pi-planning-workflow.md` and `../../references/state-and-config.md` — both normative — and follow their setup, state, `language`, and reviewer/criticizer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi_plans/`. Ask every question with the `ask_choice` tool; run refinement rounds with the `refine` tool.

## Depth Contract

- Inspect the target Git repo read-only before the first product question.
- Ask at least 10 planning questions, one at a time; no maximum — stop only when the decision tree is genuinely resolved. Each via `ask_choice` (recommended option first; the tool adds `Other` second-last and `Auto-complete` last).
- Use web research during both brainstorming and refinement when outside facts, patterns, or ecosystem constraints matter, and cite sources in the plan.
- Ask the final scope confirmation, then write `PLAN_v1.md` per `../../references/plan-artifact-template.md`.
- After each plan version, ask the refinement-mode question via `ask_choice` — never run `refine` unless the user or `Auto-complete` selected it at that question. Default sequence: one `Reviewer` round as three concurrent independent reviewers (`refine` with `reviewers: 3`, consolidated by the main agent per the shared workflow), then one `Criticizer` round; afterwards the recommended option is `Accept plan for tracked execution`. Beyond the default sequence, refine until convergence on high-priority findings, unresolved questions, or evidence gaps; surface at most five per round. Then the execution handoff (ask_choice with `autoComplete: false`, then the `execute_plan` tool).

## Fit

New systems, large feature surfaces, cross-repository or cross-service work, open-ended architecture, safety-sensitive changes, unclear user workflows, or plans whose shape is not yet known. Use `plan-with-refs` instead when external projects, papers, articles, or documentation must be downloaded and studied before planning choices are safe.
