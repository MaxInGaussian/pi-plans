import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RefineOverlayComponent, RefineOverlayController } from "../src/refine-ui.ts";
import { visibleWidth } from "../src/refine-ui-helpers.ts";
import { applyRefineProgress, applyRefineResult, statusLabel, type RefineLaneState } from "../src/refine-ui-state.ts";

function lane(id = "lane-1", label = "reviewer-1", text = ""): RefineLaneState {
	return {
		id,
		label,
		status: "queued",
		phase: "queued",
		detail: "",
		transcript: text ? [{ id: "0:content:0", type: "assistant-text", text, streaming: true }] : [],
		currentTurnIndex: 0,
		scrollOffset: 0,
		followTranscript: true,
		viewportHeight: 1,
	};
}

function readyLane(id: string, label: string, text: string): RefineLaneState {
	return {
		...lane(id, label),
		status: "running",
		phase: "responding",
		transcript: [{ id: "0:content:0", type: "assistant-text", text, streaming: false }],
	};
}

function streamingToolLane(id: string, label: string, text: string): RefineLaneState {
	return {
		...lane(id, label),
		status: "running",
		phase: "tool result",
		transcript: [{ id: "0:tool:0", type: "tool-result", text, streaming: true, toolName: "read", isError: false }],
	};
}

function streamingAssistantLane(id: string, label: string, text: string): RefineLaneState {
	return {
		...lane(id, label),
		status: "running",
		phase: "responding",
		transcript: [{ id: "0:content:0", type: "assistant-text", text, streaming: true }],
	};
}

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

describe("refine overlay state", () => {
	it("merges streaming deltas and keeps complete tool output without clipping it", () => {
		const state = lane();
		applyRefineProgress(state, { type: "turn", phase: "start", turnIndex: 1 });
		applyRefineProgress(state, {
			type: "transcript",
			phase: "update",
			entryType: "assistant-text",
			key: "content:0",
			text: "first ",
			update: "append",
			streaming: true,
		});
		applyRefineProgress(state, {
			type: "transcript",
			phase: "update",
			entryType: "assistant-text",
			key: "content:0",
			text: "second",
			update: "append",
			streaming: true,
		});
		const output = "x".repeat(500);
		applyRefineProgress(state, {
			type: "transcript",
			phase: "end",
			entryType: "tool-result",
			key: "tool:call-1",
			text: output,
			update: "replace",
			streaming: false,
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
		});

		assert.equal(state.transcript.find((entry) => entry.type === "assistant-text")?.text, "first second");
		assert.equal(state.transcript.find((entry) => entry.type === "tool-result")?.text, output);
		assert.equal(state.detail, output);
	});

	it("keeps terminal lane states stable after completion", () => {
		const state = lane();
		applyRefineResult(state, { ok: true, output: "final conclusion", stderr: "", turns: 1 });
		applyRefineProgress(state, { type: "turn", phase: "start" });

		assert.equal(state.status, "complete");
		assert.equal(state.phase, "complete");
		assert.equal(state.transcript.at(-1)?.text, "final conclusion");
	});

	it("distinguishes cancelled and timed out child results", () => {
		const cancelled = lane();
		applyRefineResult(cancelled, { ok: false, output: "", stderr: "", turns: 0, cancelled: true, errorMessage: "Esc" });
		assert.equal(cancelled.status, "cancelled");
		assert.equal(cancelled.phase, "cancelled");

		const timedOut = lane();
		applyRefineResult(timedOut, { ok: false, output: "", stderr: "", turns: 0, timedOut: true, errorMessage: "timeout" });
		assert.equal(timedOut.status, "failed");
		assert.equal(timedOut.phase, "timed out");
		assert.equal(statusLabel(timedOut.status), "failed");
	});
});

