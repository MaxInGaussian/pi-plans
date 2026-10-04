/**
 * README consistency guard tests (PLAN: readme-audit, VC-005/VC-007).
 *
 * The positive case runs `readmeIssues(collectSurface(repoRoot))` against the
 * real README so the suite fails the moment the file drifts from the code
 * surface. The negative cases mutate a clone of the real surface and assert
 * that each declared check actually fires.
 */

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as url from "node:url";
import { describe, it } from "node:test";
import { README_CHECKS, collectSurface, readmeIssues } from "../scripts/readme-check.ts";
import type { ReadmeSurface } from "../scripts/readme-check.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const surface = collectSurface(ROOT);

function mutate(fn: (draft: ReadmeSurface) => void): string[] {
	const draft: ReadmeSurface = { ...surface, readme: surface.readme };
	fn(draft);
	return readmeIssues(draft);
}

function hits(issues: string[], check: string): string[] {
	return issues.filter((issue) => issue.startsWith(`${check}:`));
}

describe("README consistency guard", () => {
	it("declares every check the validator counts", () => {
		assert.ok(README_CHECKS.length >= 12, `expected at least 12 checks, found ${README_CHECKS.length}`);
		for (const check of ["commands", "tools", "actions", "skills", "dependencies", "links", "anchors", "highlights", "legacy-ids", "cjk", "stat-strip", "extraction-floors"]) {
			assert.ok(README_CHECKS.includes(check as (typeof README_CHECKS)[number]), `missing check ${check}`);
		}
	});

	it("passes for the repository's real surface", () => {
		assert.deepEqual(readmeIssues(surface), []);
	});

	it("rejects a command the README stopped mentioning", () => {
		const issues = mutate((draft) => {
			// Every mention, not only the backticked table row: the check is about the name.
			draft.readme = draft.readme.split("/plans-terminate").join("/plans-zzz");
		});
		assert.ok(hits(issues, "commands").length >= 1, `expected a commands issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a tool the README stopped mentioning", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace(/`plans_update_task`/g, "the task tool");
		});
		assert.ok(hits(issues, "tools").length >= 1, `expected a tools issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a missing plans action", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace(/`record-checkpoint`/g, "the checkpoint record");
		});
		assert.ok(hits(issues, "actions").length >= 1, `expected an actions issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a skill row that lost its link", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace("skills/plan-huge/SKILL.md", "skills/plan-huge/README.md");
		});
		assert.ok(hits(issues, "skills").length >= 1, `expected a skills issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a README that stopped naming devDependencies", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace(/devDependencies/g, "the toolchain extras");
		});
		assert.ok(hits(issues, "dependencies").length >= 1, `expected a dependencies issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a Contents anchor that resolves to nothing", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace("- [Layout](#layout)", "- [Layout](#no-such-heading)");
		});
		assert.ok(hits(issues, "anchors").length >= 1, `expected an anchors issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a mis-ordered Highlights section", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace("\n## Highlights\n", "\n## NotTheHighlightsHeading\n");
		});
		assert.ok(hits(issues, "highlights").length >= 1, `expected a highlights issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a reintroduced legacy plan id", () => {
		const issues = mutate((draft) => {
			draft.readme = `${draft.readme}\n- [ ] \`VC-001\` covers \`I-001\`; pass condition: x.\n`;
		});
		assert.ok(hits(issues, "legacy-ids").length >= 1, `expected a legacy-ids issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects CJK prose in the README", () => {
		const issues = mutate((draft) => {
			draft.readme = `${draft.readme}\n中文检查。\n`;
		});
		assert.ok(hits(issues, "cjk").length >= 1, `expected a cjk issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a stat strip that disagrees with the surface", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace("<b>7</b> skills", "<b>9</b> skills");
		});
		const stripIssues = hits(issues, "stat-strip");
		assert.ok(
			stripIssues.some((issue) => issue.includes("entry 1 is 9")),
			`expected the equality assertion (not the missing-strip branch), got ${JSON.stringify(stripIssues)}`,
		);
	});

	it("rejects a Highlights bullet whose anchor no longer resolves", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace("](\#safety-model)", "](\#safety-model-renamed)");
		});
		assert.ok(hits(issues, "anchors").length >= 1, `expected an anchors issue, got ${JSON.stringify(issues)}`);
	});

	it("fails loudly when the extractor finds fewer names than the floor", () => {
		const issues = mutate((draft) => {
			draft.tools = draft.tools.slice(0, 1);
		});
		assert.ok(hits(issues, "extraction-floors").length >= 1, `expected an extraction-floors issue, got ${JSON.stringify(issues)}`);
	});

	it("rejects a relative link whose target is gone", () => {
		const issues = mutate((draft) => {
			draft.readme = draft.readme.replace("](CONTRIBUTING.md)", "](CONTRIBUTING-does-not-exist.md)");
		});
		assert.ok(hits(issues, "links").length >= 1, `expected a links issue, got ${JSON.stringify(issues)}`);
	});
});
