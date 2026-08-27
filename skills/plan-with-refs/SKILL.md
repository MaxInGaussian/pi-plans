---
name: plan-with-refs
description: Research references before creating a Pi plan. Use when repo-change planning needs downloaded projects, articles, papers, docs, per-reference analysis, adoption questions, language settings, and reviewer or criticizer refinement; exclude direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Plan With Refs

Use this skill when external references must shape the plan before implementation.

## Pi Setup

Read `../../references/pi-planning-workflow.md` and `../../references/state-and-config.md` — both normative — and follow their setup, state, `language`, and reviewer/criticizer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi_plans/`. Ask every question with the `ask_choice` tool; run refinement rounds with the `refine` tool.

## Required Reference Flow

1. Inspect the target Git repo read-only before external research so search terms match the actual codebase and constraints.
2. Create the `.git/pi_plans` run state and planning artifact directory once the topic is clear (`plans` action `start-run`).
3. Search proactively for related projects, articles, papers, docs, and prior art. Prefer a websearch skill when installed; otherwise use bash tools such as `curl` or `gh` when already available.
4. Download or clone at least 3 credible references before writing `PLAN_v1.md`; store large downloads outside the target repo under `~/.cache/pi-plans/refs/<repo-slug>/<topic>/`. Landing pages, README-only snapshots, abstracts, package metadata, or curl-only fragments do not count when deeper source material is available.
5. For every reference, record source metadata and local path in `REF_ANALYSIS.md` and in the run's `refs.jsonl` (via `plans` action `record-ref`): title, URL, kind, retrieval method, date accessed, local path, coverage, and evidence gaps.
6. For every reference, produce a structured analysis artifact (manual structured read recorded in `REF_ANALYSIS.md`) before asking adoption questions.
7. For every reference after analysis, ask at least 3 ref-specific adoption questions via `ask_choice` before using its ideas in `PLAN_v1.md`; each based on downloaded content, recommended option first, `Other` second-last, `Auto-complete` last (the tool appends both).
8. Block rather than pad if fewer than 3 credible references exist, unless the user explicitly narrows the topic or waives the minimum. `Auto-complete` cannot grant this waiver.
9. Continue with big-plan depth: at least 10 planning questions, required web research during brainstorming and refinement (`refine` `reviewers: 3` reviewer round, then a criticizer round), no refinement limit, at most five high-priority comments or questions per refinement round. Then the merged accept/execute question (ask_choice with `autoComplete: false`: ✓ Accept & execute now / Accept, don't execute yet / another round) and the `execute_plan` tool.

## REF_ANALYSIS.md

Include: original request and repo evidence that shaped the search; attempted queries and selection criteria; references selected and rejected; local download paths; structured analysis summaries; adoption questions and recorded answers; accepted ideas, rejected ideas, and reasons; evidence gaps and user-granted waivers; language, reviewer, and criticizer settings used.

Reference ideas are not eligible for `PLAN_v1.md` until their adoption question answers are recorded.
