/** /resume-plans command tests (I-006). */

import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { listResumeCandidates, pickDefaultCandidate } from "../src/resume.ts";
import { migrateRunIntoCurrentWorktree, resumePlansCommand } from "../src/resume-command.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint, applyQuestionAsked, applyQuestionAnswered } from "../src/workflow-state.ts";
import { acquireOwnership, processStartOf } from "../src/run-ownership.ts";
import { resetRunBindingForTests } from "../src/run-context.ts";
import { initState, setRunStatus, startRun, StateError } from "../src/state.ts";

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
	return {
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
}

function makePi(mock: CtxMock): unknown {
	return {
		sendUserMessage: async (content: string) => {
			mock.userMessages.push(content);
		},
		appendEntry: (customType: string, data?: unknown) => {
			mock.entries.push({ customType, data });
		},
		sendMessage: () => {},
		on: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
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
	it("lists resumable runs, excludes terminal ones, prioritizes active", () => {
		const workdir = setupRepo("discovery");
		const planning = startRun(workdir, { topic: "alpha", skill: "plan-normal", requestText: "a" }).run;
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
		assert.equal(ids.includes(abandoned.run_id), false);
		assert.equal(ids.includes(done.run_id), false, "plain done excluded");

		// Active priority: shared pointer names `doneWithReview` (last started).
		const picked = pickDefaultCandidate(workdir, candidates);
		assert.equal(picked?.runId, doneWithReview.run_id);
	});

	it("unique candidate auto-picks; unfinished active wins; ambiguity requires choosing", () => {
		const workdir = setupRepo("picking");
		const only = startRun(workdir, { topic: "only", skill: "plan-normal", requestText: "a" }).run;
		const candidates = listResumeCandidates(workdir);
		assert.equal(pickDefaultCandidate(workdir, candidates)?.runId, only.run_id);

		// D-001: an unfinished active run wins even when others exist.
		const second = startRun(workdir, { topic: "second", skill: "plan-normal", requestText: "b" }).run;
		const withActive = listResumeCandidates(workdir);
		assert.equal(pickDefaultCandidate(workdir, withActive)?.runId, second.run_id);

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
			path.join(workdir, ".git", "pi_plans", "runs", run.run_id, "checkpoint.json"),
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
		await resumePlansCommand(makePi(noUI) as never, ctxAdapter(noUI) as never, BASE_DIR);
		assert.ok(noUI.notifies.some((n) => /interactive/.test(n.message)));

		const busy = makeCtx(workdir, { isIdleResult: false });
		await resumePlansCommand(makePi(busy) as never, ctxAdapter(busy) as never, BASE_DIR);
		assert.ok(busy.notifies.some((n) => /busy/.test(n.message)));
		assert.equal(busy.userMessages.length, 0);

		const empty = setupRepo("empty-repo");
		const emptyCtx = makeCtx(empty);
		await resumePlansCommand(makePi(emptyCtx) as never, ctxAdapter(emptyCtx) as never, BASE_DIR);
		assert.ok(emptyCtx.notifies.some((n) => /No resumable/.test(n.message)));
	});

	it("corrupt checkpoints report and change nothing", async () => {
		const workdir = setupRepo("corrupt-cmd");
		const run = startRun(workdir, { topic: "corruptcmd", skill: "plan-normal", requestText: "a" }).run;
		const cpPath = path.join(workdir, ".git", "pi_plans", "runs", run.run_id, "checkpoint.json");
		fs.writeFileSync(cpPath, "{ broken", "utf8");
		const mock = makeCtx(workdir);
		await resumePlansCommand(makePi(mock) as never, ctxAdapter(mock) as never, BASE_DIR);
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
		await resumePlansCommand(makePi(mock) as never, ctxAdapter(mock) as never, BASE_DIR);
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
		await resumePlansCommand(makePi(mock) as never, ctxAdapter(mock) as never, BASE_DIR);
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
				path.join(workdir, ".git", "pi_plans", "runs", run.run_id, "owner.json"),
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
			await resumePlansCommand(makePi(mock) as never, ctxAdapter(mock) as never, BASE_DIR);
			assert.ok(mock.notifies.some((n) => /actively owned/.test(n.message)));
			assert.equal(mock.userMessages.length, 0);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("cross-worktree: cancel changes nothing; confirm migrates artifacts and resets approval", async () => {
		// Source worktree holds the artifacts inside its own tree.
		const source = setupRepo("xwt-source", { commit: true });
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
		await resumePlansCommand(makePi(cancelMock) as never, ctxAdapter(cancelMock) as never, BASE_DIR);
		assert.equal(cancelMock.userMessages.length, 0);
		assert.ok(cancelMock.confirmShown.length >= 1);

		const goMock = makeCtx(target, { confirmAnswer: true });
		await resumePlansCommand(makePi(goMock) as never, ctxAdapter(goMock) as never, BASE_DIR);
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
		await resumePlansCommand(makePi(mock) as never, ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 1);
		assert.match(mock.userMessages[0]!, /re-run the execution handoff/);
		assert.ok(mock.confirmShown.some((c) => /Legacy execution run/.test(c.title)));
	});

	it("migrateRunIntoCurrentWorktree aborts on differing conflicts (F-003)", () => {
		const source = setupRepo("mig-overwrite", { commit: true });
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
		await resumePlansCommand(makePi(mock) as never, ctxAdapter(mock) as never, BASE_DIR);
		assert.equal(mock.userMessages.length, 1);
		const brief = mock.userMessages[0]!;
		assert.doesNotMatch(brief, /PENDING question/, "answered ledger entry wins");
		// The reconciled state is persisted for future resumes too.
		const after = loadCheckpoint(workdir, run.run_id);
		if (after.status === "ok") assert.equal(after.checkpoint.pendingQuestion, null);
	});
});
