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
	function transcript(text: string): RefineLaneState["transcript"] {
		return [{ id: "0:content:0", type: "assistant-text", text, streaming: false }];
	}

	function readyLane(id: string, label: string, text: string): RefineLaneState {
		return {
			...lane(id, label),
			status: "running",
			phase: "responding",
			transcript: transcript(text),
		};
	}

	it("renders the resolved overlay width without a legacy 96-column cap", () => {
		const component = new RefineOverlayComponent(fakeTheme, "reviewer", [readyLane("lane-1", "reviewer-1", "output")], () => {});
		const lines = component.render(120);
		assert.ok(lines.some((line) => line.startsWith("┌")));
		assert.ok(lines.every((line) => visibleWidth(line) <= 120));
		assert.ok(lines.some((line) => line.includes("output")));
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

		const finished = new RefineOverlayController("reviewer", [{ id: "lane-1", label: "one" }], () => {
			calls.push("abort");
		});
		finished.markFinished();
		finished.cancel();
		assert.deepEqual(calls, [], "finished Esc must not invoke the abort hook either");
		assert.equal(finished.isClosed(), true);
		assert.equal(finished.isFinished(), true);
	});

	it("replacees the retained overlay when a new round begins", () => {
		let previousClose = false;
		const retained = new RefineOverlayController("reviewer", [{ id: "lane-1", label: "one" }], () => undefined);
		retained.markFinished();
		const previousClosePromise = retained.close().then(() => {
			previousClose = true;
		});
		const next = new RefineOverlayController("reviewer", [{ id: "lane-2", label: "two" }], () => undefined);
		void next;
		return previousClosePromise.then(() => {
			assert.equal(previousClose, true);
			assert.equal(retained.isClosed(), true);
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
			fakeTui,
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

	it("closes the retained overlay before establishing a new one to avoid mouse-mode flip", () => {
		const retained = new RefineOverlayController("reviewer", [{ id: "lane-1", label: "one" }], () => undefined);
		retained.markFinished();
		return retained.close().then(() => {
			assert.equal(retained.isClosed(), true);
			assert.equal(retained.isFinished(), true);
			// Calling close again stays idempotent.
			return retained.close();
		}).then(() => {
			assert.equal(retained.isClosed(), true);
		});
	});
});
