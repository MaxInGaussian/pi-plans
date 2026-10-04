/** plan-huge workflow checkpoint tests: huge state, stream identities,
 * version loop-back, budget inheritance, deferred gates and migration. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	applyExecutionApproved,
	applyHugeDeferredDispositions,
	applyHugeOverallAccepted,
	applyHugeOverallPlanWritten,
	applyHugeVersionCompleted,
	applyHugeVersionPlanWritten,
	applyMigration,
	applyQuestionAnswered,
	applyQuestionAsked,
	createCheckpoint,
	deferredQuestionId,
	loadCheckpoint,
	mutateCheckpoint,
	planIdentityOf,
	validateCheckpoint,
	type ExecutionApproval,
	type WorkflowCheckpoint,
} from "../src/workflow-state.ts";
import { initState, startRun, StateError } from "../src/state.ts";

let tmpRoot: string;

function mkWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function git(workdir: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd: workdir, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr ?? "");
}

function setupRun(name: string): { workdir: string; runId: string; artifactDir: string } {
	const workdir = mkWorkdir(name);
	git(workdir, "init");
	git(workdir, "config", "user.email", "t@example.com");
	git(workdir, "config", "user.name", "T");
	initState(workdir);
	const { run } = startRun(workdir, { topic: "huge-workflow", skill: "plan-huge", requestText: "test" });
	return { workdir, runId: run.run_id, artifactDir: run.artifact_dir };
}

function baseCheckpoint(workdir: string, runId: string): WorkflowCheckpoint {
	const created = createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
	return created;
}

const VERSIONS = [
	{ label: "v0.1.0", mission: "walking skeleton", done: "cli runs" },
	{ label: "v0.2.0", mission: "persistence", done: "data survives restart" },
	{ label: "v0.3.0", mission: "multi-user", done: "users isolated" },
];

function withPlanFile(dir: string, name: string, text = "# plan\n"): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, text, "utf8");
	return file;
}

function approving(cp: WorkflowCheckpoint, planPath: string): WorkflowCheckpoint {
	const approval: ExecutionApproval = {
		plan: planIdentityOf(planPath, 1),
		worktree: cp.worktreeRoot,
		headAtApproval: null,
		approvedAt: "2026-10-04T00:00:00Z",
	};
	return applyExecutionApproved({ ...cp, nextAction: "accept-execute" }, approval);
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-huge-wf-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("huge checkpoint state", () => {
	it("records the overall plan and round-trips the huge section", () => {
		const { workdir, runId, artifactDir } = setupRun("roundtrip");
		baseCheckpoint(workdir, runId);
		const next = mutateCheckpoint(workdir, runId, (cp) =>
			applyHugeOverallPlanWritten(cp, { round: 1, versions: VERSIONS }),
		);
		assert.equal(next.nextAction, "accept-overall");
		assert.equal(next.huge?.versions.length, 3);
		assert.deepEqual(
			next.huge?.versions.map((version) => version.status),
			["pending", "pending", "pending"],
		);
		assert.equal(next.huge?.overallRound, 1);
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "ok");
		if (loaded.status === "ok") {
			assert.deepEqual(loaded.checkpoint.huge, next.huge);
			assert.equal(validateCheckpoint(loaded.checkpoint).huge?.currentIndex, 0);
		}
		assert.ok(artifactDir.length > 0);
	});

	it("keeps legacy checkpoints without a huge section loading unchanged", () => {
		const { workdir, runId } = setupRun("legacy");
		const created = baseCheckpoint(workdir, runId);
		assert.equal(created.huge, undefined);
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "ok");
		if (loaded.status === "ok") assert.equal(loaded.checkpoint.huge, undefined);
		assert.equal(validateCheckpoint(created).huge, undefined);
	});

	it("refuses version tables outside 2-10 rows and non-vX.Y.Z labels", () => {
		const { workdir, runId } = setupRun("table-guard");
		const cp = baseCheckpoint(workdir, runId);
		assert.throws(
			() => applyHugeOverallPlanWritten(cp, { round: 1, versions: VERSIONS.slice(0, 1) }),
			StateError,
		);
		const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `v0.${i + 1}.0`, mission: "m", done: "d" }));
		assert.throws(() => applyHugeOverallPlanWritten(cp, { round: 1, versions: eleven }), StateError);
		assert.throws(
			() => applyHugeOverallPlanWritten(cp, { round: 1, versions: [{ label: "v1.0.0", mission: "m", done: "d" }, VERSIONS[1]] }),
			StateError,
		);
	});

	it("gates overall acceptance on the accept-overall next action", () => {
		const { workdir, runId } = setupRun("accept-guard");
		const cp = baseCheckpoint(workdir, runId);
		assert.throws(() => applyHugeOverallAccepted(cp), StateError);
		const written = applyHugeOverallPlanWritten(cp, { round: 1, versions: VERSIONS });
		const accepted = applyHugeOverallAccepted(written);
		assert.equal(accepted.nextAction, "start-version-planning");
		assert.equal(accepted.huge?.versions[0]?.status, "planning");
		assert.throws(() => applyHugeOverallAccepted(accepted), StateError);
	});

	it("restricts controlled overall revisions to not-started versions", () => {
		const { workdir, runId } = setupRun("revision");
		const cp = baseCheckpoint(workdir, runId);
		const first = applyHugeOverallPlanWritten(cp, { round: 1, versions: VERSIONS });
		const started = applyHugeOverallAccepted(first);
		assert.throws(
			() => applyHugeOverallPlanWritten(started, { round: 2, versions: VERSIONS, reason: "x", affectedVersions: ["v0.1.0"] }),
			StateError,
		);
		assert.throws(() => applyHugeOverallPlanWritten(started, { round: 2, versions: VERSIONS }), StateError);
		// A revision must keep every started version (no silent drop).
		assert.throws(
			() =>
				applyHugeOverallPlanWritten(started, {
					round: 2,
					versions: [VERSIONS[1]!, VERSIONS[2]!],
					reason: "trim",
					affectedVersions: ["v0.2.0"],
				}),
			/must keep every started or completed version/,
		);
		const revised = applyHugeOverallPlanWritten(started, {
			round: 2,
			versions: [VERSIONS[0]!, { label: "v0.2.0", mission: "persistence v2", done: "d2" }, VERSIONS[2]!],
			reason: "store seam moved",
			affectedVersions: ["v0.2.0"],
		});
		assert.equal(revised.huge?.overallRound, 2);
		assert.equal(revised.huge?.versions[0]?.status, "planning");
		assert.equal(revised.huge?.versions[1]?.mission, "persistence v2");
	});

	it("records version plan revisions for the current stream only", () => {
		const { workdir, runId } = setupRun("version-plan");
		const cp = applyHugeOverallAccepted(
			applyHugeOverallPlanWritten(baseCheckpoint(workdir, runId), { round: 1, versions: VERSIONS }),
		);
		const written = applyHugeVersionPlanWritten(cp, { stream: "v0.1.0", round: 1 });
		assert.equal(written.huge?.versions[0]?.round, 1);
		assert.equal(written.nextAction, "continue-planning");
		const revised = applyHugeVersionPlanWritten(written, { stream: "v0.1.0", round: 2 });
		assert.equal(revised.huge?.versions[0]?.round, 2);
		assert.throws(() => applyHugeVersionPlanWritten(revised, { stream: "v0.2.0", round: 1 }), StateError);
	});
});

describe("huge plan identities and loop-back", () => {
	it("resolves huge identities to their stream round", () => {
		const { workdir, runId, artifactDir } = setupRun("identity");
		baseCheckpoint(workdir, runId);
		const versionPath = withPlanFile(artifactDir, "PLAN_v0.1.0_v2.md");
		const identity = planIdentityOf(versionPath, 1);
		assert.equal(identity.version, 2);
		assert.equal(identity.stream, "v0.1.0");
		const overallPath = withPlanFile(artifactDir, "PLAN_overall_v3.md");
		const overall = planIdentityOf(overallPath, 1);
		assert.equal(overall.version, 3);
		assert.equal(overall.stream, "overall");
		const legacyPath = withPlanFile(artifactDir, "PLAN_v7.md");
		const legacy = planIdentityOf(legacyPath, 1);
		assert.equal(legacy.version, 7);
		assert.equal(legacy.stream, undefined);
		assert.equal(workdir.length > 0, true);
	});

	it("loops back to planning after a version and only completes the run at the last version", () => {
		const { workdir, runId, artifactDir } = setupRun("loopback");
		let cp = applyHugeOverallAccepted(
			applyHugeOverallPlanWritten(baseCheckpoint(workdir, runId), { round: 1, versions: VERSIONS }),
		);
		cp = applyHugeVersionPlanWritten(cp, { stream: "v0.1.0", round: 1 });
		cp = approving(cp, withPlanFile(artifactDir, "PLAN_v0.1.0_v1.md"));
		assert.equal(cp.phase, "executing");
		assert.equal(cp.huge?.versions[0]?.status, "executing");
		assert.equal(cp.execution?.reviewBudget, undefined);
		// The first version spent two review rounds and chose a budget of 3.
		cp = {
			...cp,
			execution: {
				...cp.execution!,
				reviewBudget: 3,
				reviewBudgetDefaulted: false,
				reviewRoundsTotal: 2,
				reviewNoProgress: { key: "stalled-outcome", streak: 2 },
			},
		};
		cp = { ...cp, execution: { ...cp.execution!, audit: { rounds: 2, passed: true } } };
		const afterFirst = applyHugeVersionCompleted(cp, { reviewReports: ["execution-review/v0.1.0/round-1-attempt-1.md"] });
		assert.equal(afterFirst.phase, "planning");
		assert.equal(afterFirst.nextAction, "plan-next-version");
		assert.equal(afterFirst.huge?.currentIndex, 1);
		assert.equal(afterFirst.huge?.versions[0]?.status, "done");
		assert.equal(afterFirst.huge?.versions[0]?.completion?.reviewBudget, 3);
		assert.deepEqual(afterFirst.huge?.versions[0]?.completion?.reviewReports, [
			"execution-review/v0.1.0/round-1-attempt-1.md",
		]);
		assert.equal(afterFirst.execution?.approval, null);
		assert.equal(afterFirst.execution?.reviewBudget, undefined);

		// Version 2 inherits the archived budget instead of re-asking.
		let second = applyHugeVersionPlanWritten(afterFirst, { stream: "v0.2.0", round: 1 });
		second = approving(second, withPlanFile(artifactDir, "PLAN_v0.2.0_v1.md"));
		assert.equal(second.execution?.reviewBudget, 3);
		assert.equal(second.execution?.reviewRoundsTotal, 2);
		assert.deepEqual(second.execution?.reviewNoProgress, { key: "stalled-outcome", streak: 2 });
		second = { ...second, execution: { ...second.execution!, audit: { rounds: 1, passed: true } } };
		const afterSecond = applyHugeVersionCompleted(second);
		assert.equal(afterSecond.phase, "planning");
		assert.equal(afterSecond.huge?.currentIndex, 2);

		// The last version completes the run.
		let third = applyHugeVersionPlanWritten(afterSecond, { stream: "v0.3.0", round: 1 });
		third = approving(third, withPlanFile(artifactDir, "PLAN_v0.3.0_v1.md"));
		third = { ...third, execution: { ...third.execution!, audit: { rounds: 1, passed: true } } };
		const last = applyHugeVersionCompleted(third);
		assert.equal(last.phase, "completed");
		assert.equal(last.nextAction, "none");
		assert.equal(last.huge?.versions[2]?.status, "done");
		assert.equal(validateCheckpoint(last).phase, "completed");
	});

	it("requires phase executing for version completion", () => {
		const { workdir, runId } = setupRun("complete-guard");
		const cp = baseCheckpoint(workdir, runId);
		assert.throws(() => applyHugeVersionCompleted(cp), StateError);
	});
});

describe("huge deferred ledger", () => {
	it("accepts absorbed items and rejects unconfirmed drops", () => {
		const { workdir, runId } = setupRun("deferred");
		let cp = applyHugeOverallAccepted(
			applyHugeOverallPlanWritten(baseCheckpoint(workdir, runId), { round: 1, versions: VERSIONS }),
		);
		cp = applyHugeVersionPlanWritten(cp, { stream: "v0.1.0", round: 1 });
		const absorbed = applyHugeDeferredDispositions(cp, "v0.1.0", [
			{ itemId: "D-v0.1.0-1", disposition: "absorbed" },
		]);
		assert.equal(absorbed.huge?.deferred[0]?.disposition, "absorbed");
		assert.equal(absorbed.huge?.deferred[0]?.confirmationId, undefined);
		assert.throws(
			() => applyHugeDeferredDispositions(cp, "v0.1.0", [{ itemId: "D-v0.1.0-2", disposition: "dropped" }]),
			StateError,
		);
	});

	it("accepts a drop only with a user-sourced confirmation, never auto-complete", () => {
		const { workdir, runId } = setupRun("deferred-confirm");
		let cp = applyHugeOverallAccepted(
			applyHugeOverallPlanWritten(baseCheckpoint(workdir, runId), { round: 1, versions: VERSIONS }),
		);
		cp = applyHugeVersionPlanWritten(cp, { stream: "v0.1.0", round: 1 });
		const questionId = deferredQuestionId("v0.1.0", "D-v0.1.0-2");
		const asked = applyQuestionAsked(cp, { questionId, question: "drop it?", options: ["drop", "keep"] });
		const autoAnswered = applyQuestionAnswered(asked, questionId, "drop", "auto-complete");
		assert.throws(
			() => applyHugeDeferredDispositions(autoAnswered, "v0.1.0", [{ itemId: "D-v0.1.0-2", disposition: "dropped" }]),
			StateError,
		);
		const userAsked = applyQuestionAsked(cp, { questionId, question: "drop it?", options: ["drop", "keep"] });
		const userAnswered = applyQuestionAnswered(userAsked, questionId, "drop", "user");
		const dropped = applyHugeDeferredDispositions(userAnswered, "v0.1.0", [
			{ itemId: "D-v0.1.0-2", disposition: "dropped" },
		]);
		assert.equal(dropped.huge?.deferred[0]?.disposition, "dropped");
		assert.equal(dropped.huge?.deferred[0]?.confirmationId, questionId);
	});
});

describe("huge migration landing", () => {
	it("never hands accept-execute to an overall plan", () => {
		const { workdir, runId, artifactDir } = setupRun("migration");
		let cp = applyHugeOverallAccepted(
			applyHugeOverallPlanWritten(baseCheckpoint(workdir, runId), { round: 1, versions: VERSIONS }),
		);
		cp = applyHugeVersionPlanWritten(cp, { stream: "v0.1.0", round: 1 });
		cp = approving(cp, withPlanFile(artifactDir, "PLAN_v0.1.0_v1.md"));
		const migrated = applyMigration(cp, { workdir, worktreeRoot: cp.worktreeRoot, commonDir: cp.commonDir });
		assert.equal(migrated.nextAction, "accept-execute");
		const overallPlan = planIdentityOf(withPlanFile(artifactDir, "PLAN_overall_v1.md"), 1);
		const stale = { ...cp, plan: overallPlan };
		const staleMigrated = applyMigration(stale, { workdir, worktreeRoot: cp.worktreeRoot, commonDir: cp.commonDir });
		assert.equal(staleMigrated.nextAction, "start-version-planning");
	});
});
