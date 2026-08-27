# Pi Planning Workflow

This reference is shared by the `pi-plans` skills. It is a planning workflow only. Implementation after acceptance runs in the extension-managed execution loop.

## Required Pi Context

This skill set is written for the Pi coding agent's documented behavior:

- the five skills are contributed by the pi-plans extension and loaded as Pi skills (also invokable as `/skill:<name>`);
- skill references and helper sources are resolved relative to the directory containing `SKILL.md`;
- the extension provides these tools: `plans` (workspace state), `ask_choice` (choice prompts), `refine` (reviewer/criticizer subagents), and `execute_plan` (execution handoff);
- `refine` spawns read-only Pi subagents (`pi --mode json -p --no-session --tools read,grep,find,ls`) with isolated context; their results return to the main session as tool output;
- the execution loop is extension-managed: remaining verifier items are injected each turn and `[DONE:VC-xxx]` markers are tracked with a footer progress widget.

## Planning Boundary

- Treat the user's request as a planning target, not as write authorization.
- Before the execution handoff, do not edit target source files, docs, configs, package metadata, generated assets, or tests outside the planning artifact directory and the pi-plans state under `.git/pi_plans/`. The extension enforces this for `edit` and `write` while a run is active: only `.git/pi_plans/`, the run's artifact directory, and `~/.cache/pi-plans/` are writable. Bash is not machine-guarded — keep it read-only by discipline (inspection, `git init`, downloads into the cache).
- The normal pre-handoff writes are `.git/pi_plans/` state plus planning artifacts under the configured artifact root (default `./docs/pi-plans/...`).
- Large downloaded references belong outside the target repo by default, under `~/.cache/pi-plans/refs/<repo-slug>/<topic>/`; record their paths and evidence in `REF_ANALYSIS.md`.
- After the user explicitly approves the execution handoff, leave this planning workflow and execute in the extension-managed loop (see Execution Handoff).

## State And Settings

Before the first planning question, read `references/state-and-config.md` and initialize the target workspace state with the `plans` tool:

```json
{ "action": "init", "workdir": "<target-workdir>" }
```

State lives under the workspace's resolved git common dir as `.git/pi_plans/` (auto-ignored, no `.gitignore` entries; the tool auto-runs `git init` when the workdir safely has no repository). The target workspace is the current working directory unless the user explicitly names another repository.

If `language.tag` is missing from `.git/pi_plans/config.json`, ask the language setting question (via `ask_choice`) before any product question. Persist it with `plans` (`set-language`); this question does not count against the planning-question limit.

If `artifact_root_source` is missing from `.git/pi_plans/config.json` or is `unset`, ask the planning docs location question (via `ask_choice`) before any product question. Persist it with `plans` (`set-artifact-root`); this question does not count against the planning-question limit.

Reviewer and criticizer settings also live in `config.json`. If a role's mode is missing/invalid or its `confirmed_at` is `null` when the role is about to run, ask the matching role-setting or model-confirmation question (via `ask_choice`), persist with `plans` (`set-role`), and then run the `refine` tool. The `refine` tool refuses to spawn until the gates pass.

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

- `options`: ordered options, recommended option first with `recommended: true` (exactly one), each with the tradeoff that matters in `description`;
- do not add `Other` or `Auto-complete` yourself — the tool appends `Other…` second-last and `Auto-complete` last;
- pass `autoComplete: false` for the merged accept/execute question — it contains the execution approval, so Auto-complete never appears there — and for any install waiver, publishing, deployment, merge, push, credential, or external-state question. Auto-complete may choose the recommended planning or refinement option only.

Answers are recorded automatically in the active run's `decisions.jsonl`. You must still maintain `DECISIONS.md` in the artifact directory (summary table of questions, options, answers, answer sources, open assumptions).

## Required Artifact Directory

Create a run only after initial read-only inspection makes the topic clear:

```json
{ "action": "start-run", "workdir": "<target-workdir>", "topic": "<short topic>", "skill": "<skill-name>", "requestText": "<original request>" }
```

The tool creates the configured artifact directory root (default `./docs/pi-plans/YYYY-MM-DD-<topic>/`) and the private run state `.git/pi_plans/runs/<run-id>/`, and stores the active run pointer. Use a short lowercase slug for the topic. Keep paths stable once written.

`DECISIONS.md` records: original request; repository evidence inspected; each question, options, selected answer, and whether it came from the user or Auto-complete; assumptions still open; external sources consulted; language, reviewer, and criticizer settings used.

## Final Scope Confirmation