describe("refine overlay viewport", () => {
	it("renders the resolved overlay width without a legacy 96-column cap", () => {
		const component = new RefineOverlayComponent(fakeTheme, "reviewer", [readyLane("lane-1", "reviewer-1", "output")], () => {});
		const lines = component.render(120);
		assert.ok(lines.some((line) => line.startsWith("┌")));
		assert.ok(lines.every((line) => visibleWidth(line) <= 120));
		assert.ok(lines.some((line) => line.includes("output")));
	});

	it("renders model-aware titles and footer hints", () => {
		const lanes = [
			readyLane("lane-1", "correctness", "correctness output"),
			readyLane("lane-2", "ordering", "ordering output"),
			readyLane("lane-3", "verification", "verification output"),
		];
		const component = new RefineOverlayComponent(
			fakeTheme,
			"reviewer",
			lanes,
			() => {},
			undefined,
			"zai/glm-5.3-flash:high",
		);
		const lines = component.render(120);
		assert.ok(lines.some((line) => line.includes("Reviewer (zai/glm-5.3-flash:high)")));
		assert.ok(lines.some((line) => line.includes("Esc 关闭")));
		assert.ok(lines.some((line) => line.includes("Tab & Shift + Tab")));
	});

	it("renders only the last three wrapped lines for streaming transcript previews", () => {
		const linesText = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
		const component = new RefineOverlayComponent(
			fakeTheme,
			"criticizer",
			[streamingToolLane("lane-1", "criticizer", linesText)],
			() => {},
			undefined,
			"singularity-gpt/gpt-5.5:xhigh",
		);
		const lines = component.render(90);
		assert.ok(lines.some((line) => line.includes("Criticizer (singularity-gpt/gpt-5.5:xhigh)")));
		assert.ok(lines.some((line) => line.includes("…")));
		assert.ok(lines.some((line) => line.includes("line 3")));
		assert.ok(lines.some((line) => line.includes("line 4")));
		assert.ok(lines.some((line) => line.includes("line 5")));
		assert.equal(lines.some((line) => line.includes("line 1")), false);
		assert.equal(lines.some((line) => line.includes("line 2")), false);
	});

	it("renders only the last three wrapped lines for streaming assistant previews", () => {
		const linesText = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
		const component = new RefineOverlayComponent(
			fakeTheme,
			"reviewer",
			[streamingAssistantLane("lane-1", "reviewer", linesText)],
			() => {},
			undefined,
			"zai/glm-5.3-flash:high",
		);
		const lines = component.render(90);
		assert.ok(lines.some((line) => line.includes("Reviewer (zai/glm-5.3-flash:high)")));
		assert.ok(lines.some((line) => line.includes("…")));
		assert.ok(lines.some((line) => line.includes("line 3")));
		assert.ok(lines.some((line) => line.includes("line 4")));
		assert.ok(lines.some((line) => line.includes("line 5")));
		assert.equal(lines.some((line) => line.includes("line 1")), false);
		assert.equal(lines.some((line) => line.includes("line 2")), false);
	});

	it("renders a single pane with pi-btw-style transcript badges", () => {
		const component = new RefineOverlayComponent(
			fakeTheme,
			"criticizer",
			[readyLane("lane-1", "criticizer", "assistant output")],
			() => {},
		);
		const lines = component.render(90);
		assert.equal(lines.filter((line) => line.startsWith("┌")).length, 2);
		assert.equal(lines.filter((line) => line.startsWith("└")).length, 2);
		assert.ok(lines.some((line) => line.includes("assistant")));
		assert.ok(lines.some((line) => line.includes("assistant output")));
	});

	it("renders three vertical equal-height independent panes", () => {
		const lanes = [
			readyLane("lane-1", "correctness", "correctness output"),
			readyLane("lane-2", "ordering", "ordering output"),
			readyLane("lane-3", "verification", "verification output"),
		];
		const component = new RefineOverlayComponent(fakeTheme, "reviewer", lanes, () => {});
		const lines = component.render(120);
		assert.equal(lines.filter((line) => line.startsWith("┌")).length, 4);
		assert.equal(lines.filter((line) => line.startsWith("└")).length, 4);
		assert.ok(lines.some((line) => line.includes("correctness")));
		assert.ok(lines.some((line) => line.includes("ordering")));
		assert.ok(lines.some((line) => line.includes("verification")));
		const topIndexes = lines.flatMap((line, index) => line.startsWith("┌") ? [index] : []);
		const bottomIndexes = lines.flatMap((line, index) => line.startsWith("└") ? [index] : []);
		const paneHeights = topIndexes.slice(1).map((value, index) => bottomIndexes[index]! - value);
		assert.ok(paneHeights.every((height) => height === paneHeights[0]));
	});

	it("follows the bottom, pauses on upward scroll, and switches independently with Tab", () => {
		const long = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
		const lanes = [readyLane("lane-1", "one", long), readyLane("lane-2", "two", long)];
		const component = new RefineOverlayComponent(fakeTheme, "reviewer", lanes, () => {});
		component.render(100);
		const initialOffset = lanes[0]!.scrollOffset;
		assert.ok(initialOffset > 0);
		component.handleInput("\x1b[A");
		component.render(100);
		assert.equal(lanes[0]!.followTranscript, false);
		assert.ok(lanes[0]!.scrollOffset < initialOffset);
		const laneOneOffset = lanes[1]!.scrollOffset;
		component.handleInput("\t");
		component.handleInput("\x1b[A");
		component.render(100);
		assert.ok(lanes[1]!.scrollOffset < laneOneOffset);
		assert.equal(lanes[0]!.scrollOffset, initialOffset - 1);
	});
});

