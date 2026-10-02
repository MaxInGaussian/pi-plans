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

---

A rough change request becomes a versioned Markdown plan instead of a surprise diff. The agent inspects your repository read-only, asks scoped planning questions one at a time, and stores every answer in a per-run ledger. Reviewer subagents refine the plan (findings plus questions) until it converges — and only after you explicitly approve the handoff does the extension enter a task-tree execution loop that injects the current wave and remaining tasks every turn, tracks progress through the `plans_update_task` tool, gates completion on an independent audit, and lifts the write guard. Nothing outside planning artifacts is writable until that approval.

## Benchmarked: 6× more tasks solved

On <b>Terminal-Bench 2.0</b> (36-task stratified sample, GLM-5.3-Flash), a paired A/B per task found:<br>
<b>50.0%</b> of tasks solved with pi-plans vs <b>8.3%</b> with stock pi (McNemar exact <b>p = 0.0003</b>)<br>
at <b>7.6× fewer tokens per solved task</b>.

| Terminal-Bench 2.0 | GLM-5.3-Flash + Vanilla Pi | GLM-5.3-Flash + Pi with pi-plans (*/plan-big*) |
|---|---|---|
| Tasks solved (seed 1, n=36) | 3/36 (8.3%) | **18/36 (50.0%)** |
| Tokens per solved task | 2,783,085 | **366,011** (7.6× fewer) |

