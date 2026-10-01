/** Tests for the execution reviewer: tri-state verdict parsing, contract
 * coverage, rollback boundaries, skipped-pass, and no-cover exclusion. */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckItem } from "../src/plan.ts";
import { auditRollbackSet, buildTaskView } from "../src/tasks.ts";
import {
	applyAuditOutcome,
	auditablePendingChecks,
	buildAuditTask,
	parseAuditReport,
	presolvedCheckIds,
} from "../src/auditor.ts";
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

const ALL_IDS = ["VC-001", "VC-002", "VC-003", "VC-004"];

describe("auditor parsing", () => {
	it("parses per-check verdicts and ignores unknown ids", () => {
		const report = [
			"- `VC-001` — verdict: pass; evidence: src/a.ts; note: ok",
			"- `VC-002` — verdict: fail; evidence: src/c.ts; note: missing",
			"- `VC-999` — verdict: pass; evidence: n/a",
		].join("\n");
		const { passed, failed, undeterminable } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, ["VC-001"]);
		assert.deepEqual(failed, ["VC-002"]);
		assert.deepEqual(undeterminable.sort(), ["VC-003", "VC-004"]);
	});

	it("parses verdicts wrapped in markdown emphasis", () => {
		// Regression: `verdict: **pass**` used to parse as nothing, and the
		// caller's fail-closed rule then rolled the entire run back.
		const report = [
			"- `VC-001` — verdict: **pass**; evidence: src/a.ts",
			"- `VC-002` — verdict: **fail**; evidence: src/c.ts",
			"- `VC-003` — verdict: *pass*; evidence: src/d.ts",
			"- `VC-004` — verdict: `pass`; evidence: src/e.ts",
		].join("\n");
		const { passed, failed, undeterminable } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, ["VC-001", "VC-003", "VC-004"]);
		assert.deepEqual(failed, ["VC-002"]);
		assert.deepEqual(undeterminable, []);
	});

	it("does not read a verdict word prefix as a verdict", () => {
		const report = ["- `VC-001` — verdict: passed; evidence: x", "- `VC-002` — verdict: failing; evidence: y"].join("\n");
		const { passed, failed, undeterminable } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, []);
		assert.deepEqual(failed, []);
		assert.deepEqual(undeterminable.sort(), ["VC-001", "VC-002", "VC-003", "VC-004"]);
	});

	it("conflicting verdicts for one check resolve to fail", () => {
		const report = "- `VC-001` — verdict: pass; note: a\n- `VC-001` — verdict: fail; note: b";
		const { passed, failed } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, []);
		assert.deepEqual(failed, ["VC-001"]);
	});

	it("reads an explicit undeterminable verdict", () => {
		const report = "- `VC-001` — verdict: pass\n- `VC-002` — verdict: undeterminable; evidence: bash not granted";
		const { passed, failed, undeterminable } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, ["VC-001"]);
		assert.deepEqual(failed, []);
		assert.deepEqual(undeterminable.sort(), ["VC-002", "VC-003", "VC-004"]);
	});

	it("treats a reviewer-shaped report as undeterminable, never as failure", () => {
		// Regression: agents/reviewer.md was the auditor's system prompt and
		// mandates `## Findings` / `## Questions` with F-### lines and never
		// says "verdict". Under fail-closed that whole shape read as "every
		// check failed" and rolled the run back.
		const report = [
			"## Findings",
			"",
			"- `F-001` — severity: high; affected: VC-001; evidence: src/a.ts; impact: x; recommended fix: y; suggested disposition: accept.",
			"",
			"## Questions",
			"",
			"None.",
		].join("\n");
		const { passed, failed, undeterminable } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, []);
		assert.deepEqual(failed, [], "a reviewer-shaped report is not a failed audit");
		assert.deepEqual(undeterminable.sort(), ["VC-001", "VC-002", "VC-003", "VC-004"]);
	});

	it("classifies a partially covered report per check", () => {
		const report = "- `VC-001` — verdict: pass\n- `VC-003` — verdict: **pass**";
		const { passed, failed, undeterminable } = parseAuditReport(report, ALL_IDS);
		assert.deepEqual(passed, ["VC-001", "VC-003"]);
		assert.deepEqual(failed, []);
		assert.deepEqual(undeterminable.sort(), ["VC-002", "VC-004"]);
	});

	it("builds the brief with the auditable pending checks only", () => {
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 1);
		assert.match(task, /read-only/i);
		assert.match(task, /`VC-001`/);
		assert.doesNotMatch(task, /`VC-999`/);
		assert.doesNotMatch(task, /`VC-004`/, "a check covering no task is never audited");
	});

	it("brief states the tri-state contract and forbids fail-for-want-of-evidence", () => {
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 1);
		assert.match(task, /verdict: pass \| fail \| undeterminable/);
		assert.match(task, /never report `fail` for want of evidence/i);
	});

	it("brief omits checks already done in an earlier round", () => {
		// Regression: the brief listed every auditable check, so a round-2
		// auditor that legitimately skipped the satisfied ones looked like a
		// contract violation -- and, with no rollback to produce progress, the
		// budget climbed to the cap and the run livelocked.
		const done = buildAuditTask("/tmp/PLAN_v1.md", checks(["VC-001"]), view(), 2);
		assert.doesNotMatch(done, /`VC-001`/);
		assert.match(done, /`VC-002`/);
		assert.deepEqual(
			auditablePendingChecks(checks(["VC-001"]), view()).map((item) => item.id),
			["VC-002", "VC-003"],
		);
	});

	it("applyAuditOutcome classifies without touching the checklist or task tree", () => {
		const checklist = checks();
		const tasks = view({ "Task-1": { status: "complete" }, "Task-2": { status: "complete" }, "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		const parsed = parseAuditReport("- `VC-001` — verdict: pass\n- `VC-002` — verdict: fail", ["VC-001", "VC-002"]);
		const outcome = applyAuditOutcome(3, parsed, "report text");
		assert.deepEqual(outcome.passed, ["VC-001"]);
		assert.deepEqual(outcome.failed, ["VC-002"]);
		assert.deepEqual(outcome.undeterminable, []);
		assert.equal(outcome.round, 3);
		assert.equal(outcome.report, "report text");
		assert.equal(checklist.every((item) => item.done === false), true, "no done flag written here");
		assert.equal(tasks.find((t) => t.id === "Task-2")?.status, "complete", "no rollback here");
	});
});

describe("audit rollback boundaries", () => {
	it("failed multi-cover check rolls back every covered task", () => {
		const tasks = view({ "Task-1": { status: "complete" }, "Task-2": { status: "complete" }, "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		const rolledBack = auditRollbackSet(tasks, checks(), "VC-002");
		assert.deepEqual(rolledBack.sort(), ["Task-2", "Task-3", "Task-3.1"]);
		// A check that passed keeps its task closed.
		assert.equal(tasks.find((t) => t.id === "Task-1")?.status, "complete");
		assert.equal(tasks.find((t) => t.id === "Task-2")?.status, "pending");
	});

	it("covering the parent cascades to subtasks even when the parent alone is listed", () => {
		const tasks = view({ "Task-3": { status: "complete" }, "Task-3.1": { status: "complete" } });
		assert.ok(auditRollbackSet(tasks, checks(), "VC-002").includes("Task-3.1"), "subtask reopens with the parent");
	});

	it("skipped tasks reopen too (skip state cleared)", () => {
		const tasks = view({ "Task-2": { status: "skipped" } });
		assert.ok(auditRollbackSet(tasks, checks(), "VC-002").includes("Task-2"));
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