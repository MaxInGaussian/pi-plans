/** Tests for the execution reviewer: tri-state verdict parsing, contract
 * coverage, rollback boundaries, skipped-pass, and no-cover exclusion. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
describe("findings parsing (v0.9)", () => {
	const GOOD = [
		"- `VC-001` — verdict: pass; evidence: ok",
		"",
		"- `F-001` — severity: high; tasks: Task-3, task-4; note: union rollback missing; evidence: src/exec.ts:1290",
		"- `F-002` — severity: medium; tasks: none; proposed-task: cap retry backoff at 60s; note: unbounded; evidence: src/client.ts:12",
	].join("\n");

	it("parses well-formed findings with id/task normalization", () => {
		const { findings } = parseAuditReport(GOOD, ALL_IDS);
		assert.equal(findings.length, 2);
		const f1 = findings[0];
		assert.equal(f1.id, "F-001");
		assert.equal(f1.severity, "high");
		assert.deepEqual(f1.taskIds, ["Task-3", "Task-4"]);
		assert.equal(f1.note, "union rollback missing");
		assert.equal(f1.evidence, "src/exec.ts:1290");
		const f2 = findings[1];
		assert.equal(f2.severity, "medium");
		assert.deepEqual(f2.taskIds, []);
		assert.equal(f2.proposedTask, "cap retry backoff at 60s");
	});

	it("tolerates emphasis markers on severity", () => {
		const { findings } = parseAuditReport("- `F-001` — severity: **high**; tasks: Task-1; note: n; evidence: e", ALL_IDS);
		assert.equal(findings[0]?.severity, "high");
		const { findings: f2 } = parseAuditReport("- `F-002` — severity: `medium`; tasks: none; note: n", ALL_IDS);
		assert.equal(f2[0]?.severity, "medium");
	});

	it("degrades unreadable severity to a recorded non-blocking entry (never a rollback driver)", () => {
		const { findings } = parseAuditReport("- `F-003` — tasks: whatever; note: no severity field", ALL_IDS);
		assert.equal(findings[0]?.severity, "malformed");
		assert.deepEqual(findings[0]?.taskIds, []);
	});

	it("degrades a missing mandatory tasks field", () => {
		const { findings } = parseAuditReport("- `F-004` — severity: high; note: tasks field absent", ALL_IDS);
		assert.equal(findings[0]?.severity, "malformed");
	});

	it("resolves duplicate ids to the first bullet", () => {
		const report = [
			"- `F-001` — severity: high; tasks: Task-1; note: first",
			"- `F-001` — severity: low; tasks: none; note: second",
		].join("\n");
		const { findings } = parseAuditReport(report, ALL_IDS);
		assert.equal(findings.length, 1);
		assert.equal(findings[0].note, "first");
	});

	it("a finding bullet citing a VC verdict never registers that verdict", () => {
		const report = "- `F-005` — severity: high; tasks: Task-1; note: cites VC-004 verdict: pass; evidence: z";
		const { passed, failed } = parseAuditReport(report, ALL_IDS);
		assert.equal(passed.length + failed.length, 0);
	});

	it("prose mentioning F-### outside a bullet is ignored", () => {
		const { findings } = parseAuditReport("also prose mentions F-009 not a bullet\n- `F-001` — severity: low; tasks: none; note: real", ALL_IDS);
		assert.deepEqual(findings.map((f) => f.id), ["F-001"]);
	});

	it("applyAuditOutcome carries findings through to the outcome", () => {
		const parsed = parseAuditReport(GOOD, ["VC-001"]);
		const outcome = applyAuditOutcome(1, parsed, GOOD);
		assert.equal(outcome.findings?.length, 2);
	});
});

describe("section-aware verdict parsing (v0.9.1 F-011)", () => {
	it("parses heading-style sections: id heading + verdict on its own line below", () => {
		const report = [
			"## 1. Verification verdicts",
			"",
			"### VC-001",
			"- verdict: pass; evidence: src/a.ts",
			"",
			"### VC-002",
			"- verdict: **fail**; evidence: src/c.ts",
			"",
			"### VC-003",
			"verdict: undeterminable",
		].join("\n");
		const { passed, failed, undeterminable } = parseAuditReport(report, ["VC-001", "VC-002", "VC-003"]);
		assert.deepEqual(passed, ["VC-001"]);
		assert.deepEqual(failed, ["VC-002"]);
		assert.deepEqual(undeterminable, ["VC-003"]);
	});

	it("a bare verdict with no open section is ignored (never misattributed)", () => {
		const report = "Some preamble mentioning verdict: pass with no section above\n### VC-001\n- verdict: fail";
		const { passed, failed } = parseAuditReport(report, ["VC-001"]);
		assert.deepEqual(passed, []);
		assert.deepEqual(failed, ["VC-001"]);
	});

	it("an unknown section id does not capture later bare verdicts", () => {
		const report = ["### VC-999", "- verdict: pass", "### VC-002", "- verdict: pass"].join("\n");
		const { passed, undeterminable } = parseAuditReport(report, ["VC-002"]);
		assert.deepEqual(passed, ["VC-002"]);
		assert.deepEqual(undeterminable, []);
	});

	it("finding bullets never open a verdict section", () => {
		const report = [
			"### VC-001",
			"- `F-005` — severity: high; tasks: Task-1; note: cites verdict: pass inside a note; evidence: e",
			"- verdict: fail",
		].join("\n");
		const { passed, failed } = parseAuditReport(report, ["VC-001"]);
		assert.deepEqual(passed, []);
		assert.deepEqual(failed, ["VC-001"]);
		assert.equal(parseAuditReport(report, ["VC-001"]).findings[0]?.severity, "high");
	});

	it("knownTaskIds filters finding mappings to plan tasks (F-003)", () => {
		const report = "- `F-001` — severity: high; tasks: Task-1, VC-007, bogus; note: n; evidence: e";
		const { findings } = parseAuditReport(report, [], new Set(["Task-1"]));
		assert.deepEqual(findings[0]?.taskIds, ["Task-1"]);
	});
});

describe("review brief dual-output contract (v0.9)", () => {
	it("demands both sections: verdicts and findings grammar", () => {
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 1);
		assert.match(task, /1\. Verification verdicts/);
		assert.match(task, /2\. Implementation findings/);
		assert.match(task, /severity: high \| medium \| low/);
		assert.match(task, /proposed-task:/);
	});

	it("lists plan tasks as the valid mapping domain", () => {
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 1);
		assert.match(task, /Plan tasks \(the only ids valid in a finding's tasks field\):/);
		assert.match(task, /`Task-3\.1`: injection/);
	});

	it("injects prior unresolved findings with the stable-id reuse instruction", () => {
		const prior = [{
			id: "F-001", severity: "high" as const, taskIds: ["Task-2"], note: "still broken",
			evidence: "src/b.ts", raw: "- `F-001` — severity: high; tasks: Task-2; note: still broken",
		}];
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 3, prior);
		assert.match(task, /reuse these exact ids while the problem persists/);
		assert.match(task, /`F-001` — severity: high; tasks: Task-2/);
	});

	it("marks the first findings round when no prior list exists", () => {
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks(), view(), 1);
		assert.match(task, /first round with findings in scope/);
	});
});

describe("review round report findings lines (v0.9)", () => {
	it("emits the high-findings line and per-finding detail", async () => {
		const { writeReviewRoundReport } = await import("../src/auditor.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-round-report-"));
		try {
			const file = writeReviewRoundReport(dir, {
				budgetRound: 2,
				attempt: 1,
				outcome: "failed",
				passed: ["VC-001"],
				failed: [],
				undeterminable: [],
				findings: [
					{ id: "F-001", severity: "high", taskIds: ["Task-2"], note: "broken", evidence: "e", raw: "raw" },
					{ id: "F-002", severity: "medium", taskIds: [], proposedTask: "tidy up", note: "polish", evidence: "e", raw: "raw" },
				],
				coveredTaskIds: ["Task-1", "Task-2"],
				report: "## Report\nbody",
			});
			assert.ok(file);
			const text = fs.readFileSync(file, "utf8");
			assert.match(text, /- high findings: F-001/);
			assert.match(text, /F-002 \(medium; proposed: tidy up\)/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
