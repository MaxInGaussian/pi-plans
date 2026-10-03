/** /resume-plans command tests (I-006). */

import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { listResumeCandidates, pickDefaultCandidate } from "../src/resume.ts";
import { migrateRunIntoCurrentWorktree, resumePlansCommand } from "../src/resume-command.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint, applyExecutionApproved, applyExecutionProgress, applyPlanWritten, applyQuestionAsked, applyQuestionAnswered, planIdentityOf, resolveHeadAt } from "../src/workflow-state.ts";
import { acquireOwnership, processStartOf } from "../src/run-ownership.ts";
import { resetRunBindingForTests } from "../src/run-context.ts";
import { initState, setArtifactRoot, setRunStatus, startRun, StateError } from "../src/state.ts";
import { setMessagingApi } from "../src/messaging.ts";

let tmpRoot: string;

function setupRepo(name: string, options: { commit?: boolean } = {}): string {
	const workdir = path.join(tmpRoot, name);
	fs.mkdirSync(workdir, { recursive: true });
	spawnSync("git", ["init"], { cwd: workdir });
	if (options.commit) {
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
		spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
		fs.writeFileSync(path.join(workdir, "seed.txt"), "seed", "utf8");
		spawnSync("git", ["add", "-A"], { cwd: workdir });
		spawnSync("git", ["commit", "-m", "seed"], { cwd: workdir });
	}
	initState(workdir);
	return workdir;
}

interface CtxMock {
	cwd: string;
	hasUI: boolean;
	isIdleResult: boolean;
	sessionManager: Record<string, unknown>;
	selectAnswer: string | null | undefined;
	confirmAnswer: boolean;
	notifies: { message: string; severity?: string }[];
	selects: { title: string; options: string[] }[];
	confirmShown: { title: string }[];
	userMessages: string[];
	entries: { customType: string; data?: unknown }[];
}

function makeCtx(cwd: string, overrides: Partial<CtxMock> = {}): CtxMock {
	const base: CtxMock = {
		cwd,
		hasUI: true,
		isIdleResult: true,
		sessionManager: { id: `s-${Math.random().toString(36).slice(2)}` },
		selectAnswer: undefined,
		confirmAnswer: true,
		notifies: [],
		selects: [],
		confirmShown: [],
		userMessages: [],
		entries: [],
		...overrides,
	};
	return base;
}

function ctxAdapter(mock: CtxMock): unknown {
	const ctx = {
		cwd: mock.cwd,
		hasUI: mock.hasUI,
		isIdle: () => mock.isIdleResult,
		sessionManager: mock.sessionManager,
		ui: {
			select: async (title: string, options: string[]) => {
				mock.selects.push({ title, options });
				return mock.selectAnswer === null ? undefined : (mock.selectAnswer ?? options[0]);
			},
			confirm: async (title: string) => {
				mock.confirmShown.push({ title });
				return mock.confirmAnswer;
			},
			notify: (message: string, severity?: string) => {
				mock.notifies.push({ message, severity });
			},
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
	};
	setMessagingApi({
		appendEntry: (customType: string, data?: unknown) => {
			mock.entries.push({ customType, data });
		},
		sendMessage: () => {},
		sendUserMessage: async (content: string) => {
			mock.userMessages.push(content);
		},
	});
	return ctx;
}

const BASE_DIR = path.resolve(import.meta.dirname, "..");

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-resume-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	resetRunBindingForTests();
});

