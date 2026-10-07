# Pi Planning Workflow

This reference is shared by the `pi-plans` skills. It is a planning workflow only. Implementation after acceptance runs in the extension-managed execution loop.

## Required Pi Context

This skill set is written for the Pi coding agent's documented behavior:

- the seven skills are contributed by the pi-plans extension and loaded as Pi skills (also invokable as `/skill:<name>`);
- skill references and helper sources are resolved relative to the directory containing `SKILL.md`;
- Planning and reference analysis run with the extension tools `plans`, `ask_choice`, `refine`, `analyze_refs`, and `execute_plan`;
- `refine` runs read-only delegated reviewers as in-process agent sessions (tools `read,grep,find,ls`, plus a read-only `code_graph` when workspace `graph_enabled` is true) with isolated context; in TUI every delegated agent is a bullet in a subagent list above the editor — with an empty editor `↓` focuses the list, `↑/↓` pick an agent, `Enter` opens that one agent's live transcript overlay (78% × 78% top-center, ≥72 cols, no input row, follow-bottom scroll), `Esc` closes the overlay or hands focus back (close-only — the session keeps running and its result still flows back as tool output); finished agents stay listed until the next round replaces them (or ten minutes pass), and conclusions return to the main session as tool output; `analyze_refs` runs one read-only session per downloaded reference (cwd = that ref's directory) reusing the reviewer role gates, at most 3 at once with the rest queued in the same list, and returns structured per-reference sections for `REF_ANALYSIS.md`;
- when graph mode is enabled, graph-aware `read`/`edit` overrides are active for indexed source files: `read` returns a capped function digest (≤50 lines, synthetic anonymous entries folded) by default — drill in via `offset/limit` or `code_graph get-function`, and `full: true` is the only whole-file exit (small/zero-function files return full text; safety truncation matches native read); `write`/`edit` stage DB-first mutations until materialized via the `code_graph` tool's `apply` action (same planning/accepted gate as /apply-graph; refused for read-only refiner subagents via the PI_PLANS_REFINER marker; returns a per-file report with counts and a post-apply drift summary, and never changes run status); unexpected fallbacks (`not indexed` / `runtime unavailable` / `config read failed`) are marked at the top of the result while flag-off fallbacks stay unmarked;
- the execution loop is extension-managed and task-tree driven: the current wave and remaining tasks are injected each turn, progress is reported exclusively through the `plans_update_task` tool (status + evidence / skipReason), the task dashboard tracks every task (compact widget; Ctrl+Shift+T expands the tree), and an independent execution reviewer verifies the verification checks before the run completes;
- execution and planning compaction keep Pi's SessionManager as the history owner; during active pi-plans runs, `session_before_compact` uses a deterministic no-LLM VCC-style summary with `[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Outstanding Context]`, `[User Preferences]`, and a ranked brief transcript; Pi core owns manual `/compact`, threshold, and overflow scheduling, while pi-plans handles smart tail keep, `keep:N`, stats, and phase-specific run/plan/current-I/checklist context; in addition, creating a new planning run (`plans start-run`) applies one pre-plan VCC compaction on that turn's `turn_end` boundary as a host compaction draft (no abort of the running turn, no aborted-turn error, no resume message) so the new plan continues on a lean context (default on, `prePlanCompact` in `pi-vcc-config.json`); a manual `/compact` that displaces a live planning or execution turn is resumed exactly once by pi-plans when the compaction ends (success or failure, gated by `continueAfterThresholdCompact`);

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

