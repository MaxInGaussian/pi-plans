/** plan-huge display tests: the dashboard progress line, its width budget,
 * the summary line token, and the /plans version-tree chrome. */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parsePlanTasks } from "../src/plan.ts";
import { buildTaskView } from "../src/tasks.ts";
import { deriveDashboardModel, formatDashboardSummaryLine, renderDashboardLines } from "../src/dashboard.ts";
import { hugeChrome } from "../src/ui-language.ts";

const PLAN = `## Tasks

- Task-1: first — files: src/a.ts; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: src/a.ts exists; metric: 0.
`;

function hugeModel(statusLabel: string, width = 100) {
	const tasks = buildTaskView(parsePlanTasks(PLAN), undefined);
	const checklist = [{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false }];
	const model = deriveDashboardModel("demo-huge-run", tasks, checklist, {
		startedAt: "2026-10-04T00:00:00Z",
		huge: { version: "v0.2.0", index: 2, total: 5, statusLabel },
	});
	return { model, lines: renderDashboardLines(model, width) };
}

describe("huge dashboard line", () => {
	it("renders the current version progress inside the widget box", () => {
		const { lines } = hugeModel("规划中");
		const hugeLine = lines.find((line) => line.includes("huge v0.2.0"));
		assert.ok(hugeLine, `expected a huge line in:\n${lines.join("\n")}`);
		assert.match(hugeLine!, /huge v0\.2\.0 2\/5 · 规划中/);
		assert.equal(hugeLine!.startsWith("│"), true);
	});

	it("keeps every rendered line inside the width budget", () => {
		for (const width of [40, 64, 100]) {
			const { lines } = hugeModel("executing", width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${line}`);
			}
			assert.ok(lines.some((line) => line.includes("huge v0.2.0")), `missing huge line at width ${width}`);
		}
	});

	it("omits the huge line for ordinary runs", () => {
		const tasks = buildTaskView(parsePlanTasks(PLAN), undefined);
		const checklist = [{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false }];
		const model = deriveDashboardModel("demo-run", tasks, checklist, { startedAt: "2026-10-04T00:00:00Z" });
		assert.equal(model.huge ?? null, null);
		assert.equal(renderDashboardLines(model, 100).some((line) => line.includes("huge ")), false);
	});

	it("carries the version token into the status-bar summary line", () => {
		const { model } = hugeModel("executing");
		const line = formatDashboardSummaryLine(model);
		assert.match(line, /· huge v0\.2\.0 2\/5/);
	});

	it("renders the localized version-tree lines", () => {
		const zh = hugeChrome("zh");
		const en = hugeChrome("en");
		assert.equal(zh.versionLine("v0.1.0", zh.statusLabel("done"), 2), "- v0.1.0: 已完成 · 第 2 轮");
		assert.equal(en.versionLine("v0.1.0", en.statusLabel("pending"), 0), "- v0.1.0: pending · round 0");
	});
});
