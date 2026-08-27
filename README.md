<h1 align="center">pi-plans</h1>

<p align="center">
  <img src="docs/assets/pi-plans-logo.svg?v=3" alt="pi-plans: Plan. Review. Execute." width="640" />
</p>

<h2 align="center"><b>Plan. Review. Execute.</b></h2>

<p align="center">
  <i>Versioned, reviewed Markdown plans land before any code changes.<br>Human-in-the-loop planning for the Pi coding agent.</i>
</p>

<p align="center">
  <a href="https://github.com/MaxInGaussian/pi-plans/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/MaxInGaussian/pi-plans?style=square" /></a>
  <a href="https://hits.sh/github.com/MaxInGaussian/pi-plans/"><img alt="Repo views" src="https://hits.sh/github.com/MaxInGaussian/pi-plans.svg?label=repo%20views" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg?style=square" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-TS-3178C6?style=square&logo=typescript&logoColor=white" />
  <img alt="pi-package" src="https://img.shields.io/badge/pi--package-ready-7c3aed?style=square" />
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
   checklist injected each turn, [DONE:VC-xxx]
   markers tracked with a footer widget
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

Pi:  Next step for refining the plan?
     1. Reviewer round (recommended)
     2. Criticizer round
     3. Accept plan for tracked execution
     ...

You: Accept plan for tracked execution.

Pi:  Execute this plan now?
     1. Execute this plan now (recommended)
     2. Stop after planning
```

Planning artifacts live under `./docs/pi-plans/YYYY-MM-DD-<topic>/` by default (public, committed). Prefer `.git/pi_plans/plans` if you want them private to the repository.

## What it does

| Capability | In short |
|---|---|
| Planning router + five specialist skills | Start with `/skill:planning` to route to the narrowest matching specialist (`plan-small` → `plan-big`, `debug-and-plan`, `plan-with-refs`) |
| Choice prompts | `ask_choice`: recommended option first, answers auto-recorded per run |
| Refinement rounds | Read-only reviewer/criticizer Pi subagents consolidate findings into the next plan version |
| Workspace state | Config, runs, decisions, refs, and subagent ledgers in `.git/pi_plans/` (git common dir) |
| Tracked execution | Checklist injected each turn; `[DONE:VC-xxx]` markers drive progress |
| Write guard | `edit`/`write` blocked outside planning artifacts while a run is active |

## Interface overview

| Tool / Command | Purpose |
|---|---|
| `plans` | State CLI: `init`, `show`, `set-language`, `set-artifact-root`, `set-role`, `start-run`, `set-status`, `record-decision`, `record-ref`, `record-subagent` |
| `ask_choice` | Numbered choice prompt; `autoComplete: false` for execution handoff / external-state questions |
| `refine` | Reviewer/criticizer round via read-only subagents (`--tools read,grep,find,ls`); `reviewers: 3` for big plans; enforces role/model confirmation gates |
| `execute_plan` | Execution handoff: re-confirms with the user, enters extension-managed execution mode |
| `/plans` | Show config, active run, execution progress |
| `/plans-execute [plan.md]` | Manual execution handoff (defaults to highest `PLAN_vN.md`) |
| `/update-plan [plan.md] [reason…]` | Interrupt-and-refine: stops execution (if any), returns the run to planning, and directs the agent to revise the plan into `PLAN_vN+1.md` while preserving verified work |
| `/plans-stop` | Stop execution mode |
| `/plans-abandon` | Abandon the active run (lifts the write guard; artifacts stay) |

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

## Layout

```
pi-plans/
├── index.ts               # Extension entry: tools, commands, guard, execution loop
├── tools/                 # plans, ask-choice, refine, execute-plan
├── src/                   # state, guard, plan parsing, subagent runner, exec loop
├── skills/                # The planning router plus five specialist planning skills
├── references/            # Shared workflow, state/config, plan template (normative)
├── agents/                # reviewer.md / criticizer.md subagent prompts
├── scripts/validate.ts    # Structure validator
└── tests/                 # node:test suite (state, guard, plan parsing, execution)
```

## Safety model

Before the approved handoff the workflow writes only `.git/pi_plans/` state, the run's artifact directory, and `~/.cache/pi-plans/` — the extension blocks `edit`/`write` elsewhere while a run is `planning`/`accepted` (bash stays discipline-bound: inspection, `git init`, downloads into the cache). Reviewer/criticizer subagents run with read-only tools. `Auto-complete` may answer planning and refinement questions only; it is never offered for execution, installs, publishing, deployment, merge, push, or credential use, and non-interactive sessions stop instead of auto-approving those.

## Verification

```bash
npm run validate   # structure validator
npm test           # node:test suite (stdlib only, no deps)
```

Both run on Node ≥ 22.6 via `--experimental-strip-types`; no npm dependencies.

## FAQ

**Why do I have to approve before any code changes?**

The plan is the contract. Refinement converges on scope while nothing is writable yet; the execution handoff is a separate explicit approval that also lifts the write guard. You always see — and can veto — what will happen before it happens.

**What can Auto-complete decide on my behalf?**

Planning and refinement choices only (the recommended option). It is never offered for execution approval, installs, publishing, deployment, merge, push, or credentials — those questions stop and wait for you.

**Where does all the state live?**

Preferences and run ledgers in `.git/pi_plans/` inside your workspace's git directory (never tracked, never published); plan artifacts under the configured artifact root (default `./docs/pi-plans/`); large downloaded references outside the repo under `~/.cache/pi-plans/`.

**How is this different from just prompting an AI to make changes?**

Prompts produce one-shot diffs with no recorded reasoning. pi-plans produces versioned artifacts — decisions, references, reviewer findings, dispositions, a verifier checklist — that are auditable, resumable across sessions, and enforced by tooling rather than goodwill.

## License

MIT.
