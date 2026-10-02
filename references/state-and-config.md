# State And Config

pi-plans stores planning preferences and run state in the target workspace's git directory as `<git-common-dir>/pi-plans/` — in an ordinary repository this is simply `.git/pi-plans/` — resolving the git common dir with `git rev-parse --git-common-dir` from the workspace. Because the state lives inside the git dir, git never tracks it and no `.gitignore` entries are needed. The target workspace is the current working directory unless the user explicitly names another repository.

The one workspace-independent piece is the **reviewer role** (v0.7.0): it lives in the global config `~/.pi/pi-plans/config.json` (override the directory with `PI_PLANS_GLOBAL_DIR`), confirmed once and shared across every workspace. It is a standalone pi-plans file, never Pi's own settings.

Do not store pi-plans preferences in Pi's own settings (`~/.pi/agent/settings.json`); pi-plans uses `.git/pi-plans/config.json` for workspace state and `~/.pi/pi-plans/config.json` for the reviewer role.

## State Root Resolution

- Git runs with `GIT_DIR`, `GIT_COMMON_DIR`, and `GIT_WORK_TREE` scrubbed from the environment, so leaked env vars cannot misdirect state into an unrelated repository. Relative results (`.git`, `../.git`) resolve against the workdir.
- Granularity is **per enclosing repository**: running from a subdirectory uses the enclosing repo's git dir (a one-line notice names that repo). Linked worktrees share one common dir; run directories are unique, and since v0.6.0 the run registry is derived from `runs/` (no shared pointer to race). The legacy `active.json` is deprecated: reads fall back to it only when no `runs/` entries exist (pre-0.6.0 migration).
- State does not travel with clones: a fresh clone starts with empty state, and the default plan artifacts live in the git dir with it. Point `artifact_root` at `./docs/pi-plans` when you want the plans committed and public instead.

## Auto Git Init

When a mutating state action (`init`, `set-language`, `set-artifact-root`, `set-refs-root`, `set-graph-enabled`, `start-run`, record-*) runs in a workdir that is not a git repository, the helper auto-runs `git init` there (with a one-line notice) and then creates the state dir. It never creates commits. `set-role` is deliberately NOT in this list: it writes only the global config and never triggers auto-init or any workspace write. Auto-init runs only when ALL of the following hold:

- the workdir has no `.git` entry (a pre-existing `.git` file or directory that git cannot resolve is a fatal error, never a silent reinit);
- the workdir is not inside any git work tree (a subdirectory of a repo uses the enclosing repo instead);
- the workdir is neither the user's home directory nor the filesystem root.

Bare repositories are refused with a clear error. A missing `git` executable is a clear error. The `show` action is strictly read-only: it never auto-inits or writes.

## Directory Layout

```text
<git-common-dir>/pi-plans/
  config.json
  pi-vcc-config.json
  active.json      # deprecated (v0.6.0): legacy pointer, read only when runs/ is empty
  runs/            # the run registry derives from runs/<run-id>/run.json
    <run-id>/      # note: the refs root is a sibling — .git/pi-plans/refs (hyphenated), not under pi-plans/
      run.json
      decisions.jsonl
      subagents.jsonl
      refs.jsonl
  tmp/
  cache/
```

`config.json` is stable workspace preference state. `pi-vcc-config.json` is the repo-private compaction config used only by pi-plans' VCC-style compact hook. `runs/` is the run state and the source of the run registry: `listRuns` scans `runs/<run-id>/run.json` (sorted by `updated_at` desc, corrupt entries skipped) and the un-bound "active" resolution is the newest NON-TERMINAL run (null when every run is done/abandoned). Multiple concurrent planning runs in one workdir are supported: each session binds to the run it started (binding first, registry fallback after), and `/plans-abandon`, `/plans-execute`, and `/resume-plans` open a descriptive run-picker form when more than one candidate exists. Reference downloads go to the configured `refs_root` (asked once per workspace when unset; the recommended `.git/pi-plans/refs/` sits inside the git dir so git never tracks it), with metadata recorded in the run state and public artifacts.

## Config Schema

The default workspace config is (no `reviewer` key — the role lives globally since v0.7.0):

```json
{
  "schema": 1,
  "language": { "tag": null, "source": "unset", "updated_at": null },
  "artifact_root": "./.git/pi-plans/plans",
  "artifact_root_source": "unset",
  "artifact_root_updated_at": null,
  "refs_root": null,
  "refs_root_source": "unset",
  "refs_root_updated_at": null
}
```

