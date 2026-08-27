/** Tests for the planning write guard. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { planningWriteBlockReason } from "../src/guard.ts";
import { initState, setRunStatus, startRun } from "../src/state.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-guard-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("planning write guard", () => {
	it("blocks source writes during planning, allows artifacts, lifts after handoff", () => {
		const workdir = path.join(tmpRoot, "repo");
		fs.mkdirSync(workdir);
		initState(workdir);
		const { run } = startRun(workdir, {
			topic: "guard check",
			skill: "plan-small",
			requestText: "x",
		});

		const block = planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" });
		assert.ok(block);
		assert.ok(block.includes("read-only outside planning artifacts"));

		// Artifact writes are allowed (absolute artifact_dir and relative path into it).
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "write", rawPath: path.join(run.artifact_dir, "PLAN_v1.md") }),
			null,
		);
		const relArtifact = path.join(path.relative(workdir, run.artifact_dir), "DECISIONS.md");
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "edit", rawPath: relArtifact }),
			null,
		);
		// Another run's artifact directory is still blocked (per-run boundary).
		assert.ok(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "./docs/pi-plans/other-run/PLAN_v1.md" }));

		// State dir writes are allowed; @-prefixed paths are normalized.
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "write", rawPath: ".git/pi_plans/tmp/note" }),
			null,
		);
		assert.ok(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "@/src/main.ts" }));

		// Read tools are never guarded.
		assert.equal(planningWriteBlockReason({ workdir, toolName: "read", rawPath: "src/main.ts" }), null);

		// Once the run leaves planning/accepted, the guard lifts.
		setRunStatus(workdir, run.run_id, "executing");
		assert.equal(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" }), null);
	});

	it("is inactive without an active run", () => {
		const workdir = path.join(tmpRoot, "no-run");
		fs.mkdirSync(workdir);
		initState(workdir);
		assert.equal(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" }), null);
	});
});