describe("candidate discovery", () => {
	it("lists resumable runs, excludes terminal ones, registry hint first", () => {
		const workdir = setupRepo("discovery");
		const planning = startRun(workdir, { topic: "alpha", skill: "plan-normal", requestText: "a" }).run;
		const verifying = startRun(workdir, { topic: "zeta", skill: "plan-normal", requestText: "f" }).run;
		setRunStatus(workdir, verifying.run_id, "executing");
		setRunStatus(workdir, verifying.run_id, "verifying");
		const stopped = startRun(workdir, { topic: "beta", skill: "plan-normal", requestText: "b" }).run;
		setRunStatus(workdir, stopped.run_id, "executing");
		setRunStatus(workdir, stopped.run_id, "stopped");
		const abandoned = startRun(workdir, { topic: "gamma", skill: "plan-normal", requestText: "c" }).run;
		setRunStatus(workdir, abandoned.run_id, "abandoned");
		const done = startRun(workdir, { topic: "delta", skill: "plan-normal", requestText: "d" }).run;
		setRunStatus(workdir, done.run_id, "done");
		const doneWithReview = startRun(workdir, { topic: "epsilon", skill: "plan-normal", requestText: "e" }).run;
		fs.mkdirSync(doneWithReview.artifact_dir, { recursive: true });
		fs.writeFileSync(path.join(doneWithReview.artifact_dir, "PLAN_v1_reviewer_comments.md"), "# c", "utf8");
		setRunStatus(workdir, doneWithReview.run_id, "done");

		const candidates = listResumeCandidates(workdir);
		const ids = candidates.map((candidate) => candidate.runId);
		assert.ok(ids.includes(planning.run_id));
		assert.ok(ids.includes(stopped.run_id));
		assert.ok(ids.includes(doneWithReview.run_id), "done with review artifacts resumable");
		assert.ok(ids.includes(verifying.run_id), "verifying runs are resumable");
		const verifyingCandidate = candidates.find((candidate) => candidate.runId === verifying.run_id);
		assert.equal(verifyingCandidate?.phaseLabel, "verifying", "verifying runs keep a distinct resume label even though checkpoint.phase stays executing");
		assert.equal(ids.includes(abandoned.run_id), false);
		assert.equal(ids.includes(done.run_id), false, "plain done excluded");

		// v0.6.0: the active-pointer auto-win is gone. The registry hint (newest
		// non-terminal run) still sorts first; picking defaults to null when
		// several candidates exist — the command opens the form (binding-first).
		assert.equal(candidates[0]!.runId, stopped.run_id, "registry hint sorts first");
		assert.equal(pickDefaultCandidate(workdir, candidates), null, "multi-candidate requires choosing");
	});

	it("unique candidate auto-picks; ambiguity requires choosing (v0.6.0)", () => {
		const workdir = setupRepo("picking");
		const only = startRun(workdir, { topic: "only", skill: "plan-normal", requestText: "a" }).run;
		const candidates = listResumeCandidates(workdir);
		assert.equal(pickDefaultCandidate(workdir, candidates)?.runId, only.run_id);

		// v0.6.0 (D-1): no auto-win — two resumable runs are ambiguous here; the
		// command's binding-first path handles the session-bound case.
		const second = startRun(workdir, { topic: "second", skill: "plan-normal", requestText: "b" }).run;
		const withActive = listResumeCandidates(workdir);
		assert.equal(pickDefaultCandidate(workdir, withActive), null, "two candidates require choosing");

		// Ambiguity: two resumable runs, active pointer names a non-resumable one.
		const third = startRun(workdir, { topic: "third", skill: "plan-normal", requestText: "c" }).run;
		setRunStatus(workdir, third.run_id, "abandoned");
		const ambiguous = listResumeCandidates(workdir);
		assert.equal(ambiguous.length, 2);
		assert.equal(pickDefaultCandidate(workdir, ambiguous), null);
	});

	it("surfaces corrupt checkpoints instead of hiding them", () => {
		const workdir = setupRepo("corrupt-list");
		const run = startRun(workdir, { topic: "corrupt", skill: "plan-normal", requestText: "a" }).run;
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		fs.writeFileSync(
			path.join(workdir, ".git", "pi-plans", "runs", run.run_id, "checkpoint.json"),
			"{ broken",
			"utf8",
		);
		const candidates = listResumeCandidates(workdir);
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0]!.checkpointStatus, "corrupt");
	});
});