> [!NOTE]
> **Exploratory result**: single model, single seed, forced `/plan-big` variant, eval-only auto-approve. Full methodology and disclosures: [`docs/benchmarks/tech-note.md`](docs/benchmarks/tech-note.md).

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Interface overview](#interface-overview)
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
   planning questions, one ask_choice at a time  | write guard ON
                 |                              | only .git/pi-plans/,
                 v                              | run artifacts, cache
   PLAN_vN.md (## Tasks + ## Verification
   Checks)                     | are writable
                 ^                |
                 |  refine rounds |
                 +----------------+
       reviewer (x1..x3): findings + questions
                 |
                 v
     explicit approval (never auto-completed)
                 |
   =============================================== write guard OFF
                 |
     task-tree execution loop
   fused AGENTS.md × Ponytail executor rules
   current wave + tasks injected each turn,
   plans_update_task reports status + evidence,
   execution reviewer verifies every check
                 |
                 v
           run status: done
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
     1. ./.git/pi-plans/plans (recommended)
     2. ./docs/pi-plans
     3. Other
     4. Auto-complete

Pi:  Wrote ./.git/pi-plans/plans/2026-08-26-split-execution-loop/PLAN_v1.md
     Example verifier item:
     - [ ] `VC-001` covers `I-001`; pass condition: `npm test` passes;
       evidence: test output; metric: zero failing tests.

Pi:  Accept the plan and execute it now?
     1. ✓ Accept plan and execute now (recommended)
     2. Accept plan, don't execute yet
     3. Run another round: Reviewer
     ...

You: 1 — accept and execute.
```

Planning artifacts live under `./.git/pi-plans/plans/YYYY-MM-DD-<topic>/` by default — private to the repository, never tracked, never published. Choose `./docs/pi-plans` instead if you want the plans public and committed alongside the code.

## What it does

| Capability | In short |
|---|---|
| Planning router + five specialist skills | Start with `/skill:planning` to route to the narrowest matching specialist (`plan-small` → `plan-big`, `debug-and-plan`, `plan-with-refs`) |
| Choice prompts | `ask_choice`: recommended option first, answers auto-recorded per run; every option you author states its advantage and its drawback as `✓ <advantage> / ✗ <drawback>` in the configured language, so the user can weigh each option before answering; choosing Auto-complete enables recommendation-only answers for later eligible questions in the current planning run, with `/plans-autocomplete-stop` available to take back control. |
| Refinement rounds | Read-only reviewer Pi subagents return findings (`F-###`) and up to five questions (`Q-1..Q-5`) in one round; the main agent asks every question with `ask_choice` and records the answers before revising. Delegated runs have a standalone `Reviewer` progress overlay; `analyze_refs` shows the same kind of overlay titled `Refs` while per-reference analysis subagents run |
| Workspace state | Config, runs, decisions, refs, and subagent ledgers in `.git/pi-plans/` (git common dir) |
| VCC compact | Active planning/execution compaction uses deterministic, no-LLM VCC-style summaries when Pi core emits manual `/compact`, threshold, or overflow events. Summaries use five bracket sections plus a brief transcript, keep a smart recent tail, support `keep:N`, and write VCC details/stats without adding `/pi-vcc` commands. |
| Visible Refiner overlay | Delegated reviewer subagents surface as a named public overlay in the TUI — one `Reviewer` panel with per-lane tool progress, full streaming transcript with follow-bottom scroll, Tab-pane focus, retention until the user presses `Esc` after completion, and clean cancelled/timed-out vs completed states. `reviewers: 3` renders three equal-height panes inside the same overlay |
| Tracked execution | The current wave and remaining tasks are injected each turn; task progress is reported exclusively through the `plans_update_task` tool (status + evidence / skipReason, audit-only rollback); the task dashboard shows the tree live (compact aboveEditor widget, Ctrl+Shift+T expanded view with ✓/▸/~/· markers, width-adaptive); a stall watchdog pauses after three settled rounds without task-state change; the status bar shows lifecycle, `x/y` task progress, elapsed time, and token usage in real time |
| Multi-run workdirs (0.6.0) | Several pi sessions can plan concurrently in one workdir: the run registry derives from `runs/` (no shared pointer to race), each session binds to its run, and same-topic runs get suffixed artifact dirs. `/plans-abandon`, `/plans-execute`, and `/resume-plans` are binding-first and open a descriptive run-picker form when more than one candidate exists; `/plans` lists all runs (newest first, bound run marked) |
| Execution reviewer | When every task reaches a terminal state, the run status moves to `verifying` and an independent read-only reviewer verifies each `VC-###` check AND reports severity-graded `F-###` findings over the whole implemented change in a detached, overlay-visible round (Esc closes; Ctrl+Shift+R reopens the in-flight round). Finding ids are stable across rounds (absence from the newest report = resolved). A failed check or a high-severity finding opens one union fix round: mapped tasks roll back to pending (children cascade, skipped reopen; an unmapped high gets a plan task appended mechanically from the reviewer's proposed title), and the executor is woken exactly once with a findings summary plus the round-report path. The run completes only when every check is affirmatively `pass` and no high finding remains; residual medium/low findings are summarized at completion. Five committed rounds bound the loop — exhaustion pauses in every mode, and only an explicit `/plans-execute` confirmation grants a fresh budget (unresolved findings survive the renewal; ordinary input and restores never refill). Checks with all-skipped coverage pass; checks covering no task never audit |
| Execution handoff | The accepted plan executes in the current session after explicit approval (never auto-completed); legacy `I-###` plans parse through the compatibility mapping with an upgrade notice; 0.6.0 in-flight runs resume compatibly (delegated-executor orphans re-approve, paused executions rebuild from the task tree) |
| Execution-phase compaction | Pi core owns scheduling; pi-plans maps the active plan path, current task, task ids, and remaining `VC-###` checks into the VCC sections. Proactive triggers and model-generated summary paths are removed. |
| Planning-phase compaction | During `run.status=planning` with no active execution, pi-plans maps active run, artifact directory, latest plan path from session entries, and observed current-I markers into the VCC sections. Without an active planning run, compaction returns to Pi core. Additionally, creating a new run (`plans start-run`) proactively requests one pre-plan VCC compaction and resumes planning with a hidden message (default on; `prePlanCompact:false` disables). |
| Efficient executor prompt | Each turn, the executor is steered by a fused rule set — Marcos Hernanz's AGENTS.md principles × Ponytail minimalism: layered growth, simplest implementation, long-term architecture (no stopgaps), library discipline — so plans finish in fewer tokens and fewer detours |
| Write guard | `edit`/`write` blocked outside planning artifacts while a planning run is active in the workdir; the guard prefers the session-bound run and lists the allowed roots on refusal |

## Interface overview

| Tool / Command | Purpose |
|---|---|
| `plans` | State CLI: `init`, `show`, `set-language`, `set-artifact-root`, `set-refs-root`, `set-role`, `start-run`, `set-status`, `record-decision`, `record-ref`, `record-subagent`, `record-checkpoint` (state-machine-validated workflow transitions) |
| `ask_choice` | Numbered choice prompt; `autoComplete: false` for the merged accept/execute question and external-state questions |
| `refine` | Reviewer round via standalone read-only subagents (`--mode json -p --no-session --tools read,grep,find,ls`, plus `code_graph` when the workspace has the code graph enabled): findings (`F-###`) and up to five questions (`Q-1..Q-5`) per lane; the caller must ask every question with `ask_choice` and record answers before revising; delegated TUI runs show one `Reviewer` overlay (78% width × 78% height, top-center, ≥72 cols) with per-lane transcript, follow-bottom scroll, Tab focus, and retention until `Esc`; `reviewers: 3` renders three equal-height panes; enforces the reviewer gates — first use pops native model + effort panels in TUI (menus on RPC, text guidance headless), persisted to the global reviewer config |
| `analyze_refs` | plan-with-refs reference analysis: one independent read-only subagent per downloaded reference (cwd = the ref directory), reusing the reviewer model confirmation from the global config (the mode is not consulted — analysis always spawns) and the concurrent overlay (titled `Refs`); batches of at most 3 lanes run sequentially; returns structured per-reference sections for `REF_ANALYSIS.md` |
| `execute_plan` | Execution handoff: re-confirms with the user (never auto-completed) and enters task-tree execution mode (`plans_update_task` progress, dashboard, execution reviewer); legacy `I-###` plans parse through the compatibility mapping with an upgrade notice; picks the run via a descriptive form when several planned runs coexist |
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
| `/watch-graph` `/unwatch-graph` | 300ms-debounced filesystem watcher feeding incremental reindex; single-writer per worktree (atomically claimed PID+heartbeat lock, stale takeover), skips files with staged edits, fails closed on errors, stops cleanly on fs.watch errors / repeated failures / session shutdown, auto-restarts when enabled |
| `code_graph` actions | Read-only: `status` (files/functions/edges + confidence×resolution distribution), `screening` (per-row freshness probes), `get-function`, `query` (keyword→BFS/DFS with token budget + shown/omitted counts), `path A B` (shortest call path), `explain <fn>` (community/degrees/neighbors), `impact <fn>` (reverse call closure + affected files); write path: DB-first staged edits + `apply` (auto-reindexes the materialized set). Edge resolution covers re-export barrels (`export {x} from` / `export *` follow to the defining module), namespace/default imports, `require` destructuring, and dynamic `import()`; same-name exports classify as `ambiguous` |
| `/plans-stop` | Stop execution mode |
| `/plans-abandon` | Abandon a run (pick via form when several candidates; lifts the write guard; artifacts stay) |
| Status bar (lifecycle) | 💬 Q&A → 📝 draft written (planning sub-phases) → ⌛ executing `x/y · spent · in/out-toks` in the bottom status bar → ⛔ stopped / 🎯 done / 🚫 abandoned |

## VCC compact

Pi core remains the owner of compaction scheduling: manual `/compact`, threshold, and overflow events are emitted by Pi as usual. During an active pi-plans planning or execution run, pi-plans handles `session_before_compact` with a deterministic VCC-style compiler instead of calling a model for a summary.

- **Summary shape.** The summary contains exactly five bracket sections: `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, and `[User Preferences]`, followed by `---` and a ranked brief transcript. Execution contributes plan path, current `I-###`, implementation IDs, and remaining verifier IDs; planning contributes run ID, artifact directory, latest plan path from session entries, and any observed current-I marker.
- **Session-only input.** Compact summaries are built from the event's branch entries, previous summary, file ops, pi-plans custom session entries, and live phase state. The compiler does not read plan files, git history, or the worktree to invent context.
- **Tail policy.** The default keep is one recent user turn; smart keep may retain more turns when the tail is still small. Explicit `keep:N` is honored, while no-anchor and oversized-tail cases use a deterministic token-budget cut that avoids starting retained context with an orphan tool result.
- **Manual matrix.** Plain `/compact` and `/compact keep:N` compact and show stats without continuing. `/compact <text>` and `/compact keep:N <text>` compact, then send the text once as the follow-up prompt. Internal pi-plans compaction markers are never reused as user follow-up prompts.
- **Fallbacks and stats.** Unsafe manual/threshold cuts cancel with a warning; overflow or retrying unsafe cuts return control to Pi core. Successful VCC compactions notify with kept-tail and summarized-message stats. Threshold/overflow compactions may queue one hidden continuation only when the running Pi version still needs it and `continueAfterThresholdCompact` is enabled.
- **Pre-plan compaction.** When `plans start-run` creates a new planning run, pi-plans proactively requests one VCC compaction (internal hint `pi-plans planning pre-plan compact`) right after the run is created and before the first planning question, then resumes the planning turn with a hidden message — so each new plan starts on a lean context (LLM reasoning degrades with longer input). Small sessions, already-compacted sessions, and failures skip silently and still resume. `prePlanCompact:false` in the repo-private config restores the old behavior.
- **Repo-private config.** Defaults are scaffolded in `.git/pi-plans/pi-vcc-config.json` under the resolved git common dir: `overrideDefaultCompaction:true`, `smartKeepTail:true`, `continueAfterThresholdCompact:true`, `prePlanCompact:true`, `debug:false`. Global pi-vcc config and `PI_VCC_CONFIG_PATH` are intentionally ignored.

## Visible Refiner overlay

Delegated `refine` rounds (reviewer) and `analyze_refs` rounds (titled `Refs`) show their progress directly inside the Pi TUI instead of disappearing into the child process's terminal. The overlay is a public, named panel so users always know who is doing what:

- **Pi-btw-aligned geometry.** Each round uses `width: "78%"`, `minWidth: 72`, `maxHeight: "78%"`, `anchor: "top-center"`, and `{ top: 1, left: 2, right: 2 }` margins (no dependency on `pi-btw`; the renderer is built on Pi's public `pi-tui` primitives).
- **Complete streaming transcript.** Assistant text, thinking blocks, tool calls, tool results, and stderr are merged per turn/content block into lane entries without overlay-facing truncation; only the viewport slices them. Final `message_end` / `tool_execution_end` overwrite the live snapshot with the authoritative content.
- **No input row.** The overlay has no composer, no submit path, and no printable input forwarding. Only `Esc`, `Tab`/`Shift+Tab`, `↑/↓`, `PgUp/PgDn`, and SGR mouse wheel are consumed; everything else is ignored by design.
- **Equal-height panes for `reviewers: 3`.** Concurrent reviewer rounds render one reviewer lane per subagent as three independent equal-height panes inside the same top-center overlay; each pane keeps its own scroll offset and `follow-bottom` state. `Tab`/`Shift+Tab` switches the focused pane and scroll keys only affect it.
- **Lifecycle.** The overlay opens at round start, advances via the JSONL progress feed emitted by `pi --mode json`, and is dismissed by `Esc`. `Esc` is close-only — it never aborts the refiner child; the child keeps running to natural completion and its result still flows back through the tool result path. A new refinement round replaces any retained finished overlay to avoid overlay stacking. Cancelled and timed-out children render as terminal states with the original error message — never as silent drops.
- **Tool-only progress.** The overlay only consumes tool and message lifecycle events from the child; unrelated `pi` events are ignored, so a noisy upstream release does not desync the panel.

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

| Skill | Use it when |
|---|---|
| [`planning`](skills/planning/SKILL.md) | General router; selects the narrowest specialist skill before planning starts |
| [`plan-small`](skills/plan-small/SKILL.md) | Small scoped change; 1–3 questions; one reviewer round |
| [`plan-normal`](skills/plan-normal/SKILL.md) | Broad or risky change; 5–10 questions; reviewer rounds |
| [`plan-big`](skills/plan-big/SKILL.md) | Open-ended/high-risk effort; 10+ questions; three concurrent reviewers |
| [`debug-and-plan`](skills/debug-and-plan/SKILL.md) | Bug, CI failure, regression, incident — diagnose before planning |
| [`plan-with-refs`](skills/plan-with-refs/SKILL.md) | External references must be analyzed before planning — repos, papers (arXiv), engineering blogs, and docs sites all count; theoretical references are equal citizens. plan-normal/plan-big may optionally cite 1–2 search-found references without downloading |

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

First full A/B run complete (36-task stratified TB2.0 sample, GLM-5.3-Flash, seed 1) — headline numbers above; full methodology and disclosures in [`docs/benchmarks/tech-note.md`](docs/benchmarks/tech-note.md).

| Terminal-Bench 2.0 | GLM-5.3-Flash + Vanilla Pi | GLM-5.3-Flash + Pi with pi-plans (*/plan-big*) |
|---|---|---|
| Tasks solved (seed 1, n=36) | 3/36 (8.3%) | **18/36 (50.0%)** |
| Tokens per solved task | 2,783,085 | **366,011** (7.6× fewer) |

We evaluate pi-plans with a controlled A/B: **<a href="https://github.com/earendil-works/pi">vanilla pi</a>** vs **pi + pi-plans** (planning entry injected at the adapter level; task instructions verbatim in both arms) on [Terminal-Bench 2.0](https://www.tbench.ai/) (89 tasks) through the [harbor](https://github.com/laude-institute/harbor) framework, paired per task and analyzed with a pre-registered McNemar exact test plus paired bootstrap CIs. Cost accounting includes parent **and subagent** usage.

**Scope of any published claim (strictly limited):** pi-plans (forced-`/plan-big` variant) on Terminal-Bench 2.0 / single model / single seed — an exploratory paired difference, **not** a general claim about pi-plans. Human-approval gates are bypassed by an eval-only `PI_PLANS_AUTO_APPROVE=1` env (lifecycle questions only, default off), so results do not represent the interactive experience.

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
├── tools/                 # plans, ask-choice, refine, execute-plan, code-graph
├── src/                   # state, guard, plan parsing, subagent runner, refine overlay, exec loop
│   └── code-graph/        # SQLite schema/store, parsers, indexer, summary, materialize
├── skills/                # The planning router plus five specialist planning skills
├── references/            # Shared workflow, state/config, plan template (normative)
├── agents/                # reviewer.md subagent prompt (ref-analyst.md for reference analysis)
├── scripts/validate.ts    # Structure + package artifact guard
└── tests/                 # node:test suite (state, guard, plan parsing, execution, refine progress, code-graph)
```

## Safety model

Before the approved handoff the workflow writes only `.git/pi-plans/` state, the run's artifact directory, `~/.cache/pi-plans/`, and the configured refs root (set via `plans set-refs-root` or `/config-pi-plans`; the recommended `.git/pi-plans/refs/` lives inside the git dir and needs no extra guard) — the extension blocks `edit`/`write` elsewhere while a run is `planning`/`accepted` (bash stays discipline-bound: inspection, `git init`, downloads into the cache). Reviewer/ref-analyst subagents run with read-only tools. `Auto-complete` may answer planning and refinement questions only; it is never offered for execution, installs, publishing, deployment, merge, push, or credential use, and non-interactive sessions stop instead of auto-approving those.

Read-only reviewer and ref-analyst subagents run with pinned tool lists (`read, grep, find, ls` plus `code_graph` when enabled) and inherit pi's project-trust model without any write capability; the execution reviewer runs the same read-only profile (role-governed model/thinking when confirmed, session default otherwise, with a per-round timeout). Execution itself happens in the approved session, never in an unsupervised child.

## Verification

```bash
npm run validate   # structure + package artifact guard
npm test           # node:test suite (stdlib only, no deps)
```

Both run on Node ≥ 22.6 via `--experimental-strip-types`. The graph
extension additionally requires `node:sqlite` (Node ≥ 22.13 unflagged, or
any Node ≥ 22.6 with `--experimental-sqlite`) and the four parser
dependencies listed in `dependencies`.

## FAQ

**Why do I have to approve before any code changes?**

The plan is the contract. Refinement converges on scope while nothing is writable yet; the merged accept/execute question is an explicit, never-auto-completed approval that also lifts the write guard. You always see — and can veto — what will happen before it happens.

**What can Auto-complete decide on my behalf?**

Planning and refinement choices only (the recommended option). Choosing Auto-complete enables the recommended answer for later eligible planning questions in the current run and the extension continues the planning turn when the model stops early. Use `/plans-autocomplete-stop` to take back control. It is never offered for execution approval, installs, publishing, deployment, merge, push, or credentials — those questions stop and wait for you. After execution completes, the independent execution reviewer verifies every check; the five-round budget pauses the run for review in every mode when exhausted, and only an explicit `/plans-execute` confirmation grants a fresh budget.

**Where does all the state live?**

Workspace preferences and run ledgers in `.git/pi-plans/` inside your workspace's git directory (never tracked, never published); the reviewer role in the global config `~/.pi/pi-plans/config.json` (override with `PI_PLANS_GLOBAL_DIR`) — confirmed once, shared across every workspace; plan artifacts under the configured artifact root (default `./.git/pi-plans/plans/`, also private — pick `./docs/pi-plans` for public committed plans); reference downloads under the configured refs root — asked once per workspace (recommended `.git/pi-plans/refs/`), changeable via `plans set-refs-root` or `/config-pi-plans`.

**How is this different from just prompting an AI to make changes?**

Prompts produce one-shot diffs with no recorded reasoning. pi-plans produces versioned artifacts — decisions, references, reviewer findings, dispositions, a verifier checklist — that are auditable, resumable across sessions, and enforced by tooling rather than goodwill.

**Doesn't injecting execution rules every turn cost extra tokens?**

The injected rule set is four compressed lines. It buys back more than it costs: the executor stops re-deriving discipline (no speculative abstractions, no compatibility detours, no reinvented helpers), so finished items converge in fewer turns and fewer tokens overall.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow (setup, checks, commit style, and PR expectations). Small fixes can go straight to a pull request; for larger changes, open an issue first. Look for issues labeled `good first issue` to get started.

## License

MIT.
