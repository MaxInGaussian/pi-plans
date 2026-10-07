/**
 * The reviewer counts and the "planner writes the directions" rule live in
 * prose (skills + the shared workflow), so pin them: the prose must not drift
 * from the tool that enforces them.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("reviewer counts in the skills", () => {
	it("plan-normal runs two tailored reviewers", () => {
		const text = read("skills/plan-normal/SKILL.md");
		assert.match(text, /two concurrent independent reviewers/);
		assert.match(text, /`reviewers: 2`/);
		assert.match(text, /`directions`/);
		assert.doesNotMatch(text, /one reviewer round \(findings/);
	});

	it("plan-big and plan-huge run three tailored reviewers", () => {
		for (const skill of ["plan-big", "plan-huge"]) {
			const text = read(`skills/${skill}/SKILL.md`);
			assert.match(text, /`reviewers: 3`/, skill);
			assert.match(text, /`directions`/, skill);
		}
	});

	it("plan-with-refs follows its shape: two for plan-normal, three for big/huge, tailored", () => {
		const text = read("skills/plan-with-refs/SKILL.md");
		assert.match(text, /`plan-normal` runs `reviewers: 2`/);
		assert.match(text, /`refine` with `reviewers: 3`/);
		assert.match(text, /tailor-made `directions`/);
		assert.doesNotMatch(text, /reviewers: 1/);
	});

	it("plan-small and debug-and-plan still use a single reviewer round", () => {
		assert.match(read("skills/plan-small/SKILL.md"), /exactly one reviewer round/);
		assert.doesNotMatch(read("skills/debug-and-plan/SKILL.md"), /reviewers: [23]/);
	});
});

describe("reviewer counts and directions in the shared workflow", () => {
	const workflow = read("references/pi-planning-workflow.md");

	it("lists the default sequence per skill", () => {
		assert.match(workflow, /`plan-small`: one reviewer round; `plan-normal`: two concurrent reviewers via `refine` with `reviewers: 2`/);
		assert.match(workflow, /`plan-big` \/ `plan-huge`: three via `refine` with `reviewers: 3`/);
		assert.match(workflow, /two for `plan-normal`, three for `plan-big` \/ `plan-huge`/);
	});

	it("documents how the planner authors directions", () => {
		assert.match(workflow, /### Concurrent Reviewers And Tailored Directions/);
		assert.match(workflow, /`refine` refuses the round without them/);
		assert.match(workflow, /There are no fixed lenses/);
		assert.match(workflow, /Name the project/);
		assert.match(workflow, /Complementary, not overlapping/);
		assert.match(workflow, /`resumeRoundId` without `directions` reuses the lanes/);
	});

	it("no longer describes the fixed correctness / ordering / verification lenses", () => {
		for (const file of ["references/pi-planning-workflow.md", "references/state-and-config.md", "README.md", "agents/reviewer.md"]) {
			const text = read(file);
			assert.doesNotMatch(text, /emphasis lens/, file);
			assert.doesNotMatch(text, /requirements fit and correctness of claims/, file);
		}
	});
});

describe("the reviewer agent prompt", () => {
	it("tells a directed reviewer to dig deep and not duplicate the others", () => {
		const text = read("agents/reviewer.md");
		assert.match(text, /assigns you a direction, that is where you dig/);
		assert.match(text, /do not spend your report duplicating them/);
		assert.match(text, /high-severity problem you stumble on outside your direction/);
	});
});
