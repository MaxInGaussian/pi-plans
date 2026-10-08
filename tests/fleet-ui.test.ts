import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { AgentFleet } from "../src/agent-fleet.ts";
import { FleetUiController, SubagentOverlay, formatElapsed, formatTokens, renderFleetLines, usageText, FLEET_WIDGET_KEY } from "../src/fleet-ui.ts";
import { visibleWidth } from "../src/refine-ui-helpers.ts";
import { __clearPiTuiForTests, __setPiTuiForTests } from "../src/terminal-keys.ts";

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

const ansiTheme = {
	fg: (color: string, text: string) => `\x1b[${color === "border" ? 31 : color === "borderAccent" ? 32 : 33}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as never;

function seed(fleet: AgentFleet, labels: string[], role: "reviewer" | "refs" | "auditor" | "executor" = "reviewer", groupId = "g1") {
	const group = fleet.registerGroup({ groupId, role, lanes: labels.map((label) => ({ id: label, label })) });
	for (const label of labels) {
		group.update(label, { type: "turn", phase: "start", turnIndex: 1 });
		group.update(label, { type: "transcript", phase: "update", entryType: "assistant-text", key: "content:0", text: `${label} output`, update: "replace", streaming: false });
	}
	return group;
}

describe("renderFleetLines", () => {
	it("renders a bulleted list with one row per agent, no panes", () => {
		const fleet = new AgentFleet();
		seed(fleet, ["correctness", "ordering", "verification"]);
		const lines = renderFleetLines({ entries: fleet.list(), selected: null, now: Date.now(), lang: "en", theme: fakeTheme, width: 100 });
		assert.match(lines[0]!, /^Subagents \(3\) · 3 running/);
		const rows = lines.filter((line) => line.startsWith("•"));
		assert.equal(rows.length, 3);
		assert.ok(rows[0]!.includes("correctness"));
		assert.ok(lines.at(-1)!.includes("↓ browse subagents"));
		assert.equal(lines.some((line) => /[┌└│]/.test(line)), false);
	});

	it("marks the selected row and swaps the hint when focused", () => {
		const fleet = new AgentFleet();
		seed(fleet, ["a", "b"]);
		const lines = renderFleetLines({ entries: fleet.list(), selected: 1, now: Date.now(), lang: "en", theme: fakeTheme, width: 100 });
		assert.ok(lines.some((line) => line.startsWith("▸ b")));
		assert.ok(lines.some((line) => line.startsWith("• a")));
		assert.ok(lines.at(-1)!.includes("Enter view"));
	});

	it("shows tool counts, idle workers and notes", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["worker-1"], "executor");
		group.update("worker-1", { type: "transcript", phase: "start", entryType: "tool-call", key: "tool:c1", text: "{}", update: "replace", streaming: true, toolName: "edit" });
		group.setNote("worker-1", "1/3 tasks");
		group.setIdle("worker-1", true);
		const [, row] = renderFleetLines({ entries: fleet.list(), selected: null, now: Date.now(), lang: "en", theme: fakeTheme, width: 120 });
		assert.match(row!, /worker-1 idle/);
		assert.match(row!, /1 tool calls/);
		assert.match(row!, /1\/3 tasks/);
	});

	it("shows input/output tokens and the context percentage beside the tool count", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["worker-1"], "executor");
		group.update("worker-1", { type: "transcript", phase: "start", entryType: "tool-call", key: "tool:c1", text: "{}", update: "replace", streaming: true, toolName: "edit" });
		group.update("worker-1", { type: "usage", input: 12_345, output: 1_234, contextPercent: 33.6 });
		const [, row] = renderFleetLines({ entries: fleet.list(), selected: null, now: Date.now(), lang: "en", theme: fakeTheme, width: 160 });
		assert.match(row!, /1 tool calls · ↑12k ↓1\.2k · 34% ctx/);
	});

	it("omits the usage segment until the agent reports tokens", () => {
		const fleet = new AgentFleet();
		seed(fleet, ["a"]);
		const [, row] = renderFleetLines({ entries: fleet.list(), selected: null, now: Date.now(), lang: "en", theme: fakeTheme, width: 120 });
		assert.doesNotMatch(row!, /↑|ctx/);
	});

	it("formats token counts compactly", () => {
		assert.equal(formatTokens(842), "842");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(12_345), "12k");
		assert.equal(formatTokens(1_250_000), "1.3M");
		assert.equal(usageText({ inputTokens: 0, outputTokens: 0 }), "");
		assert.equal(usageText({ inputTokens: 0, outputTokens: 0, contextPercent: 5 }), " · 5% ctx");
	});

	it("never exceeds the width, even with ANSI, CJK labels and tiny widths", () => {
		const fleet = new AgentFleet();
		seed(fleet, ["评审员-正确性", "x".repeat(200), "ordering"]);
		for (const width of [20, 40, 80, 160]) {
			const lines = renderFleetLines({ entries: fleet.list(), selected: 1, now: Date.now(), lang: "zh", theme: ansiTheme, width });
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
	});

	it("caps the list height and keeps the selection visible with a +N more line", () => {
		const fleet = new AgentFleet();
		seed(fleet, Array.from({ length: 20 }, (_, i) => `ref-${i + 1}`), "refs");
		const lines = renderFleetLines({ entries: fleet.list(), selected: 15, now: Date.now(), lang: "en", theme: fakeTheme, width: 100 });
		assert.ok(lines.length <= 12);
		assert.ok(lines.some((line) => line.startsWith("▸ ref-16")));
		assert.ok(lines.some((line) => /\+\d+ more/.test(line)));
	});

	it("shows queued lanes as queued bullets", () => {
		const fleet = new AgentFleet();
		fleet.registerGroup({ groupId: "g", role: "refs", lanes: [{ id: "r1" }, { id: "r2" }] });
		const lines = renderFleetLines({ entries: fleet.list(), selected: null, now: Date.now(), lang: "en", theme: fakeTheme, width: 100 });
		assert.match(lines[0]!, /2 queued/);
		assert.equal(lines.filter((line) => line.startsWith("•")).length, 2);
	});

	it("formats elapsed time", () => {
		assert.equal(formatElapsed(12_000), "12s");
		assert.equal(formatElapsed(72_000), "1m12s");
		assert.equal(formatElapsed(3_720_000), "1h02m");
	});
});

describe("collapsing a finished list", () => {
	const view = (fleet: AgentFleet, selected: number | null, lang: "en" | "zh" = "en") =>
		renderFleetLines({ entries: fleet.list(), selected, now: Date.now(), lang, theme: fakeTheme, width: 100 });

	it("collapses to a single summary line once every agent has finished", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["a", "b", "c"]);
		assert.equal(view(fleet, null).filter((line) => line.startsWith("•")).length, 3, "expanded while running");
		for (const id of ["a", "b", "c"]) group.complete(id, { ok: true, output: "done", stderr: "", turns: 1 });
		const lines = view(fleet, null);
		assert.equal(lines.length, 1, `collapsed: ${JSON.stringify(lines)}`);
		assert.match(lines[0]!, /^Subagents \(3\) · 3 done · ↓ browse subagents$/);
	});

	it("counts failed and cancelled agents in the summary", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["a", "b", "c"]);
		group.complete("a", { ok: true, output: "x", stderr: "", turns: 1 });
		group.complete("b", { ok: false, output: "", stderr: "", turns: 0, errorMessage: "boom" });
		group.complete("c", { ok: false, output: "", stderr: "", turns: 0, cancelled: true });
		const [line] = view(fleet, null);
		assert.match(line!, /1 done · 1 failed · 1 cancelled/);
		assert.match(view(fleet, null, "zh")[0]!, /1 已完成 · 1 失败 · 1 已取消 · ↓ 浏览子代理/);
	});

	it("stays expanded while anything is running, queued or idle", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["a", "b"]);
		group.complete("a", { ok: true, output: "x", stderr: "", turns: 1 });
		assert.ok(view(fleet, null).length > 1, "one agent still running");

		const queued = new AgentFleet();
		const g2 = queued.registerGroup({ groupId: "g", role: "refs", lanes: [{ id: "r1" }, { id: "r2" }] });
		g2.update("r1", { type: "turn", phase: "start", turnIndex: 1 });
		g2.complete("r1", { ok: true, output: "x", stderr: "", turns: 1 });
		assert.ok(view(queued, null).length > 1, "a queued agent keeps the list open");

		const workers = new AgentFleet();
		const g3 = seed(workers, ["w"], "executor");
		g3.setIdle("w", true);
		assert.ok(view(workers, null).length > 1, "an idle worker is still live");
	});

	it("expands again while the list is focused and collapses when focus leaves", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["a", "b"]);
		for (const id of ["a", "b"]) group.complete(id, { ok: true, output: "x", stderr: "", turns: 1 });
		const focused = view(fleet, 0);
		assert.ok(focused.some((line) => line.startsWith("▸ a")), "browsing shows the bullets");
		assert.ok(focused.at(-1)!.includes("Enter view"));
		assert.equal(view(fleet, null).length, 1);
	});

	it("the controller collapses the widget when the round ends and expands it on ↓", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls, state } = fakeHost();
		const rendered: Array<() => string[]> = [];
		const ui = host.ui as unknown as { setWidget: (key: string, content: unknown) => void };
		const original = ui.setWidget;
		ui.setWidget = (key, content) => {
			original(key, content);
			if (typeof content === "function") {
				const component = (content as (tui: unknown, theme: unknown) => { render(w: number): string[] })({ requestRender() {}, getFocusedComponent: () => null }, fakeTheme);
				rendered.push(() => component.render(100));
			}
		};
		controller.attach(host);
		const group = seed(fleet, ["a", "b", "c"]);
		assert.ok(rendered[0]!().length > 3, "expanded while running");
		for (const id of ["a", "b", "c"]) group.complete(id, { ok: true, output: "x", stderr: "", turns: 1 });
		assert.equal(rendered[0]!().length, 1, "collapsed after the last agent finished");
		assert.equal(calls.widgets.filter((entry) => entry.shown).length, 1, "the widget stays registered");
		state.editorText = "";
		controller.handleKey("\x1b[B");
		assert.ok(rendered[0]!().length > 3, "↓ expands it for browsing");
		controller.handleKey("\x1b");
		assert.equal(rendered[0]!().length, 1, "Esc collapses it again");
	});
});

describe("elapsed time counts only while an agent is working", () => {
	afterEach(() => mock.timers.reset());

	const rowOf = (fleet: AgentFleet): string => {
		const lines = renderFleetLines({ entries: fleet.list(), selected: 0, now: Date.now(), lang: "en", theme: fakeTheme, width: 200 });
		return lines.find((line) => line.startsWith("▸")) ?? "";
	};
	const event = { type: "turn", phase: "start", turnIndex: 1 } as const;

	it("excludes idle stretches of a long-lived worker and resumes when it works again", () => {
		mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
		const fleet = new AgentFleet();
		const group = fleet.registerGroup({ groupId: "g", role: "executor", lanes: [{ id: "w", label: "worker" }] });
		group.setIdle("w", true); // registered but waiting for its first wave
		mock.timers.tick(120_000);
		assert.doesNotMatch(rowOf(fleet), /\d+s/, "no time shown before the first assignment");

		group.setIdle("w", false); // a wave arrives
		group.update("w", event);
		mock.timers.tick(5_000);
		assert.match(rowOf(fleet), / · 5s/);

		group.setIdle("w", true); // wave done: waiting for the next one
		mock.timers.tick(60_000);
		assert.match(rowOf(fleet), / · 5s/, "idle minutes are not counted");
		assert.doesNotMatch(rowOf(fleet), /1m/);

		group.setIdle("w", false); // next wave
		mock.timers.tick(10_000);
		assert.match(rowOf(fleet), / · 15s/, "working time accumulates across waves");

		group.complete("w", { ok: true, output: "done", stderr: "", turns: 1 });
		mock.timers.tick(30_000);
		assert.match(rowOf(fleet), / · 15s/, "the clock stops when the agent finishes");
	});

	it("does not count the time a lane spent queued", () => {
		mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
		const fleet = new AgentFleet();
		const group = fleet.registerGroup({ groupId: "g", role: "refs", lanes: [{ id: "r1", label: "ref-1" }] });
		mock.timers.tick(30_000);
		assert.doesNotMatch(rowOf(fleet), /\d+s/, "a queued lane shows no time");
		group.update("r1", event);
		mock.timers.tick(4_000);
		assert.match(rowOf(fleet), / · 4s/);
	});

	it("freezes the clock for a finished agent even if the list is rendered much later", () => {
		mock.timers.enable({ apis: ["Date"], now: 0 });
		const fleet = new AgentFleet();
		const group = fleet.registerGroup({ groupId: "g", role: "reviewer", lanes: [{ id: "a", label: "a" }] });
		group.update("a", event);
		mock.timers.tick(7_000);
		group.complete("a", { ok: true, output: "x", stderr: "", turns: 1 });
		mock.timers.tick(9 * 60_000);
		assert.match(rowOf(fleet), / · 7s/);
	});

	it("an agent cancelled while idle keeps only the time it actually worked", () => {
		mock.timers.enable({ apis: ["Date"], now: 0 });
		const fleet = new AgentFleet();
		const group = fleet.registerGroup({ groupId: "g", role: "executor", lanes: [{ id: "w", label: "worker" }] });
		group.update("w", event);
		mock.timers.tick(3_000);
		group.setIdle("w", true);
		mock.timers.tick(50_000);
		group.complete("w", { ok: false, output: "", stderr: "", turns: 0, cancelled: true });
		assert.match(rowOf(fleet), / · 3s/);
	});
});

describe("AgentFleet", () => {
	it("drops finished agents after the retention window but keeps running ones", async () => {
		const fleet = new AgentFleet(20);
		const finished = seed(fleet, ["old"], "reviewer", "g-old");
		const running = seed(fleet, ["live"], "auditor", "g-live");
		finished.complete("old", { ok: true, output: "done", stderr: "", turns: 1 });
		assert.equal(fleet.list().length, 2, "a just-finished agent is still listed");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.deepEqual(fleet.list().map((entry) => entry.label), ["live"]);
		void running;
	});

	it("prunes finished lanes of earlier groups when a new group registers", () => {
		const fleet = new AgentFleet();
		const first = seed(fleet, ["a"], "reviewer", "round-1");
		first.complete("a", { ok: true, output: "done", stderr: "", turns: 1 });
		seed(fleet, ["b"], "reviewer", "round-2");
		assert.deepEqual(fleet.list().map((e) => e.id), ["round-2:b"]);
	});

	it("keeps running lanes of earlier groups", () => {
		const fleet = new AgentFleet();
		seed(fleet, ["a"], "reviewer", "round-1");
		seed(fleet, ["b"], "auditor", "round-2");
		assert.equal(fleet.list().length, 2);
	});

	it("ignores progress after a lane finished", () => {
		const fleet = new AgentFleet();
		const group = seed(fleet, ["a"]);
		group.complete("a", { ok: false, output: "", stderr: "", turns: 0, errorMessage: "boom" });
		group.update("a", { type: "turn", phase: "start", turnIndex: 9 });
		assert.equal(fleet.list()[0]!.lane.status, "failed");
	});
});

function overlayFor(fleet: AgentFleet, entryId: string, extra: Partial<ConstructorParameters<typeof SubagentOverlay>[0]> = {}) {
	return new SubagentOverlay({ theme: fakeTheme, fleet, entryId, onClose: () => {}, ...extra });
}

describe("SubagentOverlay", () => {
	const long = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");

	function longFleet() {
		const fleet = new AgentFleet();
		const group = fleet.registerGroup({ groupId: "g", role: "reviewer", lanes: [{ id: "one" }, { id: "two" }] });
		for (const id of ["one", "two"]) {
			group.update(id, { type: "transcript", phase: "update", entryType: "assistant-text", key: "content:0", text: long, update: "replace", streaming: false });
		}
		return fleet;
	}

	it("shows ONE agent as a single framed pane", () => {
		const fleet = longFleet();
		const lines = overlayFor(fleet, "g:one").render(120);
		assert.equal(lines.filter((line) => line.startsWith("┌")).length, 1);
		assert.equal(lines.filter((line) => line.startsWith("└")).length, 1);
		assert.ok(lines[1]!.includes("one"));
		for (const line of lines) assert.equal(visibleWidth(line), 120);
	});

	it("follows the bottom, pauses on upward scroll, and switches agent with Tab", () => {
		const fleet = longFleet();
		const overlay = overlayFor(fleet, "g:one");
		overlay.render(100);
		const start = fleet.get("g:one")!.lane.scrollOffset;
		assert.ok(start > 0);
		overlay.handleInput("\x1b[A");
		overlay.render(100);
		assert.equal(fleet.get("g:one")!.lane.followTranscript, false);
		assert.equal(fleet.get("g:one")!.lane.scrollOffset, start - 1);
		overlay.handleInput("\t");
		overlay.render(100);
		const two = fleet.get("g:two")!.lane.scrollOffset;
		assert.ok(two > 0);
		overlay.handleInput("\x1b[A");
		overlay.render(100);
		assert.equal(fleet.get("g:two")!.lane.scrollOffset, two - 1);
		assert.equal(fleet.get("g:one")!.lane.scrollOffset, start - 1);
	});

	it("handles kitty CSI-u scroll, page and Esc keys", () => {
		const fleet = longFleet();
		const calls: string[] = [];
		const overlay = overlayFor(fleet, "g:one", { onClose: () => calls.push("close") });
		overlay.render(100);
		const start = fleet.get("g:one")!.lane.scrollOffset;
		overlay.handleInput("\x1b[57419u");
		overlay.render(100);
		assert.equal(fleet.get("g:one")!.lane.scrollOffset, start - 1);
		overlay.handleInput("\x1b[57421u");
		assert.ok(fleet.get("g:one")!.lane.scrollOffset < start - 1);
		overlay.handleInput("\x1b[27u");
		assert.deepEqual(calls, ["close"]);
	});

	it("treats arrows as scroll, not escape, on the fallback path", () => {
		__setPiTuiForTests(undefined);
		try {
			const fleet = longFleet();
			const calls: string[] = [];
			const overlay = overlayFor(fleet, "g:one", { onClose: () => calls.push("close") });
			overlay.render(100);
			const start = fleet.get("g:one")!.lane.scrollOffset;
			overlay.handleInput("\x1b[A");
			overlay.handleInput("\x1bOA");
			overlay.render(100);
			assert.deepEqual(calls, []);
			assert.equal(fleet.get("g:one")!.lane.scrollOffset, start - 2);
			overlay.handleInput("\x1b");
			assert.deepEqual(calls, ["close"]);
		} finally {
			__clearPiTuiForTests();
		}
	});

	it("forwards unhandled keys instead of swallowing them", () => {
		const fleet = longFleet();
		const calls: string[] = [];
		const overlay = overlayFor(fleet, "g:one", { onUnhandledKey: (data) => calls.push(data) });
		overlay.handleInput("\x1b[84;6u"); // Ctrl+Shift+T
		assert.deepEqual(calls, ["\x1b[84;6u"]);
		overlay.handleInput("\x1b[B");
		assert.deepEqual(calls, ["\x1b[84;6u"]);
	});

	it("stops one agent only after a second x press", () => {
		const fleet = new AgentFleet();
		let stopped = 0;
		const group = fleet.registerGroup({ groupId: "g", role: "executor", lanes: [{ id: "w", abort: () => (stopped += 1) }] });
		group.update("w", { type: "turn", phase: "start", turnIndex: 1 });
		const overlay = overlayFor(fleet, "g:w");
		overlay.handleInput("x");
		assert.equal(stopped, 0);
		assert.ok(overlay.render(100).some((line) => line.includes("press x again to stop")));
		overlay.handleInput("x");
		assert.equal(stopped, 1);
		overlay.handleInput("x");
		overlay.handleInput("\x1b[A"); // any other key disarms
		overlay.handleInput("x");
		assert.equal(stopped, 1);
	});

	it("pairs mouse-mode enable with disable", () => {
		const writes: string[] = [];
		const tui = { terminal: { write: (text: string) => writes.push(text) }, requestRender() {} } as never;
		const overlay = overlayFor(longFleet(), "g:one", { tui });
		overlay.dispose();
		overlay.dispose();
		assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1006h", "\x1b[?1000l\x1b[?1006l"]);
	});

	it("keeps the right wall intact on ANSI-heavy rows", () => {
		const fleet = new AgentFleet();
		const group = fleet.registerGroup({ groupId: "g", role: "reviewer", lanes: [{ id: "one" }] });
		const heavy = `\x1b[90m[${"payload".repeat(30)}]\x1b[0m styled \x1b[1mbold\x1b[0m tail`;
		group.update("one", { type: "transcript", phase: "update", entryType: "assistant-text", key: "content:0", text: heavy, update: "replace", streaming: false });
		const lines = new SubagentOverlay({ theme: ansiTheme, fleet, entryId: "g:one", onClose: () => {} }).render(120);
		for (const line of lines) assert.equal(visibleWidth(line), 120);
		for (const row of lines.filter((line) => line.includes("│"))) assert.match(row, /\x1b\[32m│\x1b\[0m$/);
	});

	it("shows the reopen hint only for the execution review", () => {
		const fleet = new AgentFleet();
		fleet.registerGroup({ groupId: "g", role: "auditor", lanes: [{ id: "a" }] });
		fleet.registerGroup({ groupId: "h", role: "reviewer", lanes: [{ id: "b" }] });
		assert.ok(overlayFor(fleet, "g:a").render(140).some((l) => l.includes("Ctrl+Shift+R")));
		assert.equal(overlayFor(fleet, "h:b").render(140).some((l) => l.includes("Ctrl+Shift+R")), false);
	});
});

// ---------------------------------------------------------------------------
// Controller: widget + keys
// ---------------------------------------------------------------------------

function fakeHost(editorText = "", focused: unknown = null) {
	const calls = { widgets: [] as Array<{ key: string; shown: boolean }>, customs: 0, handlers: [] as Array<(d: string) => { consume?: boolean } | undefined> };
	const state = { editorText, renders: 0 };
	const ui = {
		setWidget: (key: string, content: unknown) => {
			calls.widgets.push({ key, shown: content !== undefined });
			if (typeof content === "function") (content as (tui: unknown, theme: unknown) => unknown)({ requestRender: () => (state.renders += 1), getFocusedComponent: () => focused }, fakeTheme);
		},
		onTerminalInput: (handler: (d: string) => { consume?: boolean } | undefined) => {
			calls.handlers.push(handler);
			return () => undefined;
		},
		getEditorText: () => state.editorText,
		custom: () => {
			calls.customs += 1;
			return new Promise<void>(() => undefined);
		},
	};
	return { host: { ui: ui as never, hasUI: true, mode: "tui" }, calls, state };
}

describe("FleetUiController", () => {
	it("only attaches in TUI sessions", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls } = fakeHost();
		controller.attach({ ...host, mode: "rpc" });
		seed(fleet, ["a"]);
		assert.equal(calls.widgets.length, 0);
		assert.equal(calls.handlers.length, 0);
	});

	it("shows the widget while agents exist and removes it when the fleet empties", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls } = fakeHost();
		controller.attach(host);
		assert.equal(calls.widgets.length, 0, "nothing to show yet");
		seed(fleet, ["a"]);
		assert.deepEqual(calls.widgets, [{ key: FLEET_WIDGET_KEY, shown: true }]);
		fleet.clear();
		assert.deepEqual(calls.widgets.at(-1), { key: FLEET_WIDGET_KEY, shown: false });
	});

	it("attach is idempotent for the same ui", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls } = fakeHost();
		controller.attach(host);
		controller.attach(host);
		assert.equal(calls.handlers.length, 1);
	});

	it("↓ focuses the list only with an empty editor; Enter opens the selected agent; Esc backs out", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls, state } = fakeHost();
		controller.attach(host);
		seed(fleet, ["a", "b"]);

		state.editorText = "draft";
		assert.equal(controller.handleKey("\x1b[B"), undefined, "a non-empty editor keeps its ↓");
		assert.equal(controller.isFocused(), false);

		state.editorText = "";
		assert.deepEqual(controller.handleKey("\x1b[B"), { consume: true });
		assert.equal(controller.isFocused(), true);
		assert.equal(controller.selected(), "g1:a");
		assert.deepEqual(controller.handleKey("\x1b[B"), { consume: true });
		assert.equal(controller.selected(), "g1:b");
		assert.deepEqual(controller.handleKey("\x1b[B"), { consume: true });
		assert.equal(controller.selected(), "g1:b", "clamped at the last row");
		assert.deepEqual(controller.handleKey("\x1b[A"), { consume: true });
		assert.equal(controller.selected(), "g1:a");

		assert.deepEqual(controller.handleKey("\r"), { consume: true });
		assert.equal(calls.customs, 1, "Enter opens one overlay");
		assert.equal(controller.isOverlayOpen(), true);
		assert.equal(controller.handleKey("\x1b[B"), undefined, "keys belong to the overlay while it is open");
	});

	it("Esc and ↑ past the first row return focus; other keys pass through to the editor", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host } = fakeHost();
		controller.attach(host);
		seed(fleet, ["a"]);
		controller.handleKey("\x1b[B");
		assert.deepEqual(controller.handleKey("\x1b[A"), { consume: true });
		assert.equal(controller.isFocused(), false);
		controller.handleKey("\x1b[B");
		assert.deepEqual(controller.handleKey("\x1b"), { consume: true });
		assert.equal(controller.isFocused(), false);
		controller.handleKey("\x1b[B");
		assert.equal(controller.handleKey("h"), undefined, "typing is never swallowed");
		assert.equal(controller.isFocused(), false);
	});

	it("does nothing without agents", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host } = fakeHost();
		controller.attach(host);
		assert.equal(controller.handleKey("\x1b[B"), undefined);
	});

	it("never touches ↓ while a dialog (not the editor) has focus, but accepts any editor-like component", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const dialog = { handleInput() {}, render: () => [] };
		const { host } = fakeHost("", dialog);
		controller.attach(host);
		seed(fleet, ["a"]);
		assert.equal(controller.handleKey("\x1b[B"), undefined, "a select dialog keeps its arrow keys");
		assert.equal(controller.isFocused(), false);

		const second = new FleetUiController(fleet);
		const editorLike = { handleInput() {}, getText: () => "" };
		second.attach(fakeHost("", editorLike).host);
		assert.deepEqual(second.handleKey("\x1b[B"), { consume: true }, "an editor from another module copy still counts");
	});

	it("openLatest reopens the newest agent of a role", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls } = fakeHost();
		controller.attach(host);
		assert.equal(controller.openLatest("auditor"), false);
		seed(fleet, ["x"], "auditor", "audit-1");
		assert.equal(controller.openLatest("auditor"), true);
		assert.equal(calls.customs, 1);
		assert.equal(controller.selected(), "audit-1:x");
	});

	it("detach removes the widget", () => {
		const fleet = new AgentFleet();
		const controller = new FleetUiController(fleet);
		const { host, calls } = fakeHost();
		controller.attach(host);
		seed(fleet, ["a"]);
		controller.detach();
		assert.deepEqual(calls.widgets.at(-1), { key: FLEET_WIDGET_KEY, shown: false });
	});
});
