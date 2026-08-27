# PLAN_vN - <topic>

Status: draft | reviewed | accepted
Plan version: N
Artifact directory: `<artifact_root>/YYYY-MM-DD-topic/`
State directory: `.git/pi_plans/runs/<run-id>/` (resolved git common dir)
Language: `<BCP47 tag>`

## Original Request

Summarize the user's request in one paragraph.

## Goals

- `G-001`: Goal statement.

## Non-Goals

- `NG-001`: Explicitly excluded work.

## Workspace State

- `STATE-001`: `.git/pi_plans/config.json` language, reviewer, and criticizer settings used for this run.
- `STATE-002`: `.git/pi_plans/runs/<run-id>/run.json` and linked decision/subagent/ref ledgers.

## Repo Evidence

- `E-REPO-001`: Path or command inspected, what it proves, and any uncertainty.

## External Evidence

- `E-EXT-001`: URL or local ref path, what it supports, and date accessed.

## Resolved Decisions

- `D-001`: Question, chosen answer, answer source (user | Auto-complete), and rationale.

## Requirements

- `R-001`: Requirement tied to goals and decisions.

## Constraints

- `C-001`: Compatibility, style, interface, performance, safety, or ownership constraint.

## Implementation Items

- `I-001`: Work item with affected paths, dependencies, and expected code or doc changes.

## Acceptance Criteria

- `AC-001`: Observable result tied to one or more requirements.

## Verification Plan

- `V-001`: Command, manual check, screenshot, log review, or static inspection required after implementation.

## Verifier Checklist

- [ ] `VC-001` covers `I-001`; pass condition: describe pass condition; evidence: describe expected evidence; metric: threshold or reason not quantified.

## Risks And Mitigations

- `Risk-001`: Risk and mitigation.

## Refinement Settings

- Reviewer mode: `delegated-subagent | current-session`; model selector: `inherit | <selector>`.
- Criticizer mode: `delegated-subagent | current-session`; model selector: `inherit | <selector>`.

## Execution Handoff Notes

State anything the executor should know, including order of work, files to avoid, and verification commands. The merged accept/execute question still requires explicit user approval (ask_choice with `autoComplete: false`, then the `execute_plan` tool) and must never be auto-completed. Once approved, the extension-managed execution loop injects the remaining checklist every turn and completes when every `[DONE:VC-xxx]` marker has landed — keep this section concise enough to serve as the executor's brief.

## Revision Ledger

- `PLAN_v1`: Initial plan from resolved questions and evidence.