describe("/resume-plans command", () => {
	it("refuses non-interactive and busy sessions, notifies when nothing is resumable", async () => {
		const workdir = setupRepo("guards");
		const noUI = makeCtx(workdir, { hasUI: false });
		await resumePlansCommand(ctxAdapter(noUI) as never, BASE_DIR);
		assert.ok(noUI.notifies.some((n) => /interactive/.test(n.message)));

		const busy = makeCtx(workdir, { isIdleResult: false });
		await resumePlansCommand(ctxAdapter(busy) as never, BASE_DIR);
		assert.ok(busy.notifies.some((n) => /busy/.test(n.message)));
		assert.equal(busy.userMessages.length, 0);

		const empty = setupRepo("empty-repo");
		const emptyCtx = makeCtx(empty);
		await resumePlansCommand(ctxAdapter(emptyCtx) as never, BASE_DIR);
		assert.ok(emptyCtx.notifies.some((n) => /No resumable/.test(n.message)));
	});

	it("corrupt checkpoints report and change nothing", async () => {
		const workdir = setupRepo("corrupt-cmd");
		const run = startRun(workdir, { topic: "corruptcmd", skill: "plan-normal", requestText: "a" }).run;
		const cpPath = path.join(workdir, ".git", "pi-plans", "runs", run.run_id, "checkpoint.json");
		fs.writeFileSync(cpPath, "{ broken", "utf8");
		const mock = makeCtx(workdir);
		await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
		assert.ok(mock.notifies.some((n) => /corrupt/.test(n.message)));
		assert.equal(mock.userMessages.length, 0);
		assert.equal(fs.readFileSync(cpPath, "utf8"), "{ broken");
	});

	it("planning resume: one kickoff with decisions, pending question, and skill path", async () => {
		resetRunBindingForTests();
		const workdir = setupRepo("planning-resume");
		const run = startRun(workdir, { topic: "planme", skill: "plan-normal", requestText: "Build the thing" }).run;
		const cp = createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		mutateCheckpoint(workdir, run.run_id, (current) => {
			let next = applyQuestionAsked(current, {
				questionId: "q-scope",
				question: "Which scope?",
				options: ["A", "B"],
			});
			next = applyQuestionAnswered(next, "q-scope", "A", "user");
			return applyQuestionAsked(next, { questionId: "q-depth", question: "How deep?", options: ["shallow", "deep"] });
		});
		void cp;

		const mock = makeCtx(workdir);
		await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 1, "exactly one kickoff");
		const brief = mock.userMessages[0]!;
		assert.match(brief, /PI-PLANS RESUME/);
		assert.match(brief, new RegExp(run.run_id));
		assert.match(brief, /skills\/plan-normal\/SKILL\.md/);
		assert.match(brief, /q-scope.*A/);
		assert.match(brief, /PENDING question.*q-depth/);
		assert.match(brief, /do NOT re-run start-run/);
	});

	it("chooser cancellation changes nothing; ambiguity lists all candidates", async () => {
		const workdir = setupRepo("chooser");
		startRun(workdir, { topic: "one", skill: "plan-normal", requestText: "a" });
		startRun(workdir, { topic: "two", skill: "plan-normal", requestText: "b" });
		// Make the active pointer non-resumable so both candidates need choosing.
		const latest = startRun(workdir, { topic: "three", skill: "plan-normal", requestText: "c" }).run;
		setRunStatus(workdir, latest.run_id, "abandoned");
		const mock = makeCtx(workdir, { selectAnswer: null });
		await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 0);
		assert.ok(mock.notifies.some((n) => /Cancelled/.test(n.message)));
		assert.equal(mock.selects.length, 1);
		assert.equal(mock.selects[0]!.options.length, 2);
	});

	it("live foreign ownership refuses (D-009)", async () => {
		const workdir = setupRepo("owned");
		const run = startRun(workdir, { topic: "owned", skill: "plan-normal", requestText: "a" }).run;
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		try {
			fs.writeFileSync(
				path.join(workdir, ".git", "pi-plans", "runs", run.run_id, "owner.json"),
				JSON.stringify({
					schema: 1,
					host: os.hostname(),
					pid: child.pid,
					pidStart: processStartOf(child.pid!),
					sessionId: null,
					processToken: "live-foreign",
					generation: 1,
					acquiredAt: "2026-09-07T00:00:00Z",
				}),
				"utf8",
			);
			const mock = makeCtx(workdir);
			await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
			assert.ok(mock.notifies.some((n) => /actively owned/.test(n.message)));
			assert.equal(mock.userMessages.length, 0);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("cross-worktree: cancel changes nothing; confirm migrates artifacts and resets approval", async () => {
		// Source worktree holds the artifacts inside its own tree. D-007 only
		// applies to a per-worktree root, so pin one; the default root lives in
		// the shared git common dir and is never migrated.
		const source = setupRepo("xwt-source", { commit: true });
		setArtifactRoot(source, "./docs/pi-plans", "user");
		const run = startRun(source, { topic: "xwt", skill: "plan-normal", requestText: "a" }).run;
		const cp = createCheckpoint(source, { runId: run.run_id, originWorkdir: source, workdir: source });
		void cp;
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(path.join(run.artifact_dir, "PLAN_v1.md"), "# plan", "utf8");
		fs.writeFileSync(path.join(run.artifact_dir, "DECISIONS.md"), "# d", "utf8");

		// Linked worktree sharing the same common dir.
		const target = path.join(tmpRoot, "xwt-target");
		spawnSync("git", ["worktree", "add", target], { cwd: source });

		const cancelMock = makeCtx(target, { confirmAnswer: false });
		await resumePlansCommand(ctxAdapter(cancelMock) as never, BASE_DIR);
		assert.equal(cancelMock.userMessages.length, 0);
		assert.ok(cancelMock.confirmShown.length >= 1);

		const goMock = makeCtx(target, { confirmAnswer: true });
		await resumePlansCommand(ctxAdapter(goMock) as never, BASE_DIR);
		assert.equal(goMock.userMessages.length, 1, "one kickoff after migration");
		// Artifacts copied into the target worktree's artifact root.
		const copied = path.join(target, "docs", "pi-plans", path.basename(run.artifact_dir));
		assert.ok(fs.existsSync(path.join(copied, "PLAN_v1.md")));
		assert.ok(fs.existsSync(path.join(copied, "DECISIONS.md")));
		// Source files untouched.
		assert.ok(fs.existsSync(path.join(run.artifact_dir, "PLAN_v1.md")));
		// Approval/VC state reset in the migrated checkpoint (F-003).
		const migrated = loadCheckpoint(target, run.run_id);
		assert.equal(migrated.status, "ok");
		if (migrated.status === "ok") {
			assert.equal(migrated.checkpoint.workdir, path.resolve(target));
			assert.equal(migrated.checkpoint.execution?.approval ?? null, null);
		}
	});

	it("legacy executing run asks before the handoff path", async () => {
		const workdir = setupRepo("legacy-exec");
		const run = startRun(workdir, { topic: "legacy", skill: "plan-normal", requestText: "a" }).run;
		setRunStatus(workdir, run.run_id, "executing");
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(path.join(run.artifact_dir, "PLAN_v1.md"), "# plan", "utf8");
		const mock = makeCtx(workdir, { confirmAnswer: true });
		await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 1);
		assert.match(mock.userMessages[0]!, /re-run the execution handoff/);
		assert.ok(mock.confirmShown.some((c) => /Legacy execution run/.test(c.title)));
	});

	it("migrateRunIntoCurrentWorktree aborts on differing conflicts (F-003)", () => {
		const source = setupRepo("mig-overwrite", { commit: true });
		setArtifactRoot(source, "./docs/pi-plans", "user");
		const run = startRun(source, { topic: "mig", skill: "plan-normal", requestText: "a" }).run;
		createCheckpoint(source, { runId: run.run_id, originWorkdir: source, workdir: source });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(path.join(run.artifact_dir, "PLAN_v1.md"), "ORIGINAL", "utf8");
		const target = path.join(tmpRoot, "mig-target");
		spawnSync("git", ["worktree", "add", target], { cwd: source });
		const targetArtifact = path.join(target, "docs", "pi-plans", path.basename(run.artifact_dir));
		// Differing existing content aborts the whole migration.
		fs.mkdirSync(targetArtifact, { recursive: true });
		fs.writeFileSync(path.join(targetArtifact, "PLAN_v1.md"), "USER FILE", "utf8");
		const candidates = listResumeCandidates(target);
		const candidate = candidates.find((entry) => entry.runId === run.run_id);
		assert.ok(candidate);
		const aborted = migrateRunIntoCurrentWorktree(target, candidate!);
		assert.equal(aborted, null, "conflicting content aborts migration");
		assert.equal(fs.readFileSync(path.join(targetArtifact, "PLAN_v1.md"), "utf8"), "USER FILE", "existing file untouched");
		// Identical bytes proceed as a no-op copy.
		fs.writeFileSync(path.join(targetArtifact, "PLAN_v1.md"), "ORIGINAL", "utf8");
		const candidates2 = listResumeCandidates(target);
		const candidate2 = candidates2.find((entry) => entry.runId === run.run_id);
		const synced = migrateRunIntoCurrentWorktree(target, candidate2!);
		assert.ok(synced, "identical bytes proceed");
	});
});

