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

function makeCtx(workdir: string, mode: "print" | "tui" = "print", customOpens?: { count: number }, components?: RefineOverlayComponent[]) {
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
			// Minimal overlay host: counts ui.custom opens (one per controller)
			// and captures the rendered component so tests can drive its input.
			custom: (render: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput(data: string): void }) => {
				if (customOpens) customOpens.count += 1;
				const component = render({ requestRender() {}, terminal: undefined }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, undefined, () => {});
				if (components) components.push(component);
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
		const components: Array<{ handleInput(data: string): void }> = [];
		const ctx = makeCtx(workdir, "tui", opens, components);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		assert.equal(opens.count, 1, "the round opened its overlay before spawning");
		// ESC closed the (one-shot) controller — only THEN may reopen rebuild it
		// (the anti-stacking guard keeps a second overlay off a live one).
		components[0]!.handleInput("\x1b");
		const { reopenReviewOverlay } = await import("../src/exec.ts");
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 2, "reopen builds a fresh controller for the same round after ESC");
		// A second reopen while the new controller is live must NOT stack.
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 2, "reopen never stacks a second live overlay");
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

describe("findings-driven fix loop (v0.9)", () => {
	const finding = (id: string, severity: "high" | "medium" | "low", taskIds: string[], extra: Partial<{ note: string; proposedTask: string }> = {}) => ({
		id, severity, taskIds, note: extra.note ?? `${id} note`, evidence: "src/lib", raw: `- \` ${id}\` raw`,
		...(extra.proposedTask ? { proposedTask: extra.proposedTask } : {}),
	});

	it("all VCs pass but a mapped high finding blocks completion: rollback + exactly one wake + NOT done", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "ok but findings", findings: [finding("F-001", "high", ["Task-2"])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.ok(ex, "high findings never complete the run (liveness)");
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "executing");
		assert.equal(getRun(workdir, runId)?.status, "executing", "back to executing for the fix round");
		assert.equal(ex.tasks.find((t) => t.id === "Task-2")?.status, "pending", "the high finding's mapped task rolled back");
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1, "exactly one wake");
		assert.match(String(wakes[0].content), /1 high-severity finding/);
		assert.match(String(wakes[0].content), /F-001/);
		assert.match(String(wakes[0].content), /Full round report: /, "the wake references the round report path");
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});

	it("keep-done asymmetry: a pure-high rollback keeps earlier VC passes; a VC-fail rollback invalidates", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		// Round 1: VC-001 passes, VC-002 passes, but F-001 (high) maps to Task-1 —
		// which VC-001 covers. The high rollback must NOT clear VC-001's done.
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-001", "high", ["Task-1"])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(ex.items.find((i) => i.id === "VC-001")?.done, true, "pure-high rollback keeps the earlier pass");
		assert.equal(ex.tasks.find((t) => t.id === "Task-1")?.status, "pending", "mapped task reopened");
		await stopExecution(ctx, "teardown");
		ctl.drainAll();

		// Contrast: a VC-fail rollback invalidates checks covering the reopened task.
		const second = freshWorkdir();
		const ctx2 = await startTerminal(second.planPath, second.workdir);
		const ctl2 = controlledRunner();
		__setAuditRunnerForTests(ctl2.runner);
		const restoring2 = restoreFromSession(ctx2, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl2.resolveRound({ round: 1, passed: ["VC-001"], failed: ["VC-002"], undeterminable: [], report: "r1" });
		await restoring2;
		await __awaitReviewRoundForTests();
		const ex2 = getExecution()!;
		assert.equal(ex2.items.find((i) => i.id === "VC-001")?.done, true, "unrelated pass kept");
		assert.equal(ex2.tasks.find((t) => t.id === "Task-2")?.status, "pending", "failed check's task rolled back");
		await stopExecution(ctx2, "teardown");
		ctl2.drainAll();
	});

	it("undeterminable round carrying a high finding still wakes (high wins over self-schedule)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: [], failed: [], undeterminable: ["VC-001", "VC-002"], report: "unreadable", findings: [finding("F-001", "high", ["Task-1"])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1, "the high branch wakes despite all-undeterminable verdicts");
		const ex = getExecution()!;
		assert.equal(ex.tasks.find((t) => t.id === "Task-1")?.status, "pending", "mapped task reopened");
		assert.deepEqual(ex.audit.undeterminable, ["VC-001", "VC-002"], "undeterminable set still recorded");
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});

	it("an unmapped high appends a plan task (proposed-task applied mechanically) and wakes once", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-009", "high", [], { proposedTask: "harden the retry budget guard" })] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		const amended = ex.tasks.find((t) => t.id === "Task-3");
		assert.ok(amended, "the unmapped high gained an appended task");
		assert.equal(amended.status, "pending");
		assert.match(amended.title, /fix F-009: harden the retry budget guard/);
		assert.match(amended.title, /appended by execution review round 1/);
		const planText = fs.readFileSync(planPath, "utf8");
		assert.match(planText, /- `Task-3`: fix F-009: harden the retry budget guard/, "the plan file carries the appended bullet");
		assert.match(planText, /## Verification Checks/, "the plan stays parseable (section intact)");
		const cp = loadCheckpoint(workdir, runId).checkpoint;
		assert.ok(cp.execution?.tasks?.["Task-3"], "checkpoint carries the appended task");
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1);
		assert.match(String(wakes[0].content), /Tasks appended to the plan for unmapped findings: Task-3/);
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});

	it("completion with residual medium/low findings summarizes them in the completion message", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "clean", findings: [finding("F-002", "medium", []), finding("F-003", "low", ["Task-1"])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "no high findings: the run completes");
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "completed");
		const done = ctx.entries.filter((e) => e.customType === "pi-plans-complete");
		assert.equal(done.length, 1);
		assert.match(String(done[0].content), /Recorded findings that did not block completion: F-002 \(medium\), F-003 \(low\)/);
		ctl.drainAll();
	});

	it("findings persist across the session snapshot and survive the fresh-budget renewal", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001"], failed: [], undeterminable: ["VC-002"], report: "r1", findings: [finding("F-001", "high", ["Task-2"])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(ex.audit.findings.length, 1, "findings in live state");
		// The snapshot round-trip: a session restore rebuilds them.
		const restored = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		await restored;
		assert.deepEqual(getExecution()!.audit.findings.map((f: { id: string }) => f.id), ["F-001"], "findings survive the session restore");
		// Renewal: /plans-execute grants a fresh budget and keeps the findings.
		const { resumeActiveExecution } = await import("../src/exec.ts");
		// Drive rounds 2-5 through the real path: fix, re-close, settle (restore
		// is the settle entry in these tests) — the same high persists each time.
		for (let r = 2; r <= 5; r++) {
			for (const id of ["Task-1", "Task-2"]) {
				applyTaskUpdate(getExecution()!.tasks, id, "complete", `fix round ${r}`);
			}
			persistTaskProgress(ctx);
			const settle = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
			await tick();
			ctl.resolveRound({ round: r, passed: [], failed: [], undeterminable: [], report: `r${r}`, findings: [finding("F-001", "high", ["Task-2"])] } as never);
			await settle;
			await __awaitReviewRoundForTests();
		}
		// Round 5 committed with the high: the next terminal cycle hits the cap.
		for (const id of ["Task-1", "Task-2"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", "post-cap close");
		}
		persistTaskProgress(ctx);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const paused = getExecution()!;
		assert.equal(paused.stall.paused, true, "the cap pause fired");
		assert.match(String(paused.stall.pausedReason), /high findings: F-001/, "the pause reason names the high findings");
		assert.match(String(paused.stall.pausedReason), /execution review exhausted 5 rounds/, "the pause prefix phrase survives");
		// Cancelled rounds burn no budget and loop nowhere — safe to leave the
		// runner in this mode while checking the renewal semantics.
		__setAuditRunnerForTests(async () => ({ cancelled: true }) as never);
		assert.ok(resumeActiveExecution(ctx), "renewal lifts the pause");
		assert.equal(getExecution()!.audit.rounds, 0, "fresh budget");
		assert.deepEqual(getExecution()!.audit.findings.map((f: { id: string }) => f.id), ["F-001"], "stable ids carry into the fresh budget");
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
	});
});

