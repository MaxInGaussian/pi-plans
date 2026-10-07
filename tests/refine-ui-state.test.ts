import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

