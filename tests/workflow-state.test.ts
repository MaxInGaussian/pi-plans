/** Workflow checkpoint test suite (node:test, stdlib only) — I-001. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	applyCompleted,
	applyExecutionApproved,
	applyExecutionCompleted,
	applyExecutionProgress,
	applyExecutionHeadChanged,
	applyExecutionStopped,
	applyImplementationReviewConfigured,
	applyImplementationRoundFinished,
	applyLaneResult,
	applyMigration,
	applyPlanWritten,
	applyQuestionAnswered,
	applyQuestionAsked,
	applyReviewConsolidated,
	applyReviewRoundStarted,
	checkpointFilePath,
	createCheckpoint,
	loadCheckpoint,
	mutateCheckpoint,
	planIdentityOf,
	readReviewOutput,
	reconcilePendingWithAnswered,
	resolveHeadAt,
	safeRelativePath,
	safeResolveInside,
	sha256File,
	StaleCheckpointError,
	validateCheckpoint,
	writeReviewOutput,
	type ExecutionApproval,
	type WorkflowCheckpoint,
} from "../src/workflow-state.ts";
import { acquireOwnership } from "../src/run-ownership.ts";
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

function setupRun(name: string): { workdir: string; runId: string } {
	const workdir = mkWorkdir(name);
	git(workdir, "init");
	git(workdir, "config", "user.email", "t@example.com");
	git(workdir, "config", "user.name", "T");
	initState(workdir);
	const { run } = startRun(workdir, { topic: "checkpoint-tests", skill: "plan-normal", requestText: "test" });
	return { workdir, runId: run.run_id };
}

function baseCheckpoint(workdir: string, runId: string): WorkflowCheckpoint {
	const loaded = loadCheckpoint(workdir, runId);
	assert.equal(loaded.status, "ok");
	return loaded.checkpoint;
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-wf-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("create / load / mutate storage", () => {
	it("creates a valid initial checkpoint and reloads it", () => {
		const { workdir, runId } = setupRun("storage-create");
		const created = createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		assert.equal(created.phase, "planning");
		assert.equal(created.nextAction, "continue-planning");
		assert.equal(created.revision, 1);
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "ok");
		assert.equal(loaded.checkpoint.runId, runId);
	});

	it("refuses to overwrite an existing checkpoint via createCheckpoint", () => {
		const { workdir, runId } = setupRun("storage-no-overwrite");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		assert.throws(() => createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir }), StateError);
	});

	it("mutateCheckpoint bumps revisions atomically", () => {
		const { workdir, runId } = setupRun("storage-revision");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		const next = mutateCheckpoint(workdir, runId, (cp) => ({ ...cp, autoComplete: true }));
		assert.equal(next.revision, 2);
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "ok");
		assert.equal(loaded.checkpoint.revision, 2);
		assert.equal(loaded.checkpoint.autoComplete, true);
	});

	it("distinguishes missing from corrupt and never overwrites corrupt files", () => {
		const { workdir, runId } = setupRun("storage-corrupt");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		const filePath = checkpointFilePath(workdir, runId);
		assert.ok(filePath);
		const bytes = fs.readFileSync(filePath, "utf8");
		fs.writeFileSync(filePath, "{ not json", "utf8");
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "corrupt");
		assert.ok(loaded.status === "corrupt" && loaded.error.includes("invalid JSON"));
		assert.throws(
			() => mutateCheckpoint(workdir, runId, (cp) => cp),
			(error: unknown) => error instanceof StateError && /corrupt/.test(error.message),
		);
		assert.equal(fs.readFileSync(filePath, "utf8"), "{ not json");
		fs.writeFileSync(filePath, bytes, "utf8");
		assert.equal(loadCheckpoint(workdir, runId).status, "ok");
	});

	it("rejects unknown schema versions as corrupt without touching bytes", () => {
		const { workdir, runId } = setupRun("storage-schema");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		const filePath = checkpointFilePath(workdir, runId)!;
		const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
		data.schema = 99;
		fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
		const loaded = loadCheckpoint(workdir, runId);
		assert.equal(loaded.status, "corrupt");
		assert.ok(loaded.status === "corrupt" && loaded.error.includes("unsupported version"));
	});

	it("mutate fails cleanly when the checkpoint is missing", () => {
		const { workdir, runId } = setupRun("storage-missing");
		assert.throws(() => mutateCheckpoint(workdir, runId, (cp) => cp), StateError);
	});

	it("owner-guarded mutation refuses writes after a takeover", () => {
		const { workdir, runId } = setupRun("storage-owner");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		const owner = acquireOwnership(workdir, runId);
		const next = mutateCheckpoint(workdir, runId, (cp) => ({ ...cp, autoComplete: true }), {
			owner: { processToken: owner.processToken, generation: owner.generation },
		});
		assert.equal(next.revision, 2);
		// Another session takes over: our owner check must fail.
		const foreign = {
			schema: 1,
			host: owner.host,
			pid: process.pid,
			pidStart: "bogus-start",
			sessionId: null,
			processToken: "foreign-token",
			generation: owner.generation + 1,
			acquiredAt: "2026-09-07T00:00:00Z",
		};
		fs.writeFileSync(path.join(path.dirname(checkpointFilePath(workdir, runId)!), "owner.json"), JSON.stringify(foreign), "utf8");
		assert.throws(
			() => mutateCheckpoint(workdir, runId, (cp) => cp, { owner: { processToken: owner.processToken, generation: owner.generation } }),
			StateError,
		);
	});

	it("optimistic revision checks reject concurrent writes", () => {
		const { workdir, runId } = setupRun("storage-cas");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		mutateCheckpoint(workdir, runId, (cp) => ({ ...cp }), { expectRevision: 1 });
		assert.throws(
			() => mutateCheckpoint(workdir, runId, (cp) => cp, { expectRevision: 1 }),
			StaleCheckpointError,
		);
	});
});

describe("validation", () => {
	it("rejects malformed shapes and unexpected keys", () => {
		const { workdir, runId } = setupRun("validate-shapes");
		const cp = createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		assert.throws(() => validateCheckpoint({ ...cp, phase: "bogus" }), StateError);
		assert.throws(() => validateCheckpoint({ ...cp, nextAction: "bogus" }), StateError);
		assert.throws(() => validateCheckpoint({ ...cp, extraKey: true }), StateError);
		assert.throws(() => validateCheckpoint({ ...cp, revision: 0 }), StateError);
		assert.throws(() => validateCheckpoint({ ...cp, updatedAt: "yesterday" }), StateError);
		assert.throws(() => validateCheckpoint(null), StateError);
	});

	it("rejects run ids that could traverse paths", () => {
		const { workdir, runId } = setupRun("validate-runid");
		const cp = createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		for (const bad of ["../escape", "foo/bar", ".hidden", "a b"]) {
			assert.throws(() => validateCheckpoint({ ...cp, runId: bad }), StateError, bad);
		}
	});

	it("rejects forged approval shapes", () => {
		const { workdir, runId } = setupRun("validate-approval");
		const cp = createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		const forged = {
			...cp,
			execution: {
				approval: { plan: { path: "/tmp/x", version: "one", sha256: "zz" }, worktree: "/tmp", approvedAt: "nope" },
				doneVcIds: ["VC-001"],
				implStatus: {},
				usage: { inToks: 0, outToks: 0 },
			},
		};
		assert.throws(() => validateCheckpoint(forged), StateError);
	});

	it("completed phase must use nextAction none", () => {
		const { workdir, runId } = setupRun("validate-terminal");
		const cp = createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		assert.throws(() => validateCheckpoint({ ...cp, phase: "completed", nextAction: "execute-items" }), StateError);
	});
});

describe("safe paths and digests", () => {
	it("safeRelativePath rejects traversal and absolute inputs", () => {
		assert.throws(() => safeRelativePath("../x", "p"), StateError);
		assert.throws(() => safeRelativePath("a/../../b", "p"), StateError);
		assert.throws(() => safeRelativePath(path.resolve("x"), "p"), StateError);
		assert.throws(() => safeRelativePath("", "p"), StateError);
		assert.equal(safeRelativePath("reviews/a__b.md", "p"), "reviews/a__b.md");
	});

	it("safeResolveInside rejects symlink escapes", () => {
		const root = mkWorkdir("symlink-root");
		const outside = mkWorkdir("symlink-outside");
		fs.writeFileSync(path.join(outside, "payload.md"), "escaped", "utf8");
		fs.symlinkSync(path.join(outside, "payload.md"), path.join(root, "link.md"));
		assert.throws(() => safeResolveInside(root, "link.md", "p"), StateError);
	});

	it("sha256File hashes full bytes and fails on missing files", () => {
		const file = path.join(tmpRoot, "hash-target.txt");
		fs.writeFileSync(file, "hello", "utf8");
		assert.equal(sha256File(file), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
		assert.throws(() => sha256File(path.join(tmpRoot, "missing")), StateError);
	});

	it("resolveHeadAt returns null without commits and a sha with commits", () => {
		const empty = mkWorkdir("head-empty");
		git(empty, "init");
		assert.equal(resolveHeadAt(empty), null);
		const committed = mkWorkdir("head-set");
		git(committed, "init");
		git(committed, "config", "user.email", "t@example.com");
		git(committed, "config", "user.name", "T");
		fs.writeFileSync(path.join(committed, "a.txt"), "a", "utf8");
		git(committed, "add", "a.txt");
		git(committed, "commit", "-m", "a");
		assert.match(resolveHeadAt(committed) ?? "", /^[0-9a-f]{40}$/);
	});
});

describe("review outputs", () => {
	it("writes and reads lane outputs inside the run directory", () => {
		const { workdir, runId } = setupRun("reviews-io");
		const rel = writeReviewOutput(workdir, runId, "r1", "lane-a", "# findings\nbody");
		assert.equal(rel, "reviews/r1__lane-a.md");
		assert.equal(readReviewOutput(workdir, runId, rel), "# findings\nbody");
	});

	it("sanitizes ids and rejects traversal attempts", () => {
		const { workdir, runId } = setupRun("reviews-sanitize");
		assert.throws(() => writeReviewOutput(workdir, runId, "../r", "lane", "x"), StateError);
		assert.throws(() => writeReviewOutput(workdir, runId, "r", "../lane", "x"), StateError);
		assert.throws(() => writeReviewOutput(workdir, runId, "a/b", "lane", "x"), StateError);
		assert.throws(() => readReviewOutput(workdir, runId, "../decisions.jsonl"), StateError);
	});
});

describe("state machine reducers", () => {
	it("question lifecycle: ask, answer, no re-ask (F-005 answered wins)", () => {
		const { workdir, runId } = setupRun("sm-question");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		let cp = baseCheckpoint(workdir, runId);
		cp = applyQuestionAsked(cp, { questionId: "q1", question: "Q?", options: ["a", "b"] });
		cp = applyQuestionAnswered(cp, "q1", "a", "user");
		assert.equal(cp.pendingQuestion, null);
		assert.equal(cp.answeredQuestions.length, 1);
		// Same id pending while answered → reconcile drops the pending entry.
		const withPending = { ...cp, pendingQuestion: { questionId: "q1", question: "Q?", options: ["a"], askedAt: cp.updatedAt } };
		assert.equal(reconcilePendingWithAnswered(withPending).pendingQuestion, null);
		assert.throws(() => applyQuestionAsked(cp, { questionId: "q1", question: "Q?", options: ["a"] }), StateError);
		assert.throws(() => applyQuestionAnswered(cp, "q1", "b", "user"), StateError);
		// Another question cannot be pending at the same time.
		const two = applyQuestionAsked(cp, { questionId: "q2", question: "Q2?", options: ["a"] });
		assert.throws(
			() => applyQuestionAsked(two, { questionId: "q3", question: "Q3?", options: ["a"] }),
			StateError,
		);
	});

	it("review rounds: start requires plan; lanes complete then consolidate", () => {
		const { workdir, runId } = setupRun("sm-review");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		let cp = baseCheckpoint(workdir, runId);
		assert.throws(
			() => applyReviewRoundStarted(cp, { roundId: "r1", role: "reviewer", target: "plan", reviewers: 1, lanes: [{ laneId: "l1" }] }),
			StateError,
		);
		const planPath = path.join(path.dirname(checkpointFilePath(workdir, runId)!), "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");
		const plan = planIdentityOf(planPath, 1);
		cp = applyPlanWritten(cp, plan);
		cp = { ...cp, phase: "reviewing", nextAction: "run-review" };
		cp = applyReviewRoundStarted(cp, { roundId: "r1", role: "reviewer", target: "plan", reviewers: 2, lanes: [{ laneId: "l1" }, { laneId: "l2" }] });
		assert.throws(() => applyReviewRoundStarted(cp, { roundId: "r1", role: "reviewer", target: "plan", reviewers: 1, lanes: [{ laneId: "l1" }] }), StateError);
		const file1 = writeReviewOutput(workdir, runId, "r1", "l1", "out1");
		cp = applyLaneResult(cp, "r1", "l1", { ok: true, resultFile: file1 });
		// Idempotent replay with the same file is a no-op.
		assert.equal(applyLaneResult(cp, "r1", "l1", { ok: true, resultFile: file1 }), cp);
		assert.throws(() => applyReviewConsolidated(cp, "r1"), StateError);
		cp = applyLaneResult(cp, "r1", "l2", { ok: false, error: "boom" });
		cp = applyReviewConsolidated(cp, "r1");
		assert.equal(cp.reviewRounds[0]!.consolidated, true);
		// Successful lanes must carry a result file.
		cp = applyReviewRoundStarted(cp, { roundId: "r2", role: "reviewer", target: "plan", reviewers: 1, lanes: [{ laneId: "l1" }] });
		const lane = { ...cp.reviewRounds[1]!, lanes: cp.reviewRounds[1]!.lanes.map((l) => ({ ...l, status: "running" as const })) };
		const staged = { ...cp, reviewRounds: [cp.reviewRounds[0]!, lane] };
		assert.throws(() => applyLaneResult(staged, "r2", "l1", { ok: true }), StateError);
	});

	it("implementation review: condition first, rounds counted, completed needs evidence (F-004)", () => {
		const { workdir, runId } = setupRun("sm-impl");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		let cp = baseCheckpoint(workdir, runId);
		const planPath = path.join(path.dirname(checkpointFilePath(workdir, runId)!), "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");
		const plan = planIdentityOf(planPath, 1);
		cp = { ...cp, plan, phase: "implementation-review", nextAction: "ask-question" };
		assert.throws(
			() => applyReviewRoundStarted(cp, { roundId: "i1", role: "reviewer", target: "implementation", reviewers: 1, lanes: [{ laneId: "l1" }] }),
			StateError,
		);
		cp = applyImplementationReviewConfigured(cp, "until-no-high");
		assert.throws(() => applyImplementationReviewConfigured(cp, "again"), StateError);
		cp = applyReviewRoundStarted(cp, { roundId: "i1", role: "reviewer", target: "implementation", reviewers: 1, lanes: [{ laneId: "l1" }] });
		const file = writeReviewOutput(workdir, runId, "i1", "l1", "out");
		cp = applyLaneResult(cp, "i1", "l1", { ok: true, resultFile: file });
		assert.throws(() => applyImplementationRoundFinished(cp), StateError);
		cp = applyReviewConsolidated(cp, "i1");
		cp = applyImplementationRoundFinished(cp);
		assert.equal(cp.implementationReview?.completedRounds, 1);
		// Completion requires evidence AND a termination condition.
		assert.throws(() => applyCompleted({ ...cp, implementationReview: undefined }, "evidence"), StateError);
		assert.throws(() => applyCompleted(cp, "   "), StateError);
		const done = applyCompleted(cp, "no findings in final round");
		assert.equal(done.phase, "completed");
		assert.equal(done.nextAction, "none");
	});

	it("execution approval and progress (D-003/D-011)", () => {
		const { workdir, runId } = setupRun("sm-exec");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		let cp = baseCheckpoint(workdir, runId);
		const planPath = path.join(path.dirname(checkpointFilePath(workdir, runId)!), "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");
		const plan = planIdentityOf(planPath, 1);
		cp = applyPlanWritten(cp, plan);
		const approval: ExecutionApproval = {
			plan,
			worktree: cp.worktreeRoot,
			headAtApproval: null,
			approvedAt: cp.updatedAt,
		};
		assert.throws(() => applyExecutionApproved(cp, approval), StateError);
		cp = { ...cp, nextAction: "accept-execute" };
		cp = applyExecutionApproved(cp, approval);
		assert.equal(cp.phase, "executing");
		assert.deepEqual(cp.execution?.doneVcIds, []);
		cp = applyExecutionProgress(cp, { doneVcIds: ["VC-001"], usage: { inToks: 10, outToks: 5 } });
		assert.deepEqual(cp.execution?.doneVcIds, ["VC-001"]);
		assert.equal(cp.execution?.usage.inToks, 10);
		// Mismatched plan hash is rejected.
		const other = { ...approval, plan: { ...plan, sha256: planIdentityOf(planPath, 1).sha256.replace(/^./, "f") } };
		const fresh = { ...baseCheckpoint(workdir, runId), plan, nextAction: "accept-execute" };
		assert.throws(() => applyExecutionApproved(fresh, other), StateError);
		// Head change keeps authorization but forces re-verification (F-001).
		cp = applyExecutionHeadChanged(cp);
		assert.equal(cp.execution?.approval, approval);
		assert.equal(cp.execution?.reverifyAll, true);
		cp = applyExecutionStopped(cp, "stopped by user");
		assert.equal(cp.execution?.pausedReason, "stopped by user");
		const resumed = applyExecutionProgress(cp, { pausedReason: null });
		assert.equal(resumed.execution?.pausedReason, undefined);
		// Completion hands over to the implementation-review phase (R-005).
		const finished = applyExecutionCompleted(cp);
		assert.equal(finished.phase, "implementation-review");
		assert.equal(finished.nextAction, "ask-question");
	});

	it("migration resets rounds and approval, keeps termination (F-003)", () => {
		const { workdir, runId } = setupRun("sm-migrate");
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		const planPath = path.join(path.dirname(checkpointFilePath(workdir, runId)!), "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan", "utf8");
		const plan = planIdentityOf(planPath, 1);
		let cp: WorkflowCheckpoint = {
			...baseCheckpoint(workdir, runId),
			plan,
			phase: "implementation-review",
			implementationReview: { terminationCondition: "until-no-high", completedRounds: 3, currentRoundId: undefined },
			execution: {
				approval: { plan, worktree: "/origin/wt", headAtApproval: "a".repeat(40), approvedAt: "2026-09-07T00:00:00Z" },
				doneVcIds: ["VC-001", "VC-002"],
				implStatus: { "I-001": "implemented" },
				usage: { inToks: 1, outToks: 2 },
			},
		};
		const migrated = applyMigration(cp, { workdir: "/target/wt", worktreeRoot: "/target/wt", commonDir: "/target/.git" });
		assert.equal(migrated.implementationReview?.terminationCondition, "until-no-high");
		assert.equal(migrated.implementationReview?.completedRounds, 0);
		assert.equal(migrated.execution?.approval, null);
		assert.deepEqual(migrated.execution?.doneVcIds, []);
		assert.equal(migrated.execution?.usage.inToks, 1);
		// F-007: an implementation-review checkpoint keeps its review ordering
		// after migration instead of becoming approvable.
		assert.equal(migrated.nextAction, "run-review");
		assert.equal(migrated.migration?.fromWorktree, cp.worktreeRoot);
	});
});
