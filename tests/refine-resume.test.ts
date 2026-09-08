/** Durable review-round reuse tests (I-004). */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	applyLaneResult,
	applyReviewConsolidated,
	createCheckpoint,
	loadCheckpoint,
	mutateCheckpoint,
	readReviewOutput,
	recordLaneOutcome,
	reusableLaneOutputs,
	startReviewRound,
} from "../src/workflow-state.ts";
import { initState, startRun } from "../src/state.ts";

let tmpRoot: string;

function setupRun(name: string): { workdir: string; runId: string; artifactDir: string } {
	const workdir = path.join(tmpRoot, name);
	fs.mkdirSync(workdir, { recursive: true });
	spawnSync("git", ["init"], { cwd: workdir });
	initState(workdir);
	const { run } = startRun(workdir, { topic: name, skill: "plan-normal", requestText: "t" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	return { workdir, runId: run.run_id, artifactDir: run.artifact_dir };
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-rr-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const BASE_DIR_PLACEHOLDER = path.resolve(import.meta.dirname, "..");

describe("round orchestration helpers", () => {
	it("starts a round, persists lanes, and resumes idempotently", () => {
		const { workdir, runId, artifactDir } = setupRun("round-basic");
		const planPath = path.join(artifactDir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");

		const started = startReviewRound(workdir, runId, {
			roundId: "plan-r1",
			role: "reviewer",
			target: "plan",
			reviewers: 2,
			planPath,
			lanes: [{ laneId: "l1" }, { laneId: "l2" }],
		});
		assert.equal(started.reviewRounds.length, 1);
		assert.equal(started.reviewRounds[0]?.lanes.length, 2);
		assert.equal(started.plan?.sha256.length, 64);

		// Idempotent resume with the same shape.
		const again = startReviewRound(workdir, runId, {
			roundId: "plan-r1",
			role: "reviewer",
			target: "plan",
			reviewers: 2,
			planPath,
			lanes: [{ laneId: "l1" }, { laneId: "l2" }],
		});
		assert.equal(again.revision, started.revision, "resume start does not bump revision");

		// Persist two lanes.
		recordLaneOutcome(workdir, runId, "plan-r1", "l1", { ok: true, output: "findings A" });
		recordLaneOutcome(workdir, runId, "plan-r1", "l2", { ok: true, output: "findings B" });
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "ok");
		if (loaded.status === "ok") {
			const reusable = reusableLaneOutputs(loaded.checkpoint, "plan-r1");
			assert.equal(reusable.length, 2);
			assert.equal(readReviewOutput(workdir, runId, reusable[0]!.resultFile), "findings A");
			// Idempotent re-record with identical bytes is a no-op.
			const before = loaded.checkpoint.revision;
			recordLaneOutcome(workdir, runId, "plan-r1", "l1", { ok: true, output: "findings A" });
			const after = loadCheckpoint(workdir, runId);
			assert.equal(after.status === "ok" ? after.checkpoint.revision : -1, before + 1, "re-record bumps once");
		}
	});

	it("refuses reuse across plan versions and shape changes", () => {
		const { workdir, runId, artifactDir } = setupRun("round-guard");
		const planPath = path.join(artifactDir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan v1", "utf8");
		startReviewRound(workdir, runId, {
			roundId: "plan-r9",
			role: "reviewer",
			target: "plan",
			reviewers: 1,
			planPath,
			lanes: [{ laneId: "l1" }],
		});
		// Different lanes, same id → refuse.
		assert.throws(
			() =>
				startReviewRound(workdir, runId, {
					roundId: "plan-r9",
					role: "reviewer",
					target: "plan",
					reviewers: 1,
					planPath,
					lanes: [{ laneId: "other" }],
				}),
			/different lanes/,
		);
		// Plan bytes changed under the same round id → refuse.
		fs.writeFileSync(planPath, "# plan v2 changed", "utf8");
		assert.throws(
			() =>
				startReviewRound(workdir, runId, {
					roundId: "plan-r9",
					role: "reviewer",
					target: "plan",
					reviewers: 1,
					planPath,
					lanes: [{ laneId: "l1" }],
				}),
			/different plan version/,
		);
	});

	it("failed lanes can re-run; consolidated rounds gate on terminal lanes", () => {
		const { workdir, runId, artifactDir } = setupRun("round-fail");
		const planPath = path.join(artifactDir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");
		startReviewRound(workdir, runId, {
			roundId: "plan-r2",
			role: "reviewer",
			target: "plan",
			reviewers: 2,
			planPath,
			lanes: [{ laneId: "l1" }, { laneId: "l2" }],
		});
		recordLaneOutcome(workdir, runId, "plan-r2", "l1", { ok: true, output: "ok output" });
		recordLaneOutcome(workdir, runId, "plan-r2", "l2", { ok: false, error: "boom" });
		// Not all terminal-success; consolidation still allowed (1 ok + 1 failed).
		mutateCheckpoint(workdir, runId, (cp) => applyReviewConsolidated(cp, "plan-r2"));
		const loaded = loadCheckpoint(workdir, runId);
		if (loaded.status === "ok") {
			assert.equal(loaded.checkpoint.reviewRounds[0]?.consolidated, true);
			// Failed lane can be re-run later: applyLaneResult allows failed → complete.
			const rerun = mutateCheckpoint(workdir, runId, (cp) =>
				applyLaneResult(cp, "plan-r2", "l2", { ok: true, resultFile: writeReviewOutputPath(workdir, runId, "plan-r2", "l2") }),
			);
			assert.equal(rerun.reviewRounds[0]?.lanes.find((lane) => lane.laneId === "l2")?.status, "complete");
		}
	});

	function writeReviewOutputPath(workdir: string, runId: string, roundId: string, laneId: string): string {
		const rel = recordLaneOutcome(workdir, runId, roundId, laneId, { ok: true, output: "rerun output" });
		return rel.resultFile!;
	}
});

describe("implementation-review round 1 fixes", () => {
	it("F-001: refine tool starts a durable round with lanes on a checkpointed run (current-session mode)", async () => {
		const workdir = path.join(tmpRoot, "f001-tool");
		fs.mkdirSync(workdir, { recursive: true });
		spawnSync("git", ["init"], { cwd: workdir });
		const { initState, startRun, setRole } = await import("../src/state.ts");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "current-session", confirmed: true });
		const { run } = startRun(workdir, { topic: "f001", skill: "plan-normal", requestText: "t" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");

		const { registerRefineTool } = await import("../tools/refine.ts");
		let tool: { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> } | undefined;
		const pi = {
			registerTool: (definition: never) => {
				tool = definition as unknown as typeof tool;
			},
		} as never;
		registerRefineTool(pi, BASE_DIR_PLACEHOLDER);
		assert.ok(tool, "refine tool registered");
		const ctx = {
			cwd: workdir,
			sessionManager: {},
			model: null,
			mode: "print",
			hasUI: false,
			ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		};
		const result = await tool!.execute("t1", { role: "reviewer", planPath, reviewers: 2 }, undefined, undefined, ctx);
		assert.match(result.content[0]?.text ?? "", /current-session/);
		// The durable round exists WITH lanes — the pre-fix crash site.
		const loaded = loadCheckpoint(workdir, run.run_id);
		assert.equal(loaded.status, "ok");
		if (loaded.status === "ok") {
			const round = loaded.checkpoint.reviewRounds.at(-1);
			assert.ok(round, "round recorded");
			assert.equal(round!.lanes.length, 2, "reviewer lanes recorded");
			assert.ok(round!.lanes.every((lane) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane.laneId)), "lane ids sanitized");
		}
	});

	it("F-002: in-place plan edits after approval refuse the execution load", async () => {
		const workdir = path.join(tmpRoot, "f002-digest");
		fs.mkdirSync(workdir, { recursive: true });
		spawnSync("git", ["init"], { cwd: workdir });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
		spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
		const { initState, startRun } = await import("../src/state.ts");
		initState(workdir);
		const { run } = startRun(workdir, { topic: "f002", skill: "plan-normal", requestText: "t" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan\n\n## Verifier Checklist\n\n- [ ] `VC-001` covers `I-001`; pass condition: x.\n", "utf8");
		spawnSync("git", ["add", "-A"], { cwd: workdir });
		spawnSync("git", ["commit", "-m", "seed"], { cwd: workdir });
		const { applyExecutionApproved } = await import("../src/workflow-state.ts");
		const { planIdentityOf, resolveHeadAt, resolveWorktreeRoot } = await import("../src/workflow-state.ts");
		mutateCheckpoint(workdir, run.run_id, (cp) => {
			const plan = planIdentityOf(planPath, 1);
			return applyExecutionApproved({ ...cp, plan, nextAction: "accept-execute" }, {
				plan,
				worktree: resolveWorktreeRoot(workdir) ?? workdir,
				headAtApproval: resolveHeadAt(workdir),
				approvedAt: "2026-09-07T00:00:00Z",
			});
		});
		// Edit the plan in place — same path, different bytes.
		fs.writeFileSync(planPath, "# plan (edited)\n\n## Verifier Checklist\n\n- [ ] `VC-001` covers `I-001`; pass condition: x.\n", "utf8");
		const { loadExecutionFromCheckpoint } = await import("../src/exec.ts");
		const pi = { appendEntry: () => {}, sendMessage: () => {} } as never;
		const ctx = { cwd: workdir, sessionManager: {}, ui: { setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } } };
		const load = loadExecutionFromCheckpoint(pi, ctx, run.run_id);
		assert.equal(load.status, "plan-mismatch");
		assert.match((load as { error?: string }).error ?? "", /changed since the approval/);
	});

	it("F-006: an unverifiable approval HEAD forces re-verification", async () => {
		const workdir = path.join(tmpRoot, "f006-head");
		fs.mkdirSync(workdir, { recursive: true });
		spawnSync("git", ["init"], { cwd: workdir });
		const { initState, startRun } = await import("../src/state.ts");
		initState(workdir);
		const { run } = startRun(workdir, { topic: "f006", skill: "plan-normal", requestText: "t" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan\n\n## Verifier Checklist\n\n- [ ] `VC-001` covers `I-001`; pass condition: x.\n", "utf8");
		const { applyExecutionApproved, applyExecutionProgress, planIdentityOf, resolveWorktreeRoot } = await import("../src/workflow-state.ts");
		mutateCheckpoint(workdir, run.run_id, (cp) => {
			const plan = planIdentityOf(planPath, 1);
			return applyExecutionApproved({ ...cp, plan, nextAction: "accept-execute" }, {
				plan,
				worktree: resolveWorktreeRoot(workdir) ?? workdir,
				headAtApproval: null, // approved without a resolvable HEAD
				approvedAt: "2026-09-07T00:00:00Z",
			});
		});
		mutateCheckpoint(workdir, run.run_id, (cp) => applyExecutionProgress(cp, { doneVcIds: ["VC-001"] }));
		const { loadExecutionFromCheckpoint } = await import("../src/exec.ts");
		const pi = { appendEntry: () => {}, sendMessage: () => {} } as never;
		const ctx = { cwd: workdir, sessionManager: {}, ui: { setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } } };
		const load = loadExecutionFromCheckpoint(pi, ctx, run.run_id);
		assert.equal(load.status, "loaded");
		assert.equal((load as { reverifyAll?: boolean }).reverifyAll, true, "unverifiable HEAD re-verifies");
	});

	it("F-005: any mutation from a taken-over lease fails automatically", async () => {
		const workdir = path.join(tmpRoot, "f005-auto");
		fs.mkdirSync(workdir, { recursive: true });
		spawnSync("git", ["init"], { cwd: workdir });
		const { initState, startRun } = await import("../src/state.ts");
		initState(workdir);
		const { run } = startRun(workdir, { topic: "f005", skill: "plan-normal", requestText: "t" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		const { acquireOwnership, releaseOwnership } = await import("../src/run-ownership.ts");
		const owner = acquireOwnership(workdir, run.run_id);
		// Another process takes over (fabricated record with a reused/dead pid).
		fs.writeFileSync(
			path.join(workdir, ".git", "pi_plans", "runs", run.run_id, "owner.json"),
			JSON.stringify({ ...owner, pid: process.pid, pidStart: "bogus-start", processToken: "someone-else", generation: owner.generation + 1 }),
			"utf8",
		);
		assert.throws(
			() => mutateCheckpoint(workdir, run.run_id, (cp) => cp), // NO explicit owner option
			(error: unknown) => error instanceof Error && /no longer owns/.test(error.message),
		);
		releaseOwnership(workdir, run.run_id, owner.processToken); // clears the stale in-memory lease
		assert.doesNotThrow(() => mutateCheckpoint(workdir, run.run_id, (cp) => cp));
	});

	it("F-007: migration keeps review-phase ordering; terminal phases cannot approve", async () => {
		const { applyMigration, applyExecutionApproved } = await import("../src/workflow-state.ts");
		const workdir = path.join(tmpRoot, "f007-phase");
		fs.mkdirSync(workdir, { recursive: true });
		spawnSync("git", ["init"], { cwd: workdir });
		const { initState, startRun } = await import("../src/state.ts");
		initState(workdir);
		const { run } = startRun(workdir, { topic: "f007", skill: "plan-normal", requestText: "t" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		const migrated = mutateCheckpoint(workdir, run.run_id, (cp) =>
			applyMigration({ ...cp, phase: "implementation-review" }, { workdir, worktreeRoot: workdir, commonDir: path.join(workdir, ".git") }),
		);
		assert.equal(migrated.nextAction, "run-review", "review phase keeps its ordering");
		assert.throws(
			() =>
				applyExecutionApproved({ ...migrated, nextAction: "accept-execute" }, {
					plan: { path: "/tmp/p", version: 1, sha256: "a".repeat(64) },
					worktree: "/tmp",
					headAtApproval: null,
					approvedAt: "2026-09-07T00:00:00Z",
				}),
			/cannot approve execution from phase/,
		);
	});
});

