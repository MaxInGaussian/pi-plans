/** Tests for the execution loop: marker tracking, session restore, completion. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	applyDoneMarkers,
	completeExecution,
	consumePendingPanelSync,
	executionContextMessage,
	getExecution,
	isExecutionComplete,
	restoreFromSession,
	startExecution,
	stopExecution,
	toggleExecutionPanelView,
} from "../src/exec.ts";
import type { CheckItem } from "../src/plan.ts";

interface Recorded {
	entries: { type: string; customType?: string; data?: unknown }[];
	messages: { customType: string; content: string }[];
	status: string | undefined;
	widget?: { key: string; options?: unknown; factory: any };
	widgetCalls: number;
}

interface Harness {
	pi: any;
	ctx: any;
	recorded: Recorded;
}

function makeHarness(workdir: string): Harness {
	const recorded: Recorded = { entries: [], messages: [], status: undefined, widgetCalls: 0 };
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			recorded.entries.push({ type: "custom", customType, data });
		},
		sendMessage: (message: { customType: string; content: string }) => {
			recorded.messages.push(message);
		},
	};
	const ui = {
		setStatus: (_key: string, value: string | undefined) => {
			recorded.status = value;
		},
		setWidget: (key: string, factory: any, options?: unknown) => {
			recorded.widgetCalls += 1;
			if (factory === undefined) {
				recorded.widget = undefined;
				return;
			}
			recorded.widget = { key, options, factory };
		},
		theme: {
			fg: (_color: string, text: string) => text,
			strikethrough: (text: string) => `~~${text}~~`,
		},
	};
	const ctx = {
		cwd: workdir,
		ui,
		isIdle: () => true,
	};
	return { pi, ctx, recorded };
}

function items(...ids: string[]): CheckItem[] {
	return ids.map((id) => ({ id, text: `\`${id}\` demo item`, done: false }));
}

describe("execution loop", () => {
	let tmpRoot: string;
	let counter = 0;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-exec-"));
	});

	after(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	function freshWorkdir(): string {
		counter += 1;
		const workdir = path.join(tmpRoot, `repo-${counter}`);
		fs.mkdirSync(workdir, { recursive: true });
		return workdir;
	}

	it("tracks done markers and completes", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001", "VC-002"));

		// Collapsed by default: progress lives in the bottom status bar (same
		// layer as the ⏸ indicator); no panel widget is registered yet.
		assert.equal(recorded.widget, undefined);
		assert.match(recorded.status ?? "", /📋 plans 0\/2: spent \d{2}:\d{2}:\d{2}/);
		assert.match(recorded.status ?? "", /in-toks/);
		assert.match(recorded.status ?? "", /out-toks/);
		assert.match(recorded.status ?? "", /\/plans-list details/);

		toggleExecutionPanelView(pi, ctx);
		assert.ok(recorded.widget);
		assert.equal(recorded.widget?.key, "pi-plans-execution");
		assert.deepEqual(recorded.widget?.options, { placement: "belowEditor" });
		const expandedWidget = recorded.widget?.factory(
			{} as any,
			{ fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~~${text}~~` },
		);
		assert.ok(expandedWidget);
		const expandedLines = expandedWidget.render(80);
		assert.match(expandedLines.join("\n"), /☐/);
		// Detail view never repeats the count or the keyboard hint.
		assert.doesNotMatch(expandedLines.join("\n"), /📋 plans/);
		assert.doesNotMatch(expandedLines.join("\n"), /alt\+o/);

		assert.ok(getExecution());
		const rules = executionContextMessage()!;
		assert.match(rules, /PI-PLANS EXECUTION/);
		assert.match(rules, /VC-001/);
		// Seven-principle rule set: representative anchors (PLAN_v2 D-003/D-004).
		assert.match(rules, /for the long term/);
		assert.match(rules, /Simplest implementation/);
		assert.match(rules, /grow the change in layers/);
		assert.match(rules, /existing dependencies \(docs and types\)/);
		assert.match(rules, /well-maintained libraries/);
		assert.match(rules, /clearly separated concerns/);
		assert.match(rules, /no stopgaps/);
		assert.doesNotMatch(rules, /ponytail/i);

		assert.deepEqual(applyDoneMarkers("progress… [DONE:VC-001] done"), ["VC-001"]);
		assert.equal(isExecutionComplete(), false);
		assert.deepEqual(applyDoneMarkers("final: [DONE:VC-002]"), ["VC-002"]);
		assert.equal(isExecutionComplete(), true);

		completeExecution(pi, ctx);
		assert.equal(getExecution(), null);
		assert.ok(recorded.messages.some((message) => message.customType === "pi-plans-complete"));
	});

	it("restores progress from session entries and rescans messages", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		const snapshot = {
			planPath: path.join(workdir, "PLAN_v1.md"),
			items: items("VC-001", "VC-002"),
			startedAt: "2026-08-25T00:00:00Z",
			panel: {
				expanded: true,
				baseline: { added: 0, removed: 0, files: 0 },
				lastSnapshot: { added: 1, removed: 0, files: 1 },
				touchedPaths: ["src/exec.ts"],
				itemSummaries: {
					"VC-001": {
						summary: { added: 1, removed: 0, files: 1, paths: ["src/exec.ts"] },
					},
				},
			},
		};
		fs.writeFileSync(snapshot.planPath, "# plan");
		const entries = [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "did [DONE:VC-001]" }] },
			},
		];
		restoreFromSession(pi, ctx, entries as any);
		const execution = getExecution();
		assert.ok(execution);
		assert.ok(recorded.widget);
		const widget = recorded.widget?.factory(
			{} as any,
			{ fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~~${text}~~` },
		);
		assert.ok(widget);
		const rendered = widget.render(80);
		assert.match(rendered.join("\n"), /☑/);
		assert.match(rendered.join("\n"), /\+1/);

		const clearedEntries = [...entries, { type: "custom", customType: "pi-plans-exec-cleared", data: {} }];
		restoreFromSession(pi, ctx, clearedEntries as any);
		assert.equal(getExecution(), null);
	});

	it("ignores restore when the plan file vanished", () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		const entries = [
			{
				type: "custom",
				customType: "pi-plans-exec",
				data: {
					planPath: path.join(workdir, "missing-plan.md"),
					items: items("VC-001"),
					startedAt: "2026-08-25T00:00:00Z",
				},
			},
		];
		restoreFromSession(pi, ctx, entries as any);
		assert.equal(getExecution(), null);
	});

	it("stop clears execution", () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		stopExecution(pi, ctx, "test");
		assert.equal(getExecution(), null);
	});

	it("keeps the status bar count-free while executing and points at the panel", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		startExecution(pi, ctx, path.join(workdir, "PLAN_v2.md"), items("VC-001", "VC-002"));

		// Bottom status bar carries the count — the same layer as ⏸ — so both
		// execution states read from one consistent place.
		assert.match(recorded.status ?? "", /📋 plans 0\/2: spent \d{2}:\d{2}:\d{2}/);
		assert.match(recorded.status ?? "", /in-toks/);
		assert.match(recorded.status ?? "", /\/plans-list details/);

		const start = recorded.messages.find((message) => message.customType === "pi-plans-exec-start");
		assert.ok(start);
		assert.match(start.content, /Progress appears in the bottom status bar/);
		assert.doesNotMatch(start.content, /footer/);

		applyDoneMarkers("[DONE:VC-001]");
		completeExecution(pi, ctx);
		assert.equal(getExecution(), null);
	});

	it("defers persistence and widget churn when toggling mid-turn", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		startExecution(pi, ctx, path.join(workdir, "PLAN_v3.md"), items("VC-001", "VC-002"));

		const entriesBefore = recorded.entries.length;
		const factoriesBefore = recorded.widgetCalls;

		// Mid-turn: flip must be pure memory — no session writes, no re-register.
		(ctx as any).isIdle = () => false;
		assert.equal(toggleExecutionPanelView(pi, ctx), true);
		assert.equal(recorded.entries.length, entriesBefore, "busy toggle appended a session entry");
		assert.equal(recorded.widgetCalls, factoriesBefore, "busy toggle re-registered the widget");
		assert.equal(consumePendingPanelSync(), true, "expected a pending panel sync marker");
		assert.equal(consumePendingPanelSync(), false, "marker should be consumed exactly once");

		// Back to idle: the next toggle persists and syncs. It flips the panel to
		// expanded, which registers the detail widget exactly once (no teardown).
		ctx.isIdle = () => true;
		assert.equal(toggleExecutionPanelView(pi, ctx), false);
		assert.ok(recorded.entries.length > entriesBefore, "idle toggle did not persist");
		assert.equal(recorded.widgetCalls, factoriesBefore + 1, "idle toggle churned the widget registration");

		stopExecution(pi, ctx, "test-done");
	});
});