describe("F-004 ledger reconcile (crash window)", () => {
	it("an answered ledger entry drops the stale pending question and the brief reflects it", async () => {
		const workdir = setupRepo("f004-window");
		const run = startRun(workdir, { topic: "f004", skill: "plan-normal", requestText: "a" }).run;
		const cp = createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		void cp;
		mutateCheckpoint(workdir, run.run_id, (current) =>
			applyQuestionAsked(current, { questionId: "q-x", question: "Q?", options: ["a", "b"] }),
		);
		// Crash window: the ledger holds the answer (with the stable id), the
		// checkpoint still shows the question pending.
		const { recordDecision } = await import("../src/state.ts");
		recordDecision(workdir, run.run_id, {
			question: "Q?",
			options: ["a", "b"],
			answer: "a",
			answer_source: "user",
			questionId: "q-x",
		});
		const mock = makeCtx(workdir);
		await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 1);
		const brief = mock.userMessages[0]!;
		assert.doesNotMatch(brief, /PENDING question/, "answered ledger entry wins");
		// The reconciled state is persisted for future resumes too.
		const after = loadCheckpoint(workdir, run.run_id);
		if (after.status === "ok") assert.equal(after.checkpoint.pendingQuestion, null);
	});
});

describe("impl-review crash-window recovery (removed in v0.6.1)", () => {
	it("the resolver is gone with the loop: the helper no longer exists", async () => {
		const mod = await import("../src/resume-command.ts");
		assert.equal("resolveImplReviewConfig" in mod, false);
	});
});

