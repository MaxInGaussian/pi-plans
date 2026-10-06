/** Tests for the task dashboard (v0.6.1): compact widget, expanded tree,
 * markers, width adaptation, and the shared summary line.
 *
 * Width invariant: the widget host measures every rendered line with pi-tui's
 * `visibleWidth` and throws an uncaughtException — killing the whole TUI
 * session — when a line is wider than the terminal (real crashes:
 * "Rendered line 157 exceeds terminal width (231 > 230)" and
 * "(114 > 113)"). These tests therefore measure with the *host's* function,
 * not a local reimplementation, so a local/host divergence is caught here
 * rather than in a user's terminal.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parsePlanTasks } from "../src/plan.ts";
import { buildTaskView, flattenTaskViews } from "../src/tasks.ts";
import { visibleWidth as localVisibleWidth } from "../src/refine-ui-helpers.ts";
import {
	deriveDashboardModel,
	formatDashboardSummaryLine,
	openTaskSummary,
	renderDashboardLines,
	renderDashboardTreeLines,
	taskMarker,
} from "../src/dashboard.ts";

const PLAN = `## Tasks

- Task-1: 解析器 — files: src/plan.ts; wave: 1
- Task-2: 工具 — files: src/task-tool.ts; wave: 1
- Task-3: 核心 — deps: Task-1, Task-2; files: src/exec.ts; wave: 2
  - Task-3.1: 注入
  - Task-3.2: 状态机

### Execution Waves

- wave 1: Task-1, Task-2 — 并行
- wave 2: Task-3 — 串行

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: 解析单测
- [ ] \`VC-002\` covers \`Task-3\`; pass condition: 核心测试
`;

function model(progress?: Record<string, { status: "complete" | "skipped" }>) {
	const tasks = buildTaskView(parsePlanTasks(PLAN), progress);
	const checklist = [
		{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: progress?.["Task-1"]?.status === "complete" },
		{ id: "VC-002", text: "`VC-002` covers `Task-3`; pass condition: y", done: false },
	];
	return deriveDashboardModel("demo-run", tasks, checklist, { startedAt: new Date().toISOString() });
}

describe("dashboard model", () => {
	it("summary line carries task and VC progress", () => {
		const line = formatDashboardSummaryLine(model({ "Task-1": { status: "complete" } }));
		assert.match(line, /tasks 1\/5/);
		assert.match(line, /VC 1\/2/);
		assert.match(line, /wave 1/);
	});

	it("markers: ✓ complete, ~ skipped, ▸ current, · pending", () => {
		const m = model({ "Task-1": { status: "complete" }, "Task-2": { status: "skipped" } });
		const flat = m.tasks.flatMap(function walk(t: { id: string; children: unknown[] }) { return [t, ...t.children]; } as never) as never[];
		const byId = new Map(flat.map((t: { id: string }) => [t.id, t]));
		assert.equal(taskMarker(byId.get("Task-1")!, null), "✓");
		assert.equal(taskMarker(byId.get("Task-2")!, null), "~");
		// Task-3 is the first open task in wave order → current.
		assert.equal(taskMarker(byId.get("Task-3")!, "Task-3"), "▸");
		assert.equal(taskMarker(byId.get("Task-3.1")!, "Task-3"), "·");
	});

	it("open task summary lists the current wave and later waves", () => {
		const tasks = buildTaskView(parsePlanTasks(PLAN), { "Task-1": { status: "complete" } });
		const summary = openTaskSummary(tasks);
		assert.match(summary, /current wave 1: Task-2/);
		assert.match(summary, /later waves: Task-3/);
	});
});

describe("compact widget rendering", () => {
	it("renders the current task and files at wide width", () => {
		const lines = renderDashboardLines(model(), 100);
		assert.ok(lines.some((line) => line.includes("Task-1")));
		assert.ok(lines.some((line) => line.includes("src/plan.ts")));
		assert.ok(lines.some((line) => line.includes("Ctrl+Shift+T")));
	});

	it("narrow width drops file lists and stays inside the width", () => {
		const lines = renderDashboardLines(model(), 40);
		assert.ok(!lines.some((line) => line.includes("src/plan.ts")));
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 40, `line too wide (${visibleWidth(line)}): ${line}`);
		}
	});

	it("shows the pause state when paused", () => {
		const m = model();
		m.paused = true;
		m.pausedReason = "no task-status change in 3 rounds";
		const lines = renderDashboardLines(m, 80);
		assert.ok(lines.some((line) => line.includes("⏸")));
	});

	it("shows audit failures when present", () => {
		const m = model();
		m.auditRounds = 1;
		m.auditFailed = ["VC-002"];
		const lines = renderDashboardLines(m, 100);
		assert.ok(lines.some((line) => line.includes("VC-002")));
	});
});

describe("expanded tree rendering", () => {
	it("renders the nested tree with markers, deps, and files at wide width", () => {
		const m = model({ "Task-1": { status: "complete" }, "Task-2": { status: "complete" } });
		const lines = renderDashboardTreeLines(m, 120);
		assert.ok(lines.some((line) => /✓ Task-1/.test(line)));
		assert.ok(lines.some((line) => line.trim().startsWith("· Task-3.1")));
		assert.ok(lines.some((line) => line.includes("(deps: Task-1, Task-2)")));
		assert.ok(lines.some((line) => line.includes("Verification checks:")));
	});

	it("narrow width clips titles and drops file/dep decorations", () => {
		const lines = renderDashboardTreeLines(model(), 60);
		assert.ok(!lines.some((line) => line.includes("(deps:")));
		assert.ok(!lines.some((line) => line.includes("[")));
	});

	it("lists the audit state when a round has run", () => {
		const m = model();
		m.auditRounds = 2;
		m.auditFailed = ["VC-001"];
		const lines = renderDashboardTreeLines(m, 100);
		assert.ok(lines.some((line) => line.includes("Execution review: round 2")));
	});
});

/** Regression cover for the TUI crash: "Rendered line 157 exceeds terminal
 * width (231 > 230)" (2026-09-30, v0.99.1) and the same +1 overflow at 113
 * columns. Root cause: the box rows were built as
 * `content.padEnd(width).slice(0, width) + border` — one column over on every
 * row — and the width math counted UTF-16 units, so CJK titles overflowed by
 * far more than one. */
