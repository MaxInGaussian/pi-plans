# Changelog

All notable changes to **pi-plans** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-09-17

### Added

- **Trust: read-time validation and self-healing.** Every graph read (digest, get-function, screening) validates the owning file against the disk first — stat fast path (v3 `files.last_size/last_mtime`), full-hash fallback, and the already-read disk buffer is served directly. Genuinely stale files return the fresh disk text with a `[graph: stale — fell back to disk read; reindexed]` marker and synchronously rebuild that one file (single-flight; read-only refiner sessions validate but never rebuild). Files with staged DB-first edits (the intentional "DB ahead" state) serve the staged text with a pending marker instead — no fallback, no rebuild, staged edits are never destroyed.
- **Cross-file call/import edges with confidence labels.** The v1 regex resolver (everything unresolved) is replaced by a two-phase extractor: a module graph over DB snapshots + in-batch overrides (exports, imports per language), then per-function resolution — same-file calls are `EXTRACTED`, cross-file bindings are `INFERRED`, ambiguous imports stay `ambiguous`, and unresolvable heads on external modules plus JS/Python builtins are dropped as noise (unresolved dangling edges dropped from 22,291 to ~4,300 on this repo). Import edges resolve relative specifiers with extension probing (`EXTRACTED`) and barrel probing (`INFERRED`). Edge data lives in the existing `call_edges` table (schema v3 adds `confidence`; the `function_records` view and screening filters are updated, old DBs migrate in place).
- **Graph query actions.** `code_graph` gains `query` (keywords → node match → BFS/DFS expansion under a chars/4 token budget, deterministic expansion order), `path A B` (shortest call path, exactly two selectors), `explain <fn>` (location, community, in/out degrees, typed neighbor lists), and `impact <fn>` (reverse call closure with affected files). All pure-algorithm, resolved-edges-only by default (`includeUnresolved` opts in), each answering in <100ms at this repo's scale.
- **Communities, god nodes, and GRAPH_REPORT.md.** Label propagation (deterministic iteration order, ≤20 rounds) runs after every index; community labels derive from the dominant directory segment; god nodes are the top-10 by resolved degree. `/init-graph` and `/update-graph` write `.git/pi_plans/graph/GRAPH_REPORT.md` (edge stats by confidence/resolution, community table, god nodes, suggested queries).
- **Richer digests.** Function digests now carry signature slices plus `→calls:`/`←called-by:` lists (top-3 + `+N`, resolved edges only) and a `§community` tag — the summary carries both directions of the call graph so whole-file `full:true` escapes are needed less often.
- **Freshness automation.** Three triggers feed one shared incremental reindex: `apply` (materialized set), `plans final-commit` (pre-commit dirty snapshot), and graph-aware edit/write (parse-merge of the staged text — derived rows refresh without touching `source_text`/`pending_kind`). `/watch-graph` adds a 300ms-debounced recursive watcher (PID+heartbeat single-writer lock per worktree, pending files skipped, refiners refused) that stops on `session_shutdown` and auto-restarts on `session_start` when previously enabled; `/unwatch-graph` and `disable-graph` stop it.

### Changed

