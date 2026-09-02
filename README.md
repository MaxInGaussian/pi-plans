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
  <a href="https://github.com/earendil-works/pi"><img alt="Pi package" src="https://img.shields.io/badge/Pi-package-fbbf24" /></a>
  <a href="https://github.com/earendil-works/pi"><img alt="Pi coding agent" src="https://img.shields.io/badge/Pi%20coding%20agent-earendil--works-22d3ee" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/pi-plans?color=22c55e" /></a>
  <a href="https://github.com/MaxInGaussian/pi-plans/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MaxInGaussian/pi-plans/actions/workflows/ci.yml/badge.svg" /></a>
</p>

---

A rough change request becomes a versioned Markdown plan instead of a surprise diff. The agent inspects your repository read-only, asks scoped planning questions one at a time, and stores every answer in a per-run ledger. Reviewer and criticizer subagents refine the plan until it converges — and only after you explicitly approve the handoff does the extension enter a tracked execution loop that injects the remaining verifier checklist every turn and lifts the write guard. Nothing outside planning artifacts is writable until that approval.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Interface overview](#interface-overview)
- [Skills](#skills)
- [Installation details](#installation-details)
- [Layout](#layout)
- [Safety model](#safety-model)
- [Verification](#verification)
- [FAQ](#faq)
- [License](#license)

## How it works

```text
        rough change request
                 |
   language + docs location (once per workspace)
                 |
   planning questions, one ask_choice at a time  | write guard ON
                 |                              | only .git/pi_plans/,
                 v                              | run artifacts, cache
        PLAN_vN.md + Verifier Checklist              | are writable
                 ^                |
                 |  refine rounds |
                 +----------------+
         reviewer (x1..x3) -> criticizer -> revise
                 |
                 v
     explicit approval (never auto-completed)
                 |
   =============================================== write guard OFF
                 |
        tracked execution loop
   fused AGENTS.md × Ponytail executor rules
   checklist injected each turn, [DONE:VC-xxx]
   markers tracked via bottom status bar
                 |
                 v
           run status: done
```

Every plan version carries stable IDs (`I-###`, `VC-###`) that never get recycled across revisions, so acceptance criteria survive refinement rounds intact.

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
     1. ./docs/pi-plans (recommended)
     2. ./.git/pi_plans/plans
     3. Other
     4. Auto-complete

Pi:  Wrote ./docs/pi-plans/2026-08-26-split-execution-loop/PLAN_v1.md
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

Planning artifacts live under `./docs/pi-plans/YYYY-MM-DD-<topic>/` by default (public, committed). Prefer `.git/pi_plans/plans` if you want them private to the repository.

## What it does

| Capability | In short |
|---|---|
| Planning router + five specialist skills | Start with `/skill:planning` to route to the narrowest matching specialist (`plan-small` → `plan-big`, `debug-and-plan`, `plan-with-refs`) |
| Choice prompts | `ask_choice`: recommended option first, answers auto-recorded per run; choosing Auto-complete enables recommendation-only answers for later eligible questions in the current planning run, with `/plans-autocomplete-stop` available to take back control. After execution completes, the completion prompt replaces Auto-complete with `Auto-refine loop` (`trailing: "auto-refine-loop"`) so users can opt into an implementation-review loop instead. |
| Refinement rounds | Read-only reviewer/criticizer Pi subagents consolidate findings into the next plan version; delegated runs have standalone `Reviewer`/`Criticizer` progress overlays that close before the tool result returns |
| Workspace state | Config, runs, decisions, refs, and subagent ledgers in `.git/pi_plans/` (git common dir) |
| Smart compact (I-aware) | History is sliced by `I-###` instead of VC. The current-I slice above 20% of the model window triggers a bounded summary with paired `Read:` records, retains a legal recent suffix, targets <10% post-context, and records a hard-floor reason when unreachable. Planning phase falls back to the latest plan/Q&A focus when no current marker exists; cooldown + resume guard prevent ping-pong; one hidden continuation is queued when Pi reports `willRetry: false` |
| Visible Refiner overlay | Delegated reviewer/criticizer subagents surface as a named public overlay in the TUI — one `Reviewer`/`Criticizer` panel with per-lane tool progress, full streaming transcript with follow-bottom scroll, Tab-pane focus, retention until the user presses `Esc` after completion, and clean cancelled/timed-out vs completed states. `reviewers: 3` renders three equal-height panes inside the same overlay |
| Tracked execution | Checklist injected each turn; `[DONE:VC-xxx]` markers drive completion; implementation items report progress with `[I-xxx:implemented]` / `[I-xxx:validating]` markers; the bottom status bar shows lifecycle, `x/y` progress, elapsed time, and input/output token usage in real time |
| Execution handoff | The accepted plan resumes in the current session model; no separate model selection is performed. |
| Execution-phase compaction | Pi core owns threshold, overflow, and manual scheduling; pi-plans adds a current-I proactive check once the current-I slice exceeds 20% of the model window, summarizes I-level history and bounded `Read:` records, retains a legal recent suffix, targets under 10% when possible, and records hard-floor reasons when not; one hidden continuation is queued when Pi reports `willRetry: false` |
| Planning-phase auto compaction | In active planning runs (run.status=planning, no execution), the current-I check uses the same 20%/10% best-effort policy when a marker exists; without a marker it protects the latest plan/Q&A focus, while Pi threshold, overflow, and manual compaction remain supported; cooldown + resume guard prevent ping-pong and hidden resume messages stay out of model context |
| Efficient executor prompt | Each turn, the executor is steered by a fused rule set — Marcos Hernanz's AGENTS.md principles × Ponytail minimalism: layered growth, simplest implementation, long-term architecture (no stopgaps), library discipline — so plans finish in fewer tokens and fewer detours |
| Write guard | `edit`/`write` blocked outside planning artifacts while a run is active |

## Interface overview

| Tool / Command | Purpose |
|---|---|
| `plans` | State CLI: `init`, `show`, `set-language`, `set-artifact-root`, `set-role`, `start-run`, `set-status`, `record-decision`, `record-ref`, `record-subagent` |
| `ask_choice` | Numbered choice prompt; `autoComplete: false` for the merged accept/execute question and external-state questions |
| `refine` | Reviewer/criticizer round via standalone read-only subagents (`--mode json -p --no-session --tools read,grep,find,ls`); `target: "plan"` (default) reviews the plan, `target: "implementation"` reviews the implemented worktree against the plan; delegated TUI runs show one `Reviewer`/`Criticizer` overlay (78% width × 78% height, top-center, ≥72 cols) with per-lane transcript, follow-bottom scroll, Tab focus, and retention until `Esc`; `reviewers: 3` renders three equal-height panes; enforces role/model confirmation gates |
| `execute_plan` | Execution handoff: re-confirms with the user and enters extension-managed execution mode |
| `/plans` | Show config, active run, and execution progress |
| `/plans-execute [plan.md]` | Manual execution handoff (defaults to highest `PLAN_vN.md`) |
| `/update-plan [plan.md] [reason…]` | Interrupt-and-refine: stops execution (if any), returns the run to planning, and directs the agent to revise the plan into `PLAN_vN+1.md` while preserving verified work |
| `/plans-autocomplete-stop` | Stop the current run's Auto-complete mode and return later planning questions to normal interaction |
| `/plans-stop` | Stop execution mode |
| `/plans-abandon` | Abandon the active run (lifts the write guard; artifacts stay) |
| Status bar (lifecycle) | 💬 Q&A → 📝 draft written (planning sub-phases) → ⌛ executing `x/y · spent · in/out-toks` in the bottom status bar → ⛔ stopped / 🎯 done / 🚫 abandoned |

## Smart compact (I-aware)

Default `compaction` is Pi-core-owned: threshold, overflow, and manual `/compact` always run as designed. On top of that, pi-plans layers an **I-aware policy** so long, tool-heavy sessions survive the same run instead of running out of context:

- **Slice by implementation item.** History is grouped by `[I-###:current]` markers instead of `[DONE:VC-xxx]`. The current I's prefix can be summarized, the current I's recent suffix stays raw, and finished `I-###` items become independent sections.
- **Bounded read history.** Every paired `read` call/result is reduced to `Read: <path> line <X-Y> Extracted information summary: ...` (line range is `unknown` when no offset/limit is given). Records deduplicate by path/range across compactions and never embed full raw tool output.
- **20%/10% best-effort budget.** When the current-I slice exceeds 20% of `ctx.getContextUsage().contextWindow`, a compact is requested on the next settled turn. The summary's `details` record `contextWindow`, `tokensBefore`, `currentITokens`, `summaryTokens`, `keptSuffixTokens`, `estimatedAfterTokens`, `targetRatio`, `currentI`, `firstKeptEntryId`, `targetMet`, and a `hardFloorReason` when the 10% target cannot be reached (system prompt, tool definitions, single oversized tool result). Hard floors stop the loop; they do not silently fall through.
- **Pi-owned scheduling preserved.** Threshold, overflow, and manual triggers still come from Pi core. pi-plans only customizes the summary and re-arms once usage falls below the low watermark. The hidden `Continue execution.` resume message is queued on non-retry compactions and never enters model context.
- **Bounded model call.** Custom summaries reuse the current Pi model via `ctx.modelRegistry.complete(model, context, options)` with `event.signal`, `cacheRetention: "none"`, a fresh `sessionId`, and bounded `maxTokens`. Empty, length-stopped, error, or tool-call responses fall back to Pi's default compaction — no half-checkpoint is ever written.
- **Phase isolation.** Planning and execution keep independent compaction state (`pi-plans-plan-resume` vs `pi-plans-exec-resume`); planning without a current marker protects the latest plan/Q&A focus rather than leaking execution state.

## Visible Refiner overlay

Delegated `refine` rounds (reviewer or criticizer) show their progress directly inside the Pi TUI instead of disappearing into the child process's terminal. The overlay is a public, named panel so users always know who is doing what:

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
| [`plan-small`](skills/plan-small/SKILL.md) | Small scoped change; 1–3 questions; one criticizer round |
| [`plan-normal`](skills/plan-normal/SKILL.md) | Broad or risky change; 5–10 questions; reviewer + criticizer rounds |
| [`plan-big`](skills/plan-big/SKILL.md) | Open-ended/high-risk effort; 10+ questions; three concurrent reviewers |
| [`debug-and-plan`](skills/debug-and-plan/SKILL.md) | Bug, CI failure, regression, incident — diagnose before planning |
| [`plan-with-refs`](skills/plan-with-refs/SKILL.md) | External projects/papers/docs must be analyzed before planning |

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

## Code graph (v0.2+)

`/init-graph` walks the worktree, parses JavaScript/TypeScript and Python
files with Tree-sitter, and stores a normalized function graph in
`.git/pi_plans/code_graph.db`. The DB is the canonical source for downstream
agents: function rows expose a low-token `description`/`inputs`/`outputs`
JSON view, call edges are normalized with `in_links`/`out_links` derived on
read, and each function retains its full UTF-8 source.

- `/init-graph [--reindex] [--no-summary] [--no-commit]` — scan the worktree and write the
  graph; with `--reindex` it incrementally updates an existing DB. Dirty trees
  get a `chore(code-graph): pre-init snapshot` commit first (`--no-commit` skips).
  After indexing it records a `code_graph_snapshot` (HEAD + uncommitted paths)
  that `/graph-drift` compares against. The parser dependencies are installed
  via npm (`tree-sitter`, grammars).
- `/graph-status` — print function/file/edge counts.
- `/update-graph [--dry-run] [--base <commit>]` — incrementally reindex only
  the paths `git status --porcelain` reports (including untracked and rename
  targets); deleted files' DB rows are purged, never resurrected.
- `/graph-drift [--json] [--commit-aware]` — direction-aware convergence check:
  (a) per-file hash match or a pending apply marker, (b) every uncommitted
  indexable path is indexed, (c) snapshot vs current HEAD (informational).
- `/apply-graph [--force]` — materialize DB edits back to source. Files with
  `pending_kind='update'` are written (created when missing on disk);
  `pending_kind='delete'` files are removed from disk and the DB; pending-null
  missing files are skipped, never resurrected. Refuses when the active
  planning run is `planning`/`accepted`.
- `/enable-graph` / `/disable-graph` — toggle the `graph_enabled` config
  flag (disable refuses while drift is dirty). When enabled, planner/refiner/
  executor prompts direct agents to read code via the graph; refiner
  subagents get the `code_graph` tool in their allowlist; the executor loop
  becomes DB-first: `code_graph` mutations → `/apply-graph` → `/graph-drift`
  → `plans final-commit` → `/init-graph`.
- The `code_graph` tool provides read-only screening (`status`, `screening`,
  `get-function`, `manifest`), DB-first mutations (`update-function`,
  `update-file`, `delete-file` — all mark files `pending_materialization`
  and append to `change_log`), and `list-pending` so agents can navigate and
  edit the graph without pulling `full_code`.

Runtime requirements: the base extension still requires Node ≥ 22.6; the
graph feature additionally requires Node ≥ 22.13 (or `--experimental-sqlite`)
so that `node:sqlite` is available without flag. Pi's host currently ships
Node ≥ 22.19, so a fresh install works out of the box. On unsupported
runtimes (Bun, missing parsers) graph commands fail locally without
affecting the planning workflow.

## Layout

```
pi-plans/
├── index.ts               # Extension entry: tools, commands, guard, execution loop
├── tools/                 # plans, ask-choice, refine, execute-plan, code-graph
├── src/                   # state, guard, plan parsing, subagent runner, refine overlay, exec loop
│   └── code-graph/        # SQLite schema/store, parsers, indexer, summary, materialize
├── skills/                # The planning router plus five specialist planning skills
├── references/            # Shared workflow, state/config, plan template (normative)
├── agents/                # reviewer.md / criticizer.md subagent prompts
├── scripts/validate.ts    # Structure validator
└── tests/                 # node:test suite (state, guard, plan parsing, execution, refine progress, code-graph)
```

## Safety model

Before the approved handoff the workflow writes only `.git/pi_plans/` state, the run's artifact directory, and `~/.cache/pi-plans/` — the extension blocks `edit`/`write` elsewhere while a run is `planning`/`accepted` (bash stays discipline-bound: inspection, `git init`, downloads into the cache). Reviewer/criticizer subagents run with read-only tools. `Auto-complete` may answer planning and refinement questions only; it is never offered for execution, installs, publishing, deployment, merge, push, or credential use, and non-interactive sessions stop instead of auto-approving those.

## Verification

```bash
npm run validate   # structure validator
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

Planning and refinement choices only (the recommended option). Choosing Auto-complete enables the recommended answer for later eligible planning questions in the current run and the extension continues the planning turn when the model stops early. Use `/plans-autocomplete-stop` to take back control. It is never offered for execution approval, installs, publishing, deployment, merge, push, or credentials — those questions stop and wait for you. The post-execution amelioration prompt uses a separate `Auto-refine loop` trailing option, which is an explicit user choice that triggers a follow-up rounds/termination question and a refinement loop over the implementation result; it is never auto-selected.

**Where does all the state live?**

Preferences and run ledgers in `.git/pi_plans/` inside your workspace's git directory (never tracked, never published); plan artifacts under the configured artifact root (default `./docs/pi-plans/`); large downloaded references outside the repo under `~/.cache/pi-plans/`.

**How is this different from just prompting an AI to make changes?**

Prompts produce one-shot diffs with no recorded reasoning. pi-plans produces versioned artifacts — decisions, references, reviewer findings, dispositions, a verifier checklist — that are auditable, resumable across sessions, and enforced by tooling rather than goodwill.

**Doesn't injecting execution rules every turn cost extra tokens?**

The injected rule set is four compressed lines. It buys back more than it costs: the executor stops re-deriving discipline (no speculative abstractions, no compatibility detours, no reinvented helpers), so finished items converge in fewer turns and fewer tokens overall.

## License

MIT.
