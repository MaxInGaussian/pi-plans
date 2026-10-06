/**
 * `/plans-terminate` tests (v0.9.4): the user-authorized end of a run.
 *
 * Covers the decided contract (planning decisions Q1–Q5): no hard gate with a
 * `<3` round warning, unresolved highs allowed but disclosed, unverified checks
 * and open tasks left untouched, abort of an in-flight round with a `cancelled`
 * report that burns no budget, `TERMINATION.md` in the plan artifact dir, the
 * `audit.passed = false` / `lastResult` marker, the `pi-plans-exec-cleared`
 * tombstone, and the terminal-run guard on `/plans-execute` handoffs.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	__awaitReviewRoundForTests,
	__setAuditRunnerForTests,
	getExecution,
	persistTaskProgress,
	restoreFromSession,
	startExecution,
	stopExecution,
	terminateExecution,
	terminationSummary,
	type TerminationSummary,
} from "../src/exec.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { bindRun, resetRunBindingForTests } from "../src/run-context.ts";
import { getRun, initState, runDirPath, setRunStatus, startRun } from "../src/state.ts";
import { applyTaskUpdate } from "../src/task-tool.ts";
import { terminationChrome } from "../src/ui-language.ts";
import { terminatePlanCommand } from "../src/terminate-command.ts";
import { executeHandoff } from "../tools/execute-plan.ts";
import {
	applyExecutionApproved,
	applyPlanWritten,
	createCheckpoint,
	loadCheckpoint,
	mutateCheckpoint,
	planIdentityOf,
} from "../src/workflow-state.ts";

const PLAN = `# PLAN_v1 - terminate fixture

## Tasks

- Task-1: engine — files: lib/engine.js; wave: 1
- Task-2: report — files: lib/report.js; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: engine works; evidence: tests; metric: green.
- [ ] \`VC-002\` covers \`Task-1\`; pass condition: engine clean; evidence: lint; metric: green.
- [ ] \`VC-003\` covers \`Task-2\`; pass condition: report written; evidence: file; metric: green.
`;

let root = "";
let counter = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-terminate-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	__setAuditRunnerForTests(null);
	resetRunBindingForTests();
});

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
	content?: string;
}

interface CapturedCtx {
	ctx: never;
	entries: CapturedEntry[];
	notifies: Array<{ message: string; level?: string }>;
	confirms: Array<{ title: string; body: string }>;
	setConfirm(value: boolean): void;
}

function ctxFor(
	workdir: string,
	opts: { hasUI?: boolean; confirm?: boolean; session?: unknown } = {},
): CapturedCtx {
	const entries: CapturedEntry[] = [];
	const notifies: Array<{ message: string; level?: string }> = [];
	const confirms: Array<{ title: string; body: string }> = [];
	let confirmResult = opts.confirm ?? true;
	const ctx = {
		cwd: workdir,
		sessionManager: opts.session ?? { id: `s-${counter}` },
		hasUI: opts.hasUI ?? true,
		mode: "tui",
		entries,
		ui: {
			notify: (message: string, level?: string) => notifies.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
			confirm: async (title: string, body: string) => {
				confirms.push({ title, body });
				return confirmResult;
			},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as never;
	setMessagingApi({
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { customType: string; content: string }) =>
			entries.push({ type: "custom", customType: message.customType, content: message.content }),
	} as never);
	return { ctx, entries, notifies, confirms, setConfirm: (value) => (confirmResult = value) };
}

function freshWorkdir(): { workdir: string; planPath: string; runId: string } {
	counter += 1;
	const workdir = path.join(root, `repo-${counter}`);
	fs.mkdirSync(path.join(workdir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(workdir, "lib", "engine.js"), "export const engine = 1;\n", "utf8");
	fs.writeFileSync(path.join(workdir, "lib", "report.js"), "export const report = 1;\n", "utf8");
	initState(workdir);
	const { run } = startRun(workdir, { topic: `t${counter}`, skill: "plan-small", requestText: "terminate fixture" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
	fs.writeFileSync(planPath, PLAN, "utf8");
	mutateCheckpoint(workdir, run.run_id, (cp) =>
		applyExecutionApproved(applyPlanWritten({ ...cp, nextAction: "accept-execute" }, planIdentityOf(planPath, 1)), {
			plan: planIdentityOf(planPath, 1),
			worktree: workdir,
			headAtApproval: null,
			approvedAt: cp.updatedAt,
		}),
	);
	return { workdir, planPath, runId: run.run_id };
}

/** Start an execution and mark the given checks done. Forces English chrome so
 * message assertions stay language-stable. */
