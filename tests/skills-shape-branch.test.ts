/**
 * plan-with-refs plan-shape branch: after the references are analyzed the
 * skill fixes the plan's shape (plan-normal / plan-big / plan-huge), and a
 * huge shape continues in the SAME run through the whole plan-huge stage
 * order. The rule has to stay pinned across six files, so every assertion
 * below is a file-content check — the evidence the execution reviewer can
 * reproduce with read-only tools; running the file is corroboration only.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function assertAll(text: string, literals: string[], label: string): void {
	for (const literal of literals) {
		assert.ok(text.includes(literal), `${label}: missing "${literal}"`);
	}
}

describe("plan-with-refs plan shape branch", () => {
	it("documents the Plan Shape Branch with all three shapes and the huge stage order", () => {
		const text = read("skills/plan-with-refs/SKILL.md");
		assertAll(
			text,
			[
				"## Plan Shape Branch",
				"## Plan Shape",
				"plan-normal",
				"plan-big",
				"plan-huge",
				"2 to 10",
				"refs-plan-shape",
				"ask_choice",
				"autoComplete: false",
				"reviewers: 3",
				"reviewers: 1",
				"overall-plan-written",
				"overall-review-consolidated",
				"overall-accepted",
				"version-plan-written",
				"version-review-consolidated",
				"version-completed",
				"Checkpoint Transitions",
				"huge-plan-artifact-template",
				"PLAN_overall_vN.md",
				"PLAN_vX.Y.Z_vN.md",
				"REF_ANALYSIS.md",
				"huge-refs",
				"new technology",
				"genuinely contested",
				"✓",
				"✗",
			],
			"plan-with-refs SKILL",
		);
	});

	it("keeps the frontmatter description routing-valid and bounded", () => {
		const text = read("skills/plan-with-refs/SKILL.md");
		const frontmatter = text.split("---\n")[1] ?? "";
		const description = frontmatter.split("\n").find((line) => line.startsWith("description:")) ?? "";
		assert.ok(/Use/.test(description), "description must keep its routing language (Use)");
		assert.ok(description.includes("plan-huge"), "description must advertise the huge branch");
		assert.ok(description.length <= 1024, `description too long: ${description.length}`);
	});

	it("routes multi-version reference work to plan-with-refs first", () => {
		const text = read("skills/planning/SKILL.md");
		const rule = text
			.split("\n")
			.find((line) => line.includes("route to `plan-with-refs`") && line.includes("plan-huge"));
		assert.ok(rule, "a routing rule must name both plan-with-refs and plan-huge");
		assert.ok(/multiple product versions|multi-version/.test(rule!), "the rule must cover the multi-version case");
	});

	it("documents the plan-with-refs entry in plan-huge", () => {
		const text = read("skills/plan-huge/SKILL.md");
		assertAll(
			text,
			["plan-with-refs", "REF_ANALYSIS.md", "same run", "never start a new run", "new technology", "genuinely contested"],
			"plan-huge SKILL",
		);
	});

	it("carries the normative shape-branch rule and drops the stale claims", () => {
		const text = read("references/pi-planning-workflow.md");
		assertAll(
			text,
			[
				"refs-plan-shape",
				"never counts against a skill's question minimum",
				"record-checkpoint",
				"overall-plan-written",
				"## Plan Shape",
				"reviewers: 3",
			],
			"workflow reference",
		);
		assert.ok(
			!text.includes("(`plan-big` / `plan-with-refs`: three concurrent reviewers"),
			"the stale always-three-lanes claim must be gone",
		);
		assert.ok(!text.includes("five skills"), "the stale skill count must be gone");
	});

	it("states the union append trigger in the workflow reference's plan-huge section", () => {
		const text = read("references/pi-planning-workflow.md");
		const hugeSection = text.split("## plan-huge (Multi-Version Builds)")[1] ?? "";
		const paragraph = hugeSection.split("\n\n").find((block) => block.includes("`analyze_refs`"));
		assert.ok(paragraph, "the plan-huge references paragraph must exist");
		const normalized = paragraph!.replace(/\s+/g, " ");
		assert.ok(
			normalized.includes("new technology") && normalized.includes("genuinely contested"),
			"the plan-huge append trigger must be the same union as the skill files",
		);
	});

	it("advertises the shape branch in the README skill row and router", () => {
		const text = read("README.md");
		const row = text
			.split("\n")
			.find((line) => line.includes("plan-with-refs") && line.includes("skills/plan-with-refs/SKILL.md"));
		assert.ok(row, "the README skill table row must exist");
		assert.ok(row!.includes("plan-huge") && /multi-version/.test(row!), "the skill row must mention the huge branch");
		const router = text.split("\n").find((line) => line.startsWith("`planning` inspects"));
		assert.ok(router, "the router paragraph must exist");
		assert.ok(router!.includes("plan-huge") && /multi-version/.test(router!), "the router must mention the huge branch");
	});

	it("names both entry skills in the version-complete message", () => {
		const text = read("src/exec.ts");
		const line = text.split("\n").find((entry) => entry.includes("Plan the next version"));
		assert.ok(line, "the version-complete tail line must exist");
		assert.ok(
			line!.includes("plan-huge") && line!.includes("plan-with-refs"),
			"the tail must name both entry skills",
		);
	});
});
