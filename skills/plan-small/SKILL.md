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
- Ask 1 to 3 planning questions via `ask_choice` (recommended option first; the tool adds `Other` second-last and `Auto-complete` last). With 2-3 ready questions, batch them into ONE `questions: [...]` form call; a single question uses the classic `question` form.
- Batch protocol (0.4.0): when a round has several questions, submit them together as one `ask_choice` call with `questions: [...]` (2-8 items, recommended option first per question) — the tool opens one tabbed multiple-choice form with a submit page instead of asking one at a time. After the batch returns, think about the answers, then follow up in later calls (batch again for 2+ related follow-ups; single `question` for one). `Esc` on the form returns the answered subset as partial answers — continue with what you got and re-ask only what matters. The final scope confirmation and the execution handoff are ALWAYS single-question calls with `autoComplete: false`; batches reject those questions.
- Ask the final scope confirmation, then write `PLAN_v1.md` under the artifact root (normally the configured workspace root, default `./docs/pi-plans/YYYY-MM-DD-topic/`) per `../../references/plan-artifact-template.md`.
- After each plan version, ask the merged accept/execute question via `ask_choice` with `autoComplete: false` — never run `refine` unless the user picked another round at that question. Default: exactly one round, recommended mode `Criticizer`; afterwards the recommended option is `✓ Accept & execute now` in the merged accept/execute question (ask_choice with `autoComplete: false`: ✓ Accept & execute now / Accept, don't execute yet / another round), then the `execute_plan` tool.

## Fit

A few local files, clear ownership, low risk, focused verification. Escalate to `plan-normal` for external API semantics, dependency behavior, compatibility research, cross-module design, or more than three meaningful decisions.