async function beginExecution(
	workdir: string,
	planPath: string,
	doneVcIds: string[] = [],
	opts: { session?: unknown } = {},
): Promise<CapturedCtx> {
	const captured = ctxFor(workdir, opts);
	const items = parseChecklist(PLAN).map((item) => ({ ...item, done: doneVcIds.includes(item.id) }));
	await startExecution(captured.ctx, { planPath, planTasks: parsePlanTasks(PLAN), items });
	getExecution()!.uiLanguage = "en";
	// Persist the done flags so the checkpoint's doneVcIds reflects them (the
	// live items are memory-side until a task update persists progress).
	if (doneVcIds.length > 0) persistTaskProgress(captured.ctx);
	return captured;
}

function entryOf(entries: CapturedEntry[], customType: string): CapturedEntry | undefined {
	return entries.find((entry) => entry.customType === customType);
}

/** Let the engine chain advance without awaiting its completion. */
const tick = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Replace the captured ctx's confirm with a hook-driven stub (the hook runs
 * while the dialog is “open”, so tests can mutate the live loop there). */
function overrideConfirm(
	captured: CapturedCtx,
	hook: (title: string, body: string, call: number) => boolean | Promise<boolean>,
): void {
	let calls = 0;
	(captured.ctx as unknown as { ui: { confirm: (title: string, body: string) => Promise<boolean> } }).ui.confirm = async (title, body) => {
		calls += 1;
		captured.confirms.push({ title, body });
		return await hook(title, body, calls);
	};
}

/** Complete every task and spawn one detached review round the test resolves
 * by hand (the sanctioned in-flight seam). */
async function spawnControlledRound(captured: CapturedCtx): Promise<{
	resolve(value: unknown): void;
	restoring: Promise<void>;
	budgetRound: number;
	attempt: number;
}> {
	for (const id of ["Task-1", "Task-2"]) {
		applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
		persistTaskProgress(captured.ctx);
	}
	let resolver: ((value: unknown) => void) | null = null;
	__setAuditRunnerForTests(
		async () =>
			new Promise((resolve) => {
				resolver = resolve as (value: unknown) => void;
			}) as never,
	);
	const restoring = restoreFromSession(captured.ctx, [
		{ type: "custom", customType: "pi-plans-exec", data: getExecution() } as never,
	]);
	await tick();
	const inFlight = getExecution()!.review.inFlight;
	assert.ok(inFlight, "the controlled round is in flight");
	return {
		resolve: (value) => resolver?.(value),
		restoring,
		budgetRound: inFlight!.budgetRound,
		attempt: inFlight!.attempt,
	};
}

