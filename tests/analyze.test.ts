/** F-002/F-005-wiring/F-011: analysis correctness regression tests — McNemar
 * two-sided formula, arm classification by relative segment (not absolute
 * path), sensitivity-subtree isolation, both_resolved counting. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { analyze, collectTrials, mcnemarExact, pairTrials, sensitivityVotes } from "../scripts/bench/analyze.ts";
import type { TrialRecord } from "../scripts/bench/analyze.ts";

let root: string;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-analyze-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeTrial(rel: string, taskId: string, resolved: boolean, tokens = 100): void {
	const dir = path.join(root, rel);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "result.json"),
		JSON.stringify({
			task_name: taskId,
			verifier_result: { rewards: { reward: resolved ? 1 : 0 } },
			agent_result: { n_input_tokens: tokens, n_output_tokens: tokens, cost_usd: 0, metadata: {} },
			agent_execution: { started_at: "2026-09-12T00:00:00Z", finished_at: "2026-09-12T00:10:00Z" },
		}),
	);
}

describe("mcnemarExact (F-002-adjacent formula regression)", () => {
	it("computes the correct two-sided p for b=1,c=16 (0.0002746)", () => {
		const { pValue } = mcnemarExact(1, 16);
		assert.ok(Math.abs(pValue - 2 * (18 / 131072)) < 1e-9);
	});
	it("computes p=0.25 for b=3,c=0 and p=1 for 0,0", () => {
		assert.ok(Math.abs(mcnemarExact(3, 0).pValue - 0.25) < 1e-9);
		assert.equal(mcnemarExact(0, 0).pValue, 1);
	});
});

describe("arm classification (V-006 regression: repo path contains pi-plans)", () => {
	it("classifies by relative segment, never the absolute path", () => {
		writeTrial("baseline/2026/a__1", "taskA", true);
		writeTrial("treatment/2026/a__2", "taskA", false);
		const trials = collectTrials(root);
		const b = trials.find((t) => t.taskId === "taskA" && t.arm === "baseline");
		const t = trials.find((t2) => t2.taskId === "taskA" && t2.arm === "treatment");
		assert.ok(b && t, "both arms must be present");
		assert.equal(trials.filter((x) => x.arm === "treatment").length, 1);
	});
	it("excludes archive and sensitivity subtrees from the primary walk", () => {
		writeTrial("archive/treatment/2026/b__1", "taskB", true);
		writeTrial("sensitivity/seed-2/treatment/b__2", "taskB", true);
		const trials = collectTrials(root).filter((t) => t.taskId === "taskB");
		assert.equal(trials.length, 0, "sensitivity/archive records must not leak into the primary");
	});
});

describe("both_resolved counting (F-002)", () => {
	it("counts both-resolved directly, not as concordant total", () => {
		const mk = (taskId: string, arm: "baseline" | "treatment", resolved: boolean): TrialRecord => ({
			taskId, arm, seed: 1, resolved, costUsd: 0, inputTokens: 1, outputTokens: 1, turns: 1, wallTimeSec: 1,
		});
		const pairs = pairTrials([
			mk("x", "baseline", true), mk("x", "treatment", true),
			mk("y", "baseline", false), mk("y", "treatment", false),
			mk("z", "baseline", true), mk("z", "treatment", false),
		]);
		const report = analyze(pairs) as { mcnemar: { both_resolved: number; both_failed: number } };
		assert.equal(report.mcnemar.both_resolved, 1);
		assert.equal(report.mcnemar.both_failed, 1);
	});
});

describe("sensitivity isolation (F-011)", () => {
	it("sensitivityVotes uses primary pairs + rerun records only", () => {
		const mk = (taskId: string, arm: "baseline" | "treatment", seed: number, resolved: boolean): TrialRecord => ({
			taskId, arm, seed, resolved, costUsd: 0, inputTokens: 1, outputTokens: 1, turns: 1, wallTimeSec: 1,
		});
		const primary = pairTrials([
			mk("w", "baseline", 1, true), mk("w", "treatment", 1, false),
		]);
		const rerun = [
			{ ...mk("w", "baseline", 2, true), relSeed: 2 },
			{ ...mk("w", "treatment", 2, true), relSeed: 2 },
			{ ...mk("w", "baseline", 3, false), relSeed: 3 },
			{ ...mk("w", "treatment", 3, true), relSeed: 3 },
		];
		const rows = sensitivityVotes(primary, rerun);
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0], { taskId: "w", baselineVotes: 2, treatmentVotes: 2, winner: "tie" });
	});
});
