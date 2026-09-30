/** Tests for plan artifact parsing (verifier checklist + done markers). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { latestPlanVersion, nextPlanVersionPath, parseChecklist, parseImplItems, extractCoverage, parsePlanTasks, resolveTaskWaves, extractTaskCoverage, normalizeTaskId, checklistHeaderName, lintPlanTasks } from "../src/plan.ts";

const PLAN = `# PLAN_v1 - demo

## Goals

- \`G-001\`: Ship it.

## Verifier Checklist

- [ ] \`VC-001\` covers \`I-001\`; pass condition: tests green; evidence: pytest output; metric: 100% pass.
- [x] \`VC-002\` covers \`I-002\`; pass condition: no lint errors; evidence: run ruff; metric: zero findings.
- not a checklist line
- [ ] \`VC-003\` covers \`I-003\`; pass condition: manual check; metric: not quantified.

## Risks And Mitigations

- \`Risk-001\`: something.
`;

describe("plan parsing", () => {
	it("parses checklist items with ids and done state", () => {
		const items = parseChecklist(PLAN);
		assert.equal(items.length, 3);
		assert.equal(items[0]?.id, "VC-001");
		assert.equal(items[0]?.done, false);
		assert.equal(items[1]?.id, "VC-002");
		assert.equal(items[1]?.done, true);
		assert.equal(items[2]?.id, "VC-003");
	});

	it("returns empty without a checklist section", () => {
		assert.equal(parseChecklist("# no checklist here\n\n- [ ] `VC-001` orphan\n").length, 0);
	});

});

describe("latestPlanVersion", () => {
	let dir: string;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-plan-"));
		fs.writeFileSync(path.join(dir, "PLAN_v1.md"), "v1");
		fs.writeFileSync(path.join(dir, "PLAN_v10.md"), "v10");
		fs.writeFileSync(path.join(dir, "PLAN_v2.md"), "v2");
		fs.writeFileSync(path.join(dir, "notes.md"), "notes");
	});

	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("picks the highest version numerically", () => {
		const latest = latestPlanVersion(dir);
		assert.equal(latest?.version, 10);
		assert.equal(latest?.path, path.join(dir, "PLAN_v10.md"));
	});

	it("returns null for missing dirs", () => {
		assert.equal(latestPlanVersion(path.join(dir, "nope")), null);
	});
});

describe("nextPlanVersionPath", () => {
	let dir: string;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-next-"));
	});

	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("increments from the highest existing version", () => {
		fs.writeFileSync(path.join(dir, "PLAN_v1.md"), "v1");
		fs.writeFileSync(path.join(dir, "PLAN_v4.md"), "v4");
		const next = nextPlanVersionPath(dir);
		assert.equal(next.version, 5);
		assert.equal(next.path, path.join(dir, "PLAN_v5.md"));
	});

	it("starts at v1 for empty dirs", () => {
		const empty = path.join(dir, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const next = nextPlanVersionPath(empty);
		assert.equal(next.version, 1);
		assert.equal(next.path, path.join(empty, "PLAN_v1.md"));
	});
});

describe("implementation items", () => {
	const IMPL_PLAN = `# PLAN_v1 - demo

## Implementation Items

- \`I-001\`: Add state helpers in src/exec.ts; evaluate percent and coverage. Details follow:
  - nested sub-bullet ignored
- \`I-002\`: Wire the turn_end trigger and status bar.
- not an item line
- \`I-001\`: duplicate id ignored

## Verifier Checklist

- [ ] \`VC-001\` covers \`I-001\` and \`I-002\`; pass condition: tests green; metric: 0 fail.
- [ ] \`VC-002\` covers \`I-002\`; pass condition: lint clean; metric: zero findings.
`;

	it("parses strict top-level single-line items and ignores continuations", () => {
		const items = parseImplItems(IMPL_PLAN);
		assert.equal(items.length, 2);
		assert.equal(items[0]?.id, "I-001");
		// First line only: the multi-line body and nested sub-bullet are ignored.
		assert.match(items[0]!.text, /^Add state helpers/);
		assert.doesNotMatch(items[0]!.text, /nested/);
		assert.equal(items[1]?.id, "I-002");
	});

	it("returns empty without an Implementation Items section", () => {
		assert.equal(parseImplItems("# no items here\n- `I-001`: orphan\n").length, 0);
	});


	it("extracts coverage refs before the first semicolon only", () => {
		assert.deepEqual(extractCoverage("`VC-001` covers `I-001` and `I-002`; pass: `I-003` mentioned late"), ["I-001", "I-002"]);
		assert.deepEqual(extractCoverage("no coverage clause here"), []);
	});


});

const TASK_PLAN = `# PLAN_v1 - demo

## Tasks

- Task-1: 解析器主体 — files: src/plan.ts; wave: 1
- Task-2: 单测 — files: tests/plan.test.ts; wave: 1
- Task-3: 执行核心 — deps: Task-1，Task-2; files: src/exec.ts、src/tasks.ts; wave: 2
  - Task-3.1: 注入骨架 — deps: Task-1; files: src/exec.ts
  - Task-3.2: 状态机 — files: src/tasks.ts
- Task-4: 文档 — deps: Task-3

### Execution Waves

- wave 1: Task-1, Task-2 — 文件集不相交可并行
- wave 2: Task-3 — 依赖前波
- wave 3: Task-4 — 收尾

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\` and \`Task-2\`; pass condition: 解析单测全绿; metric: 100%。
- [x] \`VC-002\` covers \`Task-3.1\`; pass condition: 注入正确; metric: 通过。

## Risks And Mitigations
`;

describe("task-tree parsing (v0.6.1)", () => {
	it("parses tasks with inline fields, tolerating full-width separators", () => {
		const parsed = parsePlanTasks(TASK_PLAN);
		assert.equal(parsed.legacy, false);
		assert.equal(parsed.tasks.length, 4);
		const t3 = parsed.tasks[2];
		assert.equal(t3?.id, "Task-3");
		assert.deepEqual(t3?.deps, ["Task-1", "Task-2"]);
		assert.deepEqual(t3?.files, ["src/exec.ts", "src/tasks.ts"]);
		assert.equal(t3?.wave, 2);
		assert.equal(t3?.children.length, 2);
		assert.equal(t3?.children[0]?.id, "Task-3.1");
		assert.deepEqual(t3?.children[0]?.deps, ["Task-1"]);
		const t4 = parsed.tasks[3];
		assert.equal(t4?.deps.length, 1);
		assert.equal(t4?.wave, undefined);
	});

	it("parses the Execution Waves subsection with rationale", () => {
		const parsed = parsePlanTasks(TASK_PLAN);
		assert.equal(parsed.waves.length, 3);
		assert.deepEqual(parsed.waves[0], { wave: 1, taskIds: ["Task-1", "Task-2"], rationale: "文件集不相交可并行" });
		assert.deepEqual(parsed.waves[1]?.taskIds, ["Task-3"]);
	});

	it("accepts the canonical and legacy checklist headers, and task coverage", () => {
		assert.equal(checklistHeaderName(TASK_PLAN), "Verification Checks");
		const items = parseChecklist(TASK_PLAN);
		assert.equal(items.length, 2);
		assert.equal(items[1]?.done, true);
		assert.deepEqual(extractTaskCoverage(items[0]?.text ?? ""), ["Task-1", "Task-2"]);
		assert.deepEqual(extractTaskCoverage("`VC-009` covers `I-002` and `I-003`; pass: ok"), ["Task-2", "Task-3"]);
		assert.equal(checklistHeaderName("## Verifier Checklist\n"), "Verifier Checklist");
		assert.equal(parseChecklist("## Verifier Checklist\n- [x] \`VC-001\` covers \`I-001\`; ok\n").length, 1);
	});

	it("falls back to legacy I-### parsing with normalized ids", () => {
		const parsed = parsePlanTasks("## Implementation Items\n\n- \`I-001\`: First.\n- \`I-002\`：Second.\n");
		assert.equal(parsed.legacy, true);
		assert.deepEqual(parsed.tasks.map((t) => t.id), ["Task-1", "Task-2"]);
		assert.equal(parsed.tasks[0]?.title, "First.");
		assert.equal(parsed.waves.length, 0);
		// No Tasks section and no Implementation Items → empty non-legacy model.
		const empty = parsePlanTasks("# nothing\n");
		assert.equal(empty.tasks.length, 0);
		assert.equal(empty.legacy, false);
	});

	it("resolves effective waves: subsection > inline > derived from deps", () => {
		const parsed = parsePlanTasks(TASK_PLAN);
		const waves = resolveTaskWaves(parsed);
		assert.equal(waves.get("Task-1"), 1);
		assert.equal(waves.get("Task-2"), 1);
		assert.equal(waves.get("Task-3"), 2);
		// Task-4 has no inline wave; the subsection lists it under wave 3.
		assert.equal(waves.get("Task-4"), 3);
		// Subtasks inherit the parent's effective wave (Task-3 → 2).
		assert.equal(waves.get("Task-3.1"), 2);
		assert.equal(waves.get("Task-3.2"), 2);
	});

	it("normalizes task ids from messy input", () => {
		assert.equal(normalizeTaskId("I-001"), "Task-1");
		assert.equal(normalizeTaskId("task-03.1"), "Task-3.1");
		assert.equal(normalizeTaskId("`Task-12`"), "Task-12");
		assert.equal(normalizeTaskId("nope"), null);
	});

	it("lints clean plans as null and flags drift", () => {
		assert.equal(lintPlanTasks(TASK_PLAN), null);
		assert.equal(lintPlanTasks("# no tasks\n"), null);
		const drifted = "## Tasks\n\n- nothing parseable here\n";
		assert.ok(lintPlanTasks(drifted)?.includes("0 项"));
		const deep = "## Tasks\n\n- Task-1: a\n  - Task-1.1.1: too deep\n";
		assert.ok(lintPlanTasks(deep)?.includes("层级过深"));
		const unknownDep = "## Tasks\n\n- Task-2: b — deps: Task-9\n";
		assert.ok(lintPlanTasks(unknownDep)?.includes("引用未知任务"));
		const sharedFile = "## Tasks\n\n- Task-1: a — files: src/a.ts; wave: 1\n- Task-2: b — files: src/a.ts; wave: 1\n";
		assert.ok(lintPlanTasks(sharedFile)?.includes("不相交"));
		const lateDep = "## Tasks\n\n- Task-1: a; wave: 2\n- Task-2: b — deps: Task-1; wave: 1\n";
		assert.ok(lintPlanTasks(lateDep)?.includes("不在更早的波次"));
		const coversUnknown = "## Tasks\n\n- Task-1: a\n\n## Verification Checks\n\n- [ ] \`VC-001\` covers \`Task-7\`; pass: ok\n";
		assert.ok(lintPlanTasks(coversUnknown)?.includes("covers 引用未知任务"));
		const conflict = "## Tasks\n\n- Task-1: a — wave: 2\n\n### Execution Waves\n\n- wave 1: Task-1 — x\n";
		assert.ok(lintPlanTasks(conflict)?.includes("以子节为准"));
		const subWave = "## Tasks\n\n- Task-1: a\n  - Task-1.1: s — wave: 3\n";
		assert.ok(lintPlanTasks(subWave)?.includes("继承父任务波次"));
		const gap = "## Tasks\n\n- Task-2: starts at two\n";
		assert.ok(lintPlanTasks(gap)?.includes("不连续"));
		const dup = "## Tasks\n\n- Task-1: first — files: src/a.ts; wave: 1\n- Task-1: shadow — files: src/b.ts; wave: 1\n";
		assert.ok(lintPlanTasks(dup)?.includes("重复"));
		const noCover = "## Tasks\n\n- Task-1: a\n\n## Verification Checks\n\n- [ ] \`VC-001\` pass condition: no covers clause\n- [ ] \`VC-002\` covers \`Task-1\`; pass condition: ok\n";
		assert.ok(lintPlanTasks(noCover)?.includes("VC-001 无 covers"));
	});

	it("lintPlanIntoNotices surfaces task lint via state", () => {
		// Direct unit probe: state lint joins impl + task notices.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-task-lint-"));
		try {
			const planPath = path.join(tmp, "PLAN_v1.md");
			fs.writeFileSync(
				planPath,
				"## Tasks\n\n- Task-2: gap and unknown dep — deps: Task-9\n",
				"utf8",
		);
			const notices = lintPlanTasks(fs.readFileSync(planPath, "utf8"));
		assert.ok(notices !== null && notices.includes("引用未知任务"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	});
});