describe("/plans-terminate (v0.9.4)", () => {
	it("(a) no execution in progress: notify only, nothing changes", async () => {
		const { workdir, runId } = freshWorkdir();
		const before = getRun(workdir, runId)?.status;
		const checkpointBefore = loadCheckpoint(workdir, runId);
		const captured = ctxFor(workdir);
		await terminatePlanCommand(captured.ctx);
		assert.equal(captured.confirms.length, 0, "no confirm without a live execution");
		assert.equal(captured.entries.length, 0, "no message written");
		assert.ok(captured.notifies.some((n) => n.message.length > 0), "the user is told why nothing happened");
		assert.equal(getRun(workdir, runId)?.status, before, "run status untouched");
		assert.deepEqual(loadCheckpoint(workdir, runId), checkpointBefore, "checkpoint untouched");
	});

	it("(b) headless host: refuses up front with the interactive-session notice", async () => {
		const { workdir, planPath } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		const headless = ctxFor(workdir, { hasUI: false });
		await terminatePlanCommand(headless.ctx);
		assert.equal(headless.confirms.length, 0);
		assert.equal(headless.entries.length, 0, "no disclosure message in a session that cannot confirm");
		assert.ok(headless.notifies.length >= 1);
		assert.ok(getExecution(), "the execution stays alive");
	});

	it("(c) confirm declined: zero change — execution, status, checkpoint, no record", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		captured.setConfirm(false);
		await terminatePlanCommand(captured.ctx);
		assert.equal(captured.confirms.length, 1, "exactly one confirm");
		assert.ok(entryOf(captured.entries, "pi-plans-terminate-preview"), "the full disclosure ships before the confirm");
		assert.equal(entryOf(captured.entries, "pi-plans-terminate"), undefined, "no termination message");
		assert.equal(entryOf(captured.entries, "pi-plans-exec-cleared"), undefined, "no tombstone");
		assert.ok(getExecution(), "the execution survives a declined confirm");
		assert.equal(getRun(workdir, runId)?.status, "executing", "run status untouched");
		assert.equal(fs.existsSync(path.join(getRun(workdir, runId)!.artifact_dir, "TERMINATION.md")), false);
		assert.ok(captured.notifies.some((n) => n.message.length > 0), "the cancel is acknowledged");
	});

	it("(d) full termination with an unresolved high, unverified checks and an open task", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath, ["VC-001"]);
		const finding = (id: string, severity: "high" | "medium") => ({
			id,
			severity,
			taskIds: [],
			note: `${id} note`,
			evidence: "round-1 report",
			raw: `${id}; severity: ${severity}`,
		});
		getExecution()!.audit.findings = [finding("F-001", "high"), finding("F-002", "medium")];
		await terminatePlanCommand(captured.ctx);

		const artifactDir = getRun(workdir, runId)!.artifact_dir;
		const recordPath = path.join(artifactDir, "TERMINATION.md");
		assert.equal(fs.existsSync(recordPath), true, "TERMINATION.md lands beside PLAN_vN.md");
		const record = fs.readFileSync(recordPath, "utf8");
		for (const heading of [
			"## Terminated at",
			"## Committed review rounds",
			"## Budget",
			"## Unverified checks",
			"## Open tasks",
			"## Unresolved findings",
		]) {
			assert.ok(record.includes(heading), `record carries ${heading}`);
		}
		assert.ok(record.includes("- VC-002") && record.includes("- VC-003"), "unverified checks are listed");
		assert.ok(record.includes("- Task-1") && record.includes("- Task-2"), "open tasks are listed");
		assert.ok(record.includes("- F-001 (high)") && record.includes("- F-002 (unresolved)"), "findings are listed by severity (non-high is unresolved, not residual)");

		const message = entryOf(captured.entries, "pi-plans-terminate");
		assert.ok(message, "termination message sent");
		assert.match(String(message!.content), /terminated by user/i);
		assert.match(String(message!.content), /F-001/);
		assert.match(String(message!.content), /VC-002/);
		// The chat surface carries the rounds/budget summary (F-002) and never a
		// pass-looking tick on a run whose checkpoint says audit.passed = false.
		assert.match(String(message!.content), /committed review round\(s\) \(budget /);
		assert.equal(String(message!.content).includes("✅"), false, "no audit-passed tick");
		assert.ok(entryOf(captured.entries, "pi-plans-exec-cleared"), "the session snapshot is tombstoned");
		assert.equal(getExecution(), null, "the loop is gone");
		assert.equal(getRun(workdir, runId)?.status, "done", "terminal status recorded");

		const load = loadCheckpoint(workdir, runId);
		assert.equal(load.status, "ok");
		if (load.status !== "ok") return;
		assert.equal(load.checkpoint.phase, "completed");
		assert.equal(load.checkpoint.execution?.audit?.passed, false, "a terminated run does not claim the audit passed");
		assert.equal(load.checkpoint.execution?.audit?.lastResult, "terminated by user");
		assert.equal(load.checkpoint.execution?.reviewBudget, undefined, "budget state is dropped on completion");
		assert.equal(load.checkpoint.execution?.doneVcIds?.includes("VC-001"), true, "verified checks keep their state");
		assert.equal(load.checkpoint.execution?.doneVcIds?.includes("VC-002"), false, "unverified checks stay unverified");
	});

	it("(e) fewer than three committed rounds adds the warning to the confirm body; three drops it", async () => {
		const { workdir, planPath } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		captured.setConfirm(false);
		const note = terminationChrome("en").fewRoundsNote(2);
		getExecution()!.reviewRoundsTotal = 2;
		await terminatePlanCommand(captured.ctx);
		assert.ok(captured.confirms[0].body.includes(note), "the <3 rounds warning is in the confirm body");
		getExecution()!.reviewRoundsTotal = 3;
		await terminatePlanCommand(captured.ctx);
		assert.equal(captured.confirms[1].body.includes(note), false, "three rounds silence the warning");
	});

	it("(f) an in-flight round is aborted with a cancelled report and burns no budget", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		for (const id of ["Task-1", "Task-2"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(captured.ctx);
		}
		let resolver: ((value: never) => void) | null = null;
		__setAuditRunnerForTests(
			async () =>
				new Promise((resolve) => {
					resolver = resolve as (value: never) => void;
				}) as never,
		);
		const restoring = restoreFromSession(captured.ctx, [
			{ type: "custom", customType: "pi-plans-exec", data: getExecution() } as never,
		]);
		await tick();
		const ex = getExecution()!;
		assert.ok(ex.review.inFlight, "the round is in flight");
		const inFlight = { budgetRound: ex.review.inFlight!.budgetRound, attempt: ex.review.inFlight!.attempt };
		const counters = { audit: ex.audit.rounds, total: ex.reviewRoundsTotal };

		await terminatePlanCommand(captured.ctx);

		const runDir = runDirPath(workdir, runId);
		assert.ok(runDir, "run dir exists");
		const reportPath = path.join(runDir!, "execution-review", `round-${inFlight.budgetRound}-attempt-${inFlight.attempt}.md`);
		assert.equal(fs.existsSync(reportPath), true, "the aborted round leaves a report");
		const report = fs.readFileSync(reportPath, "utf8");
		assert.match(report, /cancelled/i, "its outcome is cancelled");
		assert.equal(ex.audit.rounds, counters.audit, "aborting spends no budget");
		assert.equal(ex.reviewRoundsTotal, counters.total, "the committed-round counter is untouched");
		assert.equal(getExecution(), null);
		// Teardown: resolve the abandoned round so the chain can settle (its
		// handler is dropped by the ownership guard).
		resolver?.({ cancelled: true } as never);
		await restoring.catch(() => {});
		await tick();
		__setAuditRunnerForTests(null);
	});

	it("(g) replaying the session entries cannot resurrect a terminated run", async () => {
		const { workdir, planPath } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath, ["VC-001"]);
		await terminatePlanCommand(captured.ctx);
		assert.equal(getExecution(), null);
		const replay = ctxFor(workdir);
		await restoreFromSession(replay.ctx, captured.entries as never);
		assert.equal(getExecution(), null, "the pi-plans-exec-cleared tombstone wins over the snapshot");
	});

	it("(h) the terminal-run guard refuses to revive a done run", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const session = { id: "guarded-session" };
		bindRun(session, workdir, runId);
		setRunStatus(workdir, runId, "done");
		const captured = ctxFor(workdir, { session });
		const items = parseChecklist(PLAN).map((item) => ({ ...item, done: true }));
		await startExecution(captured.ctx, { planPath, planTasks: parsePlanTasks(PLAN), items });
		assert.equal(getExecution(), null, "no execution is constructed for a terminal run");
		assert.equal(getRun(workdir, runId)?.status, "done", "the status is not flipped back to executing");
		assert.equal(entryOf(captured.entries, "pi-plans-exec-start"), undefined, "no start banner");
		assert.ok(
			captured.notifies.some((n) => n.message.includes(runId)),
			"the guard notice names the terminal run",
		);
	});

	it("(j) an empty artifact_dir degrades to record-unavailable instead of throwing or writing to cwd", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath, ["VC-001"]);
		// Simulate the unvalidated ActiveInfo case: the registry entry carries an
		// empty artifact dir (state.ts reads run.json with a raw cast).
		const runJson = path.join(runDirPath(workdir, runId)!, "run.json");
		const info = JSON.parse(fs.readFileSync(runJson, "utf8")) as { artifact_dir: string };
		info.artifact_dir = "";
		fs.writeFileSync(runJson, JSON.stringify(info), "utf8");
		assert.equal(getRun(workdir, runId)?.artifact_dir, "", "precondition: empty artifact dir");

		await terminatePlanCommand(captured.ctx);

		assert.equal(getExecution(), null, "the termination still completes");
		assert.equal(getRun(workdir, runId)?.status, "done", "the run still reaches its terminal status");
		const message = entryOf(captured.entries, "pi-plans-terminate");
		assert.ok(message, "the termination is still reported");
		assert.ok(
			String(message!.content).includes(terminationChrome("en").recordUnavailable),
			"the message says the record could not be written",
		);
		assert.equal(fs.existsSync(path.join(workdir, "TERMINATION.md")), false, "no record in the workdir");
		assert.equal(fs.existsSync(path.join(process.cwd(), "TERMINATION.md")), false, "no record in the process cwd");
	});

	it("(k) an unbound session whose every run is terminal is refused too", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		setRunStatus(workdir, runId, "done");
		const captured = ctxFor(workdir);
		const started = await startExecution(captured.ctx, {
			planPath,
			planTasks: parsePlanTasks(PLAN),
			items: parseChecklist(PLAN),
		});
		assert.equal(started, false, "the guard refuses an all-terminal registry");
		assert.equal(getExecution(), null);
		assert.equal(getRun(workdir, runId)?.status, "done", "status stays terminal");
		assert.ok(
			captured.notifies.some((n) => n.message.includes(runId)),
			"the guard notice names the terminal run",
		);
	});

	it("(l) executeHandoff reports the refusal instead of claiming success", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const session = { id: "handoff-session" };
		bindRun(session, workdir, runId);
		setRunStatus(workdir, runId, "done");
		const captured = ctxFor(workdir, { session });
		const outcome = await executeHandoff(captured.ctx, planPath, workdir);
		assert.equal(outcome.status, "error", "a terminal run cannot be executed again");
		assert.match(outcome.message, /terminal|refused/i);
		assert.equal(getExecution(), null);
		assert.equal(getRun(workdir, runId)?.status, "done");
	});

	it("(k2) an unrelated plan in an all-terminal workdir is not refused", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		setRunStatus(workdir, runId, "done");
		const otherPlan = path.join(workdir, "PLAN_v1.md");
		fs.copyFileSync(planPath, otherPlan);
		const captured = ctxFor(workdir);
		const started = await startExecution(captured.ctx, {
			planPath: otherPlan,
			planTasks: parsePlanTasks(PLAN),
			items: parseChecklist(PLAN),
		});
		assert.equal(started, true, "a plan unrelated to any terminal run keeps the pre-existing path");
		await stopExecution(captured.ctx, "teardown");
	});

	it("(m) a round that commits while the dialog is open is never overwritten by a cancelled report", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		const round = await spawnControlledRound(captured);
		// The dialog stays open while the round commits with a failure: the loop
		// survives (tasks roll back) and its in-flight marker is cleared.
		overrideConfirm(captured, async () => {
			round.resolve({ round: 1, passed: ["VC-002", "VC-003"], failed: ["VC-001"], undeterminable: [], report: "VC-001 failed" });
			await __awaitReviewRoundForTests();
			return true;
		});
		await terminatePlanCommand(captured.ctx);

		const runDir = runDirPath(workdir, runId)!;
		const committed = fs.readFileSync(
			path.join(runDir, "execution-review", `round-${round.budgetRound}-attempt-${round.attempt}.md`),
			"utf8",
		);
		assert.equal(committed.includes("cancelled"), false, "the committed report keeps its own outcome");
		assert.match(committed, /VC-001/, "the committed round's evidence survives");
		const record = fs.readFileSync(path.join(getRun(workdir, runId)!.artifact_dir, "TERMINATION.md"), "utf8");
		assert.equal(record.includes("Aborted in-flight round"), false, "no phantom aborted round in the record");
		assert.match(record, /## Committed review rounds\n1/, "the round that committed is counted");
		const message = String(entryOf(captured.entries, "pi-plans-terminate")!.content);
		assert.match(message, /1 committed review round\(s\)/);
		assert.equal(message.includes("In-flight round aborted"), false, "no phantom abort in the message");
		assert.equal(getExecution(), null);
		await round.restoring.catch(() => {});
		__setAuditRunnerForTests(null);
	});

	it("(n) terminateExecution files the cancelled report for the round actually in flight", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		const round = await spawnControlledRound(captured);
		// A summary captured before the dialog named a different attempt.
		const stale: TerminationSummary = {
			...terminationSummary(getExecution()!),
			abortedRound: { budgetRound: round.budgetRound, attempt: 99 },
		};
		const terminated = await terminateExecution(captured.ctx, stale);
		assert.equal(terminated, true);
		const runDir = runDirPath(workdir, runId)!;
		assert.equal(
			fs.existsSync(path.join(runDir, "execution-review", `round-${round.budgetRound}-attempt-99.md`)),
			false,
			"no report for the stale attempt",
		);
		const report = fs.readFileSync(
			path.join(runDir, "execution-review", `round-${round.budgetRound}-attempt-${round.attempt}.md`),
			"utf8",
		);
		assert.match(report, /cancelled/, "the live in-flight round gets the cancelled report");
		const record = fs.readFileSync(path.join(getRun(workdir, runId)!.artifact_dir, "TERMINATION.md"), "utf8");
		assert.ok(
			record.includes(`round ${round.budgetRound} attempt ${round.attempt}`),
			"the record names the live round",
		);
		round.resolve({ cancelled: true });
		await round.restoring.catch(() => {});
		await tick();
		__setAuditRunnerForTests(null);
	});

	it("(o) a confirm that lands after the loop converged is reported, not silently ignored", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		const round = await spawnControlledRound(captured);
		overrideConfirm(captured, async () => {
			round.resolve({ round: 1, passed: ["VC-001", "VC-002", "VC-003"], failed: [], undeterminable: [], report: "all pass" });
			await __awaitReviewRoundForTests();
			return true;
		});
		await terminatePlanCommand(captured.ctx);
		assert.equal(getExecution(), null, "the review completed the run");
		assert.equal(getRun(workdir, runId)?.status, "done");
		assert.ok(captured.notifies.length > 0, "the user is told the execution already ended");
		assert.equal(entryOf(captured.entries, "pi-plans-terminate"), undefined, "no termination message on a converged run");
		await round.restoring.catch(() => {});
		__setAuditRunnerForTests(null);
	});

	it("(p) a high that appears while the dialog is open forces a second confirmation", async () => {
		const { workdir, planPath } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath, ["VC-001"]);
		overrideConfirm(captured, (_title, _body, call) => {
			if (call === 1) {
				getExecution()!.audit.findings = [
					{ id: "F-100", severity: "high", taskIds: [], note: "late high", evidence: "round-1", raw: "F-100" },
				];
			}
			return true;
		});
		await terminatePlanCommand(captured.ctx);
		assert.equal(captured.confirms.length, 2, "the fresh high triggers a re-ask");
		assert.ok(captured.confirms[1].body.includes("F-100"), "the second confirm lists the new high");
		const message = String(entryOf(captured.entries, "pi-plans-terminate")!.content);
		assert.match(message, /F-100/);
		assert.equal(getExecution(), null);
	});

	it("(i) chrome: zh/en key parity, every key present, no empty strings", async () => {
		const zh = terminationChrome("zh");
		const en = terminationChrome("en");
		assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "both languages carry the same keys");
		const samples: Record<string, unknown[]> = {
			confirmBody: [2, "3"],
			roundsLabel: [2, "3"],
			fewRoundsNote: [2],
			unverifiedLabel: [2],
			openTasksLabel: [1],
			highsLabel: [1],
			residualLabel: [1],
			partialIds: [3],
			recordLine: ["/tmp/TERMINATION.md"],
			abortedRoundLabel: [2, 1],
			guardNotice: ["run-1", "done"],
		};
		for (const table of [zh, en]) {
			for (const [key, value] of Object.entries(table)) {
				if (typeof value === "function") {
					const rendered = String((value as (...args: unknown[]) => string)(...(samples[key] ?? [])));
					assert.ok(rendered.trim().length > 0, `${key} renders non-empty`);
				} else {
					assert.ok(value.trim().length > 0, `${key} is non-empty`);
				}
			}
		}
	});

	it("keeps execution stopped in teardown paths (regression guard)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const captured = await beginExecution(workdir, planPath);
		await stopExecution(captured.ctx, "teardown");
		assert.equal(getExecution(), null);
	});
});