describe("mixed and hygiene rounds (v0.9.1 F-004/F-006/F-007/F-012)", () => {
	it("a round with a failed check AND a high finding rolls back the union once and wakes exactly once (F-007)", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		// VC-001 fails (covers Task-1) and F-001 also maps to Task-1: the union
		// must dedupe to one reopen of Task-1 plus Task-2 (VC-002 stays passed).
		ctl.resolveRound({ round: 1, passed: ["VC-002"], failed: ["VC-001"], undeterminable: [], report: "mixed", findings: [{ id: "F-001", severity: "high", taskIds: ["Task-1"], note: "n", evidence: "e", raw: "r" }] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(ex.tasks.find((t) => t.id === "Task-1")?.status, "pending", "Task-1 reopened once by both channels");
		assert.equal(ex.tasks.find((t) => t.id === "Task-2")?.status, "complete", "the passing check's task stays closed");
		assert.equal(ex.items.find((i) => i.id === "VC-002")?.done, true, "unrelated pass kept");
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1, "one wake for the mixed round");
		assert.match(String(wakes[0].content), /and failed checks: VC-001/);
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "executing");
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});

	it("a pure VC-fail round keeps the v0.8 lead — never '0 high-severity findings' (F-004)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001"], failed: ["VC-002"], undeterminable: [], report: "vc2 broken" });
		await restoring;
		await __awaitReviewRoundForTests();
		const wake = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wake.length, 1);
		assert.doesNotMatch(String(wake[0].content), /0 high-severity finding/);
		assert.doesNotMatch(String(wake[0].content), /High findings:\n\(none/);
		assert.match(String(wake[0].content), /round 1 failed\*\* — checks: VC-002/);
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});

	it("the appended bullet carries its wave tail and sanitizes reviewer text (F-006/F-012)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [{ id: "F-009", severity: "high", taskIds: [], proposedTask: "harden — the retry; budget guard", note: "n", evidence: "e", raw: "r" }] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		const appended = ex.tasks.find((t) => t.id === "Task-3");
		assert.ok(appended, "task appended");
		const planText = fs.readFileSync(planPath, "utf8");
		const bullet = planText.split("\n").find((l) => l.startsWith("- `Task-3`:"))!;
		assert.match(bullet, /— wave: \d+$/, "the bullet carries the wave tail");
		// Re-parse restores the same wave the live tree assigned (not wave 1).
		const reparse = (await import("../src/plan.ts")).parsePlanTasks(planText);
		const flat = reparse.tasks.flatMap(function walk(t: { children: unknown[] }) { return [t, ...t.children]; } as never) as never[];
		const reparsed = flat.find((t: { id: string }) => t.id === "Task-3") as { wave: number; title: string; files: string[] };
		assert.equal(reparsed.wave, appended.wave, "re-parse restores the live wave");
		// Sanitized: em dash -> hyphen, ';' -> ',', no forged fields.
		assert.ok(!/—|—/.test(reparsed.title.split("(appended")[0]), "em dashes sanitized out of the reviewer text");
		assert.equal(reparsed.files.length, 0, "no fields forged from reviewer text");
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});
});

