/** plan-huge end-to-end loop on a fake context: overall plan → accept →
 * v0.1.0 plan/review/execute/archive → v0.2.0 planning (deferred absorbed,
 * budget inherited) → terminal. Review legs are simulated through
 * `startReviewRound`/`recordLaneOutcome`; no pi subprocess is spawned. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { completeExecution, startExecution } from "../src/exec.ts";
import { writeReviewRoundReport } from "../src/auditor.ts";
import { deriveDashboardModel, renderDashboardLines } from "../src/dashboard.ts";
import { hugeChrome } from "../src/ui-language.ts";
import { runDirPath } from "../src/state.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { bindRun } from "../src/run-context.ts";
import { getRun, initState, startRun, utcNow } from "../src/state.ts";
import {
	createCheckpoint,
	loadCheckpoint,
	mutateCheckpoint,
	recordLaneOutcome,
	startReviewRound,
} from "../src/workflow-state.ts";
import { showStateView } from "../src/state.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-huge-loop-"));
	setMessagingApi({ appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: async () => {} });
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const OVERALL = [
	"# PLAN_overall_v1",
	"",
	"## Versions",
	"",
	"- `v0.1.0`: walking skeleton — done: the CLI runs on a sample input.",
	"- `v0.2.0`: persistence — done: data survives a restart.",
	"",
	"## Architecture",
	"",
	"One CLI process over a store module.",
	"",
	"## File Map",
	"",
	"| Path | Responsibility | Version |",
	"| --- | --- | --- |",
	"| src/cli.ts | command layer | v0.1.0 |",
	"",
	"## User Experience",
	"",
	"One command per action.",
	"",
	"## Final Objective",
	"",
	"A dependable local tool.",
	"",
].join("\n");

function versionPlan(deferredTarget: string, deferredId: string | null, references: boolean): string {
	const deferred =
		deferredId === null
			? `## Deferred to ${deferredTarget}\n\n- \`${deferredId ?? "none"}\`: none.\n`
			: `## Deferred to ${deferredTarget}\n\n- \`${deferredId}\`: file store — reason: the backend seam comes first.\n`;
	return [
		"## Tasks",
		"",
		"- `Task-1`: command layer — files: src/cli.ts; wave: 1",
		"",
		"### Execution Waves",
		"",
		"- wave 1: Task-1 — the walking skeleton",
		"",
		"## Verification Checks",
		"",
		"- [ ] `VC-001` covers `Task-1`; pass condition: src/cli.ts exports run; evidence: symbol; metric: 0 failures.",
		"",
		references ? "## Evidence\n\n- https://github.com/example/cli-kit\n" : "",
		deferred,
	].join("\n");
}

async function reviewAndConsolidate(
	workdir: string,
	runId: string,
	transition: "overall-review-consolidated" | "version-review-consolidated",
	planPath: string,
): Promise<void> {
	const { recordCheckpointTransition } = await import("../tools/plans.ts");
	const roundId = `${transition}-${path.basename(planPath, ".md")}`;
	startReviewRound(workdir, runId, {
		roundId,
		role: "reviewer",
		target: "plan",
		reviewers: 1,
		lanes: [{ laneId: "a" }],
		planPath,
	});
	recordLaneOutcome(workdir, runId, roundId, "a", { ok: true, output: "findings: none" });
	recordCheckpointTransition({ sessionManager: null }, workdir, runId, { transition, roundId });
}

describe("plan-huge end-to-end loop", () => {
	it("runs overall → v0.1.0 → v0.2.0 → done on one non-terminal run", { timeout: 60000 }, async () => {
		const { recordCheckpointTransition, hugeRunSummary } = await import("../tools/plans.ts");
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const workdir = path.join(tmpRoot, "loop");
		fs.mkdirSync(workdir);
		spawnSync("git", ["init"], { cwd: workdir });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
		spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
		initState(workdir);
		const { run } = startRun(workdir, { topic: "loop", skill: "plan-huge", requestText: "x" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		const session = { id: "loop-session" };
		bindRun(session, workdir, run.run_id);
		const ctx = {
			cwd: workdir,
			sessionManager: session,
			hasUI: false,
			mode: "json",
			ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		} as never;

		// ---- overall plan: write → review → accept ----
		const overallPath = path.join(run.artifact_dir, "PLAN_overall_v1.md");
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(overallPath, OVERALL, "utf8");
		recordCheckpointTransition({ sessionManager: session }, workdir, run.run_id, {
			transition: "overall-plan-written",
			planPath: overallPath,
		});
		await reviewAndConsolidate(workdir, run.run_id, "overall-review-consolidated", overallPath);
		let cp = loadCheckpoint(workdir, run.run_id);
		assert.equal(cp.status === "ok" ? cp.checkpoint.nextAction : null, "accept-overall");
		recordCheckpointTransition({ sessionManager: session }, workdir, run.run_id, { transition: "overall-accepted" });

		// ---- v0.1.0: plan → review → execute → archive ----
		const v1 = path.join(run.artifact_dir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(v1, versionPlan("v0.2.0", "D-v0.1.0-1", true), "utf8");

		// The overall plan is never executable, even though it is the newest plan;
		// the refusal names the current version plan and changes nothing.
		const refused = await executeHandoff(ctx, overallPath);
		assert.equal(refused.status, "error");
		assert.match(refused.message, /never executable/);
		assert.match(refused.message, /PLAN_v0\.1\.0_v1\.md/);
		assert.equal(getRun(workdir, run.run_id)?.status, "planning", "the refusal changed nothing");
		recordCheckpointTransition({ sessionManager: session }, workdir, run.run_id, {
			transition: "version-plan-written",
			planPath: v1,
		});
		await reviewAndConsolidate(workdir, run.run_id, "version-review-consolidated", v1);
		const gated = await executeHandoff(ctx, v1);
		assert.match(gated.message, /explicit user approval/, "the version plan passes every execution gate");

		const text1 = fs.readFileSync(v1, "utf8");
		await startExecution(ctx, { planPath: v1, planTasks: parsePlanTasks(text1), items: parseChecklist(text1) });
		// The execution reviewer's report for this version lands in the version
		// subdirectory and is archived with the version.
		const runDir1 = runDirPath(workdir, run.run_id);
		assert.ok(runDir1);
		const report1 = writeReviewRoundReport(runDir1!, {
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
		assert.match(report1 ?? "", /execution-review\/v0\.1\.0\/round-1-attempt-1\.md$/);
		mutateCheckpoint(workdir, run.run_id, (inner) => ({
			...inner,
			execution: inner.execution
				? {
						...inner.execution,
						doneVcIds: ["VC-001"],
						tasks: { "Task-1": { status: "complete", evidence: "src/cli.ts exports run" } },
						reviewBudget: 3,
						reviewBudgetDefaulted: false,
						reviewRoundsTotal: 1,
						audit: { rounds: 1, passed: true },
					}
				: inner.execution,
		}));
		await completeExecution(ctx);

		cp = loadCheckpoint(workdir, run.run_id);
		assert.equal(cp.status, "ok");
		if (cp.status !== "ok") return;
		assert.equal(cp.checkpoint.phase, "planning", "version 1 loops back to planning");
		assert.equal(cp.checkpoint.nextAction, "plan-next-version");
		assert.equal(cp.checkpoint.huge?.versions[0]?.status, "done");
		assert.equal(cp.checkpoint.huge?.versions[0]?.completion?.auditPassed, true);
		assert.equal(getRun(workdir, run.run_id)?.status, "planning", "the run stays non-terminal");
		let view = showStateView(workdir);
		assert.equal(view.huge?.position, "2/2");
		assert.equal(view.huge?.versions[0]?.status, "done");
		assert.deepEqual(cp.checkpoint.huge?.versions[0]?.completion?.reviewReports, [
			"execution-review/v0.1.0/round-1-attempt-1.md",
		]);
		assert.equal(
			fs.existsSync(path.join(runDirPath(workdir, run.run_id)!, "execution-review", "v0.1.0", "round-1-attempt-1.md")),
			true,
		);
		// The dashboard progress line is composed from the same checkpoint state
		// exec.ts feeds the widget with, and renders the current version (v0.2.0).
		const current = cp.checkpoint.huge!.versions[cp.checkpoint.huge!.currentIndex]!;
		const dashboard = renderDashboardLines(
			deriveDashboardModel("loop", [], [], {
				huge: {
					version: current.label,
					index: cp.checkpoint.huge!.currentIndex + 1,
					total: cp.checkpoint.huge!.versions.length,
					statusLabel: hugeChrome("en").statusLabel(current.status),
				},
			}),
			100,
		);
		assert.ok(dashboard.some((line) => line.includes("huge v0.2.0 2/2")), dashboard.join("\n"));

		// ---- v0.2.0: deferred gate, inherited budget, terminal completion ----
		const v2 = path.join(run.artifact_dir, "PLAN_v0.2.0_v1.md");
		fs.writeFileSync(v2, versionPlan("v0.3.0", "D-v0.2.0-1", true), "utf8");
		assert.throws(
			() =>
				recordCheckpointTransition({ sessionManager: session }, workdir, run.run_id, {
					transition: "version-plan-written",
					planPath: v2,
				}),
			/unprocessed/,
		);
		// The absorbed item must be referenced by the new plan text.
		fs.writeFileSync(
			v2,
			versionPlan("v0.3.0", "D-v0.2.0-1", true).replace(
				"- `Task-1`: command layer",
				"- `Task-1`: D-v0.1.0-1 command layer",
			),
			"utf8",
		);
		recordCheckpointTransition({ sessionManager: session }, workdir, run.run_id, {
			transition: "version-plan-written",
			planPath: v2,
			deferred: [{ itemId: "D-v0.1.0-1", disposition: "absorbed" }],
		});
		await reviewAndConsolidate(workdir, run.run_id, "version-review-consolidated", v2);
		const text2 = fs.readFileSync(v2, "utf8");
		await startExecution(ctx, { planPath: v2, planTasks: parsePlanTasks(text2), items: parseChecklist(text2) });
		cp = loadCheckpoint(workdir, run.run_id);
		assert.equal(cp.status, "ok");
		if (cp.status !== "ok") return;
		assert.equal(cp.checkpoint.execution?.reviewBudget, 3, "version 2 inherits the version-1 budget");
		assert.equal(cp.checkpoint.execution?.reviewRoundsTotal, 1);
		mutateCheckpoint(workdir, run.run_id, (inner) => ({
			...inner,
			execution: inner.execution
				? { ...inner.execution, doneVcIds: ["VC-001"], audit: { rounds: 1, passed: true } }
				: inner.execution,
		}));
		await completeExecution(ctx);

		cp = loadCheckpoint(workdir, run.run_id);
		assert.equal(cp.status, "ok");
		if (cp.status !== "ok") return;
		assert.equal(cp.checkpoint.phase, "completed", "the last version completes the run");
		assert.equal(cp.checkpoint.nextAction, "none");
		assert.equal(getRun(workdir, run.run_id)?.status, "done");
		assert.deepEqual(
			cp.checkpoint.huge?.versions.map((version) => version.status),
			["done", "done"],
		);
		assert.deepEqual(cp.checkpoint.huge?.deferred.map((entry) => entry.itemId), ["D-v0.1.0-1"]);
		assert.equal(cp.checkpoint.huge?.deferred[0]?.disposition, "absorbed");
		// A terminal run is no longer the ACTIVE run, so the state view stops
		// showing its tree; the run itself still reports it by id.
		view = showStateView(workdir);
		assert.equal(view.huge ?? null, null);
		const summary = hugeRunSummary(workdir, run.run_id) as {
			position: string;
			versions: Array<{ label: string; status: string }>;
		};
		assert.equal(summary.position, "2/2");
		assert.deepEqual(
			summary.versions.map((version) => `${version.label}:${version.status}`),
			["v0.1.0:done", "v0.2.0:done"],
		);
		assert.ok(utcNow().length > 0);
	});
});
