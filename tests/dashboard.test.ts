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
import { buildTaskView } from "../src/tasks.ts";
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
		assert.ok(lines.some((line) => line.includes("Completion audit: round 2")));
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
