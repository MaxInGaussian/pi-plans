/** I-010/VC-007: subagent usage metering — the child's JSON event stream
 * usage is aggregated into SubagentResult.usage and persisted into
 * subagents.jsonl via recordSubagent. Benchmark cost accounting (F-001)
 * depends on these numbers being present and correct. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPiSubagent } from "../src/subagent.ts";
import { recordSubagent } from "../src/state.ts";

async function withFakePi(scriptLines: string[], task: string): Promise<Awaited<ReturnType<typeof runPiSubagent>>> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-fake-pi-usage-"));
	const script = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(script, scriptLines.join("\n"));
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		return await runPiSubagent({ systemPrompt: "sp", task, cwd: process.cwd(), timeoutMs: 5000 });
	} finally {
		process.argv[1] = previousScript;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("subagent usage metering (I-010)", () => {
	it("aggregates usage from message_end assistant messages", async () => {
		const result = await withFakePi(
			[
				'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
				'emit({ type: "turn_start" });',
				'emit({ type: "message_start", message: { role: "assistant", content: [] } });',
				'emit({ type: "message_update", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.01 } }, assistantMessageEvent: { type: "text_delta", delta: "x" } });',
				'emit({ type: "message_end", message: { role: "assistant", model: "fake/model", usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1, totalTokens: 19, cost: { input: 0.002, output: 0.003, total: 0.012 } }, content: [{ type: "text", text: "done" }] } });',
			],
			"Task: usage",
		);
		assert.equal(result.ok, true);
		assert.ok(result.usage, "usage must be present when the stream carries it");
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.output, 5);
		assert.equal(result.usage.cacheRead, 3);
		assert.equal(result.usage.cacheWrite, 1);
		assert.ok(Math.abs(result.usage.cost - 0.012) < 1e-9);
	});

	it("sums usage across multiple assistant messages", async () => {
		const result = await withFakePi(
			[
				'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
				'const msg = (text, input, output, total) => ({ type: "message_end", message: { role: "assistant", model: "fake/model", usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total } }, content: [{ type: "text", text }] } });',
				'emit(msg("one", 100, 10, 0.001));',
				'emit(msg("two", 200, 20, 0.002));',
			],
			"Task: multi",
		);
		assert.equal(result.ok, true);
		assert.ok(result.usage);
		assert.equal(result.usage.input, 300);
		assert.equal(result.usage.output, 30);
		assert.ok(Math.abs(result.usage.cost - 0.003) < 1e-9);
	});

	it("omits usage when the stream carries none (legacy children)", async () => {
		const result = await withFakePi(
			[
				'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
				'emit({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: "final" }] } });',
			],
			"Task: nousage",
		);
		assert.equal(result.ok, true);
		assert.equal(result.usage, undefined);
	});
});

describe("recordSubagent usage persistence (I-010)", () => {
	it("writes the usage fields into subagents.jsonl", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-usage-jsonl-"));
		try {
			const { initState, startRun } = await import("../src/state.ts");
			initState(dir);
			const startRunId = startRun(dir, { topic: "usage-fixture", skill: "plan-normal", requestText: "fixture" }).run.run_id;
			const entry = recordSubagent(dir, startRunId, {
				role: "reviewer",
				name: "rev-usage-1",
				model: "zai/glm-5.3-flash:high",
				usage: { input: 11, output: 22, cache_read: 3, cache_write: 4, cost: 0.5 },
			});
			assert.equal(entry.usage?.input, 11);
			const line = fs
				.readFileSync(path.join(dir, ".git", "pi_plans", "runs", startRunId, "subagents.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
				.find((e) => e.name === "rev-usage-1");
			assert.ok(line);
			assert.deepEqual(line.usage, { input: 11, output: 22, cache_read: 3, cache_write: 4, cost: 0.5 });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
