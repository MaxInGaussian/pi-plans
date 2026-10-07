<h1 align="center">π-plans</h1>

<p align="center">
  <img src="docs/assets/pi-plans-logo.svg?v=4" alt="pi-plans: Plan. Review. Execute." width="640" />
</p>

<h2 align="center"><b>Plan. Review. Execute.</b></h2>

<p align="center">
  <i>Versioned, reviewed Markdown plans land before any code changes.<br>Human-in-the-loop planning for the <a href="https://github.com/earendil-works/pi">Pi coding agent</a>.</i>
</p>

<p align="center">
  <a href="https://github.com/MaxInGaussian/pi-plans/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/MaxInGaussian/pi-plans?style=square" /></a>
  <a href="https://hits.sh/github.com/MaxInGaussian/pi-plans/"><img alt="Repo views" src="https://hits.sh/github.com/MaxInGaussian/pi-plans.svg?label=repo%20views" /></a>
  <a href="https://www.npmjs.com/package/pi-plans"><img alt="npm downloads" src="https://img.shields.io/npm/dt/pi-plans?color=38bdf8" /></a>
  <a href="https://www.npmjs.com/package/pi-plans"><img alt="npm version" src="https://img.shields.io/npm/v/pi-plans?color=60a5fa" /></a>
  <a href="https://pi.dev/packages/pi-plans"><img alt="Pi package" src="https://img.shields.io/badge/Pi-package-fbbf24" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/pi-plans?color=22c55e" /></a>
  <a href="https://github.com/MaxInGaussian/pi-plans/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MaxInGaussian/pi-plans/actions/workflows/ci.yml/badge.svg" /></a>
</p>

<p align="center"><b>7</b> skills · <b>25</b> slash commands · <b>7</b> tools · <b>2</b> templates · <b>MIT</b></p>

---

## Highlights