The reviewer role lives in the GLOBAL config (`~/.pi/pi-plans/config.json`, `PI_PLANS_GLOBAL_DIR` override — one confirmation for every workspace). If its mode is missing/invalid when a round is about to run, ask the role-setting question via `ask_choice` and persist with `plans` (`set-role`). The model + thinking level are confirmed at first use through NATIVE panels, not ask_choice: in TUI the `refine` gate itself pops a searchable model panel followed by an effort panel (Default row = no explicit level; other rows follow the chosen model's `thinkingLevelMap`) and continues the same invocation on completion; hasUI non-TUI sessions get native menus; UI-less sessions get text guidance embedding the available selectors. Esc cancels the whole gate (nothing persisted; do NOT re-ask via ask_choice — suggest `/config-pi-plans`). The `refine` tool refuses to spawn until `reviewerReady` passes (current-session, or delegated with a confirmed concrete `provider/model`). (v0.6.1: the criticizer role is gone — the reviewer emits findings AND questions in one round.)

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

The recommended option follows the skill level's default sequence: while the default round is unfinished it is option 3 (`plan-small` / `plan-normal`: one reviewer round; `plan-big` / `plan-huge`: three concurrent reviewers via `refine` with `reviewers: 3`; `plan-with-refs`: three concurrent reviewers, or one when its plan shape is `plan-normal`); once the default round is complete it is option 1. Every round returns findings (`F-###`) and up to five questions (`Q-1..Q-5`) in the same output.

If the user selects another round, run the `refine` tool with the plan path and any focus. Reviewer output consolidates into `PLAN_vN_reviewer_comments.md` with findings IDs, severity, affected plan IDs, evidence, impact, recommended fix, and disposition. Revise the next plan only for findings accepted on evidence.

### Concurrent Reviewers (big plans)

A big-plan reviewer round runs three independent reviewer subagents (`reviewers: 3`); each gets its own emphasis lens but forms its own priorities. After they return, merge and dedupe their findings into one consolidated `PLAN_vN_reviewer_comments.md`, keeping each finding's source reviewer, severity, evidence, and disposition, and surface at most five high-priority comments to the user. Treat agreement between independent reviewers as stronger evidence, not as authority; every accepted finding still needs repo or reference evidence.

### Reviewer Questions

Merge the rounds' `Questions` sections into one deduped list and ask EVERY question with `ask_choice` (one batched `questions: [...]` form or one call per question, in the configured language, stable questionIds). Do not revise the plan until every reviewer question has a recorded answer.

### Round Lifecycle

A refinement round is complete when every reviewer has returned; each lane's output carries findings (`F-###`) and up to five questions (`Q-1..Q-5`). In the same turn: consolidate, accept or reject each finding on evidence (the user may override any disposition), revise to `PLAN_v(N+1).md` when accepted items require it (copy, edit only the new version, update the revision ledger and verifier checklist), then immediately ask the next merged accept/execute question. Never end a turn merely because a round completed.

## plan-with-refs (Plan Shape Branch)

`plan-with-refs` fixes the plan's shape only after every downloaded reference has an `analyze_refs`
analysis and its adoption answers recorded, and before the run's first plan file is written. The
agent recommends the shape — `plan-normal`, `plan-big`, or `plan-huge` — and asks for it as one
`ask_choice` single-question call with `questionId: refs-plan-shape` and `autoComplete: false`; the
recorded answer lands in the run's decision ledger and in the `## Plan Shape` section of
`REF_ANALYSIS.md`. That routing question never counts against a skill's question minimum, it comes
before the final scope confirmation, and the final scope confirmation stays its own single-question
call. Recommend `plan-huge` when the prompt asks for multiple product versions planned, executed,
and reviewed one at a time (2–10 strictly ascending versions) or when the workload clearly exceeds
a single `plan-big` plan; default to `plan-big` when the shape is genuinely ambiguous; choose
`plan-normal` when the analyzed references shrink the work to a broad but bounded change (the ≥3
qualifying references and ≥3 adoption questions per reference still apply).

Depth and reviewers follow the chosen shape: `plan-normal` keeps that skill's single reviewer and
bounded refinement, while `plan-big` and `plan-huge` keep at least ten questions and `refine` with
`reviewers: 3`. A `plan-huge` shape continues in the SAME run — the run's recorded `skill` stays
`plan-with-refs` and no new run is started — by writing `PLAN_overall_vN.md` and recording `plans`
`record-checkpoint` transition `overall-plan-written`, after which the whole plan-huge stage order
applies (all six transitions, the deferred gate, the Evidence lint). The versions reuse the
analyzed references recorded in `REF_ANALYSIS.md` instead of downloading them again, and append a
new reference only when a version introduces a new technology or when a key design decision is
genuinely contested. A version plan whose references are all papers, blogs, or documentation sites
cites those analyzed URLs in `## Evidence` and accepts the advisory `huge-refs` run notice rather
than inventing a GitHub URL.

## plan-huge (Multi-Version Builds)

`plan-huge` extends the single-plan workflow with a version loop inside ONE run
and ONE flat artifact directory (`.git/pi-plans/plans/<date-topic>/`).

**Stage order.** (1) Overall planning writes `PLAN_overall_v1.md` from at least
ten `ask_choice` questions, using `references/huge-plan-artifact-template.md`
(version table, architecture, file map, user experience, final objective; never
`## Tasks` or `## Verification Checks`). (2) One `refine` round of three
concurrent reviewers by default; the user may extend rounds at the merged
accept/execute question. (3) Accepting the overall plan starts the first
version's planning round — never execution. (4) Version planning writes
`PLAN_vX.Y.Z_v1.md` (5–10 questions) with the `plan-big` task grammar plus the
huge-only sections `## Deferred to vX.Y.Z` and `## Evidence`, then the same
reviewer treatment. (5) The merged accept/execute question, the `execute_plan`
tool, `plans_update_task` progress, and the independent execution reviewer run
exactly as in `plan-big`. (6) When a version completes, the run returns to
planning for the next row of the version table; only the last version makes the
run terminal.

**Names and rounds.** `PLAN_overall_vN.md` is the overall stream;
`PLAN_vX.Y.Z_vN.md` is a version stream. The trailing `vN` is the revision
round of that stream. The legacy `PLAN_vN.md` name keeps its old meaning and
belongs to ordinary runs — never write it into a huge artifact directory. The
overall plan may be revised in a controlled way as `PLAN_overall_v(N+1).md`
with the reason and the affected versions; only not-started versions may
change, and the current version keeps its identity from the run checkpoint.

**Transitions.** Each stage boundary is a `plans` `record-checkpoint` call:
`overall-plan-written` (validates the version table; a controlled revision
also carries its reason and affected versions), `overall-review-consolidated`,
`overall-accepted`, `version-plan-written` (deferred gate + reference lint +
this version's round), `version-review-consolidated`, and `version-completed`
(only for closing a version outside the ordinary completion path). An agent
that records only the overall plan silently disables the deferred gate, the
reference lint, and the per-version round — and with it the `vX.Y.Z round N`
resume display.

**State machine.** The checkpoint carries a `huge` section (version table
snapshot, current index, per-version rounds and statuses, per-version
completion archives, deferred ledger, inherited review budget). Existing
phases are reused; the new next actions are `accept-overall`,
`start-version-planning`, `plan-next-version`, and `complete-huge`. Run status
cycles `planning → accepted → executing → planning → … → done`, and the
planning write guard keeps blocking source writes while the run is
`planning`/`accepted` between versions.

**Gates and precedence.** `execute_plan` hard-rejects `PLAN_overall_vN.md`
before any parsing, approval prompt, or state change, and names the current
version's plan. Without an explicit `planPath` the current version's latest
round is resolved from the checkpoint; an explicit path wins, but it must
belong to the run's current version stream and be that stream's latest round —
a stale round, another stream, or an already-completed version is refused.

**Deferred ledger.** Version rows are
``- `D-<this version>-<n>`: <summary> — reason: <why>`` and ids never repeat
across the run. Before a version plan is recorded, every item of the previous
version must be processed: absorbed items must be referenced by the new plan
text, and a drop needs a recorded user confirmation whose question id is
`huge-deferred-<version>--<itemId>` (double dash — the checkpoint question-id
grammar forbids `:`) with `source === "user"`; an `auto-complete` answer never
counts. The tool rejects a version plan that leaves items unprocessed.

**References.** Every version plan cites 1–3 related open-source GitHub
projects (at least one) in its `## Evidence` section. Zero references produce a
run notice visible in `/plans`; the check is advisory, never a hard block.
Download and run `analyze_refs` only when a version introduces a new
technology or when a key design decision is genuinely contested.

**Review budget.** The execution-review budget and termination condition are
asked once, on the first version's handoff; each completion archives them in
the version's `completion` record and the next version's approval restores
them, so later versions do not re-ask.

**VC evidence form.** The execution reviewer runs with read-only tools
(`read`, `grep`, `find`, `ls`). Write every verification check so a reviewer
can judge it from the worktree alone — file X contains symbol/case Y asserting
Z — and treat command output as corroboration, not as the primary evidence.

**Language.** Repository documents (README, references, skills) stay English;
`src/ui-language.ts` keeps its `zh` table in Chinese. `CHANGELOG.md` is written
by the maintainer, not by the workflow.

## Execution Handoff

When the user picks `✓ Accept PLAN_vN and execute it now` in the merged question, mark the plan accepted and call the `execute_plan` tool (or the user runs `/plans-execute`). It re-confirms with the user (never auto-completed) and then asks where the plan runs: the current session (same model), one delegated subagent, or several (2–4) — delegated choices open the reviewer's model + effort picker, the last choice is listed first, and Esc cancels the handoff. A delegated run is implemented by in-process worker sessions that report each finished task through their own `plans_update_task` tool (the panel updates while they keep working; waves run in order, tasks sharing a file stay on one worker), while the main session only supervises and cannot edit files; a failed review round sends its repair brief to the owning workers. Details: `references/state-and-config.md` (*Execution Placement*). The extension then enters task-tree execution mode:

- every agent turn is injected with the current wave's open tasks, the remaining task list, verification-check summary, and execution rules (wave order, `plans_update_task` reporting with status + evidence / skipReason, subprocess polling backoff 5s -> 10s -> 20s -> 40s -> 80s then keep polling at 80s, no stopgaps, dependency and library discipline, minimum tests);
- task progress flows exclusively through the `plans_update_task` tool: one call per task closing it as `complete` (with evidence) or `skipped` (with skipReason); closed statuses are immutable outside the audit-authorized rollback channel; subtasks close before their parent;
- the task dashboard tracks the whole tree live: a compact aboveEditor widget (current task ▸, progress bar, ✓/· counts, VC pass count, wave indicator, pause state, audit-outcome line, unresolved-findings line visible in both the repairing and verifying phases, and a `⊘ blocked` row naming the open rolled-back tasks while the review is blocked) and the Ctrl+Shift+T expanded tree view (✓/▸/~/·/↺ markers, current-task anchor, VC list with audit state, width-adaptive layout). `↺` marks a task that was completed and then rolled back by a failed audit: it is open again but still shows the evidence from its previous attempt;
- while a failed round's reopened tasks are still open, the wake message states explicitly that NO review round is running (the tree is not terminal, so the review cannot start) and carries a `BLOCKED` block naming every open rolled-back task, its provenance (`reopened by round N`), and the required `plans_update_task` action — closing a task's children does not close the task itself. The blocker is persisted in the checkpoint (`execution.blocked`), so the pause reason, the dashboard row, and the `/resume-plans` brief can name it after a restart;
- a stall watchdog pauses execution after three consecutive settled rounds without any task-status change (genuine user input or `/plans-execute` resumes without losing progress). A round in which the agent ran successful tool calls counts as progress even with no status change, so investigating the codebase is never mistaken for a dead agent. Blocked raises escalate on their OWN ladder (`execution.blocked.escalatedRounds`, which tool activity does not reset but which DOES reset to zero whenever the blocker set shrinks — closing one reopened task per settled round is progress, never a reason to harden or pause): the wake wording hardens on each consecutive no-progress blocked wake, ONE visible `pi-plans-exec-blocked` system line is emitted per escalation level, and the third consecutive no-progress blocked wake pauses the run with the blocker as the reason (`blocked: review round N cannot start — …`) instead of the watchdog's own metric. A resume (ordinary input or `/plans-execute`) grants a fresh blocked ladder without refilling the review budget;
- when every task reaches a terminal state, the run status moves to `verifying` and an independent read-only execution reviewer (`agents/execution-reviewer.md`) verifies each check against the worktree in a detached round that appears as an entry in the subagent list (Enter opens its overlay; Esc closes it; Ctrl+Shift+R reopens the newest execution-review overlay). Each check gets one of three verdicts:
  - `pass` — the evidence establishes the check's condition;
  - `fail` — the condition is demonstrably not met; the covered tasks roll back to pending (children cascade, skipped tasks reopen, the `evidence` of the previous attempt is retained while `skipReason` is cleared) and the audit report is injected;
  - `undeterminable` — the reviewer could not reach a conclusion. This is never a failure and never a completion: nothing rolls back, the loop self-schedules the retry (no agent wake), and each retry counts as a committed round against the run's review budget. An all-undeterminable round that also reports a high-severity finding still wakes the executor — a finding is actionable independent of verdict evidence;
  - `F-###` findings — every round also reports severity-graded implementation findings (`high | medium | low`) over the whole implemented change, not just what the checks cover. Ids are stable: the brief lists the previous round's unresolved findings and the reviewer reuses their ids verbatim while the problem persists; absence from the newest round's report is the resolution signal. A `high` finding (or a `fail` verdict) opens ONE union fix round: mapped tasks roll back to pending exactly like a failed check's coverage (children cascade, evidence retained), and a `high` whose `tasks: none` names no owner gets a plan task appended mechanically from the reviewer's `proposed-task` title — the reviewer itself stays read-only. The executor is woken exactly once with a findings summary plus the round-report path. A pure finding-driven rollback deliberately keeps earlier VC passes (the findings channel re-examines the repaired work next round); only a `fail`-driven rollback invalidates the checks covering the reopened tasks. Unresolved findings persist across checkpoint restores, session restores, and fresh budget grants.
  - `medium`/`low` findings are a REPAIR PRIORITY, not a completion gate (v0.10). A report whose actionable findings are all non-high grants the single non-high repair cycle per version: a mapped `medium` rolls back through the same pure finding-driven union (no VC invalidation); an unmapped `medium` and every `low` get a repair task appended mechanically (`fix F-###: … (appended by execution review round N)`; append is idempotent by the `fix <id>:` title prefix, highs included); `low` NEVER rolls back verified work. The executor is woken exactly once with each finding's id, severity, and note, and either fixes and re-closes the affected task with `plans_update_task` evidence, or declines it with status `skipped` and `skipReason: "deferred: <reason>"` (disclosed verbatim at completion, so a declined finding is visibly declined rather than silently dropped). The immediately following round re-judges by stable id. A high/fail-driven pass carries the round's non-high findings as ride-alongs WITHOUT consuming the one-shot. The flag is `execution.reviewNonHighRepair` (`available | granted | used`; absent = a pre-v0.10 checkpoint, whose recorded medium/low keep the old no-owed behavior), server-reset per huge version, and it never rolls back a `low` finding's work.

  The run completes when every pending check is affirmatively `pass` and no finding remains. When the single non-high cycle has been spent (or a high/fail round left the one-shot available but the budget cannot buy another round), a completion may still happen with residual findings — but it never claims `execution review passed`: the message states how many findings were left (`N unresolved, M deferred`), lists each one's disposition (`fixed` when its repair task is closed and the newest round no longer reports it, `repair claimed — still reported` when the task is closed but the id is still reported, `deferred: <reason>`, or `unresolved`), and notes when the non-high cycle was spent or abandoned at the review cap. The user can also end the run explicitly at any time with `/plans-terminate` (see the lifecycle bullet below) — that route records `done` with `audit.passed = false` and `TERMINATION.md` beside the plan (its unresolved-findings list labels non-high ids `(unresolved)`). A partial round credits the checks that passed and leaves the rest for the next round. Checks whose covered tasks are all skipped pass as skipped-pass; checks covering no task never enter the audit; checks already satisfied in an earlier round are neither re-briefed nor re-judged;
- the round budget is a PER-RUN choice, resolved exactly once — right before round 1, when every task is terminal and the review is genuinely owed. An interactive session asks through the same native select menu `ask_choice` uses for a single question (1 / 2 / 3 / 5 / unlimited; a re-pick names the current budget in the menu title, because the native selector has no preselection parameter); every other case (no UI, headless/print/json, auto-approve, RPC without menus, or a selector that throws) applies the default 3 with one visible note, and the checkpoint records `reviewBudgetDefaulted` so the dashboard and the resume brief mark it `(default)`. The value lives in the run checkpoint (`execution.reviewBudget`), never in the plan file, and picking is never a per-round question;
  - a numeric budget counts COMMITTED rounds (pass, fail, or undeterminable; discarded fingerprint-mismatch attempts and cancellations burn nothing; two consecutive discards commit as one undeterminable round) and resets per grant; the single granted non-high repair cycle is EXEMPT: its billed count is `audit.rounds - reviewNonHighCredits` (credit 1 exactly while `execution.reviewNonHighRepair` is `granted`), so a spent budget still funds the one cycle and its credited re-review round;
  - `unlimited` runs until no high finding remains, guarded by two valves: the no-progress valve pauses after three consecutive committed rounds with an identical outcome signature (sorted failed checks + undeterminable checks + high-finding ids, so a round that never produces a report — spawn failure or discard synthesis — still counts), and a run-cumulative hard cap of 50 committed rounds (`execution.reviewRoundsTotal`, never reset — the exempt non-high cycle counts here too) pauses the run. An explicit `/plans-execute` grant that lands on `unlimited` lifts the hard cap by another 50 rounds (`execution.reviewCapExtension`); if the hard cap is reached while a granted non-high cycle is still unjudged, the run completes and the completion message discloses that the cycle counts as spent;
- exhaustion pauses the run in EVERY mode — interactive and auto-approve/headless alike — with an in-band `pi-plans-review-paused` message naming the real budget, EXCEPT when every verification check is already satisfied: then the run completes even with unresolved high findings, which the completion message discloses by id (the findings stay in the round reports and the checkpoint). Ordinary user input and session restores never lift a pause or refill the budget. The only fresh-budget surface is `/plans-execute`: its confirmation re-opens the budget menu with the current value named in its title and resets the per-grant round counter, the no-progress valve, and (only for an `unlimited` pick) extends the hard cap; Esc keeps the run paused. A pre-feature checkpoint that already spent rounds keeps its legacy bound of five committed rounds instead of being cut to the new default mid-flight. The watchdog counter is rebased by real tool activity;
- execution-phase compaction is handled only when Pi core emits manual `/compact`, threshold, or overflow events; summaries are deterministic VCC-style summaries, include session-derived plan/current-task/checklist context, use smart tail keep and `keep:N`, and never call a model;
- the read-only guard lifts: full write access returns;
- the run status moves to `executing`, then `verifying` while the review loop owns the run, then `done` when every check passes (a failed round rolls its tasks back and returns the run to `executing` for repair) or when the user terminates via `/plans-terminate`;
- `/plans-stop` stops execution; `/plans` shows progress. `/plans-terminate` ends the current plan by user decision: it aborts an in-flight round with a `cancelled` round report (no budget charge, no wake), clears the loop and tombstones the session snapshot, writes `TERMINATION.md` beside `PLAN_vN.md`, and moves the run to `done`. It works while the review is paused (its main use case), warns when fewer than three rounds were committed, and discloses — rather than waives — unverified checks, open tasks, and unresolved high findings (the checkpoint keeps `audit.passed = false` and `audit.lastResult = "terminated by user"`). The confirmation is a snapshot boundary: the disclosure summary is re-read from the live loop after the dialog, so a round that commits meanwhile keeps its own report (it is never relabelled `cancelled`) and only the round in flight at termination gets the `cancelled` report; a high that appeared meanwhile forces a second confirmation, and a loop that converged meanwhile is reported as already finished. A terminated run is not offered by `/resume-plans` or the `/plans-execute` run picker, and a handoff whose bound run — or whose plan file inside a terminal run's artifact directory — is terminal is refused with a visible notice (an unrelated plan in a workdir whose runs are all terminal keeps the pre-existing unattributed path).

If the user declines, stay in planning (or stop, per their choice). Never start implementation without the approved handoff.

### Continuation Between Turns

In TUI/RPC, automatic continuation is evaluated only at `agent_settled`, after
Pi has finished natural tool continuation, retries, and compaction. The
extension rechecks that the same execution is active with open tasks, the
session is idle, and neither pending input nor compaction owns continuation.
Each eligible settled cycle can send at most one hidden custom message with
the current execution rules. Tool `turn_end` events only update usage; they
never prequeue continuation reminders. The stall watchdog counts settled
cycles without task-state change (threshold 3); while a rolled-back blocker
keeps the review from starting, the blocked ladder escalates the wake first
(naming the open tasks and stating that no review round is running) and only
its third consecutive raise pauses — a blocked pause names the blocker rather
than the watchdog metric. User interruption and final model errors pause too. Genuine interactive/RPC
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
