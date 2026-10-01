/**
 * Execution-review loop tests (v0.8): detached rounds, abort/identity
 * lifecycle, the fingerprint guard, budget accounting (commit-only), round
 * report persistence, the cap pause, and resume self-heal.
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
} from "../src/exec.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { applyTaskUpdate } from "../src/task-tool.ts";
import { REVIEW_MAX_ROUNDS } from "../src/auditor.ts";
import { getRun, initState, startRun } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint, applyExecutionApproved, applyExecutionProgress, applyPlanWritten, planIdentityOf } from "../src/workflow-state.ts";

const PLAN = `# PLAN_v1 - review-loop fixture

## Tasks

- Task-1: engine — files: lib/engine.js; wave: 1
- Task-2: report — files: lib/report.js; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: engine works; evidence: tests; metric: green.
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: report written; evidence: file; metric: green.
`;

let root = "";
let counter = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-review-loop-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	__setAuditRunnerForTests(null);
});

function freshWorkdir(): { workdir: string; planPath: string; runId: string } {
	counter += 1;
	const workdir = path.join(root, `repo-${counter}`);
	fs.mkdirSync(workdir, { recursive: true });
	fs.mkdirSync(path.join(workdir, "lib"), { recursive: true });
	// Real covered files so the round fingerprint tracks their mtimes.
	fs.writeFileSync(path.join(workdir, "lib", "engine.js"), "export const engine = 1;\n", "utf8");
	fs.writeFileSync(path.join(workdir, "lib", "report.js"), "export const report = 1;\n", "utf8");
	initState(workdir);
	const { run } = startRun(workdir, { topic: `r${counter}`, skill: "plan-small", requestText: "demo" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	fs.writeFileSync(planPath, PLAN, "utf8");
	mutateCheckpoint(workdir, run.run_id, (cp) =>
		applyExecutionApproved(
			applyPlanWritten({ ...cp, nextAction: "accept-execute" }, planIdentityOf(planPath, 1)),
			{ plan: planIdentityOf(planPath, 1), worktree: workdir, headAtApproval: null, approvedAt: cp.updatedAt },
		),
	);
	return { workdir, planPath, runId: run.run_id };
}

function makeCtx(workdir: string, mode: "print" | "tui" = "print", customOpens?: { count: number }) {
	const entries: Array<{ customType: string; data?: unknown; content?: string }> = [];
	const ctx = {
		cwd: workdir,
		sessionManager: {},
		hasUI: true,
		mode,
		entries,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			// Minimal overlay host: counts ui.custom opens (one per controller).
			custom: () => {
				if (customOpens) customOpens.count += 1;
				return Promise.resolve();
			},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as never;
	setMessagingApi({
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendMessage: (message: { customType: string; content: string }) => entries.push({ customType: message.customType, content: message.content }),
	} as never);
	return ctx;
}

async function startTerminal(planPath: string, workdir: string) {
	const ctx = makeCtx(workdir);
	await startExecution(ctx, { planPath, planTasks: (await import("../src/plan.ts")).parsePlanTasks(PLAN), items: (await import("../src/plan.ts")).parseChecklist(PLAN) });
	for (const id of ["Task-1", "Task-2"]) {
		applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
		persistTaskProgress(ctx);
	}
	return ctx;
}

/** A runner whose rounds the test resolves by hand. */
function controlledRunner() {
	const pending: Array<(value: { round: number; passed: string[]; failed: string[]; undeterminable: string[]; report: string } | null) => void> = [];
	let calls = 0;
	const runner = async () => {
		calls += 1;
		return new Promise<{ round: number; passed: string[]; failed: string[]; undeterminable: string[]; report: string } | null>((resolve) => pending.push(resolve));
	};
	const resolveRound = (value: Parameters<typeof pending[0]>[0]) => {
		const resolve = pending.shift();
		if (resolve) resolve(value);
	};
	/** Resolve every still-pending round (teardown: the identity guard discards them). */
	const drainAll = (value: Parameters<typeof pending[0]>[0] = null) => {
		while (pending.length > 0) pending.shift()!(value);
	};
	return { runner, resolveRound, drainAll, calls: () => calls };
}