describe("no-report rounds preserve findings (v0.9.1 F-001)", () => {
	const finding = (id: string) => ({ id, severity: "high" as const, taskIds: ["Task-2"], note: `${id} note`, evidence: "e", raw: "r" });

	it("a spawn-failure round never vacuously completes a run with an unresolved high", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		// Round 1: both VCs pass, one mapped high -> rollback + wake.
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-001")] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const wakesAfterR1 = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed").length;
		// The executor fixes and re-closes; the settle starts round 2.
		for (const id of ["Task-1", "Task-2"]) applyTaskUpdate(getExecution()!.tasks, id, "complete", "fixed");
		persistTaskProgress(ctx);
		const settle = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		// Round 2's subagent FAILS (null outcome): findings must be preserved,
		// no completion, no second wake — the loop self-schedules. The inline
		// settle chain stays pending through the self-scheduled round 3, so
		// resolve round 3 BEFORE awaiting the settle.
		ctl.resolveRound(null);
		await tick();
		const ex = getExecution()!;
		assert.ok(ex, "a spawn-failure round never completes the run");
		assert.deepEqual(ex.audit.findings.map((f: { id: string }) => f.id), ["F-001"], "unresolved findings survive the no-report round");
		assert.equal(ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed").length, wakesAfterR1, "no extra wake on the no-report round");
		// Round 3 spawned (self-schedule) and reports the fix — now it completes.
		ctl.resolveRound({ round: 3, passed: [], failed: [], undeterminable: [], report: "fixed", findings: [] } as never);
		await settle;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "a clean re-report completes");
		ctl.drainAll();
	});

	it("the two-consecutive-discard synthesis preserves findings instead of clearing them", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-001")] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const engine = path.join(workdir, "lib", "engine.js");
		const discard = () => {
			fs.writeFileSync(engine, `export const engine = ${Math.random()};\n`, "utf8");
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(engine, later, later);
		};
		// Re-close, settle, then two fingerprint discards -> the synthesized
		// commit must carry the previous findings forward, not wipe them.
		for (const id of ["Task-1", "Task-2"]) applyTaskUpdate(getExecution()!.tasks, id, "complete", "fixed");
		persistTaskProgress(ctx);
		const settle = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		discard();
		ctl.resolveRound({ round: 2, passed: [], failed: [], undeterminable: ["VC-001", "VC-002"], report: "stale", findings: [finding("F-001")] } as never);
		await tick();
		discard();
		ctl.resolveRound({ round: 2, passed: [], failed: [], undeterminable: ["VC-001", "VC-002"], report: "stale", findings: [finding("F-001")] } as never);
		await tick();
		await tick();
		const ex = getExecution()!;
		assert.ok(ex, "the synthesis never completes the run");
		assert.equal(ex.audit.rounds, 2, "the synthesis committed as round 2");
		assert.deepEqual(ex.audit.findings.map((f: { id: string }) => f.id), ["F-001"], "findings preserved through the discard synthesis");
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
		await settle;
		await __awaitReviewRoundForTests();
	});
});