describe("refine overlay wiring", () => {
	it("uses pi-btw geometry, no input box, and no pi-btw runtime dependency", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "src", "refine-ui.ts"), "utf8");
		assert.match(source, /custom<void>/);
		assert.match(source, /overlay:\s*true/);
		assert.match(source, /width: "78%"/);
		assert.match(source, /minWidth: OVERLAY_MIN_WIDTH/);
		assert.match(source, /maxHeight: "78%"/);
		assert.match(source, /anchor: "top-center"/);
		assert.match(source, /margin: \{ top: 1, left: 2, right: 2 \}/);
		assert.match(source, /previewTranscriptText/);
		assert.match(source, /footerText/);
		assert.match(source, /Tab|tab/);
		assert.match(source, /scrollOffset|followTranscript/);
		assert.doesNotMatch(source, /new Input|inputFrameLine|onSubmit/);
		assert.doesNotMatch(source, /pi-btw|createAgentSession|AgentSession/);
	});
});
	describe("refine overlay lifecycle", () => {
	it("treats Esc as close-only and never relays the abort hook", () => {
		const calls: string[] = [];
		const controller = new RefineOverlayController("reviewer", [{ id: "lane-1", label: "one" }], () => {
			calls.push("abort");
		});
		controller.cancel();
		assert.deepEqual(calls, [], "running Esc must not invoke the abort hook");
		assert.equal(controller.isClosed(), true);

		const another = new RefineOverlayController("reviewer", [{ id: "lane-1", label: "one" }], () => {
			calls.push("abort");
		});
		another.cancel();
		assert.deepEqual(calls, [], "repeated Esc must still not invoke the abort hook");
		assert.equal(another.isClosed(), true);
	});

	it("keeps close idempotent across repeated calls", () => {
		const controller = new RefineOverlayController("reviewer", [{ id: "lane-1", label: "one" }], () => undefined);
		return controller.close().then(() => controller.close()).then(() => {
			assert.equal(controller.isClosed(), true);
		});
	});

	it("pairs mouse-mode enable with disable through the controller lifecycle", () => {
		const writes: string[] = [];
		const fakeTui = {
			terminal: { write: (data: string) => { writes.push(data); } },
			requestRender: () => undefined,
		} as never;
		const controller = new RefineOverlayController(
			"reviewer",
			[{ id: "lane-1", label: "one" }],
			() => undefined,
		);
		// Simulate the factory hand-off path that open() runs.
		(controller as unknown as { tui: unknown }).tui = fakeTui;
		(controller as unknown as {
			component: { dispose: () => void; tui?: unknown } | undefined;
		}).component = new RefineOverlayComponent(
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
			"reviewer",
			controller.lanes,
			() => undefined,
			fakeTui,
		);
		assert.ok(writes.some((entry) => entry.includes("\x1b[?1000h")), "mouse-enable must be emitted");
		return controller.close().then(() => {
			assert.ok(writes.some((entry) => entry.includes("\x1b[?1000l")), "mouse-disable must be emitted");
			assert.equal(controller.isClosed(), true);
		});
	});

	it("closes refinement overlays on completion instead of retaining them", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "tools", "refine.ts"), "utf8");
		assert.match(source, /await execution\.close\(\)/);
		assert.doesNotMatch(source, /await execution\.retain\(\)|retainedRefineOverlay|closeRetainedRefineOverlay|markFinished|isFinished/);
	});
});