/** Let the engine chain advance one step without awaiting its completion. */
const tick = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("execution-review loop (v0.8)", () => {
	it("tui/rpc detach: the settle returns before the round resolves, status becomes verifying", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const ctxTui = makeCtx(workdir, "tui");
		await restoreFromSession(ctxTui, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		// The restore returned while the round is STILL running: in-flight marker
		// present, run status moved to verifying, no outcome committed yet.
		assert.ok(getExecution()!.review.inFlight, "the round is in flight after the settle returned");
		assert.equal(getExecution()!.audit.rounds, 0, "no budget spent yet");
		assert.equal(getRun(workdir, runId)?.status, "verifying", "run status enters verifying");
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" });
		await __awaitReviewRoundForTests();
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "completed", "the round completes the run after resolution");
		__setAuditRunnerForTests(null);
	});

	it("print/json keep the inline await: the settle returns only after the round commits", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const ctxPrint = makeCtx(workdir, "print");
		const restoring = restoreFromSession(ctxPrint, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick(); // the inline round spawns
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" });
		await restoring;
		// Inline: by the time restoreFromSession returned, the round committed —
		// and a passing round completes (clearing execution state).
		assert.equal(getExecution(), null, "the inline round committed before the settle returned");
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "completed");
		assert.equal(ctl.calls(), 1);
		__setAuditRunnerForTests(null);
	});

	it("a cancelled round burns no budget, sends no wake, and pauses nothing", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		__setAuditRunnerForTests(async () => ({ cancelled: true }) as never);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const ex = getExecution()!;
		assert.equal(ex.audit.rounds, 0, "cancelled rounds burn no budget");
		assert.equal(ex.stall.paused, false, "cancelled rounds do not pause");
		assert.equal(ctx.entries.filter((e) => String(e.customType).startsWith("pi-plans-audit-")).length, 0, "no wake, no report message");
		await stopExecution(ctx, "teardown");
	});

	it("fingerprint change discards the attempt, re-runs without budget burn, and both report files survive", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick(); // the inline round spawns
		// Mutate a covered file while the round is in flight (real mutation path).
		const engine = path.join(workdir, "lib", "engine.js");
		fs.writeFileSync(engine, "export const engine = 2;\n", "utf8");
		const later = new Date(Date.now() + 10_000);
		fs.utimesSync(engine, later, later);
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "stale verdict" });
		await tick();
		// Attempt 1 discarded (report on disk, marked), attempt 2 committed the pass.
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "fresh verdict" });
		await restoring;
		await __awaitReviewRoundForTests();
		// Attempt 1 discarded (report on disk, marked), attempt 2 committed the pass.
		const ex = getExecution();
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "completed");
		const runDir = path.join(workdir, ".git", "pi-plans", "runs", runId);
		const attempt1 = path.join(runDir, "execution-review", "round-1-attempt-1.md");
		const attempt2 = path.join(runDir, "execution-review", "round-1-attempt-2.md");
		assert.ok(fs.existsSync(attempt1), "the discarded attempt's report survives");
		assert.match(fs.readFileSync(attempt1, "utf8"), /outcome: discarded/);
		assert.match(fs.readFileSync(attempt1, "utf8"), /discarded: fingerprint changed/);
		assert.ok(fs.existsSync(attempt2), "the re-run's report exists beside it");
		assert.match(fs.readFileSync(attempt2, "utf8"), /outcome: passed/);
		assert.equal(ctl.calls(), 2, "one discard plus one re-run");
		assert.ok(!ex, "execution completed");
		__setAuditRunnerForTests(null);
	});

	it("two consecutive discards commit as a budget-counting undeterminable round", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const engine = path.join(workdir, "lib", "engine.js");
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		const discard = () => {
			fs.writeFileSync(engine, `export const engine = ${Math.random()};\n`, "utf8");
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(engine, later, later);
		};
		discard();
		ctl.resolveRound({ round: 1, passed: [], failed: [], undeterminable: ["VC-001", "VC-002"], report: "stale 1" });
		await tick();
		assert.equal(getExecution()!.audit.rounds, 0, "the first discard burns nothing");
		discard();
		ctl.resolveRound({ round: 1, passed: [], failed: [], undeterminable: ["VC-001", "VC-002"], report: "stale 2" });
		await tick();
		assert.equal(getExecution()!.audit.rounds, 1, "the second consecutive discard commits as undeterminable (budget spent)");
		assert.deepEqual(getExecution()!.audit.undeterminable, ["VC-001", "VC-002"]);
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
		await restoring;
		await __awaitReviewRoundForTests();
		__setAuditRunnerForTests(null);
	});

	it("a failed round rolls back, returns the run to executing, and wakes exactly once", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001"], failed: ["VC-002"], undeterminable: [], report: "VC-002 is not satisfied" });
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(getRun(workdir, runId)?.status, "executing", "rollback returns the run to executing for repair");
		assert.equal(ex.tasks.find((t) => t.id === "Task-2")?.status, "pending", "the failed check's task rolled back");
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1, "exactly one wake per committed failed outcome");
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "executing", "checkpoint phase stays executing across the round");
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("a second restore aborts the previous in-flight round; never two live rounds on one run", async () => {
		const { workdir, planPath } = freshWorkdir();
		await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const ctx = makeCtx(workdir, "tui");
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const firstAttempt = getExecution()!.review.attempts;
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const after = getExecution()!;
		assert.ok(after.review.inFlight, "the second resume started its own round");
		assert.equal(after.review.attempts, 1, "the replacement identity starts its own attempt 1 (the old round was aborted)");
		assert.notEqual(after.review.inFlight.controller, undefined, "exactly one live round — its abort lifecycle is owned");
		// The aborted first round resolves late against a replaced identity: it
		// must be discarded silently (no extra wake, no budget charge).
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "late stale round" });
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "fresh round" });
		await __awaitReviewRoundForTests();
		assert.equal(ctx.entries.filter((e) => e.customType === "pi-plans-complete").length, 1, "the run completed exactly once");
		__setAuditRunnerForTests(null);
	});

	it("every attempt opens a fresh overlay; the reopen shortcut is inert with no in-flight round", async () => {
		const { workdir, planPath } = freshWorkdir();
		await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const opens = { count: 0 };
		const ctx = makeCtx(workdir, "tui", opens);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		assert.equal(opens.count, 1, "the round opened its overlay before spawning");
		// ESC closed the (one-shot) controller; the reopen shortcut rebuilds it
		// from engine-held lane state while the round is still in flight.
		const { reopenReviewOverlay } = await import("../src/exec.ts");
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 2, "reopen builds a fresh controller for the same round");
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "done" });
		await __awaitReviewRoundForTests();
		// No round in flight → the shortcut is inert.
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 2, "reopen is inert with no in-flight round");
		__setAuditRunnerForTests(null);
	});

	it("a legacy cap pause (old prefix) survives restore paused at its round count", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		await startTerminal(planPath, workdir);
		// Simulate a checkpoint paused by a v0.7 build ("completion audit
		// exhausted 3 rounds") — the dual-matched prefix must keep it paused.
		mutateCheckpoint(workdir, runId, (cp) =>
			applyExecutionProgress(cp, { audit: { rounds: 3, lastResult: "VC-001" }, pausedReason: "completion audit exhausted 3 rounds (failed: VC-001)." }),
		);
		const load = await import("../src/exec.ts");
		const result = load.loadExecutionFromCheckpoint(makeCtx(workdir), runId);
		assert.equal(result.status, "loaded", `checkpoint loads (${result.status})`);
		const ex = getExecution()!;
		assert.equal(ex.stall.paused, true, "a legacy cap pause stays paused across restore");
		assert.equal(ex.audit.rounds, 3, "the legacy round count survives — restore grants no budget");
		await stopExecution(makeCtx(workdir), "teardown");
	});
});
