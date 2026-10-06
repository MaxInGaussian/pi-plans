---
name: planning
description: General planning router for pi-plans. Use when the user asks for planning and you need to choose the narrowest specialist skill among plan-small, plan-normal, plan-big, plan-huge, debug-and-plan, and plan-with-refs.
---

# Planning Router

Use this skill when a task is planning-related but the right specialist is not obvious yet.

## Routing

1. If the request is a bug, CI failure, regression, incident, or debug-why case, route to `debug-and-plan`.
2. If the plan depends on external projects, articles, papers, or docs, route to `plan-with-refs` — including when the work spans multiple product versions, because that skill fixes the plan's shape (plan-normal, plan-big, or plan-huge) after the references are analyzed and can continue the same run as a huge build.
3. If the work spans multiple product versions the user wants to plan, build, and review one at a time (a huge build) and no external references are needed, route to `plan-huge`.
4. If the work is open-ended, cross-system, high-risk, or likely beyond ten decisions, route to `plan-big`.
5. If the work is broad or risky but bounded, route to `plan-normal`.
6. Otherwise route to `plan-small`.
7. If multiple skills fit, choose the smallest one that still covers the risk.
8. Then follow that skill's instructions exactly.

## Pi Setup

Use the same language, `ask_choice`, `refine`, reviewer, Auto-complete, and `.git/pi-plans` rules as the selected specialist skill and the shared workflow — including the per-option `✓ <advantage> / ✗ <drawback>` descriptions, which every option you write carries in the configured language, kept terse. Questions prefer the 0.4.0 batch form: one `ask_choice` call with `questions: [...]` (2-8) opens a tabbed multiple-choice form; scope confirmation and execution handoff stay single-question with `autoComplete: false`.
