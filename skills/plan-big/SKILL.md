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
- Ask at least 10 planning questions; no maximum — stop only when the decision tree is genuinely resolved. Each via `ask_choice` (recommended option first; the tool adds `Other` second-last and `Auto-complete` last). Phase them in batches of up to 8: submit ONE `questions: [...]` form call per phase, think about the answers, then continue with the next batch or follow-ups.
- Batch protocol (0.4.0): when a round has several questions, submit them together as one `ask_choice` call with `questions: [...]` (2-8 items, recommended option first per question) — the tool opens one tabbed multiple-choice form with a submit page instead of asking one at a time. After the batch returns, think about the answers, then follow up in later calls (batch again for 2+ related follow-ups; single `question` for one). `Esc` on the form returns the answered subset as partial answers — continue with what you got and re-ask only what matters. The final scope confirmation and the execution handoff are ALWAYS single-question calls with `autoComplete: false`; batches reject those questions.
- Use web research during both brainstorming and refinement when outside facts, patterns, or ecosystem constraints matter, and cite sources in the plan.
- Ask the final scope confirmation, then write `PLAN_v1.md` per `../../references/plan-artifact-template.md`.
- After each plan version, ask the merged accept/execute question via `ask_choice` with `autoComplete: false` — never run `refine` unless the user picked another round at that question. Default sequence: one `Reviewer` round as three concurrent independent reviewers (`refine` with `reviewers: 3`, consolidated by the main agent per the shared workflow), then one `Criticizer` round; afterwards the recommended option is `✓ Accept & execute now` in the merged accept/execute question. Beyond the default sequence, refine until convergence on high-priority findings, unresolved questions, or evidence gaps; surface at most five per round. Then the merged accept/execute question (ask_choice with `autoComplete: false`: ✓ Accept & execute now / Accept, don't execute yet / another round) and the `execute_plan` tool.

## Fit

New systems, large feature surfaces, cross-repository or cross-service work, open-ended architecture, safety-sensitive changes, unclear user workflows, or plans whose shape is not yet known. Use `plan-with-refs` instead when external projects, papers, articles, or documentation must be downloaded and studied before planning choices are safe.
