/** Tests for plan artifact parsing (verifier checklist + done markers). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { latestPlanVersion, nextPlanVersionPath, parseChecklist, scanDoneMarkers } from "../src/plan.ts";

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