Before writing `PLAN_v1.md`, ask the mandatory final scope confirmation via `ask_choice` (it does not count against the skill's planning-question limit):

1. `No more requirements` — the scope is ready for `PLAN_v1.md` (recommended).
2. `Add more requirements` — capture additional constraints before drafting.
3. `Other`.
4. `Auto-complete`.

If the user adds requirements, resolve only the necessary follow-up questions, then repeat the final scope confirmation.

## Plan Artifact Requirements

Every `PLAN_vN.md` must include stable IDs that are never recycled across revisions: goals and non-goals; requirements and constraints; implementation items; affected paths; dependencies and sequencing; risks and mitigations; acceptance criteria; verification steps; repo and external evidence; resolved decisions; revision ledger.

Every plan version must include a dedicated `## Verifier Checklist` section. Each item is a Markdown checkbox of the exact shape:

```markdown
- [ ] `VC-001` covers `I-001`; pass condition: ...; evidence: ...; metric: <threshold or reason not quantified>.
```

The execution loop parses `- [ ] \`VC-###\`` items and tracks `[DONE:VC-###]` markers, so keep IDs on the checkbox line. Use `references/plan-artifact-template.md` when drafting.

## Refinement

After each plan version, ask one merged accept/execute question via `ask_choice` with `autoComplete: false` — it contains the execution approval, so Auto-complete never appears. Options:

1. `✓ Accept PLAN_vN and execute it now` — mark the plan accepted (`plans set-status accepted`), then call the `execute_plan` tool.
2. `Accept PLAN_vN, don't execute yet` — mark accepted; resume later via `/plans-execute`.
3. `Run another round: <the level's default next refine mode>` — only while the level's default sequence is unfinished.

The recommended option follows the skill level's default sequence: while the default rounds are unfinished it is option 3's default next mode (`plan-small`: `Criticizer`; `plan-normal`: `Reviewer` then `Criticizer`; `plan-big`: three concurrent reviewers (`refine` with `reviewers: 3`) then `Criticizer`); once the default sequence is complete it is option 1.

If the user selects `Reviewer` or `Criticizer`, run the `refine` tool with the plan path and any focus. Reviewer output consolidates into `PLAN_vN_reviewer_comments.md` with findings IDs, severity, affected plan IDs, evidence, impact, recommended fix, and disposition. Revise the next plan only for findings accepted on evidence.

### Concurrent Reviewers (big plans)

A big-plan reviewer round runs three independent reviewer subagents (`reviewers: 3`); each gets its own emphasis lens but forms its own priorities. After they return, merge and dedupe their findings into one consolidated `PLAN_vN_reviewer_comments.md`, keeping each finding's source reviewer, severity, evidence, and disposition, and surface at most five high-priority comments to the user. Treat agreement between independent reviewers as stronger evidence, not as authority; every accepted finding still needs repo or reference evidence.

### Criticizer Rounds

Present each criticizer question with `ask_choice` (one call per question, in the configured language). Before each question, summarize the original criticism in at most three sentences and highlight the most important point. Do not revise the plan until every criticizer question has a recorded answer.

### Round Lifecycle

A refinement round is complete when all reviewer outputs have returned or all criticizer questions have answers. In the same turn: consolidate, accept or reject each finding on evidence (the user may override any disposition), revise to `PLAN_v(N+1).md` when accepted items require it (copy, edit only the new version, update the revision ledger and verifier checklist), then immediately ask the next merged accept/execute question. Never end a turn merely because a round completed.

## Execution Handoff

When the user picks `✓ Accept PLAN_vN and execute it now` in the merged question, mark the plan accepted and call the `execute_plan` tool (or the user runs `/plans-execute`). It re-confirms with the user, then the extension enters execution mode:

- every agent turn is injected with the remaining verifier checklist and execution rules (layered simplest implementation, no stopgaps, dependency and library discipline, minimum tests);
- the read-only guard lifts: full write access returns;
- the run status moves to `executing`, then `done` when the last `[DONE:VC-xxx]` marker lands;
- `/plans-stop` stops execution; `/plans` shows progress.

If the user declines, stay in planning (or stop, per their choice). Never start implementation without the approved handoff.

## Red Flags

Stop and return to the workflow if any of these happen:

- implementing before the approved execution handoff;
- running `refine` without first asking the merged accept/execute question, or before the role gates pass;
- ending a turn after a completed refinement round without asking the next merged accept/execute question;
- storing planning settings outside the target workspace's `.git/pi_plans/` state directory;
- asking multiple planning questions in one message, or asking them outside `ask_choice`;
- writing `PLAN_v1.md` before final scope confirmation;
- accepting vague answers that contradict repo or reference evidence;
- treating a reviewer or criticizer as authority instead of evidence;
- offering Auto-complete for execution, install, deploy, merge, push, or destructive cleanup approval.