- **Nothing is writable before you approve.** Planning, questions, and refinement run read-only: `edit`/`write` are blocked outside planning artifacts until the merged, never-auto-completed handoff lifts the guard. → [Safety model](#safety-model)
- **One tabbed form per round.** Related questions are submitted together as one `questions: [...]` form (2–8 items) with a submit page, and every option states its advantage and its drawback as `✓ … / ✗ …`. → [What it does](#what-it-does)
- **Reviewer subagents that converge.** Read-only `refine` reviewers return severity-graded findings (`F-###`) plus up to five questions; `plan-normal` runs two concurrent reviewers and `plan-big` / `plan-huge` three, each with a direction the planner writes for your project, so they probe different blind spots instead of repeating generic lenses. Every delegated agent is a bullet in a list above the editor — `↓` focuses it, `Enter` opens one agent's live transcript. → [Delegated subagents](#delegated-subagents)
- **Execute on a different model.** At the handoff you choose where the plan runs: this session, one delegated subagent, or several, on a model and effort you pick with the same picker the reviewer uses. → [Delegated subagents](#delegated-subagents)
- **Workers report live, without stopping.** Delegated workers close each task through their own `plans_update_task` tool, so the dashboard moves as work happens while the worker keeps going; waves run in order and the main session only supervises. → [Delegated subagents](#delegated-subagents)
- **Multi-version product builds.** `plan-huge` — reachable directly or through `plan-with-refs` once the analyzed references fix the shape — keeps one run and one artifact directory: an abstract overall plan with a 2–10 version table, then each version planned, executed, and execution-reviewed before the next one starts. → [Skills](#skills)
- **Tracked execution with evidence.** The current wave and remaining tasks are injected every turn, and `plans_update_task` records status plus evidence per task; a compact dashboard, a stall watchdog, and a live status bar follow along. → [What it does](#what-it-does)
- **Independent execution review.** When the task tree goes terminal, a detached read-only round verifies every `VC-###` check and reports findings of its own, under a per-run budget you choose once. → [What it does](#what-it-does)
- **Deterministic compaction.** Active planning and execution compactions use a no-LLM VCC-style compiler with five bracket sections, a smart recent tail, and `keep:N`. → [VCC compact](#vcc-compact)
- **A code graph, not just grep.** Tree-sitter function indexing, cross-file call/import edges with `EXTRACTED` vs `INFERRED` confidence, label-propagation communities, DB-first staged edits, and drift checks. → [What it does](#what-it-does)
- **Several sessions, one repository.** Run registry derived from `runs/` (no shared pointer to race), per-session run binding, and binding-first resume/execute/abandon. → [Interface overview](#interface-overview)
- **Fewer detours per turn.** A four-line fused executor rule set costs almost nothing and buys back fewer wrong turns and shorter implementation paths. → [The execution rules](#the-execution-rules)
- **Evidence, kept honest.** An exploratory paired A/B on Terminal-Bench 2.0 is published with its numbers, its instability across seeds, and its disclosures. → [Benchmarked](#benchmarked-single-seed-exploratory-result)

### New in 0.9.0

- **Where the plan runs is now your call.** After you approve the handoff, a second question picks the current session (same model, as before), one delegated subagent, or two to four. The previous choice is offered first and stored with the run, so a resumed run does not ask again. → [Choosing where the plan runs](#choosing-where-the-plan-runs)
- **One list for every delegated agent.** Reviewers, reference analysts, the execution reviewer, and execution workers are bullets above the editor with status, phase, tool-call count, and working time (time spent queued or idle is not counted); the three-pane overlay is gone, and references beyond the third wait as `queued` bullets. → [Delegated subagents](#delegated-subagents)
- **Reviewers dig where you would not look.** `plan-normal` now runs two reviewers and `plan-big` / `plan-huge` three, and the planner writes each reviewer's direction for your project (hidden coupling, rollback paths, whether the checks really prove the claims, …) instead of the old fixed correctness / ordering / verification lenses. Each reviewer sees the others' directions and goes deeper on its own. → [Delegated subagents](#delegated-subagents)
- **In-process sessions instead of child processes.** Delegated agents run inside the Pi host, so a session stays addressable — it can be re-prompted with the next wave of work and report progress while it keeps running. → [Delegated subagents](#delegated-subagents)

## Benchmarked: single-seed exploratory result

One paired A/B run on <b>Terminal-Bench 2.0</b> (36-task stratified sample, GLM-5.3-Flash, seed 1) solved <b>18/36 (50.0%)</b> tasks with pi-plans versus <b>3/36 (8.3%)</b> with stock pi (McNemar exact <b>p = 0.0003</b>), at <b>7.6× fewer tokens per solved task</b>:

| Terminal-Bench 2.0 | GLM-5.3-Flash + Vanilla Pi | GLM-5.3-Flash + Pi with pi-plans (*/plan-big*) |
|---|---|---|
| Tasks solved (seed 1, n=36) | 3/36 (8.3%) | **18/36 (50.0%)** |
| Tokens per solved task | 2,783,085 | **366,011** (7.6× fewer) |

> [!IMPORTANT]
> **Exploratory, not a product claim.** Single model, single seed, forced `/plan-big` variant, eval-only auto-approve. Re-running the 17 discordant tasks at two more seeds dissolved the gap — per-task majority vote across three seeds is baseline 8 / treatment 1 / tie 8, so the seed-1 advantage was **not stable**, and the repository's own summary is that no stable resolve-rate improvement was measurable at this sample size. The preregistered snapshot-diff fairness control was also not exercised in this run. Full methodology, statistics, and disclosures: [`docs/benchmarks/tech-note.md`](docs/benchmarks/tech-note.md).

## Contents

- [Highlights](#highlights)
- [Benchmarked: single-seed exploratory result](#benchmarked-single-seed-exploratory-result)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Interface overview](#interface-overview)
- [Requirements & compatibility](#requirements--compatibility)
- [VCC compact](#vcc-compact)
- [Delegated subagents](#delegated-subagents)
- [The execution rules](#the-execution-rules)
- [Skills](#skills)
- [Installation details](#installation-details)
- [Benchmarks](#benchmarks)
- [Layout](#layout)
- [Safety model](#safety-model)
- [Verification](#verification)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## How it works

```text
        rough change request
                 |
   language + docs location (once per workspace)
                 |
   planning questions, one batched form per round  | write guard ON
   (2-8 per form; every option ✓ / ✗)              | only .git/pi-plans/,
                 |                                 | run artifacts, cache,
                 v                                 | refs root are writable
   PLAN_vN.md (## Tasks + ## Verification Checks)
                 ^                |
                 |  refine rounds |    reviewer (x1..x3): findings + questions
                 +----------------+    /plan-huge: overall plan (## Versions)
                 |                     -> per-version plans, same loop
                 v
     explicit approval (never auto-completed)
                 |
     where it runs: this session, or delegated
     workers on a model + effort you pick
                 |
   =============================================== write guard OFF
                 |
     task-tree execution loop
   current wave + tasks injected each turn,
   plans_update_task reports status + evidence
   (workers report live while they keep going),
   execution reviewer verifies every check
                 |
                 v
           run status: done        (/plans-terminate ends a run early,
                                   /plans-stop pauses it resumably)
```

Every plan version carries stable IDs (`Task-N`, `VC-###`) that never get recycled across revisions, so the task tree and verification checks survive refinement rounds intact.

## Quick start

Install from npm:

```bash
pi install npm:pi-plans
# or try it without installing:
pi -e npm:pi-plans
```

Then describe a change from any repository:

```text
You: Create a plan to split the execution loop into smaller modules.

Pi:  Which planning docs location should this workspace use?
     1. ./.git/pi-plans/plans ★ — ✓ Private to the repo, never tracked / ✗ Stays out of the worktree
     2. ./docs/pi-plans — ✓ Public and committable / ✗ Becomes tracked repo content
     3. Other
     4. Auto-complete

Pi:  (one form, three tabs — every option carries its own ✓ advantage / ✗ drawback)
     1/3  Which planning depth?
          plan-normal ★ — ✓ 5-10 questions, one reviewer round / ✗ Fewer safety lenses
          plan-big — ✓ 10+ questions, three reviewers / ✗ Slower and costlier
     2/3  Should the refactor keep the legacy CLI flag?
          Keep it — ✓ No user-visible break / ✗ Costs a compatibility path
          Drop it — ✓ Deletes the obsolete path / ✗ Breaks existing callers
     3/3  Which verification command proves the split?
          npm test ★ — ✓ Covers the behavior end to end / ✗ Slower to run
          npm run validate — ✓ Also checks structure / ✗ Does not exercise the loop
     [Enter] Submit all   [←→] Review   [Esc] Cancel

Pi:  Wrote ./.git/pi-plans/plans/2026-08-26-split-execution-loop/PLAN_v1.md
     Example verifier item:
     - [ ] `VC-001` covers `Task-1`; pass condition: `npm test` passes;
       evidence: test output; metric: zero failing tests.

Pi:  Accept PLAN_v1 and execute it now?   (Auto-complete never appears here)
     1. ✓ Accept PLAN_v1 and execute it now
     2. Accept PLAN_v1, don't execute yet
     3. Run another round: Reviewer

You: 1 — accept and execute.
```

The option labels above are the wording the agent uses for the merged handoff; the questions themselves are generated per plan.

Planning artifacts live under `./.git/pi-plans/plans/YYYY-MM-DD-<topic>/` by default — private to the repository, never tracked, never published. Choose `./docs/pi-plans` instead if you want the plans public and committed alongside the code.

## What it does

| Capability | In short |
|---|---|
| Planning router + six specialist skills | Start with `/skill:planning` to route to the narrowest matching specialist (`plan-small` → `plan-big`, `plan-huge`, `debug-and-plan`, `plan-with-refs`) |
| Choice prompts | `ask_choice`: recommended option first, answers auto-recorded per run, every option stating its `✓` gain and `✗` cost; `Auto-complete` answers later eligible questions until `/plans-autocomplete-stop` |
| Refinement rounds | Read-only reviewer subagents return findings (`F-###`) and up to five questions (`Q-1..Q-5`) in one round; the agent asks every question and records the answers before revising |
| Workspace state | Config, runs, decisions, refs, and subagent ledgers in `.git/pi-plans/` (git common dir) |
| Tracked execution | The current wave and remaining tasks are injected each turn; progress is reported only through `plans_update_task` (status + evidence), with a live dashboard, stall watchdog, and status bar |
| Execution reviewer | After the last task settles, an independent read-only round verifies every `VC-###` and reports severity-graded findings under a per-run review budget |
| Execution handoff | After explicit approval (never auto-completed) you pick where the accepted plan runs — the current session, or one or several delegated subagents on a model and effort you choose; legacy plan grammars still parse with an upgrade notice |
| Efficient executor prompt | A four-line fused rule set (layered growth, simplest implementation, long-term architecture, library discipline) steers every execution turn |
| Write guard | `edit`/`write` blocked outside planning artifacts while a planning run is active in the workdir |
| VCC compact | Active planning/execution compaction uses deterministic, no-LLM VCC summaries for `/compact`, threshold, and overflow events |
| Delegated subagents | Reviewer, reference-analysis, execution-review and delegated execution subagents run in-process, are listed as bullets above the editor, and open one at a time in a live transcript overlay |
| Multi-run workdirs (0.6.0) | Concurrent sessions in one workdir: registry derived from `runs/`, per-session binding, descriptive run pickers, suffixed artifact dirs |
| Huge multi-version loop (`/plan-huge`) | One run and one artifact directory: an abstract overall plan drives 2–10 strictly ascending versions, each planned, executed, and reviewed before the next |
| Code graph | Tree-sitter function index with cross-file edges (`EXTRACTED`/`INFERRED`), communities, DB-first staged edits, drift checks, and an optional watcher |
| Execution/planning compaction | Pi core owns scheduling; pi-plans maps the active plan, current task, and remaining `VC-###` checks into the VCC sections |

<details>
<summary><b>Planning router + six specialist skills</b></summary>

`planning` inspects the request and routes to the narrowest specialist: `plan-small` (1–3 questions, one reviewer round), `plan-normal` (5–10 questions, two concurrent reviewers), `plan-big` (10+ questions, three concurrent reviewers), `plan-huge` (multi-version streams), `plan-with-refs` (external references analyzed before planning; it then fixes the plan's shape — `plan-normal`, `plan-big`, or `plan-huge` — and a huge shape continues the same run as a multi-version build), and `debug-and-plan` (diagnose a bug or CI failure before planning). Every specialist shares the same state, language, question, and reviewer rules, so switching depth never changes what is recorded.

</details>

<details>
<summary><b>Choice prompts, Auto-complete, and the batch form</b></summary>

`ask_choice` renders a numbered prompt with the recommended option first; the tool appends `Other` second-last and `Auto-complete` last. Every option you author states its advantage and its drawback as `✓ <advantage> / ✗ <drawback>` in the configured language, so the user can weigh each option before answering. Related questions are batched into ONE tabbed form (`questions: [...]`, 2–8 items) with a submit page instead of one sequential prompt each; `Esc` on the form returns the answered subset, and the final scope confirmation plus the execution handoff always stay single-question with `autoComplete: false`. Choosing Auto-complete enables recommendation-only answers for later eligible questions in the current planning run, and `/plans-autocomplete-stop` takes back control.

</details>

<details>
<summary><b>Refinement rounds and the reviewers</b></summary>

Read-only reviewer subagents return findings (`F-###`, with severity, evidence, impact, and a recommended fix) and up to five questions (`Q-1..Q-5`) in one round; the main agent asks every question with `ask_choice` and records the answers before revising. Delegated reviewers run as in-process sessions and appear as bullets in the subagent list; `analyze_refs` lists its per-reference analysis subagents the same way.

</details>

<details>
<summary><b>Tracked execution</b></summary>

The current wave and remaining tasks are injected each turn; task progress is reported exclusively through the `plans_update_task` tool (status + evidence / `skipReason`, audit-only rollback); the task dashboard shows the tree live (compact `aboveEditor` widget, Ctrl+Shift+T expanded view with ✓/▸/~/· markers, width-adaptive); a stall watchdog pauses after three settled rounds without task-state change; the status bar shows lifecycle, `x/y` task progress, elapsed time, and token usage in real time.

</details>

<details>
<summary><b>Execution reviewer, review budget, and /plans-terminate</b></summary>

When every task reaches a terminal state, the run status moves to `verifying` and an independent read-only reviewer verifies each `VC-###` check AND reports severity-graded `F-###` findings over the whole implemented change in a detached round that shows up in the subagent list (`Enter` opens its overlay, `Esc` closes it, Ctrl+Shift+R reopens it). Finding ids are stable across rounds (absence from the newest report = resolved). A failed check or a high-severity finding opens one union fix round: mapped tasks roll back to pending (children cascade, skipped reopen; an unmapped high gets a plan task appended mechanically from the reviewer's proposed title), and the executor is woken exactly once with a findings summary plus the round-report path (a delegated run sends that brief to the workers that own the reopened tasks instead). `medium` and `low` findings are repaired too, not just recorded: the single non-high repair cycle per version wakes the executor once, a mapped `medium` rolls back through the same union, an unmapped `medium` and every `low` get a `fix F-###:` task appended (a `low` never rolls back verified work; appending is idempotent), and the next round re-judges by stable id. The executor either fixes a finding and re-closes the task with evidence, or declines it with `status: "skipped"` and `skipReason: "deferred: <reason>"`. The run completes when every check is affirmatively `pass` and no finding remains; when findings are left over after the cycle (or the budget cannot buy another round), the completion message never claims the review passed — it reports `N unresolved, M deferred` and lists each finding as `fixed`, `repair claimed — still reported`, `deferred: <reason>`, or `unresolved`. An exhausted budget completes with any unresolved high findings disclosed by id.

The review budget is a per-run choice (1/2/3/5/unlimited, default 3) asked exactly once — when every task is terminal, right before round 1 — through the same native select menu `ask_choice` uses for a single question, and stored in the checkpoint: a numeric budget bounds committed rounds, while `unlimited` runs until no high finding remains behind a no-progress valve (three consecutive identical outcomes) and a run-cumulative hard cap of 50 committed rounds (the single non-high repair cycle is exempt from a numeric budget but still counts toward that cap). Sessions without that menu (or whose selector throws) apply the default 3 with one visible note. Exhaustion pauses in every mode, and only an explicit `/plans-execute` confirmation re-opens the budget menu (with the current value named in its title) and grants a fresh budget (unresolved findings survive the renewal; ordinary input and restores never refill). Checks with all-skipped coverage pass; checks covering no task never audit.

The user can also end the run at any time with `/plans-terminate`: it aborts an in-flight round with a `cancelled` round report (no budget spent), records the run as `done` with `audit.passed` left `false` and `audit.lastResult` set to `terminated by user`, writes `TERMINATION.md` beside the plan, and discloses — rather than waives — unverified checks, open tasks, and unresolved findings; fewer than three committed rounds only adds a warning to its confirmation. A terminated run is not resumable: `/resume-plans` and the `/plans-execute` run picker do not offer it, and an explicit-path handoff into a terminal run is refused with a visible notice.

</details>

<details>
<summary><b>Huge multi-version loop (`/plan-huge`)</b></summary>

One run, one flat artifact directory: the abstract overall plan (`PLAN_overall_v1.md`, extendable to `PLAN_overall_vN.md`) carries the `## Versions` table (2–10 strictly ascending `v0.Y.Z` versions, each with a mission and a `done:` criterion), the architecture, the file map, the user experience, and the final objective. Accepting it starts the first version's planning round instead of execution; each `PLAN_vX.Y.Z_vN.md` keeps the `plan-big` task grammar plus `## Deferred to vX.Y.Z` (version-scoped `D-…` ids, absorbed or user-confirmed dropped before the next version) and `## Evidence` (1–3 GitHub project references). Executing a version runs the same handoff, task tree, and execution reviewer as `plan-big`; completion archives the version (VCs, tasks, plan identity, review reports, review budget) and loops back to planning, and only the last version makes the run terminal. The overall plan is never executable, an explicit plan path must be the current stream's latest round, and the review budget asked once is inherited by later versions.

</details>

<details>
<summary><b>Code graph</b></summary>

`/init-graph` builds a tree-sitter function index with cross-file call/import edges (`EXTRACTED` vs `INFERRED` confidence) and label-propagation communities, and writes `.git/pi-plans/graph/GRAPH_REPORT.md` (subsystems, god nodes, edge stats). Read-only queries (`status`, `screening`, `get-function`, `query`, `path`, `explain`, `impact`) run through the `code_graph` tool with a token budget; edge resolution covers re-export barrels, namespace/default imports, `require` destructuring, and dynamic `import()`, while same-name exports classify as `ambiguous`. Writes are DB-first staged edits materialized with `apply` (auto-reindexing the materialized set); `/update-graph` reindexes incrementally, `/graph-status` and `/graph-drift` report inventory and DB↔source convergence, and `/watch-graph` feeds a 300ms-debounced filesystem watcher behind a single-writer lock. Full rebuilds never touch files with staged edits (fail-closed pending guard).

</details>

<details>
<summary><b>Multi-run workdirs (0.6.0)</b></summary>

Several pi sessions can plan concurrently in one workdir: the run registry derives from `runs/` (no shared pointer to race), each session binds to its run, and same-topic runs get suffixed artifact dirs. `/plans-abandon`, `/plans-execute`, and `/resume-plans` are binding-first and open a descriptive run-picker form when more than one candidate exists; `/plans` lists all runs (newest first, bound run marked).

</details>

<details>
<summary><b>Delegated subagents</b></summary>

Delegated reviewers, `analyze_refs` analysts, the execution reviewer and delegated execution workers run as in-process agent sessions and show up as one bulleted list above the editor. With an empty editor, `↓` focuses the list, `↑/↓` pick an agent, `Enter` opens that agent's live transcript overlay, and `Esc` goes back; every other key stays with the editor. Execution can also run on delegated workers on a model you pick at the handoff.

</details>

<details>
<summary><b>Execution and planning compaction</b></summary>

**Execution-phase compaction:** Pi core owns scheduling; pi-plans maps the active plan path, current task, task ids, and remaining `VC-###` checks into the VCC sections. Proactive triggers and model-generated summary paths are removed.

**Planning-phase compaction:** During `run.status=planning` with no active execution, pi-plans maps the active run, the artifact directory, the latest plan path from session entries, and the observed current implementation id into the VCC sections. Without an active planning run, compaction returns to Pi core. Creating a new run (`plans start-run`) additionally applies one pre-plan VCC compaction on the `turn_end` boundary as a compaction draft — no abort, no error, and no resume message (default on; `prePlanCompact:false` disables).

</details>

## Interface overview

| Tool / Command | Purpose |
|---|---|
| `plans` | State CLI — actions: `init`, `show`, `set-language`, `set-artifact-root`, `set-refs-root`, `set-graph-enabled`, `set-role`, `start-run`, `set-status`, `final-commit`, `record-decision`, `record-ref`, `record-subagent`, `record-checkpoint` (state-machine-validated workflow transitions) |
| `ask_choice` | Numbered choice prompt; batches 2–8 related questions into one tabbed form; `autoComplete: false` for the merged accept/execute question and external-state questions |
| `refine` | Reviewer round via in-process read-only subagents (tools `read,grep,find,ls`, plus a read-only `code_graph` when the workspace has the code graph enabled): findings (`F-###`) and up to five questions (`Q-1..Q-5`) per reviewer; the caller must ask every question with `ask_choice` and record answers before revising; in TUI each reviewer is a bullet in the subagent list and `Enter` opens its live transcript overlay; `reviewers: 2` (plan-normal) or `reviewers: 3` (plan-big / plan-huge) runs concurrent reviewers, each with a planner-written `directions` entry tailored to the project (required when more than one reviewer runs; no fixed lenses); enforces the reviewer gates — first use pops native model + effort panels in TUI (menus on RPC, text guidance headless), persisted to the global reviewer config |
| `analyze_refs` | plan-with-refs reference analysis: one independent read-only subagent per downloaded reference (cwd = the ref directory), reusing the reviewer model confirmation from the global config (the mode is not consulted — analysis always spawns); at most 3 run at once and the rest wait as queued bullets in the subagent list; returns structured per-reference sections for `REF_ANALYSIS.md` |
| `execute_plan` | Execution handoff: re-confirms with the user (never auto-completed), asks where the plan runs (current session, one delegated subagent, or several — delegated choices reuse the reviewer's model + effort picker and the last choice is offered first), and enters task-tree execution mode (`plans_update_task` progress, dashboard, execution reviewer); plans written in the earlier implementation-item grammar parse through the compatibility mapping with an upgrade notice; picks the run via a descriptive form when several planned runs coexist |
| `plans_update_task` | The only way task progress is recorded during execution: one task per call with `status: complete` plus evidence, or `status: skipped` plus a skip reason; statuses are immutable once set, and the independent execution reviewer — not the executor — owns rollback. Delegated workers get their own copy scoped to their assigned tasks; it returns at once, so the worker keeps going |
| `code_graph` actions | Read-only: `status` (files/functions/edges + confidence×resolution distribution), `screening` (per-row freshness probes), `get-function`, `query` (keyword→BFS/DFS with token budget + shown/omitted counts), `path A B` (shortest call path), `explain <fn>` (community/degrees/neighbors), `impact <fn>` (reverse call closure + affected files); write path: DB-first staged edits + `apply` (auto-reindexes the materialized set). Edge resolution covers re-export barrels (`export {x} from` / `export *` follow to the defining module), namespace/default imports, `require` destructuring, and dynamic `import()`; same-name exports classify as `ambiguous` |
| `/plans` | Show config, all runs (newest first, bound run marked, cap 50), and execution progress |
| `/config-pi-plans` | Re-ask workspace defaults for language, artifact root, refs root, and code graph, plus the reviewer mode/model (keep/change menu; native model + effort panels on change in TUI; current-session skips the model step) |
| `/resume-plans` | Resume a run in the CURRENT session across restarts: unfinished planning (pending question + answered decisions), reviewing (round/lane state, successful outputs reused), and execution (approval digest + HEAD + recorded task progress; 0.6.0 delegated-executor orphans re-approve, legacy implementation-review phases map to done). Binding-first: the session-bound resumable run resumes directly; a unique candidate goes direct; multiple candidates get a descriptive chooser. Linked worktrees share candidates; a cross-worktree resume confirms, copies artifacts without overwriting, and resets approval + task progress. An unchanged plan digest with a changed HEAD keeps the authorization but re-opens closed tasks. Busy sessions and actively owned runs only notify — no queueing, no takeover. Interactive (TUI/RPC) only |
| `/plans-execute [plan.md]` | Resume a paused active execution without losing task progress; otherwise enter the explicit execution handoff (run-picker form when several planned runs coexist; legacy plans get an upgrade notice) |
| `/update-plan [plan.md] [reason…]` | Interrupt-and-refine: stops execution (if any), returns the run to planning, and directs the agent to revise the plan into `PLAN_vN+1.md` while preserving verified work |
| `/plans-autocomplete-stop` | Stop the current run's Auto-complete mode and return later planning questions to normal interaction |
| `/init-graph` | Build the code graph: tree-sitter function index + cross-file call/import edges (EXTRACTED vs INFERRED confidence) + label-propagation communities; writes `.git/pi-plans/graph/GRAPH_REPORT.md` (subsystems, god nodes, edge stats). Full rebuilds never touch files with staged edits (fail-closed pending guard) |
| `/update-graph` | Incrementally reindex changed files (shared path used by apply/final-commit triggers and the watcher) |
| `/apply-graph` | Materialize DB-first staged edits to the worktree; auto-reindexes the materialized set afterward |
| `/graph-status` `/graph-drift` | Graph inventory and DB↔source convergence |
| `/enable-graph` `/disable-graph` | Turn the code graph on or off for the workspace without re-running the whole configuration wizard |
| `/watch-graph` `/unwatch-graph` | 300ms-debounced filesystem watcher feeding incremental reindex; single-writer per worktree (atomically claimed PID+heartbeat lock, stale takeover), skips files with staged edits, fails closed on errors, stops cleanly on fs.watch errors / repeated failures / session shutdown, auto-restarts when enabled |
| `/plans-stop` | Stop execution mode (recorded as `stopped`; resumable) |
| `/plans-terminate` | End the current plan by user decision: aborts an in-flight review round (`cancelled` report, no budget spent), records the run `done` with `TERMINATION.md` beside the plan, discloses unverified checks/open tasks/unresolved findings instead of waiving them, and is not resumable — `/resume-plans` and the `/plans-execute` run picker do not offer it, and an explicit-path handoff whose bound run — or whose plan file inside a terminal run's artifact directory — is terminal is refused with a visible notice. Distinct from `/plans-stop` (resumable stop) and `/plans-abandon` (voids a planning run) |
| `/plans-abandon` | Abandon a run (pick via form when several candidates; lifts the write guard; artifacts stay) |
| Status bar (lifecycle) | 💬 Q&A → 📝 draft written (planning sub-phases) → ⌛ executing `x/y · spent · in/out-toks` in the bottom status bar → ⛔ stopped / 🎯 done / 🚫 abandoned |

## Requirements & compatibility

- **Node ≥ 22.6** with `--experimental-strip-types` — the extension, `npm run validate`, and `npm test` all run TypeScript sources directly, with **no runtime npm dependencies** (`dependencies` is empty by design).
- **Code graph extras:** `node:sqlite` (unflagged from Node 22.13; on Node 22.6–22.12 start with `--experimental-sqlite`) and the four tree-sitter parser packages declared in `devDependencies` (`tree-sitter`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-typescript`).
- **Pi:** install as a Pi package (`pi install npm:pi-plans`) — the entry point is `index.ts`, which registers the tools, the slash commands, the skills, and the write guard.
- **State:** workspace state lives in `.git/pi-plans/` inside the resolved git common dir; the reviewer role lives in the global config (`~/.pi/pi-plans/config.json`, override with `PI_PLANS_GLOBAL_DIR`).

## VCC compact

Pi core remains the owner of compaction scheduling: manual `/compact`, threshold, and overflow events are emitted by Pi as usual. During an active pi-plans planning or execution run, pi-plans handles `session_before_compact` with a deterministic VCC-style compiler instead of calling a model for a summary.

- **Summary shape.** The summary contains exactly five bracket sections: `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, and `[User Preferences]`, followed by `---` and a ranked brief transcript. Execution contributes plan path, current task, implementation ids, and remaining verifier ids; planning contributes run ID, artifact directory, latest plan path from session entries, and any observed current implementation-id marker.
- **Session-only input.** Compact summaries are built from the event's branch entries, previous summary, file ops, pi-plans custom session entries, and live phase state. The compiler does not read plan files, git history, or the worktree to invent context.
- **Tail policy.** The default keep is one recent user turn; smart keep may retain more turns when the tail is still small. Explicit `keep:N` is honored, while no-anchor and oversized-tail cases use a deterministic token-budget cut that avoids starting retained context with an orphan tool result.
- **Manual matrix.** Plain `/compact` and `/compact keep:N` compact and show stats; the host never continues the turn a manual compaction aborted, and pi-plans steps in only when that compaction displaced a live planning or execution run (see *Manual compaction during a run* below). `/compact <text>` and `/compact keep:N <text>` compact, then send the text once as the follow-up prompt. Internal pi-plans compaction markers are never reused as user follow-up prompts.
- **Fallbacks and stats.** Unsafe manual/threshold cuts cancel with a warning; overflow or retrying unsafe cuts return control to Pi core. Successful VCC compactions notify with kept-tail and summarized-message stats. Threshold/overflow compactions may queue one hidden continuation only when the running Pi version still needs it and `continueAfterThresholdCompact` is enabled.
- **Pre-plan compaction.** When `plans start-run` creates a new planning run, pi-plans applies one VCC compaction on that turn's `turn_end` boundary as a compaction draft (internal hint `pi-plans planning pre-plan compact`) — so each new plan continues on a lean context (LLM reasoning degrades with longer input). The draft never aborts the running turn: no aborted-turn error is recorded, sibling tool calls survive, and no resume message is needed. Small sessions, already-compacted sessions, stale requests, and executions taking over skip silently. `prePlanCompact:false` in the repo-private config disables the pre-plan draft.
- **Manual compaction during a run.** A user `/compact` (or any host-initiated manual compaction) aborts the live turn and the host never continues it. When such a compaction displaces live pi-plans work, pi-plans resumes the run exactly once when the compaction ends — success or failure — using the hidden planning/execution resume message. The gate is `continueAfterThresholdCompact`; for an execution the compaction-caused stall pause is lifted together with the resume.
- **Repo-private config.** Defaults are scaffolded in `.git/pi-plans/pi-vcc-config.json` under the resolved git common dir: `overrideDefaultCompaction:true`, `smartKeepTail:true`, `continueAfterThresholdCompact:true`, `prePlanCompact:true`, `debug:false`. Global pi-vcc config and `PI_VCC_CONFIG_PATH` are intentionally ignored.

## Delegated subagents

Reviewers (`refine`), reference analysts (`analyze_refs`), the execution reviewer, and delegated execution workers run as **in-process agent sessions** inside the pi host rather than as child processes. A session stays addressable after it starts, which is what lets a delegated executor report progress while it keeps working. The TUI shows them as one list:

- **A bulleted list, not lanes.** Every delegated agent is one bullet above the editor with its status, current phase, tool-call count and working time — queued and idle time are not counted, so a worker waiting for its next wave does not keep ticking (`• reviewer·correctness running · tool: read · 3 tool calls · 1m12s`); queued agents (for example the fourth reference while three are running) show as `queued`, long-lived workers waiting for their next wave as `idle`, with a `2/3 tasks` note for executors. When every agent has finished, the list collapses to a single summary line (`Subagents (3) · 3 done · ↓ browse subagents`); `↓` expands it again, and finished agents are dropped after ten minutes or when the next round replaces them.
- **`↓` to browse, `Enter` to open.** With an empty editor, `↓` focuses the list, `↑/↓` move the selection, `Enter` opens the selected agent's overlay, and `Esc` (or `↑` past the first row) hands focus back. Any other key leaves the list and is typed into the editor, and the list never reacts while another dialog or overlay holds focus.
- **One agent per overlay.** The detail overlay uses `width: "78%"`, `minWidth: 72`, `maxHeight: "78%"`, `anchor: "top-center"`: a complete streaming transcript (assistant text, thinking, tool calls and results merged per content block) with follow-bottom scroll. `↑/↓`, `PgUp/PgDn` and the SGR mouse wheel scroll; `Tab`/`Shift+Tab` switch to another agent; `x` twice stops just that agent; `Ctrl+Shift+T` still toggles the dashboard; `Esc` closes. There is no input row, so nothing you type reaches an agent.
- **`Esc` never aborts work.** Closing the overlay leaves the session running and its result still flows back as tool output. Cancelled, timed-out and failed agents render as terminal states with the original error message, never as silent drops.
- **Execution reviewer.** Each review round is one bullet; `Ctrl+Shift+R` opens the newest round's overlay directly.

### Choosing where the plan runs

After you approve the handoff, a second question asks where to run it: the **current session** (same model), **one delegated subagent**, or **several delegated subagents (2–4)**. Delegated choices open the same native model + effort picker the reviewer uses (menus on RPC), titled for the executor, and never change the reviewer role. The question is asked every time, with your previous choice listed first; it is stored per run in the checkpoint, so a resumed run restores the same workers without asking again. Headless and auto-approved handoffs always use the current session.

Delegated workers are write-enabled sessions on the model you picked. Each gets its own `plans_update_task` tool scoped to the tasks assigned to it: closing a task updates the dashboard and the checkpoint immediately and returns at once, so the worker's loop continues with its next task — completion is never inferred from a session ending. Work is scheduled per wave: tasks sharing a file stay on one worker, workers keep their session across waves, and a wave starts only after the previous one is fully terminal. A failed review round sends its repair brief to the workers that own the reopened tasks. While a run is delegated the main session supervises only: it is not woken to do the work and `edit`/`write` are blocked in it. A worker that ends with tasks still open is re-prompted and, after three such rounds (or two failed runs), the run pauses; `/plans-execute` resumes it. Workers load no extensions, so the code graph's graph-aware edits are unavailable to them — run `/update-graph` afterwards when the graph is enabled.

## The execution rules

Once you approve the handoff, every turn injects a compact rule set that fuses Marcos Hernanz's AGENTS.md seven principles with Ponytail minimalism — so the executor finishes plans in fewer tokens and fewer detours:

<details>
<summary>The four fused rules (click to expand)</summary>

1. **Grow in layers** — smallest end-to-end slice first, then stack each new capability on top of what already works.
2. **Simplest implementation** — no speculative abstractions, configuration, or indirection; modular components with clearly separated concerns.
3. **Long-term architecture, no stopgaps** — no backward-compatibility layers, fallbacks, or migrations; remove the obsolete paths a change obsoletes.
4. **Library discipline** — prefer established, well-maintained libraries; check the project's existing dependencies (docs and types) before writing your own or adding a package.

</details>

The rules cost four lines per turn and buy back far more: fewer wrong turns, shorter implementation paths, plans that finish in fewer tokens.

Waiting for subprocess-backed verification:
For subprocess-backed verification, when a step starts a subprocess and needs its result before verifying, use literal `waiting for` with backoff `5s -> 10s -> 20s -> 40s -> 80s`, then keep polling at 80s; restart at 5s for each new subprocess.

## Skills

Invoked via `resources_discover`, callable as `/skill:<name>`, directly as `/<name>` (e.g. `/planning`, `/plan-small` — extension aliases that forward to the skill), or picked automatically from the task description.

| Skill | Use it when | Reviewer default |
|---|---|---|
| [`planning`](skills/planning/SKILL.md) | General router; selects the narrowest specialist skill before planning starts | follows the selected specialist |
| [`plan-small`](skills/plan-small/SKILL.md) | Small scoped change; 1–3 questions | one reviewer round |
| [`plan-normal`](skills/plan-normal/SKILL.md) | Broad or risky change; 5–10 questions | two concurrent reviewers |
| [`plan-big`](skills/plan-big/SKILL.md) | Open-ended/high-risk effort; 10+ questions | three concurrent reviewers |
| [`plan-huge`](skills/plan-huge/SKILL.md) | Multi-version product builds: one abstract overall plan (`PLAN_overall_vN.md`: version table, architecture, file map, UX, final objective), then per-version plans (`PLAN_vX.Y.Z_vN.md`, 2–10 versions) each planned, reviewed, executed, and execution-reviewed before the next version; runs stay non-terminal between versions | three concurrent reviewers per version |
| [`debug-and-plan`](skills/debug-and-plan/SKILL.md) | Bug, CI failure, regression, incident — diagnose before planning | follows the routed level |
| [`plan-with-refs`](skills/plan-with-refs/SKILL.md) | External references must be analyzed before planning — repos, papers (arXiv), engineering blogs, and docs sites all count; theoretical references are equal citizens. After the analyses it fixes the plan's shape (`plan-normal`, `plan-big`, or `plan-huge`) from the prompt's workload, and a huge shape continues in the same run as a multi-version build. plan-normal/plan-big may optionally cite 1–2 search-found references without downloading | three concurrent reviewers (two for the plan-normal shape) |

## Installation details

Dev / quick test against a local checkout:

```bash
pi -e /path/to/pi-plans
```

Permanent (global), via symlink into the auto-discovered extensions dir:

```bash
mkdir -p ~/.pi/agent/extensions/pi-plans
ln -s "$(pwd)"/index.ts "$(pwd)"/tools "$(pwd)"/src "$(pwd)"/skills "$(pwd)"/references "$(pwd)"/agents ~/.pi/agent/extensions/pi-plans/
```

or register the absolute path in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/absolute/path/to/pi-plans"] }
```

## Benchmarks

One paired A/B run is published, with its headline numbers and its limits: 36-task stratified Terminal-Bench 2.0 sample, GLM-5.3-Flash, seed 1 — see [Benchmarked](#benchmarked-single-seed-exploratory-result) above for the table and the stability disclosure.

We evaluate pi-plans with a controlled A/B: **<a href="https://github.com/earendil-works/pi">vanilla pi</a>** vs **pi + pi-plans** (planning entry injected at the adapter level; task instructions verbatim in both arms) on [Terminal-Bench 2.0](https://www.tbench.ai/) (89 tasks) through the [harbor](https://github.com/laude-institute/harbor) framework, paired per task and analyzed with a pre-registered McNemar exact test plus paired bootstrap CIs. Cost accounting includes parent **and subagent** usage.

**Scope of any published claim (strictly limited):** pi-plans (forced-`/plan-big` variant) on Terminal-Bench 2.0 / single model / single seed — an exploratory paired difference, **not** a general claim about pi-plans, and not reproduced as a stable effect across seeds (see the disclosure above). Human-approval gates are bypassed by an eval-only `PI_PLANS_AUTO_APPROVE=1` env (lifecycle questions only, default off), so results do not represent the interactive experience.

Reproduce:

```bash
node --experimental-strip-types scripts/bench/run-ab.ts --prepare
node --experimental-strip-types scripts/bench/run-ab.ts --arm both --full   # requires docker + harbor
node --experimental-strip-types scripts/bench/analyze.ts --results-dir scripts/bench/results/<date>
```

Methodology, preregistered statistics, and disclosures: [`docs/benchmarks/tech-note.md`](docs/benchmarks/tech-note.md).

## Layout

```
pi-plans/
├── index.ts               # Extension entry: tools, commands, guard, execution loop
├── tools/                 # plans, ask-choice, refine, analyze-refs, execute-plan, code-graph, graph-aware file tools
├── src/                   # state, guard, plan parsing, huge-plan parser, run picker, dashboard,
│   │                      # agent sessions, subagent list + overlay, exec loop, delegated executor
│   └── code-graph/        # SQLite schema/store, parsers, indexer, summary, materialize
├── skills/                # The planning router plus six specialist planning skills
├── references/            # Shared workflow, state/config, plan template, huge-plan template (normative)
├── agents/                # reviewer.md, execution-reviewer.md, and ref-analyst.md subagent prompts
├── scripts/validate.ts    # Structure + package artifact guard (incl. the README consistency check)
└── tests/                 # node:test suite (state, guard, plan parsing, execution, refine progress, code-graph, README checks)
```

## Safety model

Before the approved handoff the workflow writes only `.git/pi-plans/` state, the run's artifact directory, `~/.cache/pi-plans/`, and the configured refs root (set via `plans set-refs-root` or `/config-pi-plans`; the recommended `.git/pi-plans/refs/` lives inside the git dir and needs no extra guard) — the extension blocks `edit`/`write` elsewhere while a run is `planning`/`accepted` (bash stays discipline-bound: inspection, `git init`, downloads into the cache). Reviewer/ref-analyst subagents run with read-only tools. `Auto-complete` may answer planning and refinement questions only; it is never offered for execution, installs, publishing, deployment, merge, push, or credential use, and non-interactive sessions stop instead of auto-approving those.

Read-only reviewer and ref-analyst subagents run with pinned tool lists (`read, grep, find, ls` plus `code_graph` when enabled) and inherit pi's project-trust model without any write capability; the execution reviewer runs the same read-only profile (role-governed model/thinking when confirmed, session default otherwise, with a per-round timeout). Execution itself happens in the approved session, never in an unsupervised child.

## Verification

```bash
npm run validate   # structure + package artifact guard + README consistency check
npm test           # node:test suite (stdlib only, no deps)
```

Both run on Node ≥ 22.6 via `--experimental-strip-types`. The graph
extension additionally requires `node:sqlite` (Node ≥ 22.13 unflagged, or
any Node ≥ 22.6 with `--experimental-sqlite`) and the four parser
dependencies declared in `devDependencies`.

## FAQ

**Why do I have to approve before any code changes?**

The plan is the contract. Refinement converges on scope while nothing is writable yet; the merged accept/execute question is an explicit, never-auto-completed approval that also lifts the write guard. You always see — and can veto — what will happen before it happens.

**What can Auto-complete decide on my behalf?**

Planning and refinement choices only (the recommended option). Choosing Auto-complete enables the recommended answer for later eligible planning questions in the current run and the extension continues the planning turn when the model stops early. Use `/plans-autocomplete-stop` to take back control. It is never offered for execution approval, installs, publishing, deployment, merge, push, or credentials — those questions stop and wait for you. After execution completes, the independent execution reviewer verifies every check; the per-run review budget (1/2/3/5/unlimited, default 3, chosen through the same native select menu `ask_choice` uses for a single question when the task tree first goes terminal) pauses the run for review in every mode when exhausted, and only an explicit `/plans-execute` confirmation re-opens the budget menu and grants a fresh budget.

**Where does all the state live?**

Workspace preferences and run ledgers in `.git/pi-plans/` inside your workspace's git directory (never tracked, never published); the reviewer role in the global config `~/.pi/pi-plans/config.json` (override with `PI_PLANS_GLOBAL_DIR`) — confirmed once, shared across every workspace; plan artifacts under the configured artifact root (default `./.git/pi-plans/plans/`, also private — pick `./docs/pi-plans` for public committed plans); reference downloads under the configured refs root — asked once per workspace (recommended `.git/pi-plans/refs/`), changeable via `plans set-refs-root` or `/config-pi-plans`.

**How is this different from just prompting an AI to make changes?**

Prompts produce one-shot diffs with no recorded reasoning. pi-plans produces versioned artifacts — decisions, references, reviewer findings, dispositions, a verifier checklist — that are auditable, resumable across sessions, and enforced by tooling rather than goodwill.

**Doesn't injecting execution rules every turn cost extra tokens?**

The injected rule set is four compressed lines. It buys back more than it costs: the executor stops re-deriving discipline (no speculative abstractions, no compatibility detours, no reinvented helpers), so finished items converge in fewer turns and fewer tokens overall.

**Do plans written by older versions still work?**

Yes. Artifacts produced by earlier releases — including the pre-0.5 implementation-item grammar — parse through a compatibility mapping that surfaces an upgrade notice, and in-flight 0.6.0 runs resume with their recorded authorization and task progress.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow (setup, checks, commit style, and PR expectations). Small fixes can go straight to a pull request; for larger changes, open an issue first. Look for issues labeled `good first issue` to get started.

## License

MIT.
