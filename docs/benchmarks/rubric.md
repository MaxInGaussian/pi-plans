# Plan-quality rubric — D-017 degrade report

- Treatment-arm plan artifacts retained: **0 / 36**
- Pre-registered clause (D-017 / C-F010): when fewer than 20 artifacts are available, report the actual count and the reason.
- Reason: the harness's artifact sync watched three candidate roots (`/tmp/pi-plans-bench/docs`, `<workdir>/docs/pi-plans`, `<workdir>/.git/pi_plans/docs`) — none received plan files in this run, and hard-killed trials (agent timeout) skip exit-time sync entirely. Planning itself demonstrably ran (planning sessions, criticizer/reviewer subagent executions verified in logs), but the PLAN_v*.md files were written outside the watched roots or not at all before termination.
- Consequence: the plan-quality dimension is **not measurable** in this run. No score is reported (reporting a placeholder score would be dishonest). Tracked as a harness fix; see tech-note §7c.
