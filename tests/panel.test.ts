/**
 * Fixed tasks' status panel model + rendering tests (0.4.0 feature 2).
 * The panel is the single source of truth for the aboveEditor widget, the
 * status-bar summary line and the execution injection text (D-014/R-011).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BADGE_ROW_COUNT,
	MIN_PANEL_WIDTH,
	PANEL_ROW_COUNT,
	deriveNextAction,
	derivePanelModel,
	formatActivityTime,
	formatPanelSummaryLine,
	renderPanelLines,
} from "../src/panel.ts";
import { visibleWidth } from "../src/refine-ui-helpers.ts";

function exec(over: Record<string, unknown> = {}) {
	return {
		items: [
			{ id: "VC-001", text: "`VC-001` panel works", done: false },
			{ id: "VC-002", text: "`VC-002` no regressions", done: false },
			{ id: "VC-003", text: "`VC-003` docs updated", done: false },
		],
		implItems: [
			{ id: "I-001", text: "Add batch form." },
			{ id: "I-002", text: "Add fixed panel." },
			{ id: "I-003", text: "Bump version." },
		],
		implStatus: {},
		currentI: undefined,
		goalWait: { noProgressRounds: 0, waitRounds: 0, lastMarkers: null, paused: false },
		...over,
	} as never;
}

describe("derivePanelModel", () => {
	it("derives remaining I, current I (inferred) and next action from fresh state", () => {
		const model = derivePanelModel(exec(), "my-topic", false);
		assert.equal(model.topic, "my-topic");
		assert.equal(model.remainingI, 3);
		assert.equal(model.totalI, 3);
		assert.equal(model.vcDone, 0);
		assert.equal(model.vcTotal, 3);
		assert.equal(model.currentI, "I-001");
		assert.equal(model.currentInferred, true);
		assert.match(model.nextAction, /^Implement I-001/);
		assert.equal(model.phase, "executing");
	});

	it("prefers the marker-backed current I and never persists the inferred fallback", () => {
		const model = derivePanelModel(exec({ currentI: "I-003" }), "t", false);
		assert.equal(model.currentI, "I-003");
		assert.equal(model.currentInferred, false);
		assert.match(model.nextAction, /^Implement I-003/);
	});

	it("drops a stale marker current I that points at an already-passed item", () => {
		const withCoverage = {
			items: [
				{ id: "VC-001", text: "`VC-001` covers `I-001`; pass", done: true },
				{ id: "VC-002", text: "`VC-002` covers `I-002`; pass", done: false },
			],
			implItems: [
				{ id: "I-001", text: "One." },
				{ id: "I-002", text: "Two." },
			],
		};
		const model = derivePanelModel(exec({ ...withCoverage, currentI: "I-001" }), "t", false);
		assert.notEqual(model.currentI, "I-001");
		assert.equal(model.currentI, "I-002");
	});

	it("marks goal-wait paused with a user-action next action", () => {
		const model = derivePanelModel(
			exec({
				goalWait: { noProgressRounds: 3, waitRounds: 6, lastMarkers: null, paused: true, pausedReason: "no progress" },
			}),
			"t",
			false,
		);
		assert.equal(model.phase, "paused");
		assert.match(model.nextAction, /paused/);
		assert.match(model.nextAction, /plans-execute/);
	});

	it("marks waiting state from the explicit approximation signal", () => {
		const model = derivePanelModel(
			exec({ goalWait: { noProgressRounds: 0, waitRounds: 2, lastMarkers: null, paused: false } }),
			"t",
			true,
		);
		assert.equal(model.phase, "goal-wait");
		assert.match(model.nextAction, /waiting for a subprocess/);
	});

	it("reports completion when nothing remains", () => {
		const model = derivePanelModel(
			exec({
				items: [{ id: "VC-001", text: "`VC-001` covers `I-001`, `I-002`, `I-003`; pass", done: true }],
				implStatus: { "I-001": "implemented", "I-002": "implemented", "I-003": "implemented" },
			}),
			"t",
			false,
		);
		assert.equal(model.remainingI, 0);
		assert.match(model.nextAction, /Report completion/);
	});
});

describe("renderPanelLines", () => {
	const WIDTHS = [20, 24, 30, 39, 60, 80, 100, 140];

	it("renders exactly PANEL_ROW_COUNT rows at >= MIN_PANEL_WIDTH and BADGE_ROW_COUNT below", () => {
		for (const width of WIDTHS) {
			const lines = renderPanelLines(derivePanelModel(exec({ currentI: "I-002" }), "v0-4-0-表单-执行面板", false), width);
			assert.equal(
				lines.length,
				width >= MIN_PANEL_WIDTH ? PANEL_ROW_COUNT : BADGE_ROW_COUNT,
				`width ${width}`,
			);
		}
	});

	it("never emits a line wider than the terminal width, including CJK topics", () => {
		for (const width of WIDTHS) {
			const lines = renderPanelLines(
				derivePanelModel(exec({ currentI: "I-002" }), "升级-0.4.0-批量表单与固定状态面板-专题", false),
				width,
			);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`width ${width}: ${JSON.stringify(line)} is ${visibleWidth(line)} wide`,
				);
			}
		}
	});

	it("keeps box borders intact and pads every content row to the fixed width", () => {
		for (const width of WIDTHS) {
			const lines = renderPanelLines(derivePanelModel(exec({ currentI: "I-002" }), "t", false), width);
			if (lines.length === PANEL_ROW_COUNT) {
				assert.ok(lines[0].startsWith("╭"));
				assert.ok(lines[0].endsWith("╮"));
				assert.ok(lines.at(-1)!.startsWith("╰"));
				assert.ok(lines.at(-1)!.endsWith("╯"));
			} else {
				assert.ok(lines[0].startsWith("╭"));
				assert.ok(lines.at(-1)!.endsWith("╯"));
			}
			for (const line of lines) {
				assert.equal(visibleWidth(line), width, `width ${width} pads to fixed width`);
			}
		}
	});

	it("shows the current I and next action prominently", () => {
		const lines = renderPanelLines(derivePanelModel(exec({ currentI: "I-002" }), "t", false), 100);
		assert.ok(lines.join("\n").includes("I-002"));
		assert.ok(lines.join("\n").includes("Next: Implement I-002"));
	});

	it("renders the goal-wait paused fixture", () => {
		const model = derivePanelModel(
			exec({ goalWait: { noProgressRounds: 3, waitRounds: 6, lastMarkers: null, paused: true, pausedReason: "no progress" } }),
			"t",
			false,
		);
		const lines = renderPanelLines(model, 100);
		assert.ok(lines.join("\n").includes("paused"));
		assert.ok(lines.join("\n").includes("plans-execute"));
	});
});

describe("formatPanelSummaryLine", () => {
	it("derives the status line from the same model as the panel", () => {
		const model = derivePanelModel(exec({ currentI: "I-002" }), "my-topic", false);
		const summary = formatPanelSummaryLine(model);
		assert.match(summary, /^plans: my-topic ▸ exec/);
		assert.match(summary, /I 0\/3/);
		assert.match(summary, /VC 0\/3/);
		assert.match(summary, /next: Implement I-002/);
		assert.ok(summary.includes(model.nextAction));
	});

	it("keeps goal-wait paused readable in one line", () => {
		const model = derivePanelModel(
			exec({ goalWait: { noProgressRounds: 3, waitRounds: 6, lastMarkers: null, paused: true, pausedReason: "no progress" } }),
			"t",
			false,
		);
		assert.match(formatPanelSummaryLine(model), /goal-wait paused/);
	});
});

describe("deriveNextAction", () => {
	it("prefers Verify wording once an item is implemented", () => {
		const statuses = { "I-001": "implementing" as const, "I-002": "implemented" as const, "I-003": "pending" as const };
		const next = deriveNextAction(exec(), false, statuses, [{ id: "VC-001", text: "x", done: false }], "I-002");
		assert.match(next, /^Verify I-002/);
	});

	it("falls back to the verifier list without implementation items", () => {
		const noImpl = { items: exec().items, implItems: [], implStatus: {}, currentI: undefined, goalWait: undefined };
		const next = deriveNextAction(noImpl, false, {}, noImpl.items, undefined);
		assert.match(next, /^Verify VC-001/);
	});

	it("suggests reporting completion only when nothing remains", () => {
		const none = {
			items: [{ id: "VC-001", text: "`VC-001` covers `I-001`; pass", done: true }],
			implItems: [{ id: "I-001", text: "One." }],
			implStatus: { "I-001": "implemented" as const },
			currentI: undefined,
			goalWait: undefined,
		};
		assert.match(deriveNextAction(none, false, { "I-001": "vc-passed" }, []), /Report completion/);
	});
});

describe("activity line (0.5.2 legend dedupe)", () => {
	const origTZ = process.env.TZ;
	before(() => {
		process.env.TZ = "UTC";
	});
	after(() => {
		if (origTZ === undefined) delete process.env.TZ;
		else process.env.TZ = origTZ;
	});

	it("formatActivityTime formats a valid ISO stamp as MM-DD HH:mm", () => {
		assert.equal(formatActivityTime("2026-09-18T15:02:00Z"), "09-18 15:02");
	});

	it("formatActivityTime degrades empty and invalid input to --", () => {
		assert.equal(formatActivityTime(null), "--");
		assert.equal(formatActivityTime(undefined), "--");
		assert.equal(formatActivityTime(""), "--");
		assert.equal(formatActivityTime("not-a-timestamp"), "--");
	});

	it("derives activity from the run record (status · since time)", () => {
		const model = derivePanelModel(exec(), "t", false, {
			status: "executing",
			created_at: "2026-09-18T10:00:00Z",
			updated_at: "2026-09-18T15:02:00Z",
		});
		assert.equal(model.activity, "executing · since 09-18 15:02");
	});

	it("falls back to created_at when updated_at is empty", () => {
		const model = derivePanelModel(exec(), "t", false, {
			status: "executing",
			created_at: "2026-09-18T10:00:00Z",
			updated_at: "",
		});
		assert.equal(model.activity, "executing · since 09-18 10:00");
	});

	it("falls back to the phase word without a run record", () => {
		assert.equal(derivePanelModel(exec(), "t", false, null).activity, "executing");
		assert.equal(derivePanelModel(exec(), "t", false, undefined).activity, "executing");
		const paused = derivePanelModel(
			{ items: [], goalWait: { paused: true, pausedReason: "waiting for user" } },
			"t",
			false,
			null,
		);
		assert.equal(paused.activity, "paused");
	});

	it("renders the activity row plus a legend-free pure bottom border", () => {
		const model = derivePanelModel(exec(), "t", false, {
			status: "executing",
			created_at: "2026-09-18T10:00:00Z",
			updated_at: "2026-09-18T15:02:00Z",
		});
		const lines = renderPanelLines(model, 100);
		assert.equal(lines.length, PANEL_ROW_COUNT);
		assert.match(lines[5]!, /executing · since 09-18 15:02/);
		const last = lines[6]!;
		assert.ok(last.startsWith("╰"), "bottom border preserved");
		assert.ok(!last.includes("▸"), "no embedded I-state legend");
		assert.ok(!last.includes("[I-"), "no marker syntax in the border");
		const all = lines.join("\n");
		assert.ok(!all.includes("markers:"), "markers legend row removed");
		assert.ok(!all.includes("[DONE:VC-"), "DONE marker legend removed from the panel");
	});
});

describe("no-timer discipline", () => {
	it("the panel module never starts periodic timers", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "src", "panel.ts"), "utf8");
		assert.doesNotMatch(source, /setInterval|setTimeout/);
		assert.doesNotMatch(source, /requestAnimationFrame/);
	});
});