describe("width invariant (TUI crash regression)", () => {
	const WIDTHS = [1, 2, 3, 5, 8, 20, 40, 63, 64, 79, 80, 95, 96, 113, 114, 120, 200, 229, 230, 231, 300, 400];

	/** Long, CJK-heavy plan: the content that triggered the crash. */
	const STRESS_PLAN = `## Tasks

- Task-1: 移除 typebox 运行时重复声明并改为 peerDependencies 通配声明 — files: package.json, package-lock.json, src/exec.ts, tests/exec.test.ts, tests/impl-review.test.ts; wave: 1
- Task-2: 适配器单测覆盖 check 双分支、schema 透传与 compiled() 非空鸭子形状断言 — files: tests/compiled-schema.test.ts, src/code-graph/schema.ts; wave: 1
- Task-3: 全量验证与冒烟启动 — deps: Task-1, Task-2; files: scripts/validate.ts; wave: 2
  - Task-3.1: 注入

### Execution Waves

- wave 1: Task-1, Task-2 — 并行
- wave 2: Task-3 — 串行

## Verification Checks

- [ ] \`VC-1\` covers \`Task-1\`; pass condition: package.json 无 typebox 残留
- [ ] \`VC-2\` covers \`Task-2\`; pass condition: 适配器单测全绿
`;

	function stressModel() {
		const tasks = buildTaskView(parsePlanTasks(STRESS_PLAN), { "Task-1": { status: "complete" } });
		const checklist = [
			{ id: "VC-1", text: "`VC-1` covers `Task-1`; pass condition: package.json 无 `@sinclair/typebox` 残留", done: true },
			{ id: "VC-2", text: "`VC-2` covers `Task-2`; pass condition: 适配器单测全绿且断言 compiled() 非空", done: false },
		];
		return deriveDashboardModel("20260930T051445Z-fix-binary-ref-download-with-a-very-long-topic-slug", tasks, checklist, {
			auditRounds: 1,
			auditFailed: ["VC-2"],
			pausedReason: "连续 3 轮无任务状态变化自动暂停 — 完成审计已耗尽预算",
		});
	}

	const states = (): [string, ReturnType<typeof stressModel>][] => {
		const base = stressModel();
		return [
			["running", base],
			["paused", { ...base, paused: true, pausedReason: base.pausedReason as string }],
			["all-terminal", { ...base, tasks: base.tasks.map((t) => ({ ...t, status: "complete" as const })) }],
			["audit-failed", { ...base, auditRounds: 3, auditFailed: ["VC-1", "VC-2"] }],
			// v0.9.2: the blocker row must keep the exact-width invariant too.
			["blocked", { ...base, blockedTasks: ["Task-1", "Task-3", "Task-3.1"], blockedRound: 1 }],
			["blocked-paused", { ...base, paused: true, pausedReason: "blocked: review round 2 cannot start — 1 task(s) reopened by round 1 still open (Task-3)", blockedTasks: ["Task-3"], blockedRound: 1 }],
		];
	};

	for (const [label, render] of [
		["compact", renderDashboardLines],
		["tree", renderDashboardTreeLines],
	] as const) {
		it(`${label} view never exceeds the terminal width at any width`, () => {
			for (const [state, m] of states()) {
				for (const width of WIDTHS) {
					for (const line of render(m, width)) {
						assert.ok(
							visibleWidth(line) <= width,
							`${label}/${state} @${width}: line is ${visibleWidth(line)} columns: ${line}`,
						);
					}
				}
			}
		});
	}

	it("compact box rows are exactly the terminal width (the +1 border overflow)", () => {
		for (const [state, m] of states()) {
			for (const width of [40, 64, 113, 230]) {
				for (const line of renderDashboardLines(m, width)) {
					assert.equal(visibleWidth(line), width, `${state} @${width}: ${line}`);
				}
			}
		}
	});

	it("keeps the progress bar and the right border at wide widths", () => {
		const m = stressModel();
		const [top, progress] = renderDashboardLines(m, 230);
		assert.ok(top.startsWith("┌─ "), "top row opens with the box corner");
		assert.ok(top.endsWith("┐"), "top row closes with the right border");
		assert.ok(progress.includes("█"), "progress bar survives a long topic");
		assert.ok(!top.includes("█"), "the bar moved to the progress row, not the title row");
	});

	it("title row is π-plans: <plan>, brand accented and the rest muted", () => {
		const m = stressModel();
		const fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
		const [title] = renderDashboardLines(m, 100, { fg });
		// Brand in the accent colour, plan name in muted — as sibling spans, so a
		// closing reset cannot strip the colour off everything after it.
		assert.ok(title.startsWith("<muted>┌─ </muted><accent>π-plans</accent>"), `brand span: ${title}`);
		assert.ok(title.includes("<muted>: 20260930T051445Z-"), `plan name muted: ${title}`);
		assert.ok(!/<muted>[^<]*<\/muted><accent>[^<]*<\/accent><muted>[^<]*π-plans/.test(title), "brand is not nested inside a muted span");
	});

	it("progress row spells out the counts and carries elapsed time then the bar", () => {
		const m = stressModel();
		const [, progress] = renderDashboardLines(m, 100);
		assert.match(progress, /│ Tasks \d+\/\d+ · Verification checks \d+\/\d+ /);
		// Elapsed time precedes the bar, both on the progress row.
		assert.match(progress, /\d{2}:\d{2}:\d{2} [█░]+/);
		assert.ok(!/VC \d+\//.test(progress), "the VC abbreviation is gone");
	});

	it("drops the bar, then elapsed time, when the row cannot fit them", () => {
		const m = stressModel();
		for (const width of [12, 20, 24, 30, 40, 64]) {
			const [, progress] = renderDashboardLines(m, width);
			assert.ok(visibleWidth(progress) <= width, `progress row fits at ${width}`);
		}
		// Where the full counts fit they always survive; the abbreviation the old
		// layout used is never substituted back in.
		assert.match(renderDashboardLines(m, 40)[1], /Tasks \d+\/\d+ · Verification checks \d+\/\d+/);
	});

	it("local width helper agrees with the host on every glyph the dashboard emits", () => {
		// The dashboard sizes rows with the local helper but the host measures
		// them. A disagreement in the crash-causing direction (local < host)
		// silently reintroduces the overflow, so pin the glyph set.
		for (const glyph of ["┌", "┐", "└", "┘", "│", "─", "⏸", "▸", "·", "✗", "✓", "☑", "☐", "█", "░", "—", "…", "~"]) {
			assert.equal(localVisibleWidth(glyph), visibleWidth(glyph), `glyph width mismatch for ${JSON.stringify(glyph)}`);
		}
	});
});

describe("rolled-back task rendering", () => {
	const CHECKS = () => [
		{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false },
		{ id: "VC-002", text: "`VC-002` covers `Task-3`; pass condition: y", done: false },
	];

	function withProgress(progress: Record<string, { status: "complete" | "skipped" | "pending"; evidence?: string }>) {
		return deriveDashboardModel("demo-run", buildTaskView(parsePlanTasks(PLAN), progress), CHECKS(), {
			startedAt: new Date().toISOString(),
		});
	}

	it("marks a rolled-back task distinctly from untouched pending work", () => {
		// A rollback keeps the task's evidence (Task-2.1), so "pending with
		// evidence" is the observable signature of work that was reopened.
		const tasks = withProgress({
			"Task-1": { status: "pending" },
			"Task-2": { status: "pending", evidence: "wired the tool" },
		}).tasks;
		const rolled = tasks.find((t) => t.id === "Task-2")!;
		const untouched = tasks.find((t) => t.id === "Task-1")!;
		assert.equal(taskMarker(rolled, null), "↺");
		assert.equal(taskMarker(untouched, null), "·");
		// The current-task indicator still wins over the rollback marker.
		assert.equal(taskMarker(rolled, "Task-2"), "▸");
	});

	it("shows the retained evidence on a rolled-back row in the tree view", () => {
		const tree = renderDashboardTreeLines(
			withProgress({
				"Task-1": { status: "pending" },
				"Task-2": { status: "pending", evidence: "wired the tool" },
			}),
			100,
		).join("\n");
		assert.match(tree, /↺ Task-2/, "the rolled-back row carries its own marker");
		assert.match(tree, /wired the tool/, "the previous attempt's evidence is visible");
	});

	const terminal = (extra: { auditRounds?: number; auditFailed?: string[]; auditUndeterminable?: string[]; reviewRunning?: boolean }) => {
		const base = withProgress({
			"Task-1": { status: "complete", evidence: "done" },
			"Task-2": { status: "complete", evidence: "done" },
			"Task-3": { status: "complete", evidence: "done" },
			"Task-3.1": { status: "complete", evidence: "done" },
			"Task-3.2": { status: "complete", evidence: "done" },
		});
		return deriveDashboardModel("demo-run", base.tasks, base.checklist, { startedAt: base.startedAt, ...extra });
	};

	it("shows the undeterminable count instead of a completion tick", () => {
		const owed = terminal({ auditRounds: 2, auditUndeterminable: ["VC-001", "VC-002"] });
		const panel = renderDashboardLines(owed, 80);
		assert.ok(panel.some((l) => /undeterminable/.test(l)), "panel reports undeterminable");
		assert.ok(!panel.some((l) => /audit complete/.test(l)), "no false completion tick");
		const tree = renderDashboardTreeLines(owed, 100).join("\n");
		assert.match(tree, /undeterminable: VC-001, VC-002/);
		assert.doesNotMatch(tree, /passed ✓/);
	});

	it("shows the retained evidence for rolled-back work in the COMPACT view too", () => {
		// VC-006 requires the evidence in both views. The first implementation
		// only added it to the tree, which the execution review caught.
		const m = withProgress({
			"Task-1": { status: "pending", evidence: "rewrote src/plan.ts" },
			"Task-2": { status: "complete", evidence: "wired the tool" },
		});
		const panel = renderDashboardLines(m, 90).join("\n");
		assert.match(panel, /\u21ba Task-1/, "compact panel marks the rolled-back task");
		assert.match(panel, /rewrote src\/plan\.ts/, "compact panel shows the retained evidence");
		const tree = renderDashboardTreeLines(m, 100).join("\n");
		assert.match(tree, /rewrote src\/plan\.ts/, "tree view still shows it");
	});

	it("keeps every compact row inside the width budget with rollback rows present", () => {
		const m = deriveDashboardModel(
			"demo-run",
			buildTaskView(parsePlanTasks(PLAN), {
				"Task-1": { status: "pending", evidence: "a very long piece of evidence that must be clipped to fit the panel width" },
				"Task-2": { status: "pending", evidence: "another long evidence string for the second rolled-back task" },
				"Task-3": { status: "pending", evidence: "a third one that must be capped out of the panel" },
			}),
			CHECKS(),
			{ startedAt: new Date().toISOString(), auditRounds: 1, auditFailed: ["VC-001"], auditUndeterminable: ["VC-002"] },
		);
		for (const width of [46, 64, 80, 120]) {
			for (const row of renderDashboardLines(m, width)) {
				assert.ok(visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(row)}`);
			}
		}
		const rows = renderDashboardLines(m, 90).filter((l) => /\u21ba /.test(l));
		assert.equal(rows.length, 2, "rollback rows are capped so the panel height stays bounded");
	});

	it("never shows the completion tick while a review round runs or checks are owed (v0.8)", () => {
		// The v0.7 mis-cue: `audit complete ✓` rendered for the whole duration
		// of a running round (auditRounds was pre-incremented, the model had no
		// running field). Now the running/owed states render their round number.
		const running = terminal({ auditRounds: 1, reviewRunning: true });
		const runningPanel = renderDashboardLines(running, 80).join("\n");
		assert.match(runningPanel, /review: round 2\/5 running/, "the running round is visible with its number");
		assert.doesNotMatch(runningPanel, /audit complete/, "no tick while a round runs");
		const runningTree = renderDashboardTreeLines(running, 100).join("\n");
		assert.match(runningTree, /Execution review: round 2\/5 running/);
		const owed = terminal({ auditRounds: 1 });
		const owedPanel = renderDashboardLines(owed, 80).join("\n");
		assert.doesNotMatch(owedPanel, /audit complete/, "no tick while checks are still owed");
		assert.match(owedPanel, /review: round 2\/5 — verdict pending/, "the owed state shows the pending round");
	});

	it("shows the completion tick only when every check is really done", () => {
		const settled = terminal({ auditRounds: 1 });
		const model = { ...settled, checklist: settled.checklist.map((item) => ({ ...item, done: true })) };
		assert.ok(renderDashboardLines(model, 80).some((l) => /audit complete/.test(l)));
	});

	it("still reports real failures ahead of undeterminable ones", () => {
		const mixed = terminal({ auditRounds: 2, auditFailed: ["VC-001"], auditUndeterminable: ["VC-002"] });
		const tree = renderDashboardTreeLines(mixed, 100).join("\n");
		assert.match(tree, /failed: VC-001/, "a real failure takes the tree audit line");
		assert.doesNotMatch(tree, /undeterminable:/, "and suppresses the softer outcome there");
		const panel = renderDashboardLines(mixed, 80);
		assert.ok(panel.some((l) => /check\(s\) failed/.test(l)));
		assert.ok(panel.some((l) => /\? VC-002/.test(l)), "the unreadable checks still get their own panel row");
	});

	it("keeps the width invariant with the new rows", () => {
		const rows = renderDashboardLines(terminal({ auditRounds: 2, auditFailed: ["VC-001"], auditUndeterminable: ["VC-002"] }), 46);
		for (const row of rows) {
			assert.ok(visibleWidth(row) <= 46, `row too wide: ${JSON.stringify(row)}`);
		}
	});
});

describe("findings visibility (v0.9)", () => {
	const findings = [
		{ id: "F-001", severity: "high", note: "union rollback missing", taskIds: ["Task-3"] },
		{ id: "F-002", severity: "medium", note: "polish", taskIds: [] },
	];

	function withFindings(extra: { auditRounds?: number; reviewRunning?: boolean }) {
		const tasks = buildTaskView(parsePlanTasks(PLAN), {});
		const checklist = [
			{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false },
			{ id: "VC-002", text: "`VC-002` covers `Task-3`; pass condition: y", done: false },
		];
		return deriveDashboardModel("demo-run", tasks, checklist, {
			startedAt: new Date().toISOString(),
			findings,
			auditRounds: extra.auditRounds ?? null,
			reviewRunning: extra.reviewRunning ?? false,
		});
	}

	it("summary line shows review round/5 and the high count", () => {
		const line = formatDashboardSummaryLine(withFindings({ auditRounds: 2 }));
		assert.match(line, /review r2\/5/);
		assert.match(line, /1 high/);
	});

	it("summary line omits the high token when only non-high findings remain", () => {
		const tasks = buildTaskView(parsePlanTasks(PLAN), {});
		const m = deriveDashboardModel("demo-run", tasks, [], {
			startedAt: new Date().toISOString(),
			findings: [{ id: "F-002", severity: "medium", note: "polish", taskIds: [] }],
			auditRounds: 3,
		});
		const line = formatDashboardSummaryLine(m);
		assert.match(line, /review r3\/5/);
		assert.doesNotMatch(line, /high/);
	});

	it("compact panel renders the high-findings line in BOTH phases", () => {
		// Non-terminal phase (the executor is repairing): the line must show.
		const repairing = renderDashboardLines(withFindings({ auditRounds: 1 }), 80);
		assert.ok(repairing.some((l) => /⚠.*high: F-001/.test(l)), "high findings visible while repairing");

		// Terminal phase: still visible alongside the round counter.
		const everyId = Object.fromEntries(
			flattenTaskViews(buildTaskView(parsePlanTasks(PLAN), {})).map((t) => [t.id, { status: "complete" as const }]),
		);
		const allDone = buildTaskView(parsePlanTasks(PLAN), everyId);
		const terminal = deriveDashboardModel("demo-run", allDone, [], {
			startedAt: new Date().toISOString(),
			findings,
			auditRounds: 1,
		});
		const lines = renderDashboardLines(terminal, 80);
		assert.ok(lines.some((l) => /⚠.*high: F-001/.test(l)));
		assert.ok(lines.some((l) => /high finding\(s\) unresolved/.test(l)));
	});

	it("tree view lists findings with severity and mapping, and the verdict line names unresolved highs", () => {
		const lines = renderDashboardTreeLines(withFindings({ auditRounds: 2 }), 100);
		assert.ok(lines.some((l) => /⚠ F-001 \(high, Task-3\): union rollback missing/.test(l)));
		assert.ok(lines.some((l) => /· F-002 \(medium\): polish/.test(l)));
		assert.ok(lines.some((l) => /high findings unresolved: F-001/.test(l)));
	});
});

describe("blocked-review visibility (v0.9.2)", () => {
	function withBlocker(extra: { paused?: boolean; pausedReason?: string } = {}) {
		const tasks = buildTaskView(parsePlanTasks(PLAN), {});
		const checklist = [{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false }];
		return deriveDashboardModel("demo-run", tasks, checklist, {
			startedAt: new Date().toISOString(),
			auditRounds: 1,
			auditFailed: ["VC-002"],
			blockedTasks: ["Task-3", "Task-3.1"],
			blockedRound: 1,
			...extra,
		});
	}

	it("compact panel names the blocker and what to do about it", () => {
		const lines = renderDashboardLines(withBlocker(), 100);
		assert.ok(lines.some((l) => /⊘ blocked: Task-3, Task-3\.1 \(reopened by round 1\) — close with plans_update_task/.test(l)));
		// Narrow widths keep the ids and drop the instruction.
		const narrow = renderDashboardLines(withBlocker(), 40);
		assert.ok(narrow.some((l) => /⊘ blocked: Task-3, Task-3\.1/.test(l)));
	});

	it("the blocker row survives a paused run (the pause summary may be clipped)", () => {
		const lines = renderDashboardLines(withBlocker({ paused: true, pausedReason: "blocked: review round 2 cannot start — 2 task(s) reopened by round 1 still open" }), 100);
		assert.ok(lines.some((l) => /⏸ blocked: review round 2 cannot start/.test(l)));
		assert.ok(lines.some((l) => /⊘ blocked: Task-3/.test(l)), "blocker row still lists the tasks");
	});

	it("the summary line carries the blocked token only when blockers exist", () => {
		assert.match(formatDashboardSummaryLine(withBlocker()), / · ⊘ blocked$/);
		const tasks = buildTaskView(parsePlanTasks(PLAN), {});
		const clean = deriveDashboardModel("demo-run", tasks, [], { startedAt: new Date().toISOString(), auditRounds: 1 });
		assert.doesNotMatch(formatDashboardSummaryLine(clean), /blocked/);
	});
});

describe("review-budget visibility (v0.9.3)", () => {
	function withBudget(extra: Record<string, unknown> = {}) {
		const tasks = buildTaskView(parsePlanTasks(PLAN), {});
		const checklist = [{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false }];
		return deriveDashboardModel("demo-run", tasks, checklist, {
			startedAt: new Date().toISOString(),
			auditRounds: 2,
			...extra,
		});
	}

	it("the summary line renders the chosen budget denominator", () => {
		assert.match(formatDashboardSummaryLine(withBudget({ reviewBudget: 3 })), / · review r2\/3/);
		assert.match(formatDashboardSummaryLine(withBudget({ reviewBudget: "unlimited" })), / · review r2\/∞/);
		// A model without the field (legacy fixtures/checkpoints) reads as 5.
		assert.match(formatDashboardSummaryLine(withBudget()), / · review r2\/5/);
	});

	it("the compact panel renders the budget denominator too", () => {
		// The review row only renders once every task is terminal.
		const terminal = (extra: Record<string, unknown>) => {
			const tasks = buildTaskView(parsePlanTasks(PLAN), {
				"Task-1": { status: "complete" },
				"Task-2": { status: "complete" },
				"Task-3": { status: "complete" },
				"Task-3.1": { status: "complete" },
				"Task-3.2": { status: "complete" },
			});
			const checklist = [{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false }];
			return deriveDashboardModel("demo-run", tasks, checklist, { startedAt: new Date().toISOString(), auditRounds: 2, ...extra });
		};
		const lines = renderDashboardLines(terminal({ reviewBudget: 3 }), 100);
		assert.ok(lines.some((l) => /review: round 3\/3/.test(l)), "the numeric budget renders");
		const unlimited = renderDashboardLines(terminal({ reviewBudget: "unlimited" }), 100);
		assert.ok(unlimited.some((l) => /review: round 3\/∞/.test(l)), "the unlimited budget renders");
	});

	it("the expanded view carries the default annotation and the unlimited hard-cap progress", () => {
		const defaulted = renderDashboardTreeLines(withBudget({ reviewBudget: 3, reviewBudgetDefaulted: true }), 120);
		assert.ok(defaulted.some((l) => /Execution review: round 2\/3 \(default\)/.test(l)));
		const userPicked = renderDashboardTreeLines(withBudget({ reviewBudget: 3 }), 120);
		assert.ok(userPicked.some((l) => /Execution review: round 2\/3/.test(l)));
		assert.equal(userPicked.some((l) => /\(default\)/.test(l)), false, "a user pick carries no annotation");
		const unlimited = renderDashboardTreeLines(
			withBudget({ reviewBudget: "unlimited", reviewRoundsTotal: 12, reviewCapExtension: 50 }),
			120,
		);
		assert.ok(unlimited.some((l) => /Execution review: round 2\/∞ · cap 12\/100/.test(l)), "the run-cumulative cap progress renders");
	});

	it("keeps the width invariant with the budget row present", () => {
		const lines = renderDashboardLines(withBudget({ reviewBudget: "unlimited", reviewBudgetDefaulted: true }), 60);
		for (const line of lines) {
			assert.equal(localVisibleWidth(line), localVisibleWidth(line));
			assert.ok(visibleWidth(line) <= 60, `line exceeds 60 columns: ${line}`);
		}
	});
});

/**
 * v0.10: the review chrome that the dashboard and the completion/termination
 * summaries share. Non-high findings are no longer "residual": they drive the
 * single non-high repair cycle and are labelled unresolved.
 */
describe("review chrome labels (v0.10)", () => {
	it("both locales label non-high findings unresolved, not residual", async () => {
		const { terminationChrome } = await import("../src/ui-language.ts");
		assert.match(terminationChrome("zh").residualLabel(2), /未解决非 high/, "zh carries the unresolved wording");
		assert.match(terminationChrome("en").residualLabel(2), /Unresolved non-high findings/, "en carries the unresolved wording");
		assert.doesNotMatch(terminationChrome("en").residualLabel(2), /Residual/, "the old residual wording is gone");
	});
});
