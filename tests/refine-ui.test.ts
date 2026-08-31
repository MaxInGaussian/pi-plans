import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RefineOverlayComponent, chunkDetailForOverlay } from "../src/refine-ui.ts";
import { applyRefineProgress, applyRefineResult, statusLabel, type RefineLaneState } from "../src/refine-ui-state.ts";


function lane(): RefineLaneState {
	return { id: "lane-1", label: "reviewer-1", status: "queued", phase: "queued", detail: "" };
}

describe("refine overlay state", () => {
	it("tracks tool progress and bounds the displayed detail", () => {
		const state = lane();
		applyRefineProgress(state, {
			type: "tool",
			phase: "update",
			toolCallId: "call-1",
			toolName: "read",
			detail: "x".repeat(500),
		});

		assert.equal(state.status, "running");
		assert.equal(state.phase, "tool: read");
		assert.ok(state.detail.length <= 180);
		assert.match(state.detail, /\.\.\.$/);
	});

	it("keeps terminal lane states stable after completion", () => {
		const state = lane();
		applyRefineResult(state, { ok: true, output: "final conclusion", stderr: "", turns: 1 });
		applyRefineProgress(state, { type: "turn", phase: "start" });

		assert.deepEqual(state, {
			id: "lane-1",
			label: "reviewer-1",
			status: "complete",
			phase: "complete",
			detail: "final conclusion",
		});
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
	const fakeTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function makeLane(): RefineLaneState {
		return { id: "lane-1", label: "reviewer-1", status: "running", phase: "responding", detail: "" };
	}

	function makeLanes(detail: string): RefineLaneState[] {
		return [{ id: "lane-1", label: "reviewer-1", status: "running", phase: "responding", detail }];
	}

	it("clamps overlay width between min and max regardless of host width", () => {
		const component = new RefineOverlayComponent(fakeTheme, "reviewer", makeLanes(""), () => {});
		const narrow = component.render(20);
		const wide = component.render(240);
		assert.ok(narrow.some((line) => line.startsWith("┌")));
		assert.ok(wide.some((line) => line.startsWith("┌")));
		assert.ok(narrow.every((line) => line.length <= 20));
	});

	it("draws top and bottom borders with rounded corners and frame lines", () => {
		const component = new RefineOverlayComponent(fakeTheme, "criticizer", makeLanes(""), () => {});
		const lines = component.render(80);
		const first = lines[0] ?? "";
		const last = lines.at(-1) ?? "";
		assert.match(first, /^┌─+┐$/);
		assert.match(last, /^└─+┘$/);
		assert.ok(lines.some((line) => line.startsWith("├") && line.endsWith("┤")));
		assert.ok(lines.some((line) => line.startsWith("│") && line.endsWith("│")));
	});

	it("chunk sentence-sized detail lines so streaming fragments stay readable", () => {
		const lines = chunkDetailForOverlay(
			"Reading the file. Found three findings. The fourth line is unrelated.",
			40,
			6,
		);
		assert.ok(lines.length >= 3);
		assert.ok(lines.every((line) => line.length <= 40));
		assert.match(lines[0] ?? "", /Reading the file\./);
	});

	it("limits chunk length and refuses to overflow the maxLines budget", () => {
		const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1}.`).join(" ");
		const lines = chunkDetailForOverlay(text, 60, 3);
		assert.equal(lines.length, 3);
	});
});

describe("refine overlay wiring", () => {
	it("uses named public overlays, guards lifecycle edges, and does not depend on pi-btw", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "src", "refine-ui.ts"), "utf8");
		assert.match(source, /custom<void>/);
		assert.match(source, /overlay:\s*true/);
		assert.match(source, /"Reviewer"/);
		assert.match(source, /"Criticizer"/);
		assert.match(source, /truncateToWidth/);
		assert.match(source, /chunkDetailForOverlay/);
		assert.match(source, /pickOverlayHeight|pickOverlayWidth/);
		assert.match(source, /renderBorderLine|renderHorizontalRule|renderRow/);
		assert.match(source, /if \(this\.closed\) return;/);
		assert.match(source, /await this\.overlayPromise/);
		assert.match(source, /if \(!ctx\.hasUI \|\| this\.overlayPromise\) return/);
		assert.doesNotMatch(source, /pi-btw|createAgentSession|AgentSession/);
	});
});
