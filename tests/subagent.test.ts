import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSubagentEvent } from "../src/subagent.ts";

describe("subagent progress events", () => {
	it("normalizes turn and message lifecycle events", () => {
		assert.deepEqual(normalizeSubagentEvent({ type: "turn_start", turnIndex: 2 }), [{ type: "turn", phase: "start", turnIndex: 2 }]);
		assert.deepEqual(
			normalizeSubagentEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "checking the plan" },
			}),
			[{ type: "transcript", phase: "update", entryType: "assistant-text", key: "content:1", text: "checking the plan", update: "append", streaming: true }],
		);
	});

	it("normalizes tool progress without exposing unbounded arguments", () => {
		assert.deepEqual(
			normalizeSubagentEvent({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "/tmp/plan.md" },
			}),
			[{
				type: "transcript",
				phase: "start",
				entryType: "tool-call",
				key: "tool:call-1",
				text: '{\n  "path": "/tmp/plan.md"\n}',
				update: "replace",
				streaming: true,
				toolCallId: "call-1",
				toolName: "read",
			}],
		);
	});

	it("ignores unknown or malformed events", () => {
		assert.deepEqual(normalizeSubagentEvent(undefined), []);
		assert.deepEqual(normalizeSubagentEvent({ type: "future_event" }), []);
		assert.deepEqual(normalizeSubagentEvent({ type: "message_end" }), []);
	});
});
