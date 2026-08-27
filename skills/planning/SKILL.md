---
name: planning
description: General planning router for pi-plans. Use when the user asks for planning and you need to choose the narrowest specialist skill among plan-small, plan-normal, plan-big, debug-and-plan, and plan-with-refs.
---

# Planning Router

Use this skill when a task is planning-related but the right specialist is not obvious yet.

## Routing

1. If the request is a bug, CI failure, regression, incident, or debug-why case, route to `debug-and-plan`.
2. If the plan depends on external projects, articles, papers, or docs, route to `plan-with-refs`.
3. If the work is open-ended, cross-system, high-risk, or likely beyond ten decisions, route to `plan-big`.
4. If the work is broad or risky but bounded, route to `plan-normal`.
5. Otherwise route to `plan-small`.
6. If multiple skills fit, choose the smallest one that still covers the risk.
7. Then follow that skill's instructions exactly.

## Pi Setup

Use the same language, `ask_choice`, `refine`, reviewer, criticizer, Auto-complete, and `.git/pi_plans` rules as the selected specialist skill and the shared workflow.
