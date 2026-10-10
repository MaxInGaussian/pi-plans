# Changelog

## [0.9.1] - 2026-10-07

### Added

- **Token usage on every subagent row.** Each bullet in the subagent list (and the overlay status row) now shows the agent's cumulative input and output tokens and how full its context window is, beside the tool-call count, for example `12 tool calls · ↑12k ↓1.2k · 34% ctx`. The numbers appear once the agent finishes its first model turn.

- **Multi-reviewer execution review.** Right before round 1 (when at least two checks are pending) a menu asks for 1, 2, or 3 parallel execution reviewers; the choice is stored in the run checkpoint (`execution.reviewers`) and reused by later rounds, and a session with no UI keeps one reviewer. The pending checks are split evenly across the reviewers and each one also looks for defects and improvements along its own direction, suggested by the executor through the new optional `plans_review_directions` tool (also given to delegated workers) with three fixed back-up aspects filling any gap. Each reviewer numbers new findings from a disjoint `F-###` range, and the lane reports merge into a single outcome, so a multi-reviewer round is still one budgeted round; a failed reviewer makes only its own checks undeterminable and aborting any reviewer cancels the round. The fleet list shows one bullet per reviewer.

## [0.9.0] - 2026-10-07

### Added

- **Run the plan on a different model.** After you approve the execution handoff, a second question asks where the plan runs: the current session (same model, the previous behavior), one delegated subagent, or several (2-4). Delegated choices open the same model and effort picker the reviewer gate uses (native panels in a TUI, menus on RPC), titled for the executor, and never touch the reviewer role. The question is asked at every handoff with the last choice listed first; it is stored per run in the checkpoint (`execution.executor`, strictly validated, dropped by a stop) so `/resume-plans` and a reload restore the same workers without asking again, and `executor_last` in the global config only seeds the picker. Headless and auto-approved handoffs always use the current session.

- **Workers report live without stopping.** A delegated run is implemented by in-process worker sessions (write tools, `agents/executor.md`) that each receive their own `plans_update_task` tool, closed over the live execution state. A finished task updates the dashboard, the checkpoint, and the worker's `n/m tasks` note immediately and returns at once, so the worker's loop continues with its next task; completion is never inferred from a session ending, and a worker can only close tasks assigned to it. Work is scheduled per wave: tasks that share a file stay on one worker (tasks without declared files share one group), groups are balanced over the workers, a wave starts only after the previous one is fully terminal, and workers keep their session across waves and repair rounds. A worker that ends with tasks still open is re-prompted in the same session; three such rounds, or two failed runs, pause the run with the reason, and `/plans-execute` resumes it. Workers are restored from the checkpoint or the session snapshot after a restart.

- **The main session supervises a delegated run.** It is told the plan is delegated, is never woken to continue the work, and `edit`/`write` are blocked in it until the run ends. A failed review round sends its repair brief to the workers that own the reopened tasks instead of waking the main model, and `/plans-stop` stops the workers. Everything the supervising session is shown says so: the start banner names the delegation instead of asking it to call `plans_update_task`, repair briefs in its transcript are marked as forwarded, and the `/resume-plans` brief makes it a supervisor; after a restart the workers' briefs also list the still-unresolved review findings for their tasks. Each worker's spawn is recorded in `subagents.jsonl` with role `executor`.

- **Reviewer directions are written for your project.** `refine` takes a new `directions` argument — one `{ id, direction }` per reviewer (slug id, 20-800 characters) — and requires it whenever more than one reviewer runs, so the planner model tailors each reviewer's direction to the project and plan (hidden coupling and blast radius, migration and rollback, failure modes, whether the verification checks really prove the claims, unstated assumptions, …) instead of the fixed `correctness` / `ordering` / `verification` lenses, which are gone. Missing, miscounted, duplicate, or out-of-range directions are refused with guidance before any model panel opens and before anything spawns; the direction id becomes the lane id, the bullet label, and the result section title; a resumed round without `directions` reuses the lanes and direction text stored in its checkpoint (rounds recorded with the old lenses still resume), and current-session mode lists the directions in its single brief. The shared workflow gains an authoring guide with project-specific examples.

### Changed

- **Reviewer counts follow the skill.** `plan-normal` now runs two concurrent reviewers (it ran one), `plan-big` and `plan-huge` keep three, and `plan-with-refs` follows its chosen shape (two for `plan-normal`, three for `plan-big` / `plan-huge`); `plan-small` and `debug-and-plan` keep one. Each reviewer's brief now lists the other reviewers' directions, asks it to go deeper on its own rather than pad with generic coverage, and still lets it report a high-severity problem it stumbles on outside its direction. `agents/reviewer.md`, the skills, the workflow reference, and the README say so.

