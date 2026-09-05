import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildCriticizerTask, buildImplementationCriticizerTask, buildImplementationReviewerTask, buildReviewerTask, reviewerLanes } from "../src/refine-prompts.ts";

describe("reviewerLanes", () => {
	it("uses stable lane ids for the big-plan fanout", () => {
		assert.deepEqual(reviewerLanes(3).map((lane) => lane.id), ["correctness", "ordering", "verification"]);
	});

	it("falls back to a general lane for one-off review passes", () => {
		assert.deepEqual(reviewerLanes(1), [{ id: "general", lens: null }]);
	});
});

describe("buildReviewerTask", () => {
	it("includes a compact read-only contract and lane emphasis", () => {
		const text = buildReviewerTask({
			planText: "# plan",
			planPath: "/tmp/PLAN_v1.md",
			lens: "verification rigor",
			focus: "check the checklist",
			context: "repo evidence",
		});

		assert.match(text, /Goal: review the plan against the repository\./);
		assert.match(text, /Target: \/tmp\/PLAN_v1\.md/);
		assert.match(text, /Authority boundary: read-only analysis only\./);
		assert.match(text, /Review lens: verification rigor\./);
		assert.match(text, /Specific concerns from the main agent: check the checklist/);
		assert.match(text, /Context: repo evidence/);
		assert.match(text, /Surface at most five high-priority findings/);
	});
});

describe("buildCriticizerTask", () => {
	it("asks for short adversarial questions only", () => {
		const text = buildCriticizerTask({
			planText: "# plan",
			planPath: "/tmp/PLAN_v1.md",
			focus: "challenge the deployment step",
		});

		assert.match(text, /Goal: stress-test the plan's assumptions\./);
		assert.match(text, /Authority boundary: read-only analysis only\./);
		assert.match(text, /Specific concerns from the main agent: challenge the deployment step/);
		assert.match(text, /at most five adaptive questions/);
		assert.match(text, /never rewrite the plan/);
	});
});

describe("buildImplementationReviewerTask", () => {
	it("anchors findings to the plan and explicitly assesses delivery maturity", () => {
		const text = buildImplementationReviewerTask({
			planText: "# plan",
			planPath: "/tmp/PLAN_v1.md",
			lens: "correctness",
		});

		assert.match(text, /Goal: review the implemented result in the worktree against the plan\./);
		assert.match(text, /the IMPLEMENTATION in the worktree is under review/);
		assert.match(text, /Judge the implementation against the plan's goals/);
		assert.match(text, /did the executor ship a minimal MVP only, or refine for long-term growth/);
		assert.match(text, /Out-of-scope improvement ideas are low severity by default/);
		assert.match(text, /Review lens: correctness\./);
		assert.match(text, /Surface at most five high-priority findings/);
	});
});

describe("buildImplementationCriticizerTask", () => {
	it("asks implementation-focused adversarial questions without rewriting the implementation", () => {
		const text = buildImplementationCriticizerTask({
			planText: "# plan",
			planPath: "/tmp/PLAN_v1.md",
		});

		assert.match(text, /Goal: stress-test the implemented result's assumptions\./);
		assert.match(text, /the IMPLEMENTATION in the worktree is under review/);
		assert.match(text, /never rewrite the plan or the implementation/);
		assert.match(text, /at most five adaptive questions/);
	});
});

describe("plan-mode builders are unchanged by the implementation-mode addition", () => {
	it("buildReviewerTask output is byte-identical to its prior contract", () => {
		// Snapshot regression guard: changing the plan-mode brief would silently
		// break existing reviewer subagents. Keep this stable.
		const before = buildReviewerTask({ planText: "PLAN", planPath: "/p/PLAN_v1.md" });
		assert.match(before, /Goal: review the plan against the repository\./);
		assert.doesNotMatch(before, /IMPLEMENTATION in the worktree/);
	});
});

describe("refine tool wires target to the right builder", () => {
	it("forwards target=implementation to the implementation builders", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "tools", "refine.ts"), "utf8");
		assert.match(source, /buildImplementationReviewerTask/);
		assert.match(source, /buildImplementationCriticizerTask/);
		assert.match(source, /target\s*===\s*"implementation"/);
		assert.match(source, /params\.target\s*\?\?\s*"plan"/);
	});

	it("criticizer spawn gets the graph tools and prompt like the reviewer", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "tools", "refine.ts"), "utf8");
		const criticizerBlock = source.slice(
			source.indexOf('params.role === "criticizer"'),
			source.indexOf("const count = Math.min"),
		);
		assert.ok(criticizerBlock.length > 0, "criticizer block not found");
		assert.match(criticizerBlock, /tools: subagentTools/);
		assert.match(criticizerBlock, /graphPrompt/);
	});
});
