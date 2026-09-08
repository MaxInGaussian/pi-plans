/** Tests for the plans tool source wiring. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { describe, it } from "node:test";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function readPlansSource(): string {
	return fs.readFileSync(path.join(ROOT, "tools", "plans.ts"), "utf8");
}

describe("plans tool source", () => {
	it("declares artifactRootSource in PlansParams", () => {
		const source = readPlansSource();
		const start = source.indexOf("const PlansParams = Type.Object({");
		const end = source.indexOf("});", start);
		assert.ok(start >= 0, "missing PlansParams block start");
		assert.ok(end >= 0, "missing PlansParams block end");

		const params = source.slice(start, end);
		assert.match(params, /artifactRootSource:\s*Type\.Optional/);
		assert.doesNotMatch(params, /executionModelSelector/);
		assert.doesNotMatch(params, /executionModelSource/);
	});

	it("keeps the plans handler wired to artifact root and no separate model-selection action", () => {
		const source = readPlansSource();
		assert.match(source, /import \{[\s\S]*setArtifactRoot,[\s\S]*\} from "\.\.\/src\/state\.ts";/);
		assert.match(source, /case "set-artifact-root"/);
		assert.doesNotMatch(source, /setExecutionModel/);
		assert.doesNotMatch(source, /case "set-execution-model"/);
		assert.match(source, /params\.artifactRootSource/);
	});

	it("declares refsRootSource and wires the set-refs-root action plus ref-analyst role", () => {
		const source = readPlansSource();
		assert.match(source, /refsRoot:\s*Type\.Optional/);
		assert.match(source, /refsRootSource:\s*Type\.Optional/);
		assert.match(source, /import \{[\s\S]*setRefsRoot,[\s\S]*\} from "\.\.\/src\/state\.ts";/);
		assert.match(source, /case "set-refs-root"/);
		assert.match(source, /params\.refsRootSource/);
		assert.match(source, /"reviewer", "criticizer", "ref-analyst"/);
	});
});

describe("record-checkpoint transitions (I-003)", () => {
	it("records plan identity and rejects forged terminal states", async () => {
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-rcp-"));
		try {
			spawnSync("git", ["init"], { cwd: workdir });
			const { initState, startRun } = await import("../src/state.ts");
			initState(workdir);
			const { run } = startRun(workdir, { topic: "rcp", skill: "plan-normal", requestText: "t" });
			const { createCheckpoint, loadCheckpoint } = await import("../src/workflow-state.ts");
			createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
			const ctx = { sessionManager: { id: "s" } };

			// plan-written records the exact file identity.
			const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
			fs.mkdirSync(run.artifact_dir, { recursive: true });
			fs.writeFileSync(planPath, "# plan body", "utf8");
			const updated = recordCheckpointTransition(ctx, workdir, run.run_id, {
				transition: "plan-written",
				planPath,
			});
			assert.equal(updated.plan?.version, 1);
			assert.equal(updated.plan?.sha256.length, 64);
			const loaded = loadCheckpoint(workdir, run.run_id);
			assert.equal(loaded.status, "ok");
			assert.equal(loaded.checkpoint.plan?.path, planPath);

			// completed without evidence is rejected (F-004).
			assert.throws(
				() => recordCheckpointTransition(ctx, workdir, run.run_id, { transition: "completed" }),
				/evidence/,
			);
			// completed from the planning phase is rejected even with evidence.
			assert.throws(
				() => recordCheckpointTransition(ctx, workdir, run.run_id, { transition: "completed", evidence: "done" }),
				/cannot complete from phase/,
			);
			// planPath is required.
			assert.throws(
				() => recordCheckpointTransition(ctx, workdir, run.run_id, { transition: "plan-written" }),
				/planPath/,
			);
		} finally {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	});
});

describe("pre-plan compaction wiring", () => {
	it("start-run marks pre-plan compaction pending under settings and execution guards", () => {
		const source = readPlansSource();
		assert.match(source, /import \{ getExecution, markPrePlanCompactPending \} from "\.\.\/src\/exec\.ts";/);
		assert.match(source, /import \{ loadVccSettings, scaffoldVccSettings \} from "\.\.\/src\/compaction\.ts";/);
		assert.match(source, /const prePlanStateRoot = resolveStateRootOrNull\(workdir\);/);
		assert.match(source, /if \(prePlanStateRoot && !getExecution\(\)\) \{/);
		assert.match(source, /scaffoldVccSettings\(prePlanStateRoot\);/);
		assert.match(source, /loadVccSettings\(prePlanStateRoot\)\.prePlanCompact/);
		assert.match(source, /markPrePlanCompactPending\(ctx, result\.run\.run_id\);/);
	});

	it("index.ts consumes the pending flag from the plans tool_result hook", () => {
		const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		assert.match(source, /consumePrePlanCompactPending/);
		assert.match(source, /customInstructions: PLANNING_PREPLAN_COMPACT_HINT/);
		assert.match(source, /sendPrePlanCompactResume\(pi\)/);
		assert.match(source, /pre-plan compaction skipped; continuing planning\./);
	});
});
