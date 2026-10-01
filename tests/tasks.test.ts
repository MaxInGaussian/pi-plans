/** Tests for the task tree primitives that the execution review drives:
 * rollback retention, persistence completeness, and done-flag invalidation.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckItem } from "../src/plan.ts";
import {
	auditRollbackSet,
	buildTaskView,
	invalidateChecksForRolledBackTasks,
	taskProgressMap,
	type TaskProgressMap,
} from "../src/tasks.ts";
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

function view(progress: TaskProgressMap = {}) {
	return buildTaskView(parsePlanTasks(PLAN), progress);
}

const ALL_DONE: TaskProgressMap = {
	"Task-1": { status: "complete", evidence: "edited src/a.ts" },
	"Task-2": { status: "complete", evidence: "edited src/b.ts" },
	"Task-3": { status: "complete", evidence: "edited src/c.ts" },
	"Task-3.1": { status: "complete", evidence: "injected src/c.ts" },
};

describe("rollback retention", () => {
	it("keeps the evidence of a rolled-back complete task", () => {
		const tasks = view(ALL_DONE);
		const reopened = auditRollbackSet(tasks, checks(), "VC-001");
		assert.deepEqual(reopened, ["Task-1"]);
		const task = tasks[0];
		assert.equal(task.status, "pending");
		// Regression: rollback used to clear evidence, so the agent lost the
		// record of what the previous attempt did and had to re-derive it.
		assert.equal(task.evidence, "edited src/a.ts");
	});

	it("keeps evidence but clears the skip reason of a rolled-back skipped task", () => {
		const tasks = view({ "Task-2": { status: "skipped", skipReason: "covered by Task-3" } });
		assert.deepEqual(auditRollbackSet(tasks, checks(), "VC-002"), ["Task-2"]);
		const task = tasks.find((t) => t.id === "Task-2");
		assert.equal(task.status, "pending");
		assert.equal(task.skipReason, undefined, "the audit overturned the skip");
	});

	it("leaves tasks outside the covers clause untouched", () => {
		const tasks = view(ALL_DONE);
		auditRollbackSet(tasks, checks(), "VC-001");
		assert.equal(tasks.find((t) => t.id === "Task-2")?.status, "complete");
		assert.equal(tasks.find((t) => t.id === "Task-2")?.evidence, "edited src/b.ts");
	});

	it("does not report a task that is already pending as reopened", () => {
		const tasks = view({ "Task-1": { status: "pending" } });
		assert.deepEqual(auditRollbackSet(tasks, checks(), "VC-001"), []);
	});
});

describe("progress persistence", () => {
	it("records every task, including untouched pending ones", () => {
		// Regression: taskProgressMap skipped pending tasks that had no
		// evidence, so after a rollback the checkpoint held zero records and
		// the run's whole history vanished.
		const tasks = view({ "Task-1": { status: "complete", evidence: "done" } });
		const map = taskProgressMap(tasks);
		assert.deepEqual(Object.keys(map).sort(), ["Task-1", "Task-2", "Task-3", "Task-3.1"]);
		assert.equal(map["Task-1"]?.status, "complete");
		assert.equal(map["Task-2"]?.status, "pending");
		assert.equal(map["Task-2"]?.evidence, undefined);
	});

	it("records a rolled-back task as pending with its retained evidence", () => {
		const tasks = view(ALL_DONE);
		auditRollbackSet(tasks, checks(), "VC-001");
		const map = taskProgressMap(tasks);
		assert.equal(map["Task-1"]?.status, "pending");
		assert.equal(map["Task-1"]?.evidence, "edited src/a.ts");
		assert.equal(map["Task-2"]?.status, "complete");
	});

	it("round-trips through buildTaskView without loss", () => {
		const tasks = view(ALL_DONE);
		auditRollbackSet(tasks, checks(), "VC-001");
		const rebuilt = buildTaskView(parsePlanTasks(PLAN), taskProgressMap(tasks));
		assert.equal(rebuilt[0]?.status, "pending");
		assert.equal(rebuilt[0]?.evidence, "edited src/a.ts");
	});
});

describe("done-flag invalidation", () => {
	it("clears done on checks whose covered tasks were reopened", () => {
		// VC-002 covers Task-2 and Task-3; its rollback reopens those, so a
		// presolved VC-003 (covering Task-3.1, cascaded open too) must lose
		// its satisfied state rather than keep claiming the work is verified.
		const checklist = checks(["VC-001", "VC-003"]);
		const tasks = view(ALL_DONE);
		const reopened = auditRollbackSet(tasks, checklist, "VC-002");
		assert.deepEqual(reopened.sort(), ["Task-2", "Task-3", "Task-3.1"]);
		const cleared = invalidateChecksForRolledBackTasks(checklist, tasks, reopened);
		assert.deepEqual(cleared.sort(), ["VC-003"]);
		assert.equal(checklist.find((c) => c.id === "VC-001")?.done, true, "unaffected check keeps its state");
	});

	it("clears done on the failing check itself when it is covered by the rollback", () => {
		const checklist = checks(["VC-002"]);
		const tasks = view(ALL_DONE);
		const reopened = auditRollbackSet(tasks, checklist, "VC-002");
		assert.deepEqual(invalidateChecksForRolledBackTasks(checklist, tasks, reopened).sort(), ["VC-002"]);
	});

	it("leaves every check done when nothing was reopened", () => {
		const checklist = checks(["VC-001", "VC-003"]);
		assert.deepEqual(invalidateChecksForRolledBackTasks(checklist, view(ALL_DONE), []), []);
		assert.deepEqual(checklist.filter((c) => c.done).map((c) => c.id).sort(), ["VC-001", "VC-003"]);
	});
});