Rules:

- `schema` must be `1`.
- `language.tag` is a BCP47-style tag such as `zh-Hans`, `en`, or `zh-Hant`, or `null` before selection; `language.source` is `user`, `auto`, or `unset`.
- A legacy workspace `reviewer` block (pre-0.7.0, and the removed v0.6.0 `criticizer` key) is read-tolerated: the first mutating state call seeds the global config from intent blocks and the next workspace write strips the key. Read-only paths resolve the effective reviewer in memory (global first, legacy block second) and never write.
- `artifact_root` is relative to the target workspace unless absolute.
- `artifact_root_source` is `user`, `auto`, or `unset`.
- `artifact_root_updated_at` is the selection timestamp or `null` before confirmation.
- `refs_root` is where plan-with-refs downloads references, relative to the target workspace unless absolute, or `null` before selection; `refs_root_source` is `user`, `auto`, or `unset`; `refs_root_updated_at` is the selection timestamp or `null`.

## Global Reviewer Config (v0.7.0)

The reviewer role is stored in `~/.pi/pi-plans/config.json` (`PI_PLANS_GLOBAL_DIR` overrides the directory; tests, CI, and bench containers rely on it):

```json
{
  "schema": 1,
  "reviewer": {
    "mode": "delegated-subagent",
    "model_selector": "devin/claude-sonnet-5.5",
    "thinking_level": null,
    "name_prefix": "pi-plans-reviewer",
    "confirmed_at": "2026-09-30T07:54:12Z"
  }
}
```

Rules:

- `mode` is `delegated-subagent` or `current-session`.
- `model_selector` is an exact `provider/model` selector. There is no inherit entry point anymore: after first-use confirmation the delegated reviewer always runs a concrete model (`modelSelector: "inherit"` in `set-role` is a full reset — it clears the selector AND `confirmed_at`).
- `thinking_level` is `null` (default — spawn WITHOUT `--thinking`, letting the child pi resolve its own chain: per-model settings → `defaultThinkingLevel` → `medium`, then model clamping) or an explicit level (`off | minimal | low | medium | high | xhigh | max`; the domain comes from the chosen model's `thinkingLevelMap` via pi-ai's `getSupportedThinkingLevels`). `"off"` is a real level and deliberately distinct from `null`. Changing `modelSelector` without passing `thinkingLevel` resets the level.
- `confirmed_at` is stamped only by a real confirmation. `reviewerReady(role)` = current-session, or delegated with `confirmed_at` set AND a concrete `model_selector` — a confirmed null selector can never pass (the old confirmed-inherit state is unreachable).
- A corrupt or wrong-schema global file yields defaults plus a notice and is NEVER clobbered by reads.
- Migration (Q-1=A): the first mutating pi-plans call in a workspace with a legacy intent block (`confirmed_at` set, an explicit selector, or a non-default mode) seeds the global file once — first touched workspace wins; other workspaces get a one-time "ignored" notice. A confirmed-inherit block seeds with the selector null and NO confirmation, so the next `refine` re-asks once via the native panel. Scaffold-only blocks are dropped silently.
- The execution reviewer's spawn IS governed by this role when it is confirmed: the round pins the configured model and thinking level and labels its overlay with the role. An unconfirmed or `current-session` role inherits the session default (labeled `session default`) — a detached round never opens the interactive first-use panel. Rounds are timeout-bounded (minutes, not the subagent default), so a hung child surfaces as a spawn-failure round instead of parking the run.

## VCC Compact Config

`pi-vcc-config.json` is scaffolded under the resolved `<git-common-dir>/pi-plans/` state root when an active planning or execution compaction hook first needs it. It is independent from `config.json` so planning preferences, run state, and compact policy can evolve separately.

