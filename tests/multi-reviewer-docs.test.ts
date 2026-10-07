/**
 * Multi-reviewer execution review lives partly in prose (executor prompts,
 * README, workflow reference): pin the pieces that must agree with the code.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { BACKUP_REVIEW_ASPECTS } from "../src/auditor.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("multi-reviewer execution review docs", () => {
	it("the executor prompt declares and explains plans_review_directions", () => {
		const text = read("agents/executor.md");
		assert.match(text, /tools:[^\n]*plans_review_directions/);
		assert.match(text, /plans_review_directions/);
	});

	it("the workflow reference names every back-up aspect", () => {
		const text = read("references/pi-planning-workflow.md");
		for (const aspect of BACKUP_REVIEW_ASPECTS) assert.ok(text.includes(`\`${aspect.id}\``), `${aspect.id} documented`);
		assert.match(text, /Multi-reviewer rounds/);
	});

	it("the README and CHANGELOG describe the picker and the tool", () => {
		const readme = read("README.md");
		assert.match(readme, /plans_review_directions/);
		assert.match(readme, /1, 2, or 3 parallel reviewers/);
		assert.match(read("CHANGELOG.md"), /Multi-reviewer execution review/);
	});
});
