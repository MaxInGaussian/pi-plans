import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeSubagentEvent, runPiSubagent, type SubagentProgressEvent } from "../src/subagent.ts";

async function withFakePi(
	task: string,
	options: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (event: SubagentProgressEvent) => void } = {},
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-fake-pi-"));
	const script = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		script,
		[
			'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
			'emit({ type: "turn_start" });',
			'if (process.argv.includes("Task: slow")) await new Promise((resolve) => setTimeout(resolve, 5000));',
			'else {',
			'  emit({ type: "message_start", message: { role: "assistant", content: [] } });',
			'  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });',
			'  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "PLAN_v1.md" } });',
			'  emit({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: "final conclusion" }] } });',
			'}',
		].join("\n"),
	);

	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		return await runPiSubagent({
			systemPrompt: "test system prompt",
			task,
			cwd: process.cwd(),
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 2000,
			onProgress: options.onProgress,
		});
	} finally {
		process.argv[1] = previousScript;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}


describe("subagent runner lifecycle", () => {
	it("waits for JSONL completion and forwards progress", async () => {
		const progress: string[] = [];
		const result = await withFakePi("normal", {
			timeoutMs: 2000,
			onProgress: (event) => progress.push(`${event.type}:${event.phase ?? ""}`),
		});
		assert.equal(result.ok, true);
		assert.equal(result.output, "final conclusion");
		assert.equal(result.model, "fake/model");
		assert.ok(progress.includes("process:started"));
		assert.ok(progress.includes("transcript:update"));
		assert.ok(progress.includes("process:exited"));
		assert.equal(result.turns, 1);
	});

	it("returns a cancelled result after aborting the child", async () => {
		const abort = new AbortController();
		const promise = withFakePi("slow", { signal: abort.signal, timeoutMs: 2000 });
		setTimeout(() => abort.abort(), 40);
		const result = await promise;
		assert.equal(result.ok, false);
		assert.equal(result.cancelled, true);
		assert.equal(result.timedOut, undefined);
	});

	it("returns a timed out result after terminating a slow child", async () => {
		const result = await withFakePi("slow", { timeoutMs: 40 });
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.equal(result.cancelled, undefined);
	});
});

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