describe("execution resume brief with a blocked review (v0.9.2)", () => {
	const BLOCKED_PLAN = `# PLAN_v1 - blocked brief

## Tasks

- Task-1: engine — files: lib/engine.js; wave: 1
- Task-2: host — files: lib/host.js; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: engine works; evidence: tests; metric: green.
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: host works; evidence: tests; metric: green.
`;

	it("names the open rolled-back task and how to unblock the review", async () => {
		resetRunBindingForTests();
		// A matching HEAD is required: an unverifiable head re-opens every task
		// (reverifyAll) and legitimately drops the blocker with the progress.
		const workdir = setupRepo("blocked-brief", { commit: true });
		const run = startRun(workdir, { topic: "blockedbrief", skill: "plan-normal", requestText: "b" }).run;
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(planPath, BLOCKED_PLAN, "utf8");
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		mutateCheckpoint(workdir, run.run_id, (cp) => {
			const plan = planIdentityOf(planPath, 1);
			let next = applyPlanWritten({ ...cp, nextAction: "accept-execute" }, plan);
			next = applyExecutionApproved(next, { plan, worktree: workdir, headAtApproval: resolveHeadAt(workdir), approvedAt: next.updatedAt });
			return applyExecutionProgress(next, {
				tasks: { "Task-1": { status: "complete", evidence: "e" }, "Task-2": { status: "pending" } },
				blocked: { rolledBack: ["Task-2"], tasks: ["Task-2"], round: 1, escalatedRounds: 2, since: next.updatedAt },
			});
		});
		setRunStatus(workdir, run.run_id, "executing");
		const mock = makeCtx(workdir);
		await resumePlansCommand(ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 1, "one resume brief");
		const brief = mock.userMessages[0]!;
		assert.match(brief, /PI-PLANS RESUME/);
		assert.match(brief, /Review blocked: Task-2 was reopened by execution review round 1 and is still open/);
		assert.match(brief, /close it with plans_update_task/);
		assert.match(brief, /no review round is running while these are open\./i);
	});
});
