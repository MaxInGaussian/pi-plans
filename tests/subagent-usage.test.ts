/** I-010/VC-007: subagent usage metering — usage is aggregated into
 * SubagentResult.usage (see tests/agent-session.test.ts) and persisted into
 * subagents.jsonl via recordSubagent. Benchmark cost accounting depends on
 * these numbers being present and correct. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordSubagent } from "../src/state.ts";

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
				.readFileSync(path.join(dir, ".git", "pi-plans", "runs", startRunId, "subagents.jsonl"), "utf8")
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
