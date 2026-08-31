/** Tests for plan artifact parsing (verifier checklist + done markers). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { latestPlanVersion, nextPlanVersionPath, parseChecklist, parseImplItems, resolveImplStatuses, scanCurrentIMarkers, scanDoneMarkers, scanImplMarkers, shortImplDescription, extractCoverage, resolveCurrentI, inferCurrentI } from "../src/plan.ts";

const PLAN = `# PLAN_v1 - demo

## Goals

- \`G-001\`: Ship it.

## Verifier Checklist

- [ ] \`VC-001\` covers \`I-001\`; pass condition: tests green; evidence: pytest output; metric: 100% pass.
- [x] \`VC-002\` covers \`I-002\`; pass condition: no lint errors; evidence: run ruff; metric: zero findings.
- not a checklist line
- [ ] \`VC-003\` covers \`I-003\`; pass condition: manual check; metric: not quantified.

## Risks And Mitigations

- \`Risk-001\`: something.
`;

describe("plan parsing", () => {
	it("parses checklist items with ids and done state", () => {
		const items = parseChecklist(PLAN);
		assert.equal(items.length, 3);
		assert.equal(items[0]?.id, "VC-001");
		assert.equal(items[0]?.done, false);
		assert.equal(items[1]?.id, "VC-002");
		assert.equal(items[1]?.done, true);
		assert.equal(items[2]?.id, "VC-003");
	});

	it("returns empty without a checklist section", () => {
		assert.equal(parseChecklist("# no checklist here\n\n- [ ] `VC-001` orphan\n").length, 0);
	});

	it("scans done markers", () => {
		assert.deepEqual(scanDoneMarkers("done [DONE:VC-001] and [DONE:VC-003], plus [DONE:VC-001] again"), [
			"VC-001",
			"VC-003",
			"VC-001",
		]);
		assert.deepEqual(scanDoneMarkers("nothing here"), []);
	});
});

describe("latestPlanVersion", () => {
	let dir: string;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-plan-"));
		fs.writeFileSync(path.join(dir, "PLAN_v1.md"), "v1");
		fs.writeFileSync(path.join(dir, "PLAN_v10.md"), "v10");
		fs.writeFileSync(path.join(dir, "PLAN_v2.md"), "v2");
		fs.writeFileSync(path.join(dir, "notes.md"), "notes");
	});

	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("picks the highest version numerically", () => {
		const latest = latestPlanVersion(dir);
		assert.equal(latest?.version, 10);
		assert.equal(latest?.path, path.join(dir, "PLAN_v10.md"));
	});

	it("returns null for missing dirs", () => {
		assert.equal(latestPlanVersion(path.join(dir, "nope")), null);
	});
});

describe("nextPlanVersionPath", () => {
	let dir: string;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-next-"));
	});

	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("increments from the highest existing version", () => {
		fs.writeFileSync(path.join(dir, "PLAN_v1.md"), "v1");
		fs.writeFileSync(path.join(dir, "PLAN_v4.md"), "v4");
		const next = nextPlanVersionPath(dir);
		assert.equal(next.version, 5);
		assert.equal(next.path, path.join(dir, "PLAN_v5.md"));
	});

	it("starts at v1 for empty dirs", () => {
		const empty = path.join(dir, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const next = nextPlanVersionPath(empty);
		assert.equal(next.version, 1);
		assert.equal(next.path, path.join(empty, "PLAN_v1.md"));
	});
});

describe("implementation items", () => {
	const IMPL_PLAN = `# PLAN_v1 - demo

## Implementation Items

- \`I-001\`: Add state helpers in src/exec.ts; evaluate percent and coverage. Details follow:
  - nested sub-bullet ignored
- \`I-002\`: Wire the turn_end trigger and status bar.
- not an item line
- \`I-001\`: duplicate id ignored

## Verifier Checklist

- [ ] \`VC-001\` covers \`I-001\` and \`I-002\`; pass condition: tests green; metric: 0 fail.
- [ ] \`VC-002\` covers \`I-002\`; pass condition: lint clean; metric: zero findings.
`;

	it("parses strict top-level single-line items and ignores continuations", () => {
		const items = parseImplItems(IMPL_PLAN);
		assert.equal(items.length, 2);
		assert.equal(items[0]?.id, "I-001");
		// First line only: the multi-line body and nested sub-bullet are ignored.
		assert.match(items[0]!.text, /^Add state helpers/);
		assert.doesNotMatch(items[0]!.text, /nested/);
		assert.equal(items[1]?.id, "I-002");
	});

	it("returns empty without an Implementation Items section", () => {
		assert.equal(parseImplItems("# no items here\n- `I-001`: orphan\n").length, 0);
	});

	it("shortens descriptions at sentence or semicolon boundaries and caps length", () => {
		assert.equal(shortImplDescription("Add helpers; evaluate percent. Then more."), "Add helpers");
		assert.equal(shortImplDescription("First sentence. Second one."), "First sentence.");
		const long = "x".repeat(120);
		assert.equal(shortImplDescription(long).length, 80);
		assert.match(shortImplDescription(long), /…$/);
	});

	it("extracts coverage refs before the first semicolon only", () => {
		assert.deepEqual(extractCoverage("`VC-001` covers `I-001` and `I-002`; pass: `I-003` mentioned late"), ["I-001", "I-002"]);
		assert.deepEqual(extractCoverage("no coverage clause here"), []);
	});

	it("parses and resolves current-I markers without changing progress marker states", () => {
		const implItems = [{ id: "I-001", text: "first" }, { id: "I-002", text: "second" }];
		assert.deepEqual(scanCurrentIMarkers("[I-001:current] [I-999:current] [I-002:current]"), [
			{ id: "I-001" },
			{ id: "I-999" },
			{ id: "I-002" },
		]);
		assert.equal(resolveCurrentI(implItems, scanCurrentIMarkers("[I-999:current] [I-002:current]")), "I-002");
		assert.equal(inferCurrentI(implItems, [], undefined), "I-001");
	});
	it("scans impl markers", () => {
		assert.deepEqual(scanImplMarkers("[I-001:implemented] then [I-002:validating] and [I-003:done]"), [
			{ id: "I-001", state: "implemented" },
			{ id: "I-002", state: "validating" },
		]);
	});

	it("resolves the status matrix with vc-passed > marker > derivation", () => {
		const items = parseChecklist(IMPL_PLAN);
		const implItems = parseImplItems(IMPL_PLAN);

		// No markers, nothing done: frontier I-001 implementing, I-002 pending.
		assert.deepEqual(resolveImplStatuses(implItems, items, undefined), {
			"I-001": "implementing",
			"I-002": "pending",
		});

		// Explicit marker wins over derivation.
		assert.deepEqual(resolveImplStatuses(implItems, items, { "I-002": "implemented" }), {
			"I-001": "implementing",
			"I-002": "implemented",
		});

		// Some covering VC done without a marker: deriving validating.
		items[1]!.done = true;
		assert.deepEqual(resolveImplStatuses(implItems, items, {}), {
			"I-001": "implementing",
			"I-002": "validating",
		});

		// All covering VCs done → vc-passed beats the marker.
		items[0]!.done = true;
		assert.deepEqual(resolveImplStatuses(implItems, items, { "I-002": "validating" }), {
			"I-001": "vc-passed",
			"I-002": "vc-passed",
		});
	});
});
