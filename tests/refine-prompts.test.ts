import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCriticizerTask, buildReviewerTask, reviewerLanes } from "../src/refine-prompts.ts";

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
