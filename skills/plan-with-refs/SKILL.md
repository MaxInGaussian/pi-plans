---
name: plan-with-refs
description: Research references before creating a Pi plan. Use when repo-change planning needs downloaded projects, articles, papers, docs, per-reference analysis, adoption questions, language settings, and reviewer refinement (findings plus questions); after the references are analyzed, the plan takes the shape the workload calls for — plan-normal, plan-big, or plan-huge, whose multi-version stream continues in the same run; exclude direct implementation-only, factual/explanation, trivial command-only, or explicit no-plan requests.
---

# Plan With Refs

Use this skill when external references must shape the plan before implementation.

## Pi Setup

Read `../../references/pi-planning-workflow.md` and `../../references/state-and-config.md` — both normative — and follow their setup, state, `language`, and reviewer rules. Initialize workspace state with the `plans` tool (`action: "init"`); state lives in `.git/pi-plans/`. Ask every question with the `ask_choice` tool (batch related questions and adoption questions into one `questions: [...]` form call, 2-8 items; scope/handoff stays single-question with `autoComplete: false`); run refinement rounds with the `refine` tool.

## Required Reference Flow

1. Inspect the target Git repo read-only before external research so search terms match the actual codebase and constraints.
2. Create the `.git/pi-plans` run state and planning artifact directory once the topic is clear (`plans` action `start-run`).
3. Search proactively for related projects, articles, papers, docs, and prior art. Prefer a websearch skill when installed; otherwise use bash tools such as `curl` or `gh` when already available.
4. Before the first download, check `refs_root` in `.git/pi-plans/config.json` (`plans` action `show`). If it is unset, ask exactly one `ask_choice` question — recommended `.git/pi-plans/refs/` (inside the git dir, never tracked), second `./refs/`, third `~/.cache/pi-plans/refs/` — with each option's `description` set to `✓ <advantage> / ✗ <drawback>` in the configured language, kept terse, and persist with `plans` (`set-refs-root`); this question does not count against the planning-question limit. Then download at least 3 credible references across at least 2 distinct origins before writing the run's first plan file (`PLAN_v1.md` for the ordinary shapes, `PLAN_overall_v1.md` for `plan-huge`), under the configured refs root (one subdirectory per reference — `analyze_refs` requires directories). References are NOT limited to GitHub repositories: papers (e.g. arXiv), engineering blog posts, and documentation sites are first-class, and theoretical references count exactly as much as implementation references. A download is qualified per medium: repo = clone (full working tree); paper = the full text (arXiv HTML preferred, else the PDF with extracted text into `paper.txt`/`paper.md`; an abstract alone never qualifies); blog/docs site = the full-article readable markdown saved locally (single-page posts are fine — they ARE the source; only fragments or teasers fail). Landing pages, README-only snapshots, abstracts, package metadata, or curl-only fragments do not count when deeper source material is available.
5. For every reference, record source metadata and local path in `REF_ANALYSIS.md` and in the run's `refs.jsonl` (via `plans` action `record-ref`): title, URL, kind (`project` for repos, `paper` for papers, `article` for blog posts, `docs` for documentation sites), retrieval method, date accessed, local path, coverage, and evidence gaps.
6. For every reference, run the `analyze_refs` tool (required path — it replaces manual structured reads): one independent read-only subagent per reference deep-reads it and returns structured sections (Overview / Key Mechanisms And Design Tradeoffs / Adoptable Ideas For The Target Repo / Pitfalls And Anti-Patterns / Evidence Citations / Coverage / Evidence Gaps). Paste each analysis into `REF_ANALYSIS.md` and fill `coverage` and `gaps` in `refs.jsonl` via `plans` (`record-ref`) before asking adoption questions.
7. For every reference after analysis, ask at least 3 ref-specific adoption questions via `ask_choice` before using its ideas in the run's first plan file; each based on downloaded content, recommended option first, `Other` second-last, `Auto-complete` last (the tool appends both). Every option you write carries a `description` of `✓ <advantage> / ✗ <drawback>` in the configured language, kept terse — adoption choices trade a real gain against a real cost, so state both. Batch one reference's adoption questions into a single `questions: [...]` form call.
8. Block rather than pad if fewer than 3 credible references exist, unless the user explicitly narrows the topic or waives the minimum. `Auto-complete` cannot grant this waiver.
9. Fix the plan's shape with `## Plan Shape Branch`: one `ask_choice` single-question call (`questionId: refs-plan-shape`, `autoComplete: false`) recommending the shape the prompt's workload calls for — `plan-normal`, `plan-big`, or `plan-huge` — then the final scope confirmation as its own single-question call, and only then the first plan file of that shape. Follow the chosen shape's depth and review rules (`plan-normal`: `reviewers: 1` and that skill's bounded refinement; `plan-big` / `plan-huge`: at least 10 planning questions, `refine` with `reviewers: 3`, no refinement limit, at most five high-priority comments or questions per refinement round). Then the merged accept/execute question (ask_choice with `autoComplete: false`: ✓ Accept & execute now / Accept, don't execute yet / another round) and the `execute_plan` tool.

## Plan Shape Branch

Only after every downloaded reference has an `analyze_refs` analysis and its adoption answers recorded — and before the run's first plan file is written — decide the plan's shape from the workload the user's prompt describes. Ask it as one `ask_choice` single-question call with `questionId: refs-plan-shape` and `autoComplete: false`, recommending the shape you judged; the tool then records the answer in the run's decision ledger. This routing question does not count against any question minimum. Then ask the final scope confirmation as its own single-question call, and only after both answers write the first plan file of that shape.

Criteria (recommend `plan-huge` when either one holds; default to `plan-big` when the shape is genuinely ambiguous):

- `plan-huge` — the prompt asks for a product built step by step across multiple product versions the user wants planned, executed, and reviewed one at a time (`2 to 10` strictly ascending versions), or the workload clearly exceeds a single `plan-big` plan.
- `plan-big` — open-ended, cross-system, or high-risk work with no version sequence.
- `plan-normal` — the analyzed references shrink the work to a broad but bounded change; the reference obligations (≥3 qualifying references, ≥3 adoption questions each) still apply.

Depth and reviewers follow the chosen shape: `plan-normal` runs `reviewers: 1` with that skill's bounded refinement, while `plan-big` and `plan-huge` keep at least 10 planning questions and `refine` with `reviewers: 3`.

### Huge shape in the same run

The run never restarts and its recorded `skill` stays `plan-with-refs`; the same run continues through the huge stage order.

1. Read `references/huge-plan-artifact-template.md` (plus the huge-only auxiliary sections of `references/plan-artifact-template.md`) and write `PLAN_overall_vN.md` exactly per that template — its `## Versions` table is hard-linted.
2. Record all six `record-checkpoint` transitions and never skip one, because each gates the next step: `overall-plan-written`, `overall-review-consolidated`, `overall-accepted`, `version-plan-written`, `version-review-consolidated`, `version-completed`. Their exact detail lives in `skills/plan-huge/SKILL.md` under "Checkpoint Transitions", which is normative here.
3. Plan each version as `PLAN_vX.Y.Z_vN.md` (5–10 questions), then review, execute, and execution-review it before planning the next version — exactly as `plan-huge` prescribes.
4. Reuse the analyses already recorded in `REF_ANALYSIS.md`; do not download references again for a version. Append a reference only when a version introduces a `new technology` or when a key design decision is `genuinely contested` (the same trigger `plan-huge` states) — then run the full mini-flow: download, `record-ref`, `analyze_refs`, and ≥3 adoption questions. Those adoption questions do not count against that version's 5–10 question budget.
5. Each version plan's `## Evidence` cites 1–3 GitHub project URLs when the analyzed references include repositories; when every reference is a paper, a blog post, or a documentation site, cite those analyzed reference URLs honestly instead and accept the advisory `huge-refs` run notice. Never invent a GitHub URL and never leave the section empty. `## Deferred to vX.Y.Z` follows the huge template.

## REF_ANALYSIS.md

Include: original request and repo evidence that shaped the search; attempted queries and selection criteria; references selected and rejected; configured refs root and local download paths; the per-reference `analyze_refs` structured analyses (pasted verbatim, one section per reference); adoption questions and recorded answers; `## Plan Shape` — the prompt signal observed, the shape question (asked before the final scope confirmation) with its answer, and the recorded decision (`questionId: refs-plan-shape`); accepted ideas, rejected ideas, and reasons; evidence gaps and user-granted waivers; language, reviewer, and reviewer settings used.

Reference ideas are not eligible for the run's first plan file until their adoption question answers are recorded.