- `vendor/` directories are excluded from discovery (this repo's vendored benchmark tree was 90% of the old index); schema version 3 with idempotent step migrations for legacy databases (legacy edge rows survive populated migrations); graph prompt blocks teach the new semantics (self-healing reads, digest link tags, query actions before grepping).

### Fixed

- **Edge-matrix hardening (implementation review r1).** `export { x } from` and `export * from` now resolve through to the DEFINING module (transitive barrels included — call edges target real function nodes, never phantom barrel entries); same-name exports across modules classify as `ambiguous` instead of unresolvable noise; dynamic `import('./x')` emits an import edge (resolved for in-repo targets, dangling for externals); `const { a } = require('./x')` binds the NAMED export (only brace-less require binds the default); import bindings are consulted before the same-name method heuristic and that heuristic is demoted to `INFERRED` (a local `readFile` can no longer hijack `fs.readFile(...)`); Python `import x.y` binds the head module and `from . import x` resolves the package `__init__`.
- **Full-rebuild pending guard.** `runIndex` fails closed: a full rebuild (`/init-graph`) skips files with staged DB-first edits instead of overwriting them — staged text survives until `apply` materializes it.
- **Watch hardening.** An `fs.watch` error event stops the watcher cleanly (with a `watch.failed` hint) instead of crashing the host; the lock is claimed atomically (`wx`) with stale-lock cleanup and ownership-checked release; repeated reindex failures (10+) stop the watcher and point at `/update-graph`; pending-file detection fails closed on store read errors.
- **`code_graph status` surface.** Now reports the total edge count and the kind × resolution × confidence distribution (AC-003); `query`/`impact` results carry `shown`/`omitted` counts alongside `truncated`; `includeUnresolved`'s description states its actual semantics (target-less dangling edges never enter traversal).
## [0.4.1] - 2026-09-17

### Fixed

- **No more duplicated （推荐） markers in the batch form.** Agents sometimes authored option labels that already ended with `（推荐）`/`(recommended)`; the renderer then appended its own marker and the option displayed the tag twice. Labels are now normalized (`stripRecommendedMarker`) wherever they render — form options, submit page, transcript `renderCall`, and both sequential-select fallbacks — and the recommended indicator is a single colored `★` (pi-goal-x alignment) instead of a `(推荐)` text suffix. `formAnswers` strips the marker from recommended answers so the returned label stays clean; the tool schema now tells agents never to embed the marker in labels.
- **Themed batch form aligned with pi-goal-x.** `formRender` accepts an optional theme (the host already injects the pi Theme into the custom-dialog factory; it was previously ignored). With it, the question tab renders the pi-goal-x frame: accent top/bottom borders, a tabs row whose active chip gets the `selectedBg` background (■ answered / □ pending, ✓ 提交 dims until every question is answered), the question line in accent, selected options in accent with `→ `, unselected in text, `★` in success color, and dim key hints. The submit page uses an accent bold header with warning/success status, the editing page an accent header. The F-001 rows-budget degradation is preserved and extends to the new frame: descriptions strip first, then blank separators, then the borders (the selectedBg chips row survives), then the question text; options are only capped behind a `… +N more` indicator as a last resort and the footer always survives. All lines stay width-safe under real ANSI styling (visibleWidth skips escape sequences).
## [0.4.0] - 2026-09-17

### Added

- **Batch multiple-choice question form.** `ask_choice` now accepts `questions: [...]` (2-8 items): instead of asking one question at a time, the tool opens ONE tabbed multiple-choice form in the terminal — one tab per question with all options visible in the first frame, the recommended option preselected, a "✏️ 自定义答案…" row per tab that switches into a Focusable single-line input (CURSOR_MARKER + hardware cursor, so zh-Hans IME composition works), and a final submit page listing every Q/A. Phased questioning stays agent-driven: submit a batch, think about the answers, follow up in later calls. Esc returns the answered subset as partial answers (recorded with a batch-level cancelled row; `disableAutoComplete` side effect matches the single-question cancel). Answers are recorded per question in decisions.jsonl (questionId passthrough for cross-session dedupe) and in the checkpoint via the new `pendingQuestions` batch field, so `/resume-plans` replays only unanswered questions. Gates: auto-approve and auto-complete short-circuit the whole batch with recommended options; print/json auto-completes every question; RPC hosts without `ctx.ui.custom` degrade to one sequential `ctx.ui.select` per question. Safety red line: batches reject `autoComplete: false` items and the reserved scope/handoff question ids — the final scope confirmation and execution handoff are always single-question calls. The tool description and prompt guidelines teach the batch protocol, and all six planning skills (planning, plan-small, plan-normal, plan-big, plan-with-refs, debug-and-plan) instruct batched rounds (≤8 per call) with follow-up phases.
- **Fixed execution status panel.** While a plan executes, a fixed `╭─ pi-plans ─ <run topic> ──╮` tasks panel renders above the editor (7 rows at ≥30 columns, a 3-row badge below): phase and goal-wait counters, remaining implementation items with a progress bar, the current implementation item (marker-backed or inferred, inference never persisted), a Next action line, and VC progress. The panel, the bottom status-bar summary line, and the execution injection text all derive from one pure model (`src/panel.ts`) — what the panel shows is exactly what the agent is told. Rendering is a width-aware component (`render(width)` reads the live width and theme; every line is truncated to width including CJK, so resizes never wrap rows) with a fixed row count so the terminal buffer height never changes (no scrollback churn, no timers). The panel registers on execution start/approve, refreshes from marker updates and turn ends through the existing `updateStatusWidget` call sites (including `restoreFromSession` rebuilds), and unregisters on completion, stop, or abort with the status summary cleared.

## [0.3.3] - 2026-09-08

### Added

- **Pre-plan compaction.** When `plans start-run` creates a new planning run, the extension now proactively requests one VCC compaction (internal hint `pi-plans planning pre-plan compact`) from the `plans` `tool_result` hook — after the run lands, before the first planning question — so every new plan starts on a lean context (LLM reasoning degrades with longer input; Chroma "Context Rot" 2025, Liu et al. "Lost in the Middle" TACL 2024). Pi's manual compaction never continues the interrupted turn, so the hook resumes planning with exactly one hidden `pi-plans-preplan-resume` message on success and failure alike, filtered out of the model context payload; stats notifications reuse the existing VCC reporter. Small sessions ("nothing to compact" / "already compacted"), aborts, and older Pi builds without the extension compact action skip silently with an info notice and still resume. The trigger respects the run-status planning gate and is disabled while an execution is active. New repo-private config key `prePlanCompact` (default `true`) in `.git/pi_plans/pi-vcc-config.json`; set it to `false` to restore the old behavior.
- **`/resume-plans`.** A new interactive command resumes the repository's working plan in the current session, across restarts and sessions: unfinished planning (pending question, answered decisions), reviewing (per-round/per-lane state with successful outputs reused, never re-run), execution (durable approval evidence: plan digest + HEAD + verified VC/I set), and the post-execution implementation review (termination condition + completed-round count). Run-level `checkpoint.json` state lives under `.git/pi_plans/runs/<run-id>/` with explicit validation, atomic writes, monotonic revisions, and separate files for full review outputs; corrupt checkpoints are reported, never silently overwritten. The `plans` tool gains a whitelisted `record-checkpoint` action for model-driven boundaries (plan-written, review-consolidated, implementation-review-configured, implementation-round-finished, completed) that cannot forge approval or terminal states, and `ask_choice` accepts `questionId`/`purpose` so questions deduplicate across sessions (an answered ledger entry always wins over a stale pending one). `refine` records rounds and lane outputs durably and supports `resumeRoundId` for lane-level resume.
- **Session-bound run attribution + run ownership.** Each session binds to the run it starts/executes/resumes (restored from `pi-plans-run-start` entries on the current branch); tools, the planning write guard, autocomplete, execution bookkeeping, and the code-graph apply gate attribute through the binding first, falling back to the shared `active.json` pointer for legacy sessions. A per-run owner lease (host + pid + process start time + token + generation, atomic acquire, conservative refusal on foreign hosts, live owners, and PID reuse) keeps two live sessions from owning one run; checkpoint writes can require ownership. Cross-worktree resumes migrate artifacts without overwriting, reset approval and VC validity, and keep the termination condition while restarting round counts. Execution approval records the HEAD at approval; on resume, an unchanged plan digest with a changed HEAD keeps the authorization but re-verifies previously verified VCs first, and loading execution from a checkpoint writes an immediate session snapshot so session restore cannot clear it.

### Fixed

- **Single-reviewer refine rounds record correctly.** `tools/refine.ts` mapped `reviewerLanes(1)`'s `lens: null` into the review-round spec, which the checkpoint schema rejects (`lanes[0].lens: expected a string`), so every one-lane reviewer round with an active run checkpoint failed before spawning. The tool now maps the missing lens to `undefined`. Found while running the preplan-compact implementation-review loop; intentional deviation from that plan's declared paths (review-loop enablement repair).

## [0.3.2] - 2026-09-07

### Fixed

- **Goal-wait lifecycle.** In TUI/RPC, continuation now waits for
  `agent_settled` and rechecks execution, idle, pending-input, and compaction
  state before sending one hidden message with the latest checklist.
  Tool turns no longer queue duplicate reminders or consume the 3/6
  no-progress/waiting guard rounds. Completion, stop, and session changes
  invalidate wake identity; user interruption and final model errors pause
  continuation until genuine user input or `/plans-execute` resumes it.
  Same-plan command resumes preserve verified progress; `execute_plan`
  retains explicit approval. Print/JSON single-shot sessions keep marker
  tracking without automatic wakes. Regression tests include the real Pi
  agent loop with an offline deterministic model and the full extension.

## [0.3.1] - 2026-09-06

### Added

- **Per-reference analysis subagents.** plan-with-refs now runs one
  independent read-only subagent per downloaded reference (cwd = the ref's
  own directory, batches of at most 3 under a `Refs` overlay) via the new
  `analyze_refs` tool: it reuses the reviewer role gates and model, returns
  structured per-reference sections (overview / mechanisms / adoptable
  ideas / pitfalls / citations / coverage / gaps) for `REF_ANALYSIS.md`, and
  records spawns best-effort in `subagents.jsonl`. Reference downloads are
  config-driven: a new `refs_root` (asked once per workspace via
  `plans set-refs-root` — recommended `.git/pi-plans/refs/`, second
  `./refs/`, third `~/.cache/pi-plans/refs/`), honored by the planning write
  guard, `/config-pi-plans`, and the plan-with-refs flow (manual structured
  reads are replaced by the tool).
- **Agent-side graph materialization.** The `code_graph` tool gains an
  `apply` action that materializes DB-first staged edits into the worktree
  without the TUI: same hard gates as `/apply-graph` (refused while the
  active run is `planning`/`accepted`, plus a `PI_PLANS_REFINER` env-marker
  refusal that keeps read-only refiner subagents write-free), a stable
  three-state JSON result (`{ok:false,reason}` / `{ok:true,report:{counts,
  files}}` with a post-apply drift summary), and no run-status side effects.
  All agent-facing guidance now teaches the `staged → code_graph apply →
  drift` loop; `/apply-graph` stays the user-facing command over the same
  shared core.

## [0.3.0] - 2026-09-05

### Added

- **Code graph.** A Tree-sitter function graph now lives in
  `.git/pi_plans/code_graph.db` and backs planning, refinement, and
  execution. `/init-graph` indexes the worktree (function descriptions,
  call edges, provenance), `/update-graph` reindexes changed paths
  incrementally, `/apply-graph` materializes DB-first edits back to source,
  `/graph-drift` checks convergence, and `/enable-graph` / `/disable-graph`
  toggle the mode (plus `/graph-status`). When enabled: `read`/`write`/`edit`
  become graph-aware for indexed source files — `read` returns a capped
  function digest instead of whole files (with `full: true` as the only
  whole-file exit), `write`/`edit` stage DB-first mutations until
  `/apply-graph`, and the loop ends with a reindex so the graph stays
  authoritative. The `code_graph` tool provides read-only screening,
  `get-function`, and `manifest` queries plus DB-first mutation actions
  (`update-function`, `update-file`, `delete-file`, `list-pending`);
  planner/refiner/executor prompts
  hard-require function-level reads, and refiner/criticizer subagents get
  `code_graph` in their allowlist. The tree-sitter parser packages are
  optional: install them where pi runs (`npm i tree-sitter
  tree-sitter-javascript tree-sitter-typescript tree-sitter-python`) to
  enable the graph; without them everything else works unchanged.
- **`/config-pi-plans`.** Interactive workspace configuration wizard that
  re-asks every pi-plans default: language, planning docs root, code graph
  toggle, and reviewer/criticizer mode and model. Model pickers aggregate
  the session model, scoped models, and the registry with `Other…` for
  exact selectors; cancellation and invalid input write nothing, and an
  active run's snapshot stays untouched.
- **Goal-running continuation.** After execution completes, interactive
  sessions automatically enter an implementation-review loop: the
  termination condition is asked once (1/2/3 rounds or until no
  high-severity finding, hard cap 5), then `refine` reviewer rounds run
  against the implemented worktree without further prompting — accepting
  evidence-backed findings, applying fixes, and re-running tests each round.
- **Overflow-safe ask_choice panels.** Choice prompts sanitize newlines,
  cap every option at three rendered lines (`..` marker), and enforce a
  hard panel-height ceiling below the terminal height with tiered shrink
  (strip descriptions → one-line labels → truncate the question). Fixed
  tail labels keep their routing prefixes, tiny terminals surface a
  one-time warning instead of failing, and ledgers keep the raw labels.

### Changed

- Subagent default timeout raised from 15 to 60 minutes so long refinement
  rounds no longer terminate mid-review.
- Refiner and criticizer subagents receive `code_graph` in their tool
  allowlist whenever the workspace has the code graph enabled.

## [0.2.0] - 2026-08-31

### Added

- **VCC compact.** Planning and execution compaction now use a deterministic,
  no-LLM VCC-style summary when Pi core emits manual `/compact`, threshold,
  or overflow events. Summaries contain `[Session Goal]`, `[Files And Changes]`,
  `[Commits]`, `[Outstanding Context]`, `[User Preferences]`, and a ranked
  brief transcript; pi-plans maps active run, plan path, current `I-###`,
  implementation IDs, and remaining `VC-###` checklist context into those
  sections. The repo-private `.git/pi_plans/pi-vcc-config.json` defaults to
  `overrideDefaultCompaction:true`, `smartKeepTail:true`,
  `continueAfterThresholdCompact:true`, and `debug:false`; global pi-vcc config
  and `PI_VCC_CONFIG_PATH` are ignored. Manual `keep:N`, follow-up prompts,
  unsafe-cut cancel/fallback behavior, compact stats, and Pi-version-gated
  continuation are covered by tests.
- **Visible Refiner overlay.** Delegated reviewer/criticizer rounds now
  surface a named public `Reviewer`/`Criticizer` overlay in the Pi TUI with
  per-lane tool progress, bounded output preview, and clean cancelled/
  timed-out vs completed terminal states. The overlay opens at round start
  and closes before the tool result returns to the main session. Built on
  Pi's public `pi-tui` primitives — no `pi-btw` dependency.
- **Auto-complete mode.** `ask_choice` routes eligible planning and refinement
  questions through a run-scoped Auto-complete mode. Use
  `/plans-autocomplete-stop` to take back control; Auto-complete is never
  offered for execution approval, installs, publishing, deployment, merge,
  push, or credential use.
- **Planning write guard with `set-artifact-root`.** While a run is
  `planning`/`accepted`, `edit`/`write` is blocked outside `.git/pi_plans/`,
  the run's artifact directory, and `~/.cache/pi-plans/`. The artifact root
  is configurable through the new `set-artifact-root` action.

### Changed

- README now links directly to the [Pi coding agent](https://github.com/earendil-works/pi)
  and documents VCC compact and Visible Refiner overlay behavior.
- Subagent invocation moved to a minimal JSONL-driven runner; the renderer no
  longer depends on `pi-btw` or any third-party view package.

### Removed

- Old current-I proactive compaction scheduling and model-generated compaction
  summaries have been replaced by Pi-core-triggered VCC compact hooks.
- Legacy execution model snapshot/selection helpers
  (`setExecutionModel`, `chooseExecutionModelSelection`,
  `snapshotCurrentModelSelector`, `ensureExecutionModelActive`,
  `restorePlanningModel`).
- Standalone execution-list widget and `/plans-list` toggle; progress lives in
  the bottom status bar throughout.

[0.1.1] - 2026-08-25

- Initial published npm release of the planning workflow.

[0.1.0] - 2026-08-20

- Initial planning workflow, skills, agents, and tests.