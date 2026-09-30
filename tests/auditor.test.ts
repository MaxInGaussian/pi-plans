/** Tests for the completion auditor (v0.6.1): verdict parsing, rollback
 * boundaries, skipped-pass, and no-cover exclusion. */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckItem } from "../src/plan.ts";
import { buildTaskView } from "../src/tasks.ts";
import { applyAuditOutcome, buildAuditTask, parseAuditReport, presolvedCheckIds } from "../src/auditor.ts";
import { parsePlanTasks } from "../src/plan.ts";

const PLAN = `## Tasks

- Task-1: parser — files: src/a.ts; wave: 1
- Task-2: tool — files: src/b.ts; wave: 1
- Task-3: core — deps: Task-1, Task-2; files: src/c.ts; wave: 2
  - Task-3.1: injection — files: src/c.ts

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: parser ok
- [ ] \`VC-002\` covers \`Task-2\` and \`Task-3\`; pass condition: tool+core ok
- [ ] \`VC-003\` covers \`Task-3.1\`; pass condition: injection ok
- [ ] \`VC-004\` covers nothing here; pass condition: orphan
`;

function checks(done: string[] = []): CheckItem[] {
	const raw = PLAN.split("## Verification Checks")[1] ?? "";
	const items: CheckItem[] = [];
	for (const line of raw.split("\n")) {
		const m = line.match(/^- \[ \] `(VC-\d+)` (.+)$/);
		if (m) items.push({ id: m[1], text: m[2], done: done.includes(m[1]) });
	}
	return items;
}

function view(progress?: Record<string, { status: "complete" | "skipped" }>) {
	return buildTaskView(parsePlanTasks(PLAN), progress);
}

describe("auditor parsing", () => {
	it("parses per-check verdicts and ignores unknown ids", () => {
		const report = [
			"- `VC-001` — verdict: pass; evidence: src/a.ts; note: ok",
			"- `VC-002` — verdict: fail; evidence: src/c.ts; note: missing",
			"- `VC-999` — verdict: pass; evidence: n/a",
		].join("\n");
		const { passed, failed } = parseAuditReport(report, checks());
		assert.deepEqual(passed, ["VC-001"]);
		assert.deepEqual(failed, ["VC-002"]);
	});

	it("conflicting verdicts for one check resolve to fail", () => {
		const report = "- `VC-001` — verdict: pass; note: a\n- `VC-001` — verdict: fail; note: b";
		const { passed, failed } = parseAuditReport(report, checks());
		assert.deepEqual(passed, []);
		assert.deepEqual(failed, ["VC-001"]);
	});

	it("builds the brief with the auditable checks only", () => {
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 1);
		assert.match(task, /read-only/i);
		assert.match(task, /`VC-001`/);
		assert.doesNotMatch(task, /`VC-999`/);
	});
});

describe("audit rollback boundaries", () => {
	it("failed multi-cover check rolls back every covered task", () => {
		const tasks = view({ "Task-1": { status: "complete" }, "Task-2": { status: "complete" }, "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		const checklist = checks();
		const outcome = applyAuditOutcome(checklist, tasks, 1, ["VC-001"], ["VC-002"], "report");
		assert.deepEqual(outcome.rolledBack.sort(), ["Task-2", "Task-3", "Task-3.1"]);
		// Passed check stays done; its task stays closed.
		assert.equal(checks().length, 4);
		assert.equal(tasks.find((t) => t.id === "Task-1")?.status, "complete");
		assert.equal(tasks.find((t) => t.id === "Task-2")?.status, "pending");
	});

	it("covering the parent cascades to subtasks even when the parent alone is listed", () => {
		const tasks = view({ "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		const outcome = applyAuditOutcome(checks(), tasks, 1, [], ["VC-002"], "report");
		assert.ok(outcome.rolledBack.includes("Task-3.1"), "subtask reopens with the parent");
	});

	it("skipped tasks reopen too (skip state cleared)", () => {
		const tasks = view({ "Task-2": { status: "skipped" } });
		const outcome = applyAuditOutcome(checks(), tasks, 1, [], ["VC-002"], "report");
		assert.ok(outcome.rolledBack.includes("Task-2"));
		assert.equal(tasks.find((t) => t.id === "Task-2")?.skipReason, undefined);
	});

	it("checks with no task coverage are excluded from presolved audit", () => {
		const tasks = view({ "Task-1": { status: "complete" }, "Task-2": { status: "complete" }, "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		const presolved = presolvedCheckIds(checks(), tasks);
		assert.ok(!presolved.includes("VC-004"), "no-cover check is never audited");
	});

	it("mixed coverage (skipped + complete siblings) resolves as skipped-pass (I-007)", () => {
		const tasks = view({ "Task-2": { status: "skipped" }, "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		const presolved = presolvedCheckIds(checks(), tasks);
		assert.ok(presolved.includes("VC-002"), "skipped + complete siblings presolve");
		assert.ok(!presolved.includes("VC-003"), "pure complete coverage goes to the auditor");
	});

	it("all-skipped coverage resolves as skipped-pass", () => {
		const tasks = view({ "Task-3": { status: "skipped" }, "Task-3.1": { status: "skipped" } });
		const presolved = presolvedCheckIds(checks(), tasks);
		assert.ok(presolved.includes("VC-003"));
		assert.ok(!presolved.includes("VC-002"), "mixed coverage needs the auditor");
	});
});
