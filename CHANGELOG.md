# Changelog

All notable changes to **pi-plans** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

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