# Pi Planning Workflow

This reference is shared by the `pi-plans` skills. It is a planning workflow only. Implementation after acceptance runs in the extension-managed execution loop.

## Required Pi Context

This skill set is written for the Pi coding agent's documented behavior:

- the five skills are contributed by the pi-plans extension and loaded as Pi skills (also invokable as `/skill:<name>`);
- skill references and helper sources are resolved relative to the directory containing `SKILL.md`;
- Planning and reference analysis run with the extension tools `plans`, `ask_choice`, `refine`, `analyze_refs`, and `execute_plan`;
- `refine` spawns read-only Pi subagents (`pi --mode json -p --no-session --tools read,grep,find,ls`, plus `code_graph` when workspace `graph_enabled` is true) with isolated context; delegated reviewer runs show a standalone aggregate overlay titled `Reviewer` (78% × 78% top-center, ≥72 cols, no input row), stream assistant/thinking/tool events into per-lane transcripts with follow-bottom scroll, dismiss on `Esc` (close-only — the refiner child keeps running and its result still flows back as tool output), replace any retained finished overlay when a new round begins, and return conclusions to the main session as tool output; `analyze_refs` spawns one read-only subagent per downloaded reference (cwd = that ref's directory) reusing the reviewer role gates, shows the same overlay titled `Refs` in batches of at most 3 lanes, and returns structured per-reference sections for `REF_ANALYSIS.md`;
- when graph mode is enabled, graph-aware `read`/`edit` overrides are active for indexed source files: `read` returns a capped function digest (≤50 lines, synthetic anonymous entries folded) by default — drill in via `offset/limit` or `code_graph get-function`, and `full: true` is the only whole-file exit (small/zero-function files return full text; safety truncation matches native read); `write`/`edit` stage DB-first mutations until materialized via the `code_graph` tool's `apply` action (same planning/accepted gate as /apply-graph; refused for read-only refiner subagents via the PI_PLANS_REFINER marker; returns a per-file report with counts and a post-apply drift summary, and never changes run status); unexpected fallbacks (`not indexed` / `runtime unavailable` / `config read failed`) are marked at the top of the result while flag-off fallbacks stay unmarked;
- the execution loop is extension-managed and task-tree driven: the current wave and remaining tasks are injected each turn, progress is reported exclusively through the `plans_update_task` tool (status + evidence / skipReason), the task dashboard tracks every task (compact widget; Ctrl+Shift+T expands the tree), and an independent execution reviewer verifies the verification checks before the run completes;
- execution and planning compaction keep Pi's SessionManager as the history owner; during active pi-plans runs, `session_before_compact` uses a deterministic no-LLM VCC-style summary with `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, `[User Preferences]`, and a ranked brief transcript; Pi core owns manual `/compact`, threshold, and overflow scheduling, while pi-plans handles smart tail keep, `keep:N`, stats, and phase-specific run/plan/current-I/checklist context; in addition, creating a new planning run (`plans start-run`) proactively requests one pre-plan VCC compaction before the first planning question and resumes the planning turn with a hidden message (default on, `prePlanCompact` in `pi-vcc-config.json`);

## Planning Boundary

- Treat the user's request as a planning target, not as write authorization.
- Before the execution handoff, do not edit target source files, docs, configs, package metadata, generated assets, or tests outside the planning artifact directory and the pi-plans state under `.git/pi-plans/`. The extension enforces this for `edit` and `write` while a run is active: only `.git/pi-plans/`, the run's artifact directory, `~/.cache/pi-plans/`, and the configured refs root are writable. Bash is not machine-guarded — keep it read-only by discipline (inspection, `git init`, downloads into the cache).
- The normal pre-handoff writes are `.git/pi-plans/` state plus planning artifacts under the configured artifact root (default `./.git/pi-plans/plans/...`).
- Downloaded references go to the workspace's configured refs root (`refs_root` in `.git/pi-plans/config.json`; unset → ask once via `ask_choice`, recommended `.git/pi-plans/refs/`, second `./refs/`, third `~/.cache/pi-plans/refs/`; persist with the `plans` tool, `set-refs-root`) and their paths and evidence are recorded in `REF_ANALYSIS.md`. References are not limited to GitHub repositories: papers (arXiv etc.), engineering blogs, and documentation sites are first-class, with per-medium qualified downloads (repo = clone; paper = full text — abstracts never qualify; blog/docs = full-article markdown) and one directory per reference; theoretical references count exactly as much as implementation references. plan-normal and plan-big may optionally cite 1–2 search-found references (URLs in the plan's Evidence section) without downloading them.
- After the user explicitly approves the execution handoff, leave this planning workflow and execute in the extension-managed loop (see Execution Handoff).

