# Changelog

All notable changes to **pi-plans** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

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