/** plan-huge execution lifecycle: a version completion archives the version and
 * loops the run back to planning; only the last version completes the run.
 * The execution-review reports land in a version-scoped subdirectory for huge
 * runs and keep the flat path for ordinary runs. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { writeReviewRoundReport } from "../src/auditor.ts";
import { completeExecution, startExecution } from "../src/exec.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { bindRun } from "../src/run-context.ts";
import { getRun, initState, startRun, runDirPath } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint } from "../src/workflow-state.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-huge-life-"));
	setMessagingApi({
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: async () => {},
	});
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function versionPlanText(): string {
	return "## Tasks\n\n- `Task-1`: first — files: src/a.ts; wave: 1\n\n### Execution Waves\n\n- wave 1: Task-1 — first\n\n## Verification Checks\n\n- [ ] `VC-001` covers `Task-1`; pass condition: src/a.ts exists; evidence: file; metric: 0.\n";
}

async function setupHuge(name: string): Promise<{
	workdir: string;
	runId: string;
	artifactDir: string;
	ctx: never;
}> {
	const { recordCheckpointTransition } = await import("../tools/plans.ts");
	const workdir = path.join(tmpRoot, name);
	fs.mkdirSync(workdir);
	spawnSync("git", ["init"], { cwd: workdir });
	spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
	spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
	initState(workdir);
	const { run } = startRun(workdir, { topic: name, skill: "plan-huge", requestText: "x" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	const session = { id: `s-${name}` };
	bindRun(session, workdir, run.run_id);
	const ctx = {
		cwd: workdir,
		sessionManager: session,
		hasUI: false,
		mode: "json",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
	} as never as { cwd: string; sessionManager: unknown };
	const transitionCtx = { sessionManager: session };
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	const overallPath = path.join(run.artifact_dir, "PLAN_overall_v1.md");
	fs.writeFileSync(
		overallPath,
		"## Versions\n\n- `v0.1.0`: skeleton — done: runs.\n- `v0.2.0`: store — done: persists.\n\n## Architecture\n\nx\n\n## File Map\n\nx\n\n## User Experience\n\nx\n\n## Final Objective\n\nx\n",
		"utf8",
	);
	recordCheckpointTransition(transitionCtx, workdir, run.run_id, { transition: "overall-plan-written", planPath: overallPath });
	recordCheckpointTransition(transitionCtx, workdir, run.run_id, { transition: "overall-accepted" });
	spawnSync("git", ["add", "-A"], { cwd: workdir });
	spawnSync("git", ["commit", "-m", "seed"], { cwd: workdir });
	return { workdir, runId: run.run_id, artifactDir: run.artifact_dir, ctx: ctx as never };
}

async function runVersion(
	ctx: never,
	workdir: string,
	runId: string,
	artifactDir: string,
	stream: string,
): Promise<void> {
	const { recordCheckpointTransition } = await import("../tools/plans.ts");
	const transitionCtx = { sessionManager: (ctx as { sessionManager: unknown }).sessionManager };
	const planPath = path.join(artifactDir, `PLAN_${stream}_v1.md`);
	fs.writeFileSync(planPath, versionPlanText(), "utf8");
	recordCheckpointTransition(transitionCtx, workdir, runId, { transition: "version-plan-written", planPath });
	const text = fs.readFileSync(planPath, "utf8");
	await startExecution(ctx, { planPath, planTasks: parsePlanTasks(text), items: parseChecklist(text) });
	// The audit gate marks the pass before completion; simulate it directly.
	mutateCheckpoint(workdir, runId, (cp) => ({
		...cp,
		execution: cp.execution
			? {
					...cp.execution,
					doneVcIds: ["VC-001"],
					audit: { ...(cp.execution.audit ?? { rounds: 0 }), rounds: 1, passed: true },
				}
			: cp.execution,
	}));
}

describe("huge version lifecycle", () => {
	it("loops back to planning after a version and completes only at the last one", async () => {
		const { workdir, runId, artifactDir, ctx } = await setupHuge("loop");
		// Version 1: also write a version-scoped review report, archived on completion.
		const runDir = runDirPath(workdir, runId);
		assert.ok(runDir);
		const reportPath = writeReviewRoundReport(runDir!, {
			versionSegment: "v0.1.0",
			budgetRound: 1,
			attempt: 1,
			outcome: "passed",
			passed: ["VC-001"],
			failed: [],
			undeterminable: [],
			coveredTaskIds: ["Task-1"],
			report: "all checks pass",
		});
		assert.match(reportPath ?? "", /execution-review\/v0\.1\.0\/round-1-attempt-1\.md$/);

		await runVersion(ctx, workdir, runId, artifactDir, "v0.1.0");
		await completeExecution(ctx);

		const afterFirst = loadCheckpoint(workdir, runId);
		assert.equal(afterFirst.status, "ok");
		if (afterFirst.status !== "ok") return;
		assert.equal(afterFirst.checkpoint.phase, "planning", "the run returns to planning");
		assert.equal(afterFirst.checkpoint.nextAction, "plan-next-version");
		assert.equal(afterFirst.checkpoint.huge?.currentIndex, 1);
		assert.equal(afterFirst.checkpoint.huge?.versions[0]?.status, "done");
		assert.equal(afterFirst.checkpoint.huge?.versions[0]?.completion?.auditPassed, true);
		assert.deepEqual(afterFirst.checkpoint.huge?.versions[0]?.completion?.doneVcIds, ["VC-001"]);
		assert.deepEqual(afterFirst.checkpoint.huge?.versions[0]?.completion?.reviewReports, [
			"execution-review/v0.1.0/round-1-attempt-1.md",
		]);
		assert.equal(getRun(workdir, runId)?.status, "planning", "the run stays non-terminal");
		assert.equal(afterFirst.checkpoint.execution?.approval ?? null, null);

		// Version 2 executes on the looped-back run and completes it.
		await runVersion(ctx, workdir, runId, artifactDir, "v0.2.0");
		await completeExecution(ctx);
		const final = loadCheckpoint(workdir, runId);
		assert.equal(final.status, "ok");
		if (final.status !== "ok") return;
		assert.equal(final.checkpoint.phase, "completed");
		assert.equal(final.checkpoint.nextAction, "none");
		assert.equal(final.checkpoint.huge?.versions[1]?.status, "done");
		assert.equal(getRun(workdir, runId)?.status, "done");
	});

	it("keeps the flat review-report path for ordinary runs", () => {
		const runDir = path.join(tmpRoot, "flat-run");
		fs.mkdirSync(runDir);
		const flat = writeReviewRoundReport(runDir, {
			budgetRound: 2,
			attempt: 1,
			outcome: "passed",
			passed: [],
			failed: [],
			undeterminable: [],
			coveredTaskIds: [],
			report: "x",
		});
		assert.match(flat ?? "", /execution-review\/round-2-attempt-1\.md$/);
		assert.equal(fs.existsSync(path.join(runDir, "execution-review", "round-2-attempt-1.md")), true);
	});

	it("refuses to execute a terminal huge run with versions still open", async () => {
		const { workdir, runId, artifactDir, ctx } = await setupHuge("guard");
		const planPath = path.join(artifactDir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(planPath, versionPlanText(), "utf8");
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		recordCheckpointTransition(
			{ sessionManager: (ctx as { sessionManager: unknown }).sessionManager },
			workdir,
			runId,
			{ transition: "version-plan-written", planPath },
		);
		const { setRunStatus } = await import("../src/state.ts");
		setRunStatus(workdir, runId, "done");
		const text = fs.readFileSync(planPath, "utf8");
		const started = await startExecution(ctx, { planPath, planTasks: parsePlanTasks(text), items: parseChecklist(text) });
		assert.equal(started, false);
		assert.equal(getRun(workdir, runId)?.status, "done");
	});
});
