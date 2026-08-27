# State And Config

pi-plans stores all planning preferences and run state in the target workspace's git directory as `<git-common-dir>/pi_plans/` — in an ordinary repository this is simply `.git/pi_plans/` — resolving the git common dir with `git rev-parse --git-common-dir` from the workspace. Because the state lives inside the git dir, git never tracks it and no `.gitignore` entries are needed. The target workspace is the current working directory unless the user explicitly names another repository.

Do not store pi-plans preferences in Pi's own settings (`~/.pi/agent/settings.json`); pi-plans uses `.git/pi_plans/config.json` for its state.

## State Root Resolution

- Git runs with `GIT_DIR`, `GIT_COMMON_DIR`, and `GIT_WORK_TREE` scrubbed from the environment, so leaked env vars cannot misdirect state into an unrelated repository. Relative results (`.git`, `../.git`) resolve against the workdir.
- Granularity is **per enclosing repository**: running from a subdirectory uses the enclosing repo's git dir (a one-line notice names that repo). Linked worktrees share one common dir; run directories are unique, but `active.json` may race across concurrent worktrees.
- State does not travel with clones: a fresh clone starts with empty state while committed `./docs/pi-plans/` artifacts persist in the repository.

## Auto Git Init

When a mutating state action (`init`, `set-language`, `set-role`, `start-run`, record-*) runs in a workdir that is not a git repository, the helper auto-runs `git init` there (with a one-line notice) and then creates the state dir. It never creates commits. Auto-init runs only when ALL of the following hold:

- the workdir has no `.git` entry (a pre-existing `.git` file or directory that git cannot resolve is a fatal error, never a silent reinit);
- the workdir is not inside any git work tree (a subdirectory of a repo uses the enclosing repo instead);
- the workdir is neither the user's home directory nor the filesystem root.

Bare repositories are refused with a clear error. A missing `git` executable is a clear error. The `show` action is strictly read-only: it never auto-inits or writes.

## Directory Layout

```text
<git-common-dir>/pi_plans/
  config.json
  active.json
  runs/
    <run-id>/
      run.json
      decisions.jsonl
      subagents.jsonl
      refs.jsonl
  tmp/
  cache/
```

`config.json` is stable workspace preference state. `active.json` and `runs/` are run state. Large external references stay outside the repository by default under `~/.cache/pi-plans/refs/`, with metadata recorded in the run state and public artifacts.

## Config Schema

The default config is:

```json
{
  "schema": 1,
  "language": { "tag": null, "source": "unset", "updated_at": null },
  "reviewer": {
    "mode": "delegated-subagent",
    "model_selector": null,
    "name_prefix": "pi-plans-reviewer",
    "confirmed_at": null
  },
  "criticizer": {
    "mode": "delegated-subagent",
    "model_selector": null,
    "name_prefix": "pi-plans-criticizer",
    "confirmed_at": null
  },
  "artifact_root": "./docs/pi-plans",
  "artifact_root_source": "unset",
  "artifact_root_updated_at": null
}
```

Rules:

- `schema` must be `1`.
- `language.tag` is a BCP47-style tag such as `zh-Hans`, `en`, or `zh-Hant`, or `null` before selection; `language.source` is `user`, `auto`, or `unset`.
- `reviewer.mode` and `criticizer.mode` are `delegated-subagent` or `current-session`.
- `model_selector` is `null` to inherit the dispatching session's model, or an exact `provider/model` selector matching Pi's model registry.
- `confirmed_at` is `null` until the user has confirmed the role's model at first use; see below.
- `artifact_root` is relative to the target workspace unless absolute.
- `artifact_root_source` is `user`, `auto`, or `unset`.
- `artifact_root_updated_at` is the selection timestamp or `null` before confirmation.
- There is intentionally no `effort` field: subagents inherit the dispatching session's model and thinking level unless an exact selector is stored. The real lever is the main session's thinking level at refine time.

## Language Setting

Before the first product planning question, check the persisted config (`plans` action `show`). If `language.tag` is missing or invalid, ask exactly one `ask_choice` question:

1. `zh-Hans` — recommended when more than 60 percent of the user's planning request is Simplified Chinese.
2. `en` — recommended when the request is mostly English or mixed without a Chinese majority.
3. `zh-Hant` — Traditional Chinese.
4. `Other` — user provides a BCP47 tag.
5. `Auto-complete` — select the recommended language.

Persist with `plans` (`set-language`, `languageSource: "user"`). Use the selected language for visible questions, choices, review summaries, criticizer questions, and Markdown artifacts. Keep IDs, file paths, command names, JSON keys, and protocol labels stable in English.

## Planning Docs Location

Before the first product planning question, check the persisted config again. If `artifact_root_source` is missing or `unset`, ask exactly one `ask_choice` question:

1. `./docs/pi-plans` — recommended; planning docs live in the repository and are public.
2. `./.git/pi_plans/plans` — private to the repository; not published.
3. `Other` — user provides a custom path.
4. `Auto-complete` — select the recommended path.

Persist with `plans` (`set-artifact-root`, `artifactRoot: <selected path>`, `artifactRootSource: "user"` or `"auto"`). Use the selected path for the run's artifact directory root. This question does not count against the planning-question limit.


Before running a `refine` round, read the role setting from the persisted config.

If the role's `mode` is missing or invalid, ask exactly one `ask_choice` question and persist:

1. `Delegated subagent` — recommended; read-only `pi` subprocess with isolated context.
2. `Current session` — run the read-only pass in the current foreground session.
3. `Other` / 4. `Auto-complete` — select the recommended delegated subagent.

Independently, each role's **model** is confirmed once, at that role's first actual use: when `confirmed_at` is `null` and a `refine` round is about to run, ask exactly one `ask_choice` question:

1. `Inherit the main agent's model` — recommended; stores `model_selector: null`.
2. `Choose a model` — pick from the models available in this Pi install (check `/model` or `ctx.scopedModels`); persist the exact `provider/model` selector; do not invent model names.
3. `Other` / 4. `Auto-complete` — select inherit.

Persist with `plans` (`set-role`, `confirmed: true`, `modelSelector: <selector or "inherit">`). `confirmed_at` is set only by this confirmation flow; a mode-only edit never forges or discards a confirmation, and a confirmed inherit (`model_selector: null` plus a stamp) is distinguishable from never-confirmed.

If a spawn later fails because the stored selector is unavailable, reset the marker (`set-role`, `resetConfirmation: true`) and re-ask the confirmation question.

## Subagent Spawning

When `mode` is `delegated-subagent`, the `refine` tool spawns a read-only `pi` subprocess (`--mode json -p --no-session --tools read,grep,find,ls`) whose system prompt comes from `agents/reviewer.md` or `agents/criticizer.md`. The subagent:

- performs read-only analysis and never edits files;
- receives the full plan text and a review/criticism brief;
- returns its findings as the tool result (recorded in `subagents.jsonl` with name and model).

The main agent consolidates the results, records dispositions, revises the plan, and asks the next refinement-mode question — all in the same turn.

## Run State

One run directory per planning request: `<git-common-dir>/pi_plans/runs/<YYYYMMDDTHHMMSSZ-topic>/` (second-precision; `-2`, `-3` suffixes on collision).

`run.json` includes: run ID; skill name; original request; target workspace; artifact directory; language tag; status (`planning` → `accepted` → `executing` → `done`, with `stopped`/`abandoned` as exits); timestamps.

`decisions.jsonl` is appended automatically by `ask_choice` (question, options, answer, answer source). `subagents.jsonl` records reviewer/criticizer spawns. `refs.jsonl` records reference metadata via `plans` (`record-ref`).