describe("plan amendment re-stamps the checkpoint identity (v0.9.1 F-002)", () => {
	it("an amended plan passes /resume-plans instead of plan-mismatch", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [{ id: "F-009", severity: "high", taskIds: [], proposedTask: "harden the guard", note: "n", evidence: "e", raw: "r" }] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.ok(ex.tasks.find((t) => t.id === "Task-3"), "the amendment appended Task-3");
		// The checkpoint identity now matches the AMENDED file, with provenance.
		const cp = loadCheckpoint(workdir, runId).checkpoint;
		const { sha256File } = await import("../src/workflow-state.ts");
		assert.equal(cp.plan?.sha256, sha256File(planPath), "identity re-stamped to the amended digest");
		assert.equal(cp.execution?.planAmended?.round, 1);
		assert.equal(cp.execution?.planAmended?.sha256, sha256File(planPath));
		// A later resume accepts the amended plan (no plan-mismatch re-approval).
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
		const { loadExecutionFromCheckpoint } = await import("../src/exec.ts");
		const result = loadExecutionFromCheckpoint(makeCtx(workdir), runId);
		assert.equal(result.status, "loaded", `resume accepts the amended plan (${result.status})`);
		assert.deepEqual(result.findings?.map((f) => f.id), ["F-009"], "the load result surfaces unresolved findings for the resume brief (F-005)");
		await stopExecution(makeCtx(workdir), "post-check teardown");
	});
});

describe("executor injection with findings (v0.9)", () => {
	it("executionContextMessage lists unresolved high findings for the repairing agent", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [{ id: "F-001", severity: "high", taskIds: ["Task-2"], note: "loop misses union", evidence: "e", raw: "r" }] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const { executionContextMessage } = await import("../src/exec.ts");
		const msg = executionContextMessage(ctx) ?? "";
		assert.match(msg, /unresolved high-severity findings/);
		assert.match(msg, /- F-001 \(Task-2\): loop misses union/);
		assert.match(msg, /Fix them, then re-close the affected tasks/);
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});
});