describe("overlay frame colors and ANSI width", () => {
	// Theme stub that emits REAL CSI sequences so frame-color and width behavior
	// can be observed on the rendered output (fakeTheme strips colors entirely).
	const ansiCodes: Record<string, number> = {
		border: 31,
		borderAccent: 32,
		accent: 33,
		dim: 90,
		muted: 93,
		success: 92,
		error: 91,
		warning: 93,
	};
	const ansiTheme = {
		fg: (color: string, text: string) => `\x1b[${ansiCodes[color] ?? 39}m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
	} as never;

	it("keeps the right wall intact on ANSI-heavy rows (every row exactly frame-wide)", () => {
		const heavy = `\x1b[90m[${"payload".repeat(30)}]\x1b[0m styled \x1b[1mbold\x1b[0m tail`;
		const component = new RefineOverlayComponent(ansiTheme, "reviewer", [readyLane("lane-1", "reviewer-1", heavy)], () => {});
		const lines = component.render(120);
		for (const line of lines) {
			assert.equal(visibleWidth(line), 120, `row must be exactly frame-wide: ${JSON.stringify(line.slice(0, 80))}`);
		}
		const wallRows = lines.filter((line) => line.includes("│"));
		assert.ok(wallRows.length >= 3, "title, body, and footer rows must carry side walls");
		for (const row of wallRows) {
			assert.match(row, /\x1b\[3[12]m│\x1b\[0m$/); // right wall survives fitLine
		}
	});

	it("renders border for the outer frame and borderAccent only for the selected lane", () => {
		const lanes = [
			readyLane("lane-1", "correctness", "out-1"),
			readyLane("lane-2", "ordering", "out-2"),
			readyLane("lane-3", "verification", "out-3"),
		];
		const component = new RefineOverlayComponent(ansiTheme, "reviewer", lanes, () => {});
		const lines = component.render(120);
		const outerTop = lines[0]!;
		assert.match(outerTop, /^\x1b\[31m┌/);
		const topBorders = lines.filter((line) => /\x1b\[31m┌/.test(line));
		const selectedTopBorders = lines.filter((line) => /\x1b\[32m┌/.test(line));
		assert.equal(topBorders.length, 3, "outer frame + two unselected panes use border color");
		assert.equal(selectedTopBorders.length, 1, "exactly the selected pane uses borderAccent");
		// Title row walls follow the outer frame color; content keeps accent.
		assert.match(lines[1]!, /\x1b\[31m│/);
		assert.match(lines[1]!, /\x1b\[33m/);
		// Footer row walls also follow the outer frame color.
		assert.match(lines[lines.length - 2]!, /\x1b\[31m│/);
	});

	it("keeps ANSI sequences atomic through truncateToWidth and wrapTextWithAnsi hard splits", async () => {
		const { truncateToWidth, wrapTextWithAnsi } = await import("../src/refine-ui-helpers.ts");
		const styled = `\x1b[90m${"ab".repeat(30)}\x1b[0m tail`;
		const cut = truncateToWidth(styled, 10);
		assert.equal(visibleWidth(cut), 10);
		assert.doesNotMatch(cut, /\x1b\[[^\x40-\x7e]*$/); // no dangling CSI at the cut point

		const longToken = `\x1b[90m${"w".repeat(80)}\x1b[0m`;
		const wrapped = wrapTextWithAnsi(longToken, 20);
		assert.ok(wrapped.length >= 4);
		for (const line of wrapped) {
			assert.ok(visibleWidth(line) <= 20);
			assert.doesNotMatch(line, /\x1b\[[^\x40-\x7e]*$/); // every sequence stays whole
		}
		// Zero-width accounting: pure escape payload measures nothing.
		assert.equal(visibleWidth("\x1b[38;5;244m\x1b[0m"), 0);
	});
});
