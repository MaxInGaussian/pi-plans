/** plan-huge call-site sweep: huge plans must be visible to the run picker,
 * the resume surface, `/update-plan`, and the write-plan hooks. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { after, before, describe, it } from "node:test";
import { latestHugePlan, nextHugePlanPath } from "../src/huge-plan.ts";
import { executionCandidates } from "../src/run-picker.ts";
import { listResumeCandidates } from "../src/resume.ts";
import { initState, startRun } from "../src/state.ts";
import { createCheckpoint } from "../src/workflow-state.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-huge-callsites-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function setup(name: string): { workdir: string; runId: string; artifactDir: string } {
	const workdir = path.join(tmpRoot, name);
	fs.mkdirSync(workdir);
	spawnSync("git", ["init"], { cwd: workdir });
	spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
	spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
	initState(workdir);
	const { run } = startRun(workdir, { topic: name, skill: "plan-huge", requestText: "x" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	return { workdir, runId: run.run_id, artifactDir: run.artifact_dir };
}

const OVERALL = "## Versions\n\n- `v0.1.0`: a — done: b.\n- `v0.2.0`: c — done: d.\n\n## Architecture\n\nx\n\n## File Map\n\nx\n";

describe("huge run visibility", () => {
	it("counts a huge-only artifact dir as an execution candidate", async () => {
		const { workdir, runId, artifactDir } = setup("candidates");
		assert.deepEqual(executionCandidates(workdir), [], "no plan yet → not a candidate");
		fs.writeFileSync(path.join(artifactDir, "PLAN_overall_v1.md"), OVERALL, "utf8");
		const candidates = executionCandidates(workdir);
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0]!.run_id, runId);
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v1.md"), "# version plan\n", "utf8");
		assert.equal(executionCandidates(workdir).length, 1);
	});

	it("names the current version stream and round in the resume surface", async () => {
		const { workdir, runId, artifactDir } = setup("resume");
		fs.writeFileSync(path.join(artifactDir, "PLAN_overall_v1.md"), OVERALL, "utf8");
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		const ctx = { sessionManager: null };
		recordCheckpointTransition(ctx, workdir, runId, {
			transition: "overall-plan-written",
			planPath: path.join(artifactDir, "PLAN_overall_v1.md"),
		});
		recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-accepted" });
		const versionPath = path.join(artifactDir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(versionPath, "# version plan\n", "utf8");
		recordCheckpointTransition(ctx, workdir, runId, { transition: "version-plan-written", planPath: versionPath });
		const version2 = path.join(artifactDir, "PLAN_v0.1.0_v2.md");
		fs.writeFileSync(version2, "# version plan v2\n", "utf8");
		recordCheckpointTransition(ctx, workdir, runId, { transition: "version-plan-written", planPath: version2 });

		const candidate = listResumeCandidates(workdir).find((entry) => entry.runId === runId);
		assert.ok(candidate, "the huge run is resumable");
		assert.equal(candidate!.planStream, "v0.1.0");
		assert.equal(candidate!.planVersion, 2);
	});

	it("advances /update-plan inside the current version stream", () => {
		const { artifactDir } = setup("update-plan");
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v1.md"), "# v1\n", "utf8");
		const next = nextHugePlanPath(artifactDir, "v0.1.0");
		assert.equal(path.basename(next.path), "PLAN_v0.1.0_v2.md");
		assert.equal(next.round, 2);
		assert.equal(latestHugePlan(artifactDir, "v0.1.0")?.round, 1);
		const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		assert.match(source, /currentHugeStream\(ctx\.cwd, active\.run_id\)/);
		assert.match(source, /nextHugePlanPath\(artifactDir, hugeStream\)/);
	});

	it("wires the write-plan hooks to huge streams", async () => {
		const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		// Both hooks (pre-write marker + post-write identity) resolve through the
		// shared helper, so huge writes re-stamp the checkpoint.
		assert.equal((source.match(/planForWrite\(active\.artifact_dir/g) ?? []).length, 2);
		assert.match(source, /latestHugePlan\(artifactDir, parsed\.stream\)/);
		// The helper resolves the newest round of a stream, older rounds do not.
		const { artifactDir } = setup("hook-resolution");
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v1.md"), "# v1\n", "utf8");
		assert.equal(latestHugePlan(artifactDir, "v0.1.0")?.round, 1);
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v2.md"), "# v2\n", "utf8");
		assert.equal(latestHugePlan(artifactDir, "v0.1.0")?.round, 2);
		assert.equal(latestHugePlan(artifactDir, "v0.2.0")?.round, undefined);
	});

	it("keeps the status glyph working for huge artifact dirs", () => {
		const execSource = fs.readFileSync(path.join(ROOT, "src", "exec.ts"), "utf8");
		assert.match(execSource, /parseLatestPlanExists[\s\S]{0,400}parseHugePlanName\(name\) !== null/);
	});
});