- **Delegated agents are a bulleted list, not three lanes.** Reviewers, reference analysts, the execution reviewer, and workers all appear as bullets above the editor with status, phase, tool-call count, and working time (the clock runs only while an agent is working: time spent queued, or idle between a long-lived worker's assignments, is not counted). With an empty editor `↓` focuses the list, `↑/↓` select, `Enter` opens that one agent's live transcript overlay (scroll, `Tab` to switch agent, `x` twice to stop just that agent), and `Esc` hands focus back; any other key stays with the editor, and the list never reacts while a dialog holds focus. The stacked three-pane overlay is gone, `analyze_refs` no longer runs sequential batches (at most three references run at once and the rest wait as `queued` bullets), once every agent has finished the list collapses to a single summary line (`Subagents (3) · 3 done · ↓ browse subagents`, with failed and cancelled counts) that `↓` expands again, finished agents are dropped from the list after ten minutes, and `Ctrl+Shift+R` opens the newest execution-review overlay directly. The execution review no longer opens an overlay on its own.

- **Delegated roles run as in-process sessions.** Plan reviewers, reference analysts, and the execution reviewer no longer spawn `pi` child processes. Their sessions load no extensions and no skills, use a strict tool allowlist (read-only for reviewers), and are created with the exact `provider/model` and, only when one is stored, an explicit thinking level. Reviewers get a read-only `code_graph` tool when the workspace graph is enabled (the `PI_PLANS_REFINER` gate still holds for externally launched read-only hosts). Reviewers keep their usage metering and `subagents.jsonl` records.

- **The model and effort picker is shared.** The persistence-free `pickModelAndEffort` now backs both the reviewer first-use gate (which still saves to the global reviewer config) and the execution chooser; its titles are parameterized per role.

- **The default effort row says "no explicit level".** With no stored level the delegated session resolves its own default chain; the picker rows, menus, `references/`, and the `plans` tool description no longer talk about a `--thinking` flag or a child pi.

- **README section renamed.** "Visible Refiner overlay" is now "Delegated subagents" (the readme check mandates the new heading), and the reference docs describe the subagent list and the execution placement.

### Fixed

- **Latent `SubagentUsage` type mismatch.** `tools/refine.ts` and `tools/analyze-refs.ts` imported a type `src/subagent.ts` did not export; the type is now exported and carried on `SubagentResult`.

## [Unreleased]

### Fixed

- **The `plan-huge` skill loads on Pi again.** Its `description` held an unquoted `: `, which is invalid YAML, so Pi reported "Nested mappings are not allowed in compact mappings" and skipped the skill (issue #7). The description is now quoted, `npm run validate` rejects unquoted frontmatter values containing `: ` or ` #`, and a test parses every skill and agent definition with Pi's own frontmatter parser.

- **Pre-plan compaction aborted the running turn before every compaction.** Creating a run (`plans start-run`) triggered the pre-plan VCC compaction through the host's manual compaction path, whose first step is `await abort()` — so every compaction was preceded by an aborted assistant message (`This operation was aborted`), sibling tool calls of the same batch died with `Operation aborted`, and the user saw an error they never caused. The compaction now travels as a `turn_end` **compaction boundary draft** (the host appends it and refreshes the finalized context), so nothing is aborted at all. Diagnosed from three real session logs: all 14 compactions were `reason: "manual"`, every one immediately preceded by the aborted-turn record.

- **A compaction could end without continuing the run.** The resume had been attached to the host's `onComplete`/`onError` callbacks with a one-shot latch that closed *before* the send, so a single failed send stranded the session until the user typed something (2 of 12 observed compactions ended with no resume message and no assistant turn). Continuation is no longer needed for the pre-plan path (the turn is never interrupted), and every path that really does displace a live turn now resumes from a terminal compaction event with the latch closing only after a successful send.

- **A manual `/compact` that displaced a live run left it stranded.** A user compaction aborts the in-flight turn and the host never continues it, which parked planning and execution runs mid-flight. pi-plans now resumes the displaced run exactly once when the compaction ends — success or failure — gated by `continueAfterThresholdCompact`, and it lifts the compaction-caused stall pause in the same step so a warning pause and an automatic resume can never coexist.

- **Ctrl+Shift+T dead while an overlay is open.** pi-tui routes key input only to the focused component (no bubbling), so any focused refine/refs/execution-review overlay swallowed every global shortcut — including the dashboard toggle, exactly when users watch the dashboard during the minutes-long review phase. The overlay component now forwards unhandled keys through an `onUnhandledKey` hook, and all three overlay call sites re-dispatch Ctrl+Shift+T to the dashboard toggle. `reopenReviewOverlay` also gained an anti-stacking guard so Ctrl+Shift+R can no longer open a second overlay on a live one.

- **First-use reviewer panel crash after model selection.** The F-008 selector re-validation in `refine` and `analyze_refs` read the first-use outcome's snake_case `model_selector`, but the outcome carries the camelCase `modelSelector` — the undefined value slipped past the `!== null` guard and crashed `findModel` with `Cannot read properties of undefined (reading 'indexOf')` immediately after the user confirmed a model in the native panel. Both call sites now read the typed field (latent since v0.7.0; it only fired on a first-use with an unconfirmed reviewer role).

### Changed

- **Pre-plan compaction is silent about its own skips.** Small sessions, already-compacted sessions, stale requests (the request expires after 30 minutes without reaching its boundary), executions taking over, and `prePlanCompact:false` all drop the request without a user-facing notice; only a successful compaction reports its VCC stats.

- **analyze_refs no longer head-truncates the combined analysis.** The merged per-reference sections used to be cut to 2000 lines / 50 KB with a truncation note; they now flow into the tool result (and REF_ANALYSIS.md) verbatim, so the tail of large reference analyses is no longer silently dropped.

- **`plan-with-refs` picks its plan shape after the references are analyzed.** The skill no longer assumes big-plan depth: once every downloaded reference has an `analyze_refs` analysis and its adoption answers are recorded, it recommends `plan-normal`, `plan-big`, or `plan-huge` from the workload the prompt describes, asks for that shape in one `ask_choice` single-question call (`questionId: refs-plan-shape`, `autoComplete: false`, never counted against the question minimum, ahead of the final scope confirmation), and records the answer in the run's decision ledger and in `REF_ANALYSIS.md`'s `## Plan Shape` section. Depth and reviewers follow the shape: `plan-normal` keeps a single reviewer and that skill's bounded refinement, while `plan-big` and `plan-huge` keep `reviewers: 3`. A huge shape continues in the SAME run - the recorded `skill` stays `plan-with-refs` and no new run starts - by writing `PLAN_overall_vN.md` from `references/huge-plan-artifact-template.md` and recording `record-checkpoint` `overall-plan-written`; all six huge transitions, the deferred gate, and the Evidence lint then apply, the versions reuse the analyzed references instead of re-downloading them (appending one only when a version introduces a new technology or when a key design decision is genuinely contested), and a version plan whose references are all papers, blogs, or docs sites cites those URLs in `## Evidence` and accepts the advisory `huge-refs` notice rather than inventing a GitHub URL. The `planning` router now sends multi-version work that needs external references to `plan-with-refs` first, `plan-huge` gained an entry section for that path, the normative workflow reference documents the branch, and the version-complete message names both entry skills.

### Changed

- **Execution-review loop with overlay visibility (v0.8).** The post-execution completion audit no longer blocks the settle handler for minutes in silence. When every task reaches a terminal state, the run status moves to `verifying` and a detached read-only reviewer round runs in the background (interactive modes); its live tool progress renders in a dedicated overlay (Esc closes it; Ctrl+Shift+R reopens the in-flight round with its accumulated transcript). Headless `print`/`json` modes keep awaiting the round inline so runtime teardown cannot kill it. The loop is bounded at five COMMITTED rounds replacing the three-round cap: discarded fingerprint-mismatch attempts and cancellations burn nothing, undeterminable rounds self-schedule their retry without waking the agent, and two consecutive discards commit as one undeterminable round. Every attempt persists a per-check report under `<run-dir>/execution-review/round-<budgetRound>-attempt-<k>.md`.

- **Round-cap pause is fail-closed and budget-faithful.** Exhaustion pauses the run in EVERY mode (the old headless `stopped` termination is gone) with an in-band `pi-plans-review-paused` message. Ordinary user input and session restores never lift the pause or refill the budget — the only fresh-budget surface is `/plans-execute`, whose explicit confirmation grants five more rounds. Checkpoints paused by older builds stay recognized through a dual-matched legacy prefix.

- **Reviewer-role pinning and round timeout.** A confirmed delegated reviewer role pins the round's model and thinking level (the overlay shows the role label); an unconfirmed or `current-session` role inherits the session default labeled `session default` — a detached round never opens the interactive first-use panel. Rounds carry an explicit minutes-scale timeout instead of the 60-minute subagent default, and a missing reviewer agent definition is now a hard error instead of silently swapping in an inline prompt.

- **Round lifecycle hardening.** Each round owns a session-scoped abort controller (aborted on session shutdown, stop, fresh handoff, and session-tree restores — never the turn-scoped `ctx.signal`), outcomes are guarded by execution identity, and a fingerprint (plan digest + git HEAD + covered-file mtimes) discards rounds whose subject moved underneath them.

- **Terminology: completion auditor -> execution reviewer.** The rename covers `agents/execution-reviewer.md` (loaded with a hard-fail), the reviewer-facing strings in `src/`/`tools/`, the dashboard tree line, README, and the references; the persisted protocol surface (`execution.audit` checkpoint keys, `pi-plans-audit-*` message types, the legacy pause prefix) is deliberately un-renamed for compatibility.

- **Dashboard round-1 mis-cue fixed.** The compact panel rendered `audit complete ✓` for the entire duration of a running audit because the model had no running field and the round counter was pre-incremented. The panel now renders `review: round n/5 running` while a round is in flight and never shows the completion tick while a round runs or checks are still owed.

### Fixed

- **Audit-stall self-healing in the execution loop.** A run whose task tree reached terminal state but whose completion audit never settled left the dashboard stuck at `0/2` and the loop parked forever — the exact failure seen on run `2026-09-30-worktree-test-fix` (VC-002 returned `verdict: fail`, tasks reverted to `0/2`, no repair attempted, no further wake). Two defects combined: `runCompletionAudit` had no bound on how long a reviewer subagent may take to settle, and the watchdog treated "settled but nothing changed" as activity. Fixes: an `agent_before_settle` backstop guarantees the audit cannot hang past its own timeout, and a per-settle latch records whether anything actually changed before the watchdog is consulted. Tests in `tests/exec.test.ts` assert the self-healing path (round increments, checkpoint `phase === "completed"`) and the single-wake path (exactly one wake message).

- **Goal-panel right border misalignment.** In the goal panel's search row the closing `│` was drawn one column off, because the zero-width escape sequence produced by `CURSOR_MARKER` was counted as display width. `src/refine-ui-helpers.ts` now ignores zero-width escape sequences when measuring, so focused and unfocused rows both measure exactly 46 columns. Regression test added in `tests/role-panels.test.ts`.

- **Worktree tests crashed on older git.** `tests/` worktree cases called `git worktree add` against a repository with no commits, which failed with `fatal: not a valid object name: 'HEAD'`. The fixture now seeds an initial commit first.

### Added

- **Full box border for the reviewer first-use gate panel.** The role-selection panel rendered only a right edge, which read as a broken frame. It now uses `BorderedPanel` for a complete box, with `borderColorFrom` selecting the edge color per state.

## [0.7.0] - 2026-09-30

**Breaking changes** (the reviewer role configuration moves wholesale to a global file; old workspace configuration is read tolerantly and migrated automatically):

- **Global ReviewConfig (single global source of truth)**: the reviewer role block (`mode`, `model_selector`, `thinking_level`, `name_prefix`, `confirmed_at`) moves to `~/.pi/pi-plans/config.json` (the `PI_PLANS_GLOBAL_DIR` environment variable can override the directory; tests, CI, and benches rely on it), so one confirmation applies to every repository. The workspace `.git/pi-plans/config.json` no longer stores reviewer keys: legacy blocks are read tolerantly — the first mutating call seeds a block that "carries user intent" (confirmed, an explicit selector, or a non-default mode) into the global file (first writer wins, every other repository gets a one-time "ignored" notice; a confirmed-inherit block degrades to unconfirmed and is re-asked on the next refine), while pure scaffolding blocks are discarded silently and stripped on the next write; read-only paths (`gate`/`show`) resolve the effective reviewer in memory (`global ?? legacy`) and never write to disk; a malformed or schema-invalid global file falls back to defaults with a notice and is never overwritten; `set-role` writes only the global file, never triggers an auto git-init, and opportunistically strips legacy workspace keys.
- **First use now opens native panels (the TUI gate pops directly)**: `refine`/`analyze_refs` in delegated mode with no confirmation yet open a `/model`-style searchable model panel directly (reusing pi's exported `ModelSelectorComponent`; the ModelRuntime main path is a four-method adapter over the public `modelRegistry` — `getAvailable`/`find`/`getError`/`refresh` — with the private `.runtime` cast demoted to a secondary path and a menu fallback when construction throws) → then a `/thinking`-style effort panel (a thin bespoke variant: `DynamicBorder` + `SelectList` + `Input` + filtering, with a `Default` sentinel on the first row and the remaining levels drawn from the selected model's `thinkingLevelMap`, reusing pi-ai's `getSupportedThinkingLevels`). Only when both panels complete does the tool persist `model + thinkingLevel + confirmed` in one write, and the current call continues immediately with the returned values. Esc in either panel cancels the whole gate: nothing is persisted, the model selection is void, and a standalone error is returned (`details.cancelled` semantics: no `ask_choice` re-ask, no automatic retry, pointing at `/config-pi-plans`); cheap validation (`planPath`, refs) runs before the panels. When `hasUI` is false in a non-TUI host (RPC/ACP) it falls back to the native `ctx.ui.select` menu (model list → level list, sharing the fallback menu); with no UI at all it keeps the `ask_choice` text stream (the copy embeds a list of usable selectors and the exact `set-role` arguments, so automation can pre-write the global file).
- **The `inherit` option is removed**: after confirmation `model_selector` must be a concrete `provider/model`. `reviewerReady(role)` passes immediately in current-session mode and otherwise requires `confirmed` plus a concrete selector (`confirmed-inherit` is no longer expressible: `set-role confirmed:true` without a concrete selector is rejected outright; `modelSelector: "inherit"` resets both the selector and `confirmed_at`). A new `thinkingLevel` parameter accepts `off|minimal|low|medium|high|xhigh|max`, or `default` for `null`; `null` (Default) means not passing `--thinking` at all (the child pi resolves its own default chain: per-model settings → `defaultThinkingLevel` → medium, then clamps per model — semantically different from an explicit `off`); changing model without a level resets the level. Subagent spawn pins a concrete `--model` plus a conditional `--thinking`; overlay/ledger labels read `provider/model:level`; `subagents.jsonl` gains a `thinking_level` field; a pre-spawn `registry.find` validation turns a missing entry into reopening the TUI panel (or an exact selector error in non-TUI mode).
- **The confirmation gate applies to delegated-subagent only** (decision 10): current-session mode needs no model confirmation and passes the gate directly. `analyze_refs` no longer inspects mode (Q-4=B: it is inherently spawn-only, so current-session still spawns a lane and gets a one-time "mode ignored" notice, while model confirmation proceeds as before); the "switch to delegated" recovery copy is removed.
- **`/config-pi-plans` wizard synchronized**: the reviewer step becomes an entry menu with "keep current (provider/model · level)" / "change" (Q-3=A); current-session skips the whole step without clearing an existing selector; the change flow reuses the same native panels in TUI mode and a menu in non-TUI mode (including `Other` with manual validation); Esc keeps the current value and continues the wizard (no longer discarding every earlier answer); a mode switch or model change writes the global file immediately, and a failed global write reports explicitly and explains that the workspace part is still written; the summarize step shows the global reviewer (`mode` / `model · level`).
- **Bench/test isolation**: `scripts/run-tests.ts` injects a one-shot `mkdtemp` as the default value of `PI_PLANS_GLOBAL_DIR`; the affected tests (`state`/`analyze-refs`/`refine-resume`/`config-command`) all switch to global isolation with updated semantics; the bench adapter seeds the global file (concrete provider/model, `thinking_level` null, no criticizer key); `scripts/validate.ts` guards now point at `src/global-state.ts` and the effort-substring ban is removed.
- **Documentation**: `references/state-and-config.md` (global file, migration, panels, Default semantics, `PI_PLANS_GLOBAL_DIR` sections; the old "intentionally no effort" decision section is removed), the first-use section of `references/pi-planning-workflow.md`, the tool table and state locations in `README.md`, and `skills/debug-and-plan/SKILL.md` are synchronized; the note that the completion auditor is not bound by the reviewer role is filed.

## [0.6.1] - 2026-09-30

**Breaking changes** (released as 0.6.1 at the user's request within the 0.x line; every item below is an incompatible change — read the migration notes before upgrading):

- **The plan format simplifies to two sections**: the body of `PLAN_vN.md` collapses to a metadata header plus `## Tasks` plus `## Verification Checks`. Task ids are `Task-1, Task-2, …` (one level of subtasks, `Task-3.1`), with inline structured fields `— deps: Task-1, Task-2; files: src/a.ts, src/b.ts; wave: 2` (fields separated by `;`, multi-values by `,`, tolerating full-width and half-width punctuation). A `### Execution Waves` subsection inside `## Tasks` explicitly gives the file-modification order in which multi-agent runs may proceed in parallel (wave → task set; file sets within a wave are disjoint, `deps` point to earlier waves, and conflicts resolve in favour of the subsection with a lint notice). VC rows become `VC-### covers Task-N` (multiple targets and `Task-N.M` supported). **Compatible reading**: when there is no `## Tasks`, parsing falls back to `## Implementation Items` (`I-001` → `Task-1`; artifacts with only a checklist synthesize one serial task per VC), and the execution handoff prompts for an upgrade when it detects fallback parsing; `lintPlanIntoNotices` gains task-tree consistency linting (consecutive numbering, reachable deps, disjoint files within a wave, existing `covers` targets, subtask depth ≤1).
- **Reviewer and Criticizer merge into a single Reviewer**: a reviewer round now emits both findings (`F-###`, with severity/evidence/impact/fix/disposition) and at most 5 questions awaiting your ruling (`Q-1..Q-5`), and the tool contract requires the main agent to ask every question with `ask_choice` before revising and to record the answers. The `refine` tool drops its `role` parameter and `target="implementation"`; `agents/criticizer.md` is deleted; the `criticizer` key in config.json is ignored on read with a one-time migration hint (the next config write persists the single-reviewer shape); the `/config-pi-plans` wizard, `plans set-role`, the refine overlay, and `scripts/validate.ts` assertions all narrow accordingly (the `ref-analyst` record label is kept). The skill documents refine the default sequence: plan-big runs 3 concurrent Reviewers for a single round (including questions), while plan-normal/plan-small run 1 Reviewer round.
- **The execution phase is rewritten as task-tree driven (standalone)**: progress is now reported through the new `plans_update_task` tool (`taskId` + `status: complete|skipped` + `evidence`/`skipReason`; statuses are immutable once closed, and rollback is performed only by the execution core inside the completion-audit flow and accounted through the checkpoint's `audit` field — the task tool itself has no rollback path), replacing `[DONE:VC-xxx]`/`[I-###]` text-marker scanning. The new task dashboard is a compact above-editor widget (current task ▸, progress bar, ✓/· counts, VC pass count, wave indicator, paused state, audit-failure rows) plus a `Ctrl+Shift+T` expanded tree view (the whole task tree with ✓/▸/~/· markers, the current task anchored, the VC list with audit status, adapting to narrow and wide widths), replacing the old fixed seven-row panel. Each turn injects the "current wave + remaining tasks + VC summary". Once every task is terminal, an **independent completion-audit subagent** verifies each VC: a failing VC (fail-closed, including checks the audit report never covered) rolls its `covers` tasks (with subtask cascade and skipped-reopen) back to pending and injects the audit report; the audit round cap is 3, and exceeding it pauses for you (under auto-approve/headless it fails within bounds and marks the run stopped rather than hanging); a VC whose covers set contains a skipped task while the rest are complete counts as skipped-pass; a VC with no `covers` does not participate in the audit (lint notice). A stall watchdog replaces the old goal-wait: three consecutive settled rounds with no task-status change pause automatically and prompt.
- **The old execution machinery is removed**: `[DONE:VC]` marker scanning, the goal-wait wait/wake lexicon, the delegated executor (runtime questioning from the delegated executor, `agents/executor.md`, the `executor_timeout_minutes` enforcement path), and the post-execution amelioration (implementation-review) loop (`termination-prompt.ts`, workflow-state phase writes, the `trailing: auto-refine-loop` entry of `ask_choice`, and the loop-resume path of `/resume-plans`). After an audit passes, `applyExecutionCompleted` goes straight to the `completed` terminal state. **In-flight 0.6.0 runs stay compatible**: a delegate orphan is refused a direct resume and must re-pass the handoff approval gate (C-006); a paused goal-wait clears its paused state on resume and rebuilds from the task tree; the impl-review phase maps to execution completion (run marked done, historical acceptance conclusions retained); an in-flight 0.6.0 checkpoint with no mapped task progress (`tasks` missing) rebuilds tasks as pending while verified VCs are kept as evidence (approximate re-run semantics); the checkpoint's `reverifyAll` is redefined as "invalidate task statuses and re-run", and `originWorktree` is still preserved. The execution-time vocabulary compresses and becomes task-tree shaped (`Current task:`/`Plan tasks:`/`Remaining verification checks:`).
- **Other**: the README feature table and the corresponding CONTRIBUTING section, `references/plan-artifact-template.md` (the spec and examples for the new two-section format), `references/pi-planning-workflow.md`, `references/state-and-config.md` (the single-Reviewer protocol), and all 6 skill documents are rewritten in step; the full test suite (node:test) and the `scripts/validate.ts` consistency checks pass.

**Fixes**:

- **Stale-ctx crash after a session swap** (`execute_plan`/`/plans-execute` and friends reporting "This extension ctx is stale…" after newSession/fork/switchSession or a reload; the session swap that follows compaction of a long session falls in this class too): every `ExtensionAPI`/ctx captured at registration time is eliminated repo-wide (the old module-level `currentApi` in `tools/execute-plan.ts`, the module-level `api` in `src/autocomplete.ts`, the run-start appender closure in `tools/plans.ts`, the command closures in index.ts), as are all `pi: ExtensionAPI` parameters (about 15 sites, now uniformly receiving each call's `ExtensionContext`). SDK audit conclusion: `appendEntry`/`sendMessage`/`sendUserMessage` exist only on the `pi` handed to the factory, and the per-call ctx has none of the three; a session swap means the old session `dispose()` (invalidate + unsubscribe) plus a brand-new runner **re-running every factory**. Hence the new module-level messaging surface `src/messaging.ts`, refreshed by the extension factory's first line `setMessagingApi(pi)` on every load/rebuild — after a swap the new session automatically gets the new messaging surface (the "automatic re-registration" is naturally satisfied by the factories re-running); the narrow race window between the swap and the new factories finishing throws the stale error, and a retry recovers (`tests/stale-ctx.test.ts` pins all three paths plus the race-window behavior).

### Fixed

- **Execution goal-panel layout**: the title line becomes `┌─ π-plans: <plan name> ───┐`, with the `π-plans` brand in the accent color (same family as the input box) and the plan name and remaining border in muted gray; the counts move to their own line and read `Tasks 3/10 · Verification checks 1/6 · 00:04:12 ███░░░░░░░░` (`tasks`→`Tasks`, `VC`→`Verification checks` spelled out), with elapsed time followed by the progress bar on the same line. When width is insufficient they are dropped in the order **progress bar → elapsed time**, and the counts never degrade to abbreviations; `renderDashboardLines` / `renderDashboardTreeLines` take an optional `theme` parameter and color themselves (previously `exec.ts` wrapped the whole line in muted, and the embedded accent was wiped by the `[39m` reset), emitting the palette as **sibling** balanced spans rather than nested ones. `formatElapsed` moves into `src/dashboard.ts` and is exported (`exec.ts` imports it, removing the duplicate implementation).

- **The state directory and default plan-artifact path become `.git/pi-plans`**: `STATE_DIRNAME` changes from `pi_plans` to `pi-plans` (`src/state.ts`), and the default artifact root moves from `./docs/pi-plans` to `./.git/pi-plans/plans` — plans and state now share the git directory, private by default, untracked, and not propagated by a clone; to make plans public and committed alongside the repository, set `artifact_root` to `./docs/pi-plans` (the preferred question in `references/state-and-config.md`, the option order of the `/config-pi-plans` wizard, `README.md`, all 6 skill documents, and the `plans` tool schema description all switch to the new default). **Old directories are not migrated**: existing `.git/pi_plans/` directories (ImageGen-Studio, Novel-Studio, pi-plans, Deliberate) are left alone, and the new default only affects future use. 112 occurrences across 44 files in code / skills / references / README / tests change `pi_plans` → `pi-plans`; the bench identifiers in `scripts/bench/` (the `pi_plans_bench` module, the `pi_plans_driver` / `pi_plans_subagent_usage` metadata) are not state directories and stay unchanged, only the `.git/pi_plans` path literals inside them follow the move. **Two real defects fixed in passing by the artifact root moving inward**: (1) the write guard previously marked the whole `stateRoot` writable, so with the artifact root moved inward it also opened up **other runs'** plan directories — it now explicitly rejects other runs' `artifact_dir` (wherever the artifact root is written), restoring the "an unbound session cannot modify another plan" protection; (2) the artifact root resolved naively against the workdir with `path.resolve`, but a linked worktree's `<workdir>/.git` is a `gitdir:` pointer **file** — the new `resolveArtifactRoot` always resolves a `.git/` prefix as the git **common dir**, so the default artifact root correctly lands in the shared state directory across worktrees (consistent with D-007's "shared locations are no longer moved" semantics). Tests: `tests/state.test.ts` gains `.git/`-prefix resolution and linked-worktree default-root landing cases; two cross-worktree migration cases in `tests/resume.test.ts` explicitly pin the per-worktree artifact root (they only ever targeted roots inside the worktree, and should stay put under the default root); the 6 skill / references path assertions in `scripts/validate.ts` follow the move.

- **A dashboard line-width regression crashed entire TUI sessions** (`Rendered line 157 exceeds terminal width (231 > 230)`, 2026-09-30, pi 0.99.1): compact panel rows in `src/dashboard.ts` were built as `content.padEnd(width).slice(0, width) + border` — truncating to exactly `width` UTF-16 units and then appending one right border — so **every row was `width + 1` columns wide**; and the width math counted UTF-16 units via `.length`/`slice`/`padEnd`, where a CJK character occupies one unit but two columns, so Chinese plan titles overflowed by far more than one column. The host widget renderer throws an uncaughtException on any over-wide line, terminating the session outright (measured 230 columns → 231, matching the crash record; the three 113 → 114 crashes in `~/.pi/agent/crashes.json` share the same cause). Regression cause: when 0.6.1 replaced the old fixed panel `src/panel.ts` with `src/dashboard.ts`, it lost the per-column clipping the old implementation did through `visibleWidth`/`truncateToWidth` in `src/refine-ui-helpers.ts`; the expanded tree view (`Ctrl+Shift+T`) previously clipped nothing at all. Fix: all dashboard width math now goes through the repo's existing per-column `visibleWidth`/`truncateToWidth` (zero dependencies, grapheme- and ANSI-aware), plus a new `boxRow` (left border + per-column-clipped body + padding + right border = exactly `width` columns) and a `clampLines` backstop; the header subtracts the progress-bar budget before clipping the title, so the bar is no longer squeezed out under long topics; every expanded-tree row is clamped to `width`. Tests: `tests/dashboard.test.ts` gains a `width invariant (TUI crash regression)` group that **measures with the host pi-tui `visibleWidth` rather than a local reimplementation**, asserting across 22 widths (including degenerate 1/2/3) × 4 states (running / paused / all-terminal / audit-failed) that neither the compact nor the expanded view exceeds the width, that compact rows measure exactly `width`, and that every glyph the dashboard uses measures identically under the local helper and the host — so any silent drift toward "local smaller than host" is caught here rather than in a user's terminal.
- **Multiple runs coexisting in one workdir (the core v0.6.0 evolution)**: the shared single-pointer `active.json` is abolished (concurrent sessions raced with last-writer-wins, and cross-worktree races were possible) in favor of a **filesystem-derived run registry**: `listRuns` scans `runs/<run-id>/run.json` (descending by `updated_at`, ties within the same second broken by the run.json's nanosecond mtime, corrupt directories skipped without throwing), with no new shared mutable file; fallback resolution for an unbound session is the newest non-terminal run (null when all are terminal, so writes are no longer blocked by mistake). `start-run` no longer writes a pointer and is safe in parallel; runs sharing a date and topic get an automatic artifact-directory suffix to avoid collisions; `/plans-abandon`, `/plans-execute`, and `/resume-plans` become **binding-first plus a descriptive choice form when there is more than one candidate** (the ★ recommended item on top, showing topic · status · skill · time), with the single-candidate path identical to 0.5.7; `/resume-plans` no longer lets the active pointer win automatically; `/plans` now lists every run (newest first, marking session binding, capped at 50) with an `active.json` deprecation hint; the execution status bar still shows the newest run's done/abandoned outcome and any surviving impl-review loop once all tasks are terminal; the old `active.json` is read only as a one-time migration fallback when the `runs/` scan comes back empty.
- **Optional model switch for execution (delegated executor)**: after execution approval a runtime choice appears — ① use the current session (recommended, identical to 0.5.7) ② switch to another model (lists ≥3 `provider/model` targets: session-visible models plus the model registry, deduplicated and excluding the current one; falls back to free-form `Other` input when short). After switching, a **single executor subagent** runs the whole plan: native write tools (read/write/edit/bash/grep/find/ls, pinned to the SDK ToolName union), `--model` to pick the model, and `PI_PLANS_EXECUTOR=1` + `PI_PLANS_RUN_ID` to pin the run; the parent session blocks and live-streams progress through an Executor overlay, mirroring `[DONE:VC-xxx]`/`[I-###]` markers parsed from the subagent's **full message stream** into the checkpoint and status bar; Esc (with tool-signal passthrough) or `/plans-stop` terminates the subagent and marks the run stopped (resumable — already-verified VCs are not re-asked); the timeout is configurable (`executor_timeout_minutes` in config.json, default 60, 0 = default). After the subagent exits, the parent validates the remainder — all items complete takes the normal completion flow, a remainder keeps the run executing and resumable; orphan delegates after a crash restart are detected and surfaced. Safety isolation: write guards and graph-aware write tools are bypassed for `PI_PLANS_EXECUTOR=1` (native writes, not intercepted by another session's planning run, no DB-first staging), and `ask_choice` refuses to run inside the executor subprocess (autonomous decisions); auto-approve / no-UI skips the questions (current session plus an `[auto-approve]` record), and the decision is written to decisions.jsonl. The `execute_plan` tool and the `/plans-execute` command path are unified (with multiple runs, pick the run first, then the runtime).
- **Every AI-authored ask question item states its advantage and drawback**: every option authored by the AI for `ask_choice` (including the final scope confirmation, the merged accept/execute handoff, and implementation-review configuration questions) must state `✓ <advantage> / ✗ <drawback>` inside the existing `description` string — **written in the workspace's configured language (`language.tag`)**, with each half kept to ~8 words. You can therefore compare options side by side on "what you gain / what you pay" instead of reading labels alone. The convention lives in the schema description of `Option.description` (`tools/ask-choice.ts`), the tool `description`, a new third `promptGuidelines` entry, and the `options` array descriptions of both the single-question and batch shapes, and is synchronized across `references/pi-planning-workflow.md` (the options clause, the handoff, and the impl-review section), all 6 `skills/*/SKILL.md` files, and the README feature table. The fixed tail entries the tool appends automatically (`Other…` / `Auto-complete` / `Auto-refine loop`) are out of scope. **No UI, no schema, no state change**: both rendering paths already output `1. <label> — ${description}` (`tools/ask-choice.ts:479`, `:766`, `src/ask-form.ts:273`), and the `decisions.jsonl` format is unchanged; the cost is that longer descriptions push single-question panels into `fitAskChoicePanel`'s "strip descriptions" degradation tier sooner (an existing graceful degradation, not a defect), hence the terse-wording requirement.
- **Optional reference retrieval for plan-normal / plan-big**: the web-research rule in both skills is expanded — after the repository investigation you may optionally retrieve 1–2 named references (papers, engineering blogs, or other repositories) and cite URLs in the plan's Evidence section; explicitly optional, not counted against the question budget, and requiring no download or analysis (that is plan-with-refs' job).
- **plan-with-refs references are no longer GitHub-only**: papers (arXiv and friends), engineering blogs, and documentation sites become first-class references, and **theoretical references count as much as implementation references**; qualifying downloads are defined per medium (repository = clone; paper = full text (HTML preferred, PDF text extracted; an abstract alone does not qualify); blog/documentation site = the whole readable markdown; one directory per reference, and `analyze_refs` accepts only directories); an explicit diversity rule is added: ≥3 qualifying references from ≥2 distinct sources; the `kind` values in `refs.jsonl` are agreed to be `project | paper | article | docs`; the ref-analyst prompt and the `buildRefAnalystTask` brief are generalized to match (read deeply per medium; evidence = code file:line / paper section · theorem · table number with a short quote / blog heading with quotation; the seven-section structure is unchanged).

### Changed

- `agents/executor.md` is new (the delegated executor's system prompt: autonomous whole-plan implementation, per-message markers, structured closing summary); the normative documents `references/state-and-config.md` (directory layout, registry semantics, deprecation notes, run-id pinning) and `references/pi-planning-workflow.md` (runtime choice, any-medium references, optional reference retrieval) are updated in step; `collectModelSelectors`/`modelSelectorOf` are exported from config-command and reused.
- Tests: new `tests/multi-run.test.ts` (registry ordering and fault tolerance, readActive fallback, empty resolution in terminal states, unique directories for parallel start-run, `PI_PLANS_RUN_ID` pinning, guard executor bypass, picker candidates and labels, subagent env markers, marker mirroring) and `tests/ask-choice-pros-cons.test.ts` (contract wording × 8: Option / tool description / promptGuidelines / batch and single-question options arrays, the 6 skills, normative document clauses, **empirical `formRender` rendering**, schema regression); two picking assertions in `tests/resume.test.ts` are updated for v0.6.0's binding-first semantics (multiple candidates no longer auto-win). `validateSkill()` in `scripts/validate.ts` additionally requires the word `drawback`, statically backstopping all 6 skills at pack time. The full suite of **549 tests passes** (526 existing + 15 multi-run + 8 pros/cons).

## [0.5.7] - 2026-09-24

### Changed

- **UI chrome follows the workspace language** (issue #3, thanks @Griznah): batch forms, status panels, and other interface copy previously hardcoded Simplified Chinese, ignoring the `plans set-language` configuration — injecting Chinese into English workspaces, and doing so even when `language.tag` was unset. All user-visible chrome is now driven by the bilingual tables in `src/ui-language.ts`:
  - **New `src/ui-language.ts`**: `UiLanguage` + `uiLanguageFromTag` (BCP47 primary-language subtag fallback per RFC 4647: `zh-Hant-CN` → `zh-Hant` → `zh`; anything non-string or unset becomes `en`) + `resolveUiLanguage(workdir)` (falls back to `en` on no git root, missing config, corrupt JSON, or a type error; never throws) + four chrome tables (`formChrome` / `refineChrome` / `panelChrome` / `execChrome`);
  - **Batch form**: 10 strings switch with the language — the custom-answer row, the submit chip, tab suffixes, and the footers and titles of the options/edit/submit pages, plus the `(unanswered)` placeholder (`createFormState` / `runQuestionForm` gain an optional `lang`, defaulting to `en`; `tools/ask-choice.ts` resolves the config just before the form opens);
  - **refine / refs overlay footers**: 4 strings including `Esc close` switch with the language; refine reuses the already-loaded config while analyze_refs resolves it at its construction site (both construction sites are consolidated);
  - **Status panel and execution status line**: the 3 panel warnings including `⚠ I parsed 0 items`, and the goal-wait status line, switch with the language; the panel render and status-bar signatures are unchanged (the language is carried by `PanelModel`/`ExecState`, resolved at construction time, introducing no per-frame disk reads), and a successful `plans set-language` redraws immediately (`refreshUiLanguage`); a cross-session resume re-resolves at resume time rather than depending on a snapshot field;
  - **Behavior change**: when `language.tag` is unset or unreadable, this chrome switches from Chinese to **English** (consistent with the rest of the extension's UI; for the historical `interface` behavior set `plans set-language --tag zh-Hans` explicitly);
  - **Known residue**: the lint diagnostic text in `src/plan.ts` (agent-facing, surfaced through notices) is still Chinese and was outside the localization scope;
  - 40+ new/updated tests (tag mapping and the four fallback paths, verbatim coverage of the four chrome tables, en-has-no-CJK assertions across the form's three pages × narrow/wide, both overlay construction sites with fake-TUI capture, panel/exec bilingualism and set-language refresh), with the full suite of 526 tests green.

### Fixed

- **npm package size fixed: 209MB → 1.8MB**: tarballs for published versions 0.4.1–0.5.5 had ballooned to **209MB / 6330+ entries** (0.1.0–0.3.3 were a normal 0.19–1.00MB). Root cause: `package.json`'s `files` contained the directory entry `"scripts/"`, which npm expands recursively, while **a root-level `.gitignore`/`.npmignore` has no effect inside directories explicitly listed in `files`** (npm's documented semantics) — so the local, gitignored benchmark harness (`scripts/bench/vendor/`, harbor, ~570MB on disk) and the benchmark artifacts (`scripts/bench/results/`) shipped with the package (vendor was 99.1% of it, including 126MB of harness-bundled results; harbor's own `.venv` at 300MB escaped only by luck because harbor ships its own subdirectory `.gitignore`). Fix:
  - `files` gains the negative patterns `!scripts/bench/vendor` and `!scripts/bench/results` (a controlled experiment confirmed both `!` negative patterns and subdirectory ignores work, while a root-level ignore does not); measured **6343 → 136 entries, unpacked 209.38MB → 1.77MB, packed 86.09MB → 0.70MB**;
  - **New package-size guard** (`scripts/validate.ts`, active automatically with `prepack` and CI): statically asserts that `files` contains the two negative patterns; dynamically runs `npm pack --dry-run --json --ignore-scripts` (`--ignore-scripts` is mandatory, otherwise the inner pack re-enters `prepack` recursively) and asserts unpacked < 5MiB, packed < 3MiB, no `scripts/bench/vendor|results` entries, and the presence of the key entries (index.ts / skills / agents / references / tools / src / scripts);
  - Note: all three published versions 0.4.1, 0.5.1, and 0.5.5 carry this defect (209MB each), and already-published registry tarballs cannot be retroactively modified; code-size parity is restored from 0.5.7 onward.

## [0.5.6] - 2026-09-23

### Fixed

- **Every key was dead in the batch form on kitty / application-cursor terminals** (issue #2, thanks @Griznah): `formHandleKey` matched legacy CSI sequences with bare string comparison, but pi-tui hands raw stdin straight to the focused component — once the kitty keyboard protocol is negotiated every key becomes CSI-u (Enter=`\x1b[13u`, Tab=`\x1b[9u`, Esc=`\x1b[27u`, arrows=`\x1b[57417..57420u`), so bare comparisons all miss and the form is 100% inoperable; under application-cursor (SS3 `\x1bOA`…) the arrow keys are dead too. Everything now migrates to key normalization:
  - New shared `src/terminal-keys.ts`: delegates to `parseKey` / `matchesKey` / `decodeKittyPrintable` when pi-tui can parse, and falls back locally otherwise (legacy + SS3 + kitty CSI-u + modifiers, aligned item-by-item with pi-tui semantics: modifier naming order, shifted letter identity, function-codepoint equivalence table, printable filtering);
  - `formHandleKey` now matches keys through normalization; the editing branch supports kitty text (including CJK/Shift) and kitty Backspace, inserts nothing for non-text sequences (arrows, ctrl combinations), passes raw non-kitty UTF-8 (IME) straight through, and decodes every CSI-u sequence within a chunk;
  - `refine-ui.ts` migrates in step (the production path already went through `matchesKey`; the fallback key table gains kitty forms, and the old "any CSI counts as Esc" defect is fixed); `refine-ui-helpers.matchesEscape` is removed accordingly;
  - Also fixes an off-by-one in the wrap formula: UP from the first row / DOWN from the last row computed the illegal row `total` (Enter became a silent no-op), now replaced with explicit clamping wraparound (the `-1` unselected slot participates in the loop);
  - 17 new tests (terminal-keys loaded/fallback parity tables against pi-tui, chunk decoding, complete kitty/SS3 key tables, the editing branch, all four wrap boundaries, both refine-ui sides), with the full suite of 506 tests green.

## [0.5.5] - 2026-09-20

### Fixed

- **Crash on startup in a non-git directory**: starting pi in a non-git worktree (such as `~/Documents`) made the `PathError` thrown by `session_start` → `restartWatcherIfEnabled` → `resolveCanonicalWorktree` surface as an unhandled rejection that pi judged to be an extension bind failure, making pi-plans completely unusable in non-git directories (skills/ask_choice/plans all dead). The same exposure: `session_shutdown` → `stopGraphWatcher`, `/disable-graph` → `disableWatcher`. All three entry points now degrade silently and uniformly (`tryResolveLifecyclePaths`: catches only `PathError` → a no-op in normal operation, other exceptions still throw; a non-git directory has no `.git/pi_plans` to begin with, so markers/locks/watchers were never in play). The fail-loud semantics of `paths.ts` and its command-line paths are unchanged.

## [0.5.4] - 2026-09-20

### Added

- **Parallel reviewers for implementation-review**: every round previously used exactly 1 reviewer — the capability layer's `refine` `reviewers` (1-3) already treated both targets alike, but all guidance text (tool description, the completion-resume prompt, workflow docs) tied the 3-way parallelism exclusively to big-plan PLAN review, so agents entering the loop never passed the parameter. The whole chain is now consolidated:
  - **Default follows the skill**: plan-big / plan-with-refs → 3, everything else → 1 (`defaultImplReviewers`, controlling subagent cost);
  - **Per-run tunable**: a reviewer-count question is appended after the termination-condition question (`questionId` `impl-review-reviewer-count`, plain numeric labels 1/2/3 with a ★ recommended slot, `allowOther: false`), and the two answers are merged into a single `record-checkpoint` persistence (`ImplementationReviewState.reviewerCount`, integer validated to 1-3);
  - **Tool fallback (D-4)**: when `refine` omits `reviewers` on an implementation round it automatically reads the checkpoint value — after a restart or worktree migration 2/3 does not silently fall back to 1 (`applyMigration` preserves the field);
  - **Crash-window recovery (D-5)**: in the window after both answers are in decisions.jsonl but before the merged write, `/resume-plans` rebuilds the answered part from the ledger and only asks for the missing question (`resolveImplReviewConfig` is a pure function, latest-entry-wins);
  - **In-loop panel box (D-3)**: during the loop (run done + checkpoint phase=implementation-review) the widget stays alive and renders a compact box (round number + reviewer count or config pending + the termination condition), mirrored from the same source in the status line (D-015); after completion it unregisters and falls back to `(done)`; the checkpoint is read live at render time and refreshed at the end of each round so it is never stale (D-8);
  - **Unified dual-lane merge contract (D-7)**: the source-reviewer annotation in `refine`'s result text changes from `count === 3` to `count > 1`, so 2 lanes keep their source attribution and the ≤5 high-priority cap alike;
  - 21 new tests (termination-prompt mapping and options, workflow-state validation/migration/replay guards, plans schema and passthrough, refine fallback/override/count=2 wording, three panel in-loop states plus narrow widths, loop widget lifecycle, the `ask_choice` trailing two questions, three-state resume), with the full suite of 485 tests green.

## [0.5.3] - 2026-09-19

### Fixed

- **The batch form silently lost its recommended option (fail-open validation gap)**: a malformed batch `ask_choice` call (the first option's label/description serialized up to the question level and the `recommended` key lost — RCA with the original toolCall evidence in PROBLEM_ANALYSIS E2) previously passed silently and rendered a "form missing its first option". The tool entry point is now doubly guarded:
  - `additionalProperties: false` on all three schema objects `Option` / `BatchQuestionParams` / `AskChoiceParams` — any stray key at any level fails loudly at the TypeBox check so the model resends;
  - every batch question requires at least one `recommended: true` (the D-4 at-least-one contract, not pinning position), with self-diagnosing error text ("did the first option's label/description get hoisted to the question level?");
  - validation runs before any decisions/checkpoint recording and before the auto-approve short-circuit (the D-7 no-side-effect assertion is nailed down);
  - 10 new negative/positive cases in `tests/ask-choice-schema.test.ts` (replaying the real E2 incident), with the full suite of 464 tests green.

All notable changes to **pi-plans** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.5.2] - 2026-09-18

### Fixed

- **Deduplicated the legend on the execution panel's last two rows**: the boxFooter built into 0.4.0 collided semantically with its own `markers:` content row (with no content-level assertion watching it), so each of the three I-state markers displayed twice. Marker syntax is now taught solely by the execution injection hint (the existing `exec.ts` text, zero loss), and the bottom border reverts to pure `╰───╯` decoration (aligned with the narrow-mode branch).
- **`restoreFromSession` now rebinds the run identity**: after restoring an execution snapshot `executionRunId` stayed null until the next `startExecution` — so the panel's activity row could not resolve run.json. The restore path now rebinds through `resolveActiveRun` + `bindRun` (the wiring gap CQ1 pointed out).

### Changed

- **Row 6 becomes the activity row**: the `markers:` legend row is replaced by `<status> · since MM-DD HH:mm` (e.g. `executing · since 09-18 15:02`), derived from `RunInfo.status` + `updated_at`. Honest semantics: `updated_at` is the state-change time (execution turns write only the checkpoint, not run.json), hence the label `since` rather than "last activity"; when the run record is missing it falls back to the bare phase word and never prints `undefined`. New `formatActivityTime` (empty/invalid ISO → `--`).
- `PanelModel.activity` is a required string (fallback consolidated inside `derivePanelModel`); tests gain content-level assertions (three activity-row states, no `▸`/`[I-` on the last row, no `markers:` anywhere in the panel) to keep the legend from creeping back.

## [0.5.1] - 2026-09-18

### Fixed

- **The execution panel no longer shows a fake "I 0/0"** (counts always come from real parsed state). `parseImplItems` now accepts top-level `I-00N` items with a half-width colon, full-width colon, or plain-space separator (indented child bullets and `- [ ] VC-…` checklist lines never match); a new `lintImplItems` returns a warning when the Implementation Items section exists but parses to zero items.
- **Durable plan-lint notices.** `RunInfo.notices` persists in `run.json` (legacy files without the field read as `[]`; `appendRunNotice` dedupes by source+text). The lint runs at three entries — `plans record-checkpoint` (plan-written), the execute handoff, and the automatic plan-written path after a plan write.
- **Panel format-warning line.** When the lint hits, the I-count row is replaced by an explicit `⚠ plan format: Implementation Items parsed 0 items` line (the 7-line envelope and narrow 3-line badge are preserved); the warning is derived on the live handoff path and persisted in the exec snapshot, and both restore paths (checkpoint and session) re-parse + re-lint from the plan file so a stale empty snapshot self-heals instead of freezing the fake count.
- **The batch question form no longer shows fake-answered chips.** `FormState.confirmed` separates the cursor from the answer: chips read `□` until the user presses Enter (or commits a custom answer), moving the cursor un-confirms the tab, Esc mid-edit keeps prior answers, the submit page labels unconfirmed rows `(unanswered)` and blocks submit, and `formAnswers` returns confirmed-only answers — a pre-positioned recommended option is never auto-submitted.
- **Uniform-gray frame borders.** The exec widget now themes only the span between the `│` borders (new `themePanelLines`; borders and box chrome stay muted gray on every line, in both wide and narrow modes) and the question form's `─` borders are muted; every rendered line asserts SGR open/close parity so no border inherits a dangling line color.

## [0.5.0] - 2026-09-17

### Added

- **Trust: read-time validation and self-healing.** Every graph read (digest, get-function, screening) validates the owning file against disk first — a stat fast path (v3 `files.last_size/last_mtime`), a full-hash fallback, and direct serving of the disk buffer already read. Genuinely stale files return the fresh disk text with a `[graph: stale — fell back to disk read; reindexed]` marker and synchronously rebuild that one file (single-flight; read-only refiner sessions validate but never rebuild). Files with staged DB-first edits (the intentional "DB ahead" state) instead serve the staged text with a pending marker — no fallback, no rebuild, and staged edits are never destroyed.
- **Cross-file call/import edges with confidence labels.** The v1 regex resolver (everything unresolved) is replaced by a two-phase extractor: a module graph over DB snapshots + in-batch overrides (exports, imports per language), then per-function resolution — same-file calls are `EXTRACTED`, cross-file bindings are `INFERRED`, ambiguous imports stay `ambiguous`, and unresolvable heads on external modules plus JS/Python builtins are dropped as noise (unresolved dangling edges drop from 22,291 to ~4,300 on this repo). Import edges resolve relative specifiers with extension probing (`EXTRACTED`) and barrel probing (`INFERRED`). Edge data lives in the existing `call_edges` table (schema v3 adds `confidence`; the `function_records` view and screening filters are updated, and old DBs migrate in place).
- **Graph query actions.** `code_graph` gains `query` (keywords → node match → BFS/DFS expansion under a chars/4 token budget, deterministic expansion order), `path A B` (shortest call path, exactly two selectors), `explain <fn>` (location, community, in/out degrees, typed neighbor lists), and `impact <fn>` (reverse call closure with affected files). All are pure algorithms over resolved edges by default (`includeUnresolved` opts in), each answering in <100ms at this repo's scale.
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

- **No more duplicated `(recommended)` markers in the batch form.** Agents sometimes authored option labels that already ended with `(recommended)`; the renderer then appended its own marker and the option displayed the tag twice. Labels are now normalized (`stripRecommendedMarker`) wherever they render — form options, the submit page, transcript `renderCall`, and both sequential-select fallbacks — and the recommended indicator is a single colored `★` instead of a `(recommended)` text suffix. `formAnswers` strips the marker from recommended answers so the returned label stays clean; the tool schema now tells agents never to embed the marker in labels.
- **Themed batch form.** `formRender` accepts an optional theme (the host already injects the pi Theme into the custom-dialog factory; it was previously ignored). With it, the question tab renders a themed frame: accent top/bottom borders, a tabs row whose active chip gets the `selectedBg` background (■ answered / □ pending, ✓ Submit dims until every question is answered), the question line in accent, selected options in accent with `→ `, unselected in text, `★` in success color, and dim key hints. The submit page uses an accent bold header with warning/success status, the editing page an accent header. The F-001 rows-budget degradation is preserved and extends to the new frame: descriptions strip first, then blank separators, then the borders (the selectedBg chips row survives), then the question text; options are only capped behind a `… +N more` indicator as a last resort and the footer always survives. All lines stay width-safe under real ANSI styling (visibleWidth skips escape sequences).

## [0.4.0] - 2026-09-17

### Added

- **Batch multiple-choice question form.** `ask_choice` now accepts `questions: [...]` (2-8 items): instead of asking one question at a time, the tool opens ONE tabbed multiple-choice form in the terminal — one tab per question with all options visible in the first frame, the recommended option preselected, a "✏️ Custom answer…" row per tab that switches into a Focusable single-line input (CURSOR_MARKER + hardware cursor, so zh-Hans IME composition works), and a final submit page listing every Q/A. Phased questioning stays agent-driven: submit a batch, think about the answers, follow up in later calls. Esc returns the answered subset as partial answers (recorded with a batch-level cancelled row; the `disableAutoComplete` side effect matches the single-question cancel). Answers are recorded per question in decisions.jsonl (questionId passthrough for cross-session dedupe) and in the checkpoint via the new `pendingQuestions` batch field, so `/resume-plans` replays only unanswered questions. Gates: auto-approve and auto-complete short-circuit the whole batch with recommended options; print/json auto-completes every question; RPC hosts without `ctx.ui.custom` degrade to one sequential `ctx.ui.select` per question. Safety red line: batches reject `autoComplete: false` items and the reserved scope/handoff question ids — the final scope confirmation and execution handoff are always single-question calls. The tool description and prompt guidelines teach the batch protocol, and all six planning skills (planning, plan-small, plan-normal, plan-big, plan-with-refs, debug-and-plan) instruct batched rounds (≤8 per call) with follow-up phases.
- **Fixed execution status panel.** While a plan executes, a fixed `╭─ pi-plans ─ <run topic> ──╮` tasks panel renders above the editor (7 rows at ≥30 columns, a 3-row badge below): phase and goal-wait counters, remaining implementation items with a progress bar, the current implementation item (marker-backed or inferred, inference never persisted), a Next action line, and VC progress. The panel, the bottom status-bar summary line, and the execution injection text all derive from one pure model (`src/panel.ts`) — what the panel shows is exactly what the agent is told. Rendering is a width-aware component (`render(width)` reads the live width and theme; every line is truncated to width including CJK, so resizes never wrap rows) with a fixed row count so the terminal buffer height never changes (no scrollback churn, no timers). The panel registers on execution start/approve, refreshes from marker updates and turn ends through the existing `updateStatusWidget` call sites (including `restoreFromSession` rebuilds), and unregisters on completion, stop, or abort with the status summary cleared.

## [0.3.3] - 2026-09-08

### Added

- **Pre-plan compaction.** When `plans start-run` creates a new planning run, the extension now proactively requests one VCC compaction (internal hint `pi-plans planning pre-plan compact`) from the `plans` `tool_result` hook — after the run lands, before the first planning question — so every new plan starts on a lean context (LLM reasoning degrades with longer input; Chroma "Context Rot" 2025, Liu et al. "Lost in the Middle" TACL 2024). Pi's manual compaction never continues the interrupted turn, so the hook resumes planning with exactly one hidden `pi-plans-preplan-resume` message on both success and failure, filtered out of the model context payload; stats notifications reuse the existing VCC reporter. Small sessions ("nothing to compact" / "already compacted"), aborts, and older Pi builds without the extension compact action skip silently with an info notice and still resume. The trigger respects the run-status planning gate and is disabled while an execution is active. New repo-private config key `prePlanCompact` (default `true`) in `.git/pi_plans/pi-vcc-config.json`; set it to `false` to restore the old behavior.
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