## State And Settings

Before the first planning question, read `references/state-and-config.md` and initialize the target workspace state with the `plans` tool:

```json
{ "action": "init", "workdir": "<target-workdir>" }
```

State lives under the workspace's resolved git common dir as `.git/pi-plans/` (auto-ignored, no `.gitignore` entries; the tool auto-runs `git init` when the workdir safely has no repository). The target workspace is the current working directory unless the user explicitly names another repository.

If `language.tag` is missing from `.git/pi-plans/config.json`, ask the language setting question (via `ask_choice`) before any product question. Persist it with `plans` (`set-language`); this question does not count against the planning-question limit.

If `artifact_root_source` is missing from `.git/pi-plans/config.json` or is `unset`, ask the planning docs location question (via `ask_choice`) before any product question. Persist it with `plans` (`set-artifact-root`); this question does not count against the planning-question limit.

The reviewer role lives in the GLOBAL config (`~/.pi/pi-plans/config.json`, `PI_PLANS_GLOBAL_DIR` override — one confirmation for every workspace). If its mode is missing/invalid when a round is about to run, ask the role-setting question via `ask_choice` and persist with `plans` (`set-role`). The model + thinking level are confirmed at first use through NATIVE panels, not ask_choice: in TUI the `refine` gate itself pops a searchable model panel followed by an effort panel (Default row = no `--thinking` flag; other rows follow the chosen model's `thinkingLevelMap`) and continues the same invocation on completion; hasUI non-TUI sessions get native menus; UI-less sessions get text guidance embedding the available selectors. Esc cancels the whole gate (nothing persisted; do NOT re-ask via ask_choice — suggest `/config-pi-plans`). The `refine` tool refuses to spawn until `reviewerReady` passes (current-session, or delegated with a confirmed concrete `provider/model`). (v0.6.1: the criticizer role is gone — the reviewer emits findings AND questions in one round.)

## First-Turn Contract

1. Inspect the target Git repository read-only before asking product questions. Prefer `rg`/`grep` when available, then focused file reads, `git status`, `git log`, existing tests, and user-provided logs.
2. If a question can be answered from the repo, answer it from evidence instead of asking the user.
3. After required language and planning-docs-location setup, the first user-facing planning response must be one `ask_choice` question, not a completed plan or implementation.
4. Ask one question per message. Do not batch multiple decisions into one prompt.

## Evidence Ladder

Resolve unknowns in this order:

1. Codebase evidence.
2. Cited web or reference evidence.
3. User choice.

When the recommended option depends on a web-verifiable claim, search first (websearch skill when installed; otherwise `curl`, `gh`, or other bash tools already available) and cite the source in the eventual plan. Do not present a recommendation backed only by an unchecked assumption.

## Choice Prompt Format

Every user-facing planning or refinement question goes through the `ask_choice` tool:

- `options`: ordered options, recommended option first with `recommended: true` (exactly one), each with a `description` of the form `✓ <advantage> / ✗ <drawback>` — **every option you author states both what it gains and what it costs**, in the configured language, tersely (≈8 words per half; write `—` when a side is genuinely absent). Both halves live in the single `description` string; there are no separate `pros`/`cons` fields. This rule covers every AI-written option, including the scope confirmation and the merged accept/execute handoff; only the tool-appended `Other…` / `Auto-complete` rows are exempt;
- do not add `Other` or `Auto-complete` yourself — the tool appends `Other…` second-last and `Auto-complete` last;
- pass `autoComplete: false` for the merged accept/execute question — it contains the execution approval, so Auto-complete never appears there — and for any install waiver, publishing, deployment, merge, push, credential, or external-state question. Auto-complete may choose the recommended planning or refinement option only.
- When the user selects Auto-complete, it remains active for the current planning run: later eligible questions use their recommended options automatically, and the extension queues one deduplicated follow-up if the model stops after an auto-completed answer. `/plans-autocomplete-stop` disables it; session restore may reactivate it only for the same active run while its status is `planning`.

Answers are recorded automatically in the active run's `decisions.jsonl`. You must still maintain `DECISIONS.md` in the artifact directory (summary table of questions, options, answers, answer sources, open assumptions).

## Required Artifact Directory

Create a run only after initial read-only inspection makes the topic clear:

```json
{ "action": "start-run", "workdir": "<target-workdir>", "topic": "<short topic>", "skill": "<skill-name>", "requestText": "<original request>" }
```

The tool creates the configured artifact directory root (default `./.git/pi-plans/plans/YYYY-MM-DD-<topic>/`) and the private run state `.git/pi-plans/runs/<run-id>/`, and stores the active run pointer. Use a short lowercase slug for the topic. Keep paths stable once written.

`DECISIONS.md` records: original request; repository evidence inspected; each question, options, selected answer, and whether it came from the user or Auto-complete; assumptions still open; external sources consulted; language and reviewer settings used.

## Final Scope Confirmation

Before writing `PLAN_v1.md`, ask the mandatory final scope confirmation via `ask_choice` (it does not count against the skill's planning-question limit):

1. `No more requirements` — the scope is ready for `PLAN_v1.md` (recommended).
2. `Add more requirements` — capture additional constraints before drafting.
3. `Other`.
4. `Auto-complete`.

If the user adds requirements, resolve only the necessary follow-up questions, then repeat the final scope confirmation.

## Plan Artifact Requirements

Every `PLAN_vN.md` must include stable IDs that are never recycled across revisions: `Task-N` tasks (with deps/files/wave and one subtask level), `VC-###` verification checks, and the revision ledger. Everything else the workflow needs lives in the run state (decisions ledger, review rounds, refs), not in the plan file.

Every plan version's body is exactly two sections — `## Tasks` and `## Verification Checks` — plus the metadata header (see `references/plan-artifact-template.md` for the full microsyntax: `Task-N` ids, one subtask level, inline `deps:`/`files:`/`wave:` fields, the `### Execution Waves` subsection, and lint rules). Each verification check is a Markdown checkbox of the exact shape:

```markdown
- [ ] `VC-001` covers `Task-1`; pass condition: ...; evidence: ...; metric: <threshold or reason not quantified>.
```

The execution loop parses `- [ ] \`VC-###\`` checks and the task tree, so keep IDs on the checkbox line and the task grammar exact; task progress flows through `plans_update_task` and the execution reviewer reads these checks. Use `references/plan-artifact-template.md` when drafting.

## Refinement

After each plan version, ask one merged accept/execute question via `ask_choice` with `autoComplete: false` — it contains the execution approval, so Auto-complete never appears. Each of the three options below carries the usual `✓ <advantage> / ✗ <drawback>` description (executing now versus deferring versus another refine round are real trade-offs — say what each wins and costs). Options:

1. `✓ Accept PLAN_vN and execute it now` — mark the plan accepted (`plans set-status accepted`), then call the `execute_plan` tool.
2. `Accept PLAN_vN, don't execute yet` — mark accepted; resume later via `/plans-execute`.
3. `Run another round: <the level's default next refine mode>` — only while the level's default sequence is unfinished.

The recommended option follows the skill level's default sequence: while the default round is unfinished it is option 3 (`plan-small` / `plan-normal`: one reviewer round; `plan-big` / `plan-with-refs`: three concurrent reviewers via `refine` with `reviewers: 3`); once the default round is complete it is option 1. Every round returns findings (`F-###`) and up to five questions (`Q-1..Q-5`) in the same output.

If the user selects another round, run the `refine` tool with the plan path and any focus. Reviewer output consolidates into `PLAN_vN_reviewer_comments.md` with findings IDs, severity, affected plan IDs, evidence, impact, recommended fix, and disposition. Revise the next plan only for findings accepted on evidence.

### Concurrent Reviewers (big plans)

A big-plan reviewer round runs three independent reviewer subagents (`reviewers: 3`); each gets its own emphasis lens but forms its own priorities. After they return, merge and dedupe their findings into one consolidated `PLAN_vN_reviewer_comments.md`, keeping each finding's source reviewer, severity, evidence, and disposition, and surface at most five high-priority comments to the user. Treat agreement between independent reviewers as stronger evidence, not as authority; every accepted finding still needs repo or reference evidence.

### Reviewer Questions

Merge the rounds' `Questions` sections into one deduped list and ask EVERY question with `ask_choice` (one batched `questions: [...]` form or one call per question, in the configured language, stable questionIds). Do not revise the plan until every reviewer question has a recorded answer.

### Round Lifecycle

A refinement round is complete when all reviewer lanes have returned; each lane's output carries findings (`F-###`) and up to five questions (`Q-1..Q-5`). In the same turn: consolidate, accept or reject each finding on evidence (the user may override any disposition), revise to `PLAN_v(N+1).md` when accepted items require it (copy, edit only the new version, update the revision ledger and verifier checklist), then immediately ask the next merged accept/execute question. Never end a turn merely because a round completed.

## Execution Handoff

When the user picks `✓ Accept PLAN_vN and execute it now` in the merged question, mark the plan accepted and call the `execute_plan` tool (or the user runs `/plans-execute`). It re-confirms with the user (never auto-completed), then the extension enters task-tree execution mode:

- every agent turn is injected with the current wave's open tasks, the remaining task list, verification-check summary, and execution rules (wave order, `plans_update_task` reporting with status + evidence / skipReason, subprocess polling backoff 5s -> 10s -> 20s -> 40s -> 80s then keep polling at 80s, no stopgaps, dependency and library discipline, minimum tests);
- task progress flows exclusively through the `plans_update_task` tool: one call per task closing it as `complete` (with evidence) or `skipped` (with skipReason); closed statuses are immutable outside the audit-authorized rollback channel; subtasks close before their parent;
- the task dashboard tracks the whole tree live: a compact aboveEditor widget (current task ▸, progress bar, ✓/· counts, VC pass count, wave indicator, pause state, audit-outcome line, unresolved-findings line visible in both the repairing and verifying phases) and the Ctrl+Shift+T expanded tree view (✓/▸/~/·/↺ markers, current-task anchor, VC list with audit state, width-adaptive layout). `↺` marks a task that was completed and then rolled back by a failed audit: it is open again but still shows the evidence from its previous attempt;
- a stall watchdog pauses execution after three consecutive settled rounds without any task-status change (genuine user input or `/plans-execute` resumes without losing progress). A round in which the agent ran successful tool calls counts as progress even with no status change, so investigating the codebase is never mistaken for a dead agent;
- when every task reaches a terminal state, the run status moves to `verifying` and an independent read-only execution reviewer (`agents/execution-reviewer.md`) verifies each check against the worktree in a detached round whose progress renders in a dedicated overlay (Esc closes it; Ctrl+Shift+R reopens the in-flight round). Each check gets one of three verdicts:
  - `pass` — the evidence establishes the check's condition;
  - `fail` — the condition is demonstrably not met; the covered tasks roll back to pending (children cascade, skipped tasks reopen, the `evidence` of the previous attempt is retained while `skipReason` is cleared) and the audit report is injected;
  - `undeterminable` — the reviewer could not reach a conclusion. This is never a failure and never a completion: nothing rolls back, the loop self-schedules the retry (no agent wake), and each retry counts toward the five-round budget. An all-undeterminable round that also reports a high-severity finding still wakes the executor — a finding is actionable independent of verdict evidence;
  - `F-###` findings — every round also reports severity-graded implementation findings (`high | medium | low`) over the whole implemented change, not just what the checks cover. Ids are stable: the brief lists the previous round's unresolved findings and the reviewer reuses their ids verbatim while the problem persists; absence from the newest round's report is the resolution signal. A `high` finding (or a `fail` verdict) opens ONE union fix round: mapped tasks roll back to pending exactly like a failed check's coverage (children cascade, evidence retained), and a `high` whose `tasks: none` names no owner gets a plan task appended mechanically from the reviewer's `proposed-task` title — the reviewer itself stays read-only. The executor is woken exactly once with a findings summary plus the round-report path. A pure finding-driven rollback deliberately keeps earlier VC passes (the findings channel re-examines the repaired work next round); only a `fail`-driven rollback invalidates the checks covering the reopened tasks. Unresolved findings persist across checkpoint restores, session restores, and fresh budget grants.

  The run completes only when every pending check is affirmatively `pass` AND the newest round reports no high-severity finding; residual `medium`/`low` findings are summarized in the completion message and stay recorded in the round reports. A partial round credits the checks that passed and leaves the rest for the next round. Checks whose covered tasks are all skipped pass as skipped-pass; checks covering no task never enter the audit; checks already satisfied in an earlier round are neither re-briefed nor re-judged;
- the round budget is five COMMITTED rounds (pass, fail, or undeterminable; discarded fingerprint-mismatch attempts and cancellations burn nothing; two consecutive discards commit as one undeterminable round). Exhaustion pauses the run in EVERY mode — interactive and auto-approve/headless alike — with an in-band `pi-plans-review-paused` message; ordinary user input and session restores never lift the pause or refill the budget. The only fresh-budget surface is `/plans-execute`, whose explicit confirmation grants five more rounds. The watchdog counter is rebased by real tool activity;
- execution-phase compaction is handled only when Pi core emits manual `/compact`, threshold, or overflow events; summaries are deterministic VCC-style summaries, include session-derived plan/current-task/checklist context, use smart tail keep and `keep:N`, and never call a model;
- the read-only guard lifts: full write access returns;
- the run status moves to `executing`, then `verifying` while the review loop owns the run, then `done` when every check passes (a failed round rolls its tasks back and returns the run to `executing` for repair);
- `/plans-stop` stops execution; `/plans` shows progress.

If the user declines, stay in planning (or stop, per their choice). Never start implementation without the approved handoff.

### Continuation Between Turns

In TUI/RPC, automatic continuation is evaluated only at `agent_settled`, after
Pi has finished natural tool continuation, retries, and compaction. The
extension rechecks that the same execution is active with open tasks, the
session is idle, and neither pending input nor compaction owns continuation.
Each eligible settled cycle can send at most one hidden custom message with
the current execution rules. Tool `turn_end` events only update usage; they
never prequeue continuation reminders. The stall watchdog counts settled
cycles without task-state change (threshold 3) and pauses instead of waking;
user interruption and final model errors pause too. Genuine interactive/RPC
user input or `/plans-execute` resumes a paused active execution without
losing task progress; extension input cannot unpause it. New-plan handoffs
and the `execute_plan` tool still require explicit approval. Print/JSON
single-shot sessions keep task tracking and completion but never auto-wake;
use RPC for persistent headless execution.

`refine` records each round and lane outcome durably (successful outputs are persisted to run-state files before the tool result returns) and accepts `resumeRoundId` to resume an interrupted round lane-by-lane: completed lanes are reused from their persisted outputs and never re-run; a round id is never reused across plan versions.

## Resuming (`/resume-plans`)

After a restart or in a fresh session, `/resume-plans` (interactive only) restores the repository's working plan in the current session: the unfinished active run wins; otherwise a unique candidate resumes directly and multiple candidates get a chooser. It resumes unfinished planning (re-asks the pending question with the same `questionId`, never re-asks answered decisions), reviewing (resumes interrupted rounds via `refine resumeRoundId`, consolidates completed ones), and execution (durable approval: unchanged plan digest keeps the authorization — a changed HEAD re-opens previously closed tasks for re-verification; an unverifiable approval HEAD behaves the same; legacy runs without checkpoints must re-approve; v0.6.0 delegated-executor orphans require a fresh handoff approval; a legacy `implementation-review` phase maps to done — its historical acceptance stands). Linked worktrees share candidates; cross-worktree resumes confirm, copy artifacts without overwriting, reset approval and VC validity, and restart round counts. Record semantic boundaries with `plans record-checkpoint` (`plan-written`, `review-consolidated`, `completed` with evidence).

`refine` reviews the plan text (the v0.6.0 `target: "implementation"` post-execution loop is gone; the independent execution reviewer now gates delivery).

## Red Flags

Stop and return to the workflow if any of these happen:

- implementing before the approved execution handoff;
- running `refine` without first asking the merged accept/execute question, or before the role gates pass;
- ending a turn after a completed refinement round without asking the next merged accept/execute question;
- storing planning settings outside the target workspace's `.git/pi-plans/` state directory;
- asking multiple planning questions in one message, or asking them outside `ask_choice`;
- writing `PLAN_v1.md` before final scope confirmation;
- accepting vague answers that contradict repo or reference evidence;
- treating a reviewer as authority instead of evidence;
- offering Auto-complete for execution, install, deploy, merge, push, or destructive cleanup approval.
