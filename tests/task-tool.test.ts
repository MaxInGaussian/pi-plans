/** Tests for the plans_update_task tool core (v0.6.1): transition
 * validation and the audit-only rollback boundary. */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlanTasks } from "../src/plan.ts";
import { buildTaskView } from "../src/tasks.ts";
import { applyTaskUpdate } from "../src/task-tool.ts";

const PLAN = `## Tasks

- Task-1: parser — files: src/a.ts; wave: 1
- Task-2: tool — files: src/b.ts; wave: 1
  - Task-2.1: schema

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: ok
`;

function tasks(progress?: Record<string, { status: "complete" | "skipped" }>) {
	return buildTaskView(parsePlanTasks(PLAN), progress);
}

describe("applyTaskUpdate validation", () => {
	it("completes a pending task and records evidence", () => {
		const tree = tasks();
		const result = applyTaskUpdate(tree, "Task-1", "complete", "npm test green");
		assert.equal(result.ok, true);
		const task = tree.find((t) => t.id === "Task-1")!;
		assert.equal(task.status, "complete");
		assert.equal(task.evidence, "npm test green");
	});

	it("skipping requires a skipReason", () => {
		const result = applyTaskUpdate(tasks(), "Task-1", "skipped");
		assert.equal(result.ok, false);
		assert.match(result.message, /skipReason/);
	});

	it("unknown task ids are rejected", () => {
		const result = applyTaskUpdate(tasks(), "Task-9", "complete", "x");
		assert.equal(result.ok, false);
		assert.match(result.message, /unknown task/);
	});

	it("closed tasks are immutable outside the audit channel", () => {
		const tree = tasks({ "Task-1": { status: "complete" } });
		const again = applyTaskUpdate(tree, "Task-1", "complete", "again");
		assert.equal(again.ok, false);
		assert.match(again.message, /immutable/);
		const reopen = applyTaskUpdate(tree, "Task-1", "skipped", undefined, "reconsidered");
		assert.equal(reopen.ok, false);
		assert.match(reopen.message, /immutable/);
	});

	it("subtasks are addressable", () => {
		const result = applyTaskUpdate(tasks(), "Task-2.1", "complete", "schema tests");
		assert.equal(result.ok, true);
	});
});
