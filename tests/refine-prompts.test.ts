import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { GENERAL_LANE, buildRefAnalystTask, buildReviewerTask, lanesFromDirections, refAnalystSections } from "../src/refine-prompts.ts";

describe("reviewer lanes", () => {
	it("uses the planner's direction ids as the lane ids for a multi-reviewer fanout", () => {
		const lanes = lanesFromDirections([
			{ id: "migration-rollback", direction: "Probe the migration and the way back from a half-applied change." },
			{ id: "check-strength", direction: "Test whether each verification check could pass while the behavior is broken." },
		]);
		assert.deepEqual(lanes.map((lane) => lane.id), ["migration-rollback", "check-strength"]);
	});

	it("falls back to a general lane for one-off review passes", () => {
		assert.deepEqual(lanesFromDirections([]), [{ id: "general", direction: null }]);
		assert.deepEqual(GENERAL_LANE, { id: "general", direction: null });
	});
});

describe("buildReviewerTask", () => {
	it("includes a compact read-only contract and the assigned direction", () => {
		const text = buildReviewerTask({
			planText: "# plan",
			planPath: "/tmp/PLAN_v1.md",
			direction: "verification rigor",
			focus: "check the checklist",
			context: "repo evidence",
		});

		assert.match(text, /Goal: review the plan against the repository and surface what needs the user's judgment\./);
		assert.match(text, /Target: \/tmp\/PLAN_v1\.md/);
		assert.match(text, /Authority boundary: read-only analysis only\./);
		assert.match(text, /Your assigned direction: verification rigor/);
		assert.match(text, /Specific concerns from the main agent: check the checklist/);
		assert.match(text, /Context: repo evidence/);
		assert.match(text, /Surface at most five high-priority findings/);
	});
});

describe("buildRefAnalystTask", () => {
	it("carries the seven-section contract, ref metadata, and language instruction", () => {
		const text = buildRefAnalystTask({
			refId: "ref-1",
			localPath: "/cache/refs/some-repo",
			title: "Some Repo",
			url: "https://github.com/x/some-repo",
			kind: "project",
			context: "pi-plans extension",
			languageTag: "zh-Hans",
		});

		assert.match(text, /Reference id: ref-1/);
		assert.match(text, /Title: Some Repo/);
		assert.match(text, /URL: https:\/\/github\.com\/x\/some-repo/);
		assert.match(text, /Local path \(your working directory\): \/cache\/refs\/some-repo/);
		assert.match(text, /Authority boundary: read-only analysis only\./);
		assert.match(text, /Target repo context: pi-plans extension/);
		assert.match(text, /BCP47 tag "zh-Hans"/);
		for (const section of refAnalystSections()) {
			assert.ok(text.includes(`## ${section}`), `missing section: ${section}`);
		}
		assert.equal(refAnalystSections().length, 7);
	});

	it("omits optional lines when metadata is absent", () => {
		const text = buildRefAnalystTask({ refId: "ref-2", localPath: "/tmp/r" });
		assert.doesNotMatch(text, /Title:/);
		assert.doesNotMatch(text, /URL:/);
		assert.doesNotMatch(text, /Kind:/);
		assert.doesNotMatch(text, /BCP47 tag/);
	});
});

describe("plan-mode builder carries the merged findings+questions contract", () => {
	it("buildReviewerTask outputs Findings and Questions sections", () => {
		// v0.6.1: the reviewer absorbed the criticizer's questioning duty.
		const brief = buildReviewerTask({ planText: "PLAN", planPath: "/p/PLAN_v1.md" });
		assert.match(brief, /## Findings[\s\S]*## Questions/);
		assert.match(brief, /`Q-1`/);
		assert.match(brief, /at most five/i);
		assert.doesNotMatch(brief, /criticizer/i);
	});
});

describe("refine tool wires the single reviewer role", () => {
	it("has no role/target params and mandates ask_choice for questions", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "tools", "refine.ts"), "utf8");
		assert.doesNotMatch(source, /buildCriticizerTask/);
		assert.doesNotMatch(source, /buildImplementation/);
		assert.doesNotMatch(source, /StringEnum\(\["reviewer", "criticizer"\]/);
		assert.match(source, /MUST ask every question with ask_choice/);
		assert.match(source, /role: "reviewer"/);
	});

	it("reviewer spawn gets the graph tools and prompt", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "tools", "refine.ts"), "utf8");
		assert.match(source, /tools: subagentTools/);
		assert.match(source, /graphPrompt/);
	});
});