Default values:

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "prePlanCompact": true,
  "debug": false
}
```

Rules:

- Only the repo-private file is read. Upstream global pi-vcc config such as `~/.pi/agent/pi-vcc-config.json` and `PI_VCC_CONFIG_PATH` are ignored.
- Missing files are created with defaults; valid files keep user values and receive missing default keys; invalid JSON is never clobbered and the runtime falls back to defaults for that read.
- `overrideDefaultCompaction:false` returns ordinary Pi manual/threshold/overflow compactions to Pi core. Explicit pi-plans internal compact hints can still use the VCC path.
- `smartKeepTail:true` starts from the requested/default keep count and may retain more recent user turns when the retained tail remains within the safe token budget. Explicit `keep:N` is honored.
- `continueAfterThresholdCompact:true` permits one hidden continuation after successful threshold/overflow compaction only on Pi versions that still need extension-driven resume behavior. Plain manual `/compact` never auto-continues, and `/compact <text>` sends the text once as the follow-up prompt.
- `prePlanCompact:true` requests one VCC planning compaction (internal hint `pi-plans planning pre-plan compact`) from the `plans` `tool_result` hook right after `plans start-run` creates a new run, before the first planning question, and resumes the planning turn with one hidden message on success and failure alike. Small sessions, already-compacted sessions, and aborts skip silently with an info notice. The trigger is disabled while an execution is active. `prePlanCompact:false` restores the old behavior.
- `debug:false` writes no diagnostics; `debug:true` writes a best-effort `/tmp/pi-vcc-debug.json` snapshot for local troubleshooting.

## Language Setting

Before the first product planning question, check the persisted config (`plans` action `show`). If `language.tag` is missing or invalid, ask exactly one `ask_choice` question:

1. `zh-Hans` — recommended when more than 60 percent of the user's planning request is Simplified Chinese.
2. `en` — recommended when the request is mostly English or mixed without a Chinese majority.
3. `zh-Hant` — Traditional Chinese.
4. `Other` — user provides a BCP47 tag.
5. `Auto-complete` — select the recommended language.

Persist with `plans` (`set-language`, `languageSource: "user"`). Use the selected language for visible questions, choices, review summaries, reviewer questions, and Markdown artifacts. Keep IDs, file paths, command names, JSON keys, and protocol labels stable in English.

## Code Graph Enabled

`graph_enabled` (`boolean | null`) records whether the workspace wants graph-aware read/write/edit wrappers and `code_graph` mutations for indexed source files. `null` means the question was never asked: the first `plans` `init`/`show` in a workspace returns a `hint` instructing the agent to ask the user once via `ask_choice` (recommended: yes) and persist with the `plans` tool (`set-graph-enabled`, `enabled: true|false`). This question does not count against the planning-question limit. `/enable-graph` and `/disable-graph` toggle it later; disable refuses while graph drift is dirty. When enabled, DB-first staged edits are materialized agent-side via the `code_graph` tool's `apply` action (same planning/accepted gate as `/apply-graph`; refused for read-only refiner subagents via the `PI_PLANS_REFINER` env marker; the result carries per-file counts and a post-apply drift summary and never changes run status).

## `/config-pi-plans`

`/config-pi-plans` is an interactive workspace configuration wizard. It re-asks the workspace language, planning docs root, refs root, and code graph toggle (written to `.git/pi-plans/config.json`), plus the reviewer mode and model. The reviewer steps live in the GLOBAL config: the mode switch persists immediately, and the model step shows a keep/change entry menu — `Keep current (provider/model · level)` or `Choose model & thinking level…`. When the mode is `current-session` the model step is skipped entirely (an existing selector is never cleared). Choosing opens the native model panel + effort panel in TUI, or model/effort menus otherwise; Esc keeps the current role and the wizard CONTINUES instead of discarding earlier answers. A failed global write is reported explicitly while workspace settings still save. When code graph is enabled, the extension also overrides built-in `read`/`write`/`edit` for indexed source files so graph-backed source reads and DB-first edits happen automatically. If a run is already active, only the workspace defaults change; the active run's `artifact_dir` and `language_tag` stay unchanged.


Before the first product planning question, check the persisted config again. If `artifact_root_source` is missing or `unset`, ask exactly one `ask_choice` question:

1. `./.git/pi-plans/plans` — recommended; the default. Planning docs stay private to the repository and are never tracked.
2. `./docs/pi-plans` — planning docs live in the working tree, are public, and can be committed with the repository.
3. `Other` — user provides a custom path.
4. `Auto-complete` — select the recommended path.

Persist with `plans` (`set-artifact-root`, `artifactRoot: <selected path>`, `artifactRootSource: "user"` or `"auto"`). Use the selected path for the run's artifact directory root. This question does not count against the planning-question limit.

Before downloading any reference in a plan-with-refs flow, check the persisted config. If `refs_root_source` is missing or `unset`, ask exactly one `ask_choice` question:

1. `.git/pi-plans/refs` — recommended; inside the git dir so git never tracks the downloads.
2. `./refs/` — inside the worktree; the planning write guard allows writes under the configured refs root.
3. `~/.cache/pi-plans/refs/` — outside the repository; matches the historical default.
4. `Other` / `Auto-complete` — select the recommended path.

Persist with `plans` (`set-refs-root`, `refsRoot: <selected path>`, `refsRootSource: "user"` or `"auto"`). Download references under this root. This question does not count against the planning-question limit.


Before running a `refine` round, read the role setting from the persisted global config.

If the role's `mode` is missing or invalid, ask exactly one `ask_choice` question and persist (the mode question stays agent-mediated):

1. `Delegated subagent` — recommended; read-only `pi` subprocess with isolated context.
2. `Current session` — run the read-only pass in the current foreground session.
3. `Other` / 4. `Auto-complete` — select the recommended delegated subagent.

The **model + thinking level** are confirmed once, at first actual use, through NATIVE panels — not ask_choice:

- **TUI**: the gate itself pops a `/model`-style searchable model panel (pi's `ModelSelectorComponent`; the runtime adapter maps the public model registry facade — `getAvailable`/`find`/`getError`/`refresh` — onto the four runtime methods, with the private `.runtime` field as a secondary attempt and menus as the construction fallback), then a `/thinking`-style effort panel whose first row is `Default (no --thinking flag: the child pi resolves per-model settings → defaultThinkingLevel → medium)` followed by the chosen model's `thinkingLevelMap` levels. Both panels must complete; the result persists to the global config (`modelSelector` + `thinkingLevel`, `confirmed: true`) only then, and the same invocation continues with the returned values.
- **hasUI non-TUI (RPC/ACP)**: native `ctx.ui.select` menus over the same data (model list, then effort list).
- **UI-less (print/json/bench)**: the gate returns text guidance embedding the available selectors and the exact `set-role` call; persist that way. Automation may also pre-write `~/.pi/pi-plans/config.json` directly.

Pressing Esc on either panel CANCELS the whole gate: nothing is persisted and the tool returns a dedicated error (`details.cancelled`) instructing the agent NOT to re-ask via ask_choice and NOT to retry unless the user asks — suggest `/config-pi-plans` instead. Cheap validations (plan path, refs) run BEFORE any panel so a typo never walks the user through panels.

The confirmation applies only to `delegated-subagent` mode (current-session runs in the main session and needs no model). If a stored selector is missing from the registry at spawn time, TUI re-opens the panel; other modes return an error naming the selector — reset with `set-role` (`resetConfirmation: true`) and re-confirm.

`set-role` invariants: `confirmed: true` requires a concrete `provider/model` selector in delegated mode; `modelSelector: "inherit"` resets BOTH the selector and `confirmed_at`; `thinkingLevel: "default"` stores `null`; changing `modelSelector` without `thinkingLevel` resets the level.

## Subagent Spawning

When `mode` is `delegated-subagent`, the `refine` tool spawns a read-only `pi` subprocess (`--mode json -p --no-session --tools read,grep,find,ls`, plus `--model <provider/model>` and — only when `thinking_level` is set — `--thinking <level>`) whose system prompt comes from `agents/reviewer.md`. In TUI mode, delegated runs also show a standalone `Reviewer` overlay with live lane/tool status (header label `provider/model:level`); the child is awaited and the overlay is closed before the tool result returns. The subagent:

- performs read-only analysis and never edits files;
- receives the full plan text and a review/criticism brief;
- returns its findings as the tool result (recorded in `subagents.jsonl` with name and model).

The main agent consolidates the results, records dispositions, revises the plan, and asks the next merged accept/execute question — all in the same turn.

The `analyze_refs` tool (plan-with-refs) uses the same spawning machinery with the **reviewer** role's model confirmation from the global config — but NOT its mode (v0.7.0, Q-4): analysis is spawn-only by nature, so a `current-session` reviewer still gets spawned ref-analyst lanes (a one-time notice says the mode is ignored and unchanged) while the confirmed concrete model remains required. Each downloaded reference gets one independent read-only subagent whose system prompt comes from `agents/ref-analyst.md` and whose working directory is that reference's own directory; lanes never get `code_graph`. Lanes run in sequential batches of at most 3 under a standalone overlay titled `Refs`; each batch's controller opens and closes exactly like a single refine round. Successful spawns are recorded best-effort in `subagents.jsonl` with role `ref-analyst` and the thinking level actually passed (skipped when no active run exists, e.g. adhoc calls). The structured per-reference sections come back as the tool result; the main agent owns `REF_ANALYSIS.md` and fills `coverage`/`gaps` in `refs.jsonl` via `plans` (`record-ref`).

## Run State

One run directory per planning request: `<git-common-dir>/pi-plans/runs/<YYYYMMDDTHHMMSSZ-topic>/` (second-precision; `-2`, `-3` suffixes on collision).

`run.json` includes: run ID; skill name; original request; target workspace; artifact directory; language tag; status (`planning` → `accepted` → `executing` → `done`, with `stopped`/`abandoned` as exits); timestamps.

`decisions.jsonl` is appended automatically by `ask_choice` (question, options, answer, answer source). `subagents.jsonl` records reviewer/ref-analyst spawns (legacy 0.6.0 entries with `criticizer` remain readable). `refs.jsonl` records reference metadata via `plans` (`record-ref`); its `kind` field is `project` (repos), `paper` (arXiv etc.), `article` (blog posts), or `docs` (documentation sites).

## Workflow Checkpoints (`/resume-plans`)

Each run may carry a `checkpoint.json` — the durable, cross-session workflow state that `/resume-plans` restores in the current session. It records: logical `phase` (`planning | reviewing | executing | completed`; the legacy 0.6.0 `implementation-review` phase is read-tolerated and maps to done), `nextAction`, the exact plan identity (path + version + SHA-256), pending/answered questions (stable `questionId`), review rounds with per-lane status and result-file references, execution approval evidence (plan digest, worktree, `git revparse HEAD` at approval, task progress map, audit rounds with the failed and undeterminable check sets plus the unresolved findings of the newest committed round, the watchdog budget counter, verified VC set, usage), and ownership metadata. Full review outputs live in separate `reviews/` files; the checkpoint keeps only validated references.

Rules:

- Validation is explicit: unknown schema versions, malformed shapes, and unexpected keys are rejected; missing and corrupt checkpoints are distinct, and corrupt files are never silently overwritten. Keys added by a later version (`execution.stallRounds`, `execution.audit.undeterminable`, `execution.audit.findings`) are optional on read, so checkpoints written before them keep loading.
- Writes are atomic with monotonic revisions; writers may require ownership (token + generation) or an expected revision.
- Model-driven boundaries (plan written, review consolidated, termination condition recorded, implementation round finished, completed) go through the whitelisted `plans record-checkpoint` action, which enforces state-machine preconditions — it cannot set execution approval, mark VCs passed, or forge terminal states.
- `ask_choice` accepts `questionId`/`purpose`; a pending question is durable before the panel opens and the answer before it returns. When a crash leaves a question both answered (ledger) and pending (checkpoint), the answered entry wins.
- On execution resume, an unchanged plan digest with a changed HEAD keeps the authorization but re-verifies previously verified VCs first; loading execution from a checkpoint writes an immediate session snapshot so session restore cannot clear it.
- Cross-worktree resumes copy artifacts without overwriting, reset approval and VC validity, keep the termination condition, and restart completed-round counts at 0 for the target worktree.

## Run Ownership

A run may be held by at most one live owner (`owner.json`: host, pid, process start time via `ps -o lstart=`, session id, random process token, generation). Acquisition is an atomic exclusive create; takeovers require proof the previous owner is dead (process gone, or pid alive with a different start time — PID reuse). Foreign hosts, corrupt records, and unverifiable liveness are conservatively refused; `/resume-plans` never queues or interrupts. Sessions bind to the run they start/execute/resume (restored from `pi-plans-run-start` entries on the current branch), and attribution (tools, write guard, autocomplete, execution bookkeeping, code-graph apply gate) prefers the binding, falling back to the registry's newest non-terminal run (v0.6.0 — the shared `active.json` pointer is deprecated). The v0.6.0 delegated-executor env pins (`PI_PLANS_RUN_ID` / `PI_PLANS_EXECUTOR`) are gone; read-only subagent children carry `PI_PLANS_REFINER=1`.
