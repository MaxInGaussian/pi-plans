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
	EXECUTION_BLOCKED_CUSTOM_TYPE,
	EXECUTION_CONTINUE_CUSTOM_TYPE,
	executionContextMessage,
	getExecution,
	persistTaskProgress,
	registerExecutionTurnHandlers,
	restoreFromSession,
	startExecution,
	stopExecution,
} from "../src/exec.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { applyTaskUpdate } from "../src/task-tool.ts";
import { buildTaskView } from "../src/tasks.ts";
import { spawnSync } from "node:child_process";
import { getRun, initState, setRunStatus, startRun } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint, applyExecutionApproved, applyExecutionProgress, applyPlanWritten, planIdentityOf, resolveHeadAt } from "../src/workflow-state.ts";

import { loadExecutionFromCheckpoint } from "../src/exec.ts";
import { fleet } from "../src/agent-fleet.ts";
import { fleetUi } from "../src/fleet-ui.ts";

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

function makeCtx(workdir: string, mode: "print" | "tui" = "print", customOpens?: { count: number }, components?: Array<{ handleInput(data: string): void }>) {
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
			onTerminalInput: () => () => undefined,
			getEditorText: () => "",
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			// Minimal overlay host: counts ui.custom opens and captures the
			// rendered component so tests can drive its input. The overlay
			// stays "open" until its component calls done().
			custom: (render: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput(data: string): void }) => {
				if (customOpens) customOpens.count += 1;
				return new Promise<void>((resolve) => {
					const component = render({ requestRender() {}, terminal: undefined }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, undefined, () => resolve());
					if (components) components.push(component);
				});
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
		// v0.9.3: a TUI host gets the budget select menu before round 1; this minimal
		// host resolves it without a choice, so one hop passes before the round
		// spawns. The detach contract itself is unchanged.
		await tick();
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
		// v0.9.3: the first restore resolves the budget (one hop) before its
		// round spawns; wait for it so the second restore really replaces a
		// LIVE round.
		await tick();
		const firstAttempt = getExecution()!.review.attempts;
		assert.equal(firstAttempt, 1, "the first round is in flight before the second restore");
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

	it("the round is one fleet agent; the reopen shortcut opens its overlay once and never stacks", async () => {
		const { workdir, planPath } = freshWorkdir();
		await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		fleet.clear();
		fleetUi.detach();
		const opens = { count: 0 };
		const components: Array<{ handleInput(data: string): void }> = [];
		const ctx = makeCtx(workdir, "tui", opens, components);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const auditors = fleet.list().filter((entry) => entry.role === "auditor");
		assert.equal(auditors.length, 1, "the round registered one auditor agent before spawning");
		assert.equal(opens.count, 0, "the list does not pop an overlay on its own");
		const { reopenReviewOverlay } = await import("../src/exec.ts");
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 1, "the shortcut opens the round's overlay");
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 1, "reopen never stacks a second live overlay");
		components[0]!.handleInput("\x1b"); // Esc closes it
		await tick();
		reopenReviewOverlay(ctx);
		assert.equal(opens.count, 2, "after Esc the shortcut can open it again");
		components[1]!.handleInput("\x1b");
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "done" });
		await __awaitReviewRoundForTests();
		assert.equal(fleet.list().find((entry) => entry.role === "auditor")?.lane.status, "complete", "the finished round stays readable in the list");
		__setAuditRunnerForTests(null);
		fleetUi.detach();
		fleet.clear();
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

	it("a medium/low-only round grants the non-high repair cycle instead of completing", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "clean", findings: [finding("F-002", "medium", []), finding("F-003", "low", ["Task-1"])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		assert.ok(getExecution(), "medium/low findings keep the run open for the repair cycle");
		assert.equal(getExecution()!.reviewNonHighRepair, "granted", "the one-shot is marked granted");
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.execution?.reviewNonHighCredits, 1, "the checkpoint carries the derived credit");
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1, "exactly one wake for the cycle");
		assert.match(String(wakes[0].content), /single non-high repair cycle/);
		assert.match(String(wakes[0].content), /F-002 \(medium\)/);
		assert.match(String(wakes[0].content), /F-003 \(low\)/);
		assert.match(String(wakes[0].content), /deferred: <reason>/);
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
	});

	it("findings persist across the session snapshot and survive the fresh-budget renewal", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		// v0.9.3: this test drives rounds 1..5 on purpose — pin the 5-round
		// budget (the no-UI default is now 3).
		getExecution()!.reviewBudget = 5;
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
		// v0.9.3: the resume is async and reports the outcome; this ctx has no
		// menu, so the headless path re-grants the same budget (5).
		const renewed = await resumeActiveExecution(ctx);
		assert.ok(renewed.resumed, "renewal lifts the pause");
		assert.equal(renewed.grantedBudget, 5, "the headless grant keeps the current budget");
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

/**
 * v0.9.2 blocked-point escalation (RCA: a missed parent re-close left the tree
 * non-terminal, the review could not start, and three silent no-op wakes
 * paused the run with a watchdog metric instead of the blocker).
 */
const PARENT_PLAN = `# PLAN_v1 - blocked fixture

## Tasks

- Task-1: engine — files: lib/engine.js; wave: 1
- Task-2: host — files: lib/host.js; wave: 1
  - Task-2.1: daemon wiring — files: lib/host.js

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: engine works; evidence: tests; metric: green.
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: host works; evidence: tests; metric: green.
`;

describe("blocked-point escalation (v0.9.2)", () => {
	let root = "";
	let counter = 0;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-blocked-"));
	});

	after(() => {
		fs.rmSync(root, { recursive: true, force: true });
		__setAuditRunnerForTests(null);
	});

	function freshParentWorkdir(): { workdir: string; planPath: string; runId: string } {
		counter += 1;
		const workdir = path.join(root, `blocked-${counter}`);
		fs.mkdirSync(path.join(workdir, "lib"), { recursive: true });
		fs.writeFileSync(path.join(workdir, "lib", "engine.js"), "export const engine = 1;\n", "utf8");
		fs.writeFileSync(path.join(workdir, "lib", "host.js"), "export const host = 1;\n", "utf8");
		initState(workdir);
		const { run } = startRun(workdir, { topic: `blocked${counter}`, skill: "plan-small", requestText: "demo" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(planPath, PARENT_PLAN, "utf8");
		mutateCheckpoint(workdir, run.run_id, (cp) =>
			applyExecutionApproved(
				applyPlanWritten({ ...cp, nextAction: "accept-execute" }, planIdentityOf(planPath, 1)),
				{ plan: planIdentityOf(planPath, 1), worktree: workdir, headAtApproval: null, approvedAt: cp.updatedAt },
			),
		);
		return { workdir, planPath, runId: run.run_id };
	}

	/** ctx + event driver (pattern: tests/exec.test.ts wireEvents, 677-690). */
	function makeHarness(workdir: string) {
		const entries: Array<{ customType: string; data?: unknown; content?: string; display?: boolean }> = [];
		const ctx = {
			cwd: workdir,
			sessionManager: {},
			hasUI: true,
			mode: "tui",
			entries,
			ui: {
				notify: () => {},
				setStatus: () => {},
				setWidget: () => {},
				theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			},
			isIdle: () => true,
			hasPendingMessages: () => false,
		} as never;
		setMessagingApi({
			appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
			sendMessage: (message: { customType: string; content: string; display?: boolean }) => entries.push({ customType: message.customType, content: message.content, display: message.display }),
		} as never);
		const handlers = new Map<string, Array<(event: unknown, c: never) => unknown>>();
		const ext = {
			on: (name: string, fn: (event: unknown, c: never) => unknown) => {
				const list = handlers.get(name) ?? [];
				list.push(fn);
				handlers.set(name, list);
			},
		} as never;
		registerExecutionTurnHandlers(ext);
		return {
			ctx,
			entries,
			async fire(name: string, event: unknown = {}) {
				for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
			},
			/** One idle executor round that never touched a task or tool. */
			async idleRound() {
				await this.fire("agent_start");
				await this.fire("turn_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1 } } });
				await this.fire("agent_settled");
			},
		};
	}

	it("names the missed parent, escalates before pausing, and clears on the parent re-close", async () => {
		const { workdir, planPath, runId } = freshParentWorkdir();
		const harness = makeHarness(workdir);
		const ctx = harness.ctx;
		await startExecution(ctx, { planPath, planTasks: parsePlanTasks(PARENT_PLAN), items: parseChecklist(PARENT_PLAN) });
		// First pass: everything closed (children before the parent).
		for (const id of ["Task-2.1", "Task-2", "Task-1"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		// Round 1 fails VC-002 -> Task-2 + Task-2.1 roll back.
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001"], failed: ["VC-002"], undeterminable: [], report: "VC-002 fails" });
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(ex.audit.rounds, 1);
		assert.deepEqual(ex.blocked?.rolledBack.sort(), ["Task-2", "Task-2.1"], "the authoritative rollback set is captured at commit time");
		assert.deepEqual(ex.blocked?.tasks.sort(), ["Task-2", "Task-2.1"]);
		assert.deepEqual(loadCheckpoint(workdir, runId).checkpoint.execution?.blocked?.tasks.sort(), ["Task-2", "Task-2.1"], "the blocker is persisted");
		// The executor re-closes the CHILD only — the lattice-code shape.
		applyTaskUpdate(ex.tasks, "Task-2.1", "complete", "wiring fixed");
		persistTaskProgress(ctx);
		assert.deepEqual(getExecution()!.blocked?.tasks, ["Task-2"], "closing the child does not close the parent");
		assert.deepEqual(loadCheckpoint(workdir, runId).checkpoint.execution?.blocked?.tasks, ["Task-2"]);

		// Blocked wake 1: escalated wording + one visible system line.
		await harness.idleRound();
		assert.equal(getExecution()!.blocked?.escalatedRounds, 1);
		const wake1 = harness.entries.filter((e) => e.customType === EXECUTION_CONTINUE_CUSTOM_TYPE).at(-1)?.content ?? "";
		assert.match(wake1, /Review: NO round is running — the task tree is not terminal, so the review cannot start/);
		assert.match(wake1, /BLOCKED — 1 task\(s\) reopened by round 1 are still open:/);
		assert.match(wake1, /- Task-2 \(reopened by round 1\)/);
		assert.match(wake1, /Closing a child does NOT close its parent/);
		assert.match(wake1, /blocked wake 1\/3/);
		const visible1 = harness.entries.filter((e) => e.customType === EXECUTION_BLOCKED_CUSTOM_TYPE);
		assert.equal(visible1.length, 1, "one visible escalation line");
		assert.equal(visible1[0]!.display, true);
		assert.match(visible1[0]!.content ?? "", /execution blocked \(wake 1\/3\)/);

		// Blocked wake 2: still no change -> escalate, still no pause.
		await harness.idleRound();
		assert.equal(getExecution()!.blocked?.escalatedRounds, 2);
		assert.equal(getExecution()!.stall.paused, false, "escalation precedes the pause");
		assert.equal(harness.entries.filter((e) => e.customType === EXECUTION_BLOCKED_CUSTOM_TYPE).length, 2);
		const wake2 = harness.entries.filter((e) => e.customType === EXECUTION_CONTINUE_CUSTOM_TYPE).at(-1)?.content ?? "";
		assert.match(wake2, /blocked wake 2\/3/);

		// Blocked wake 3: the watchdog pauses with the BLOCKER as the reason.
		await harness.idleRound();
		assert.equal(getExecution()!.stall.paused, true, "the third blocked wake pauses");
		const reason = getExecution()!.stall.pausedReason ?? "";
		assert.match(reason, /^blocked: review round 2 cannot start/);
		assert.match(reason, /Task-2/);
		assert.match(reason, /reopened by round 1/);
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.execution?.pausedReason, reason, "the pause reason is persisted");
		// Levels 1 and 2 emit the visible line; the cap levels pauses instead of
		// waking, and the pause carries the blocker in the pause row/notify.
		assert.equal(harness.entries.filter((e) => e.customType === EXECUTION_BLOCKED_CUSTOM_TYPE).length, 2);
		// The cap-pause prefix matching must not see a review-cap pause here.
		await harness.fire("input", { source: "interactive" });
		assert.equal(getExecution()!.stall.paused, false, "ordinary input resumes a blocked pause");
		assert.equal(getExecution()!.blocked?.escalatedRounds, 0, "a resume grants a fresh ladder");

		// Re-closing the parent clears the blocker and the review starts by itself.
		applyTaskUpdate(getExecution()!.tasks, "Task-2", "complete", "host fixed");
		persistTaskProgress(ctx);
		assert.equal(getExecution()!.blocked, null);
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.execution?.blocked, undefined, "the record is dropped, not left stale");
		// The very next settled round launches round 2 by itself (turn_end owns
		// the terminal-but-unaudited state — no wake, no user input).
		const settled = harness.fire("turn_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1 } } });
		await tick();
		assert.equal(ctl.calls(), 2, "round 2 spawned from the settle, not from a wake");
		ctl.resolveRound({ round: 2, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" });
		await settled;
		await __awaitReviewRoundForTests();
		assert.equal(loadCheckpoint(workdir, runId).checkpoint.phase, "completed", "the review ran once the tree became terminal");
		__setAuditRunnerForTests(null);
		ctl.drainAll();
	});
	it("real progress resets the ladder instead of hardening the wording (round-1 F-001)", async () => {
		const { workdir, planPath, runId } = freshParentWorkdir();
		const harness = makeHarness(workdir);
		const ctx = harness.ctx;
		await startExecution(ctx, { planPath, planTasks: parsePlanTasks(PARENT_PLAN), items: parseChecklist(PARENT_PLAN) });
		for (const id of ["Task-2.1", "Task-2", "Task-1"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001"], failed: ["VC-002"], undeterminable: [], report: "VC-002 fails" });
		await restoring;
		await __awaitReviewRoundForTests();
		// Both reopened tasks stay open: one no-progress blocked wake.
		await harness.idleRound();
		assert.equal(getExecution()!.blocked?.escalatedRounds, 1, "the first blocked wake counts as no progress");
		assert.deepEqual(getExecution()!.blocked?.tasks.sort(), ["Task-2", "Task-2.1"]);
		// The executor closes ONE of the two blockers -> real progress.
		applyTaskUpdate(getExecution()!.tasks, "Task-2.1", "complete", "child fixed");
		persistTaskProgress(ctx);
		assert.deepEqual(getExecution()!.blocked?.tasks, ["Task-2"], "persistTaskProgress re-syncs the STORED list (the reason it cannot be the ladder baseline)");
		await harness.idleRound();
		assert.equal(getExecution()!.blocked?.escalatedRounds, 0, "a shrunken blocker set resets the ladder");
		const wake = harness.entries.filter((e) => e.customType === EXECUTION_CONTINUE_CUSTOM_TYPE).at(-1)?.content ?? "";
		assert.doesNotMatch(wake, /blocked wake/, "the reset wake carries no escalation sentence");
		assert.equal(harness.entries.filter((e) => e.customType === EXECUTION_BLOCKED_CUSTOM_TYPE).length, 1, "no new visible line for a reset");
		// The fresh ladder then counts again: 1, 2, pause at 3.
		await harness.idleRound();
		assert.equal(getExecution()!.blocked?.escalatedRounds, 1);
		await harness.idleRound();
		assert.equal(getExecution()!.blocked?.escalatedRounds, 2);
		await harness.idleRound();
		assert.equal(getExecution()!.stall.paused, true, "three consecutive no-progress wakes still pause");
		assert.match(getExecution()!.stall.pausedReason ?? "", /blocked: review round 2 cannot start/);
		assert.match(loadCheckpoint(workdir, runId).checkpoint.execution?.pausedReason ?? "", /Task-2/);
		await stopExecution(ctx, "teardown");
		ctl.drainAll();
	});

	it("the executor rules forbid waiting and require re-closing parents", async () => {
		const { workdir, planPath } = freshParentWorkdir();
		const harness = makeHarness(workdir);
		await startExecution(harness.ctx, { planPath, planTasks: parsePlanTasks(PARENT_PLAN), items: parseChecklist(PARENT_PLAN) });
		const msg = executionContextMessage(harness.ctx) ?? "";
		assert.match(msg, /PARENTS INCLUDED/);
		assert.match(msg, /Closing a task's children does NOT close the task/);
		assert.match(msg, /NEVER wait for the review/);
		await stopExecution(harness.ctx, "teardown");
	});
});

/**
 * Pre-feature checkpoint backfill (v0.9.2): the lattice-code run was paused by
 * the old build, so its checkpoint has no `execution.blocked` record. The
 * blocker is reconstructed from round 1's `audit.lastResult` + the plan's
 * coverage — without re-applying the rollback (that would revert work the
 * executor has since re-closed).
 */
describe("pre-feature checkpoint backfill (v0.9.2)", () => {
	it("reconstructs the real lattice-code blocker (Task-2, round 1) and persists it", async () => {
		const fixtureDir = path.join(import.meta.dirname, "fixtures", "lattice-code-blocked");
		const planText = fs.readFileSync(path.join(fixtureDir, "plan-v2-trimmed.md"), "utf8");
		const state = JSON.parse(fs.readFileSync(path.join(fixtureDir, "state.json"), "utf8")) as {
			tasks: Record<string, { status: string; evidence?: string; skipReason?: string }>;
			audit: { rounds: number; lastResult: string; undeterminable: string[] };
		};
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-backfill-"));
		spawnSync("git", ["init"], { cwd: workdir });
		spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: workdir });
		spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
		fs.writeFileSync(path.join(workdir, "seed.txt"), "seed", "utf8");
		spawnSync("git", ["add", "-A"], { cwd: workdir });
		spawnSync("git", ["commit", "-m", "seed"], { cwd: workdir });
		initState(workdir);
		const { run } = startRun(workdir, { topic: "lattice-backfill", skill: "plan-small", requestText: "demo" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		const planPath = path.join(run.artifact_dir, "PLAN_v2.md");
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(planPath, planText, "utf8");
		mutateCheckpoint(workdir, run.run_id, (cp) => {
			const plan = planIdentityOf(planPath, 2);
			let next = applyPlanWritten({ ...cp, nextAction: "accept-execute" }, plan);
			next = applyExecutionApproved(next, {
				plan,
				worktree: workdir,
				headAtApproval: resolveHeadAt(workdir),
				approvedAt: next.updatedAt,
			});
			// The REAL slices; deliberately no `blocked` key (pre-feature checkpoint).
			return applyExecutionProgress(next, {
				tasks: state.tasks,
				audit: { rounds: state.audit.rounds, lastResult: state.audit.lastResult, undeterminable: state.audit.undeterminable },
			});
		});
		setRunStatus(workdir, run.run_id, "executing");
		const ctx = makeCtx(workdir, "tui");
		const load = loadExecutionFromCheckpoint(ctx, run.run_id);
		assert.equal(load.status, "loaded");
		assert.deepEqual(load.blocked?.tasks, ["Task-2"], "the real blocker is reconstructed");
		assert.equal(load.blocked?.round, 1);
		assert.ok(load.blocked?.rolledBack.includes("Task-7"), "coverage cascade covers the other tasks of the failed checks");
		assert.ok(load.blocked?.rolledBack.includes("Task-2.1"), "children cascade");
		const persisted = loadCheckpoint(workdir, run.run_id).checkpoint.execution?.blocked;
		assert.deepEqual(persisted?.tasks, ["Task-2"], "the reconstructed blocker is persisted");
		// The tree was NOT re-mutated: the reopened-then-re-closed tasks stay closed.
		const after = loadCheckpoint(workdir, run.run_id).checkpoint.execution?.tasks ?? {};
		assert.equal(after["Task-2"]?.status, "pending");
		assert.equal(after["Task-2.1"]?.status, "complete");
		assert.equal(after["Task-7"]?.status, "complete");
		assert.equal(getExecution()!.blocked?.tasks[0], "Task-2");
		// The /reload recovery path: a session snapshot written by a pre-feature
		// build carries the LIVE failed set (`audit.failed`) and no blocker
		// record — exactly the shape the stuck lattice-code session has.
		const live = getExecution()!;
		const snapshot = { ...live, audit: { ...live.audit, failed: state.audit.lastResult.split(",") } } as Record<string, unknown>;
		delete snapshot.blocked;
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		assert.deepEqual(getExecution()!.blocked?.tasks, ["Task-2"], "a pre-feature session snapshot is backfilled too");
		assert.equal(getExecution()!.blocked?.round, 1);
		await stopExecution(makeCtx(workdir), "teardown");
	});
});

describe("execution-review budget (v0.9.3)", () => {
	const highFinding = (id: string, taskIds: string[] = ["Task-1"]) => ({
		id,
		severity: "high" as const,
		taskIds,
		note: `${id} note`,
		evidence: "lib/engine.js",
		raw: `- \` ${id}\``,
	});

	/** A ctx whose budget menu answers with `choice` (a label prefix), or a
	 * cancelled menu when null. UI.custom is either absent (menu path) or a
	 * no-choice overlay (falls through to the menu). */
	function ctxWithBudgetMenu(workdir: string, choice: string | null, mode: "print" | "tui" = "tui", onAsk?: () => void) {
		const base = makeCtx(workdir, mode);
		const ui = (base as { ui: Record<string, unknown> }).ui;
		return {
			...base,
			ui: {
				...ui,
				select: async (_title: string, options: string[]): Promise<string | undefined> => {
					onAsk?.();
					if (choice === null) return undefined;
					return options.find((option) => option.startsWith(choice)) ?? options[0];
				},
			},
		} as typeof base;
	}

	it("asks for the budget once, right before round 1, and persists the pick", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		let asks = 0;
		const ctx = ctxWithBudgetMenu(workdir, "1 round", "tui", () => {
			asks += 1;
		});
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		const ex = getExecution()!;
		assert.equal(ex.reviewBudget, 1, "the picked budget is live");
		assert.equal(ex.reviewBudgetDefaulted, false, "a user pick is not marked default");
		assert.ok(ex.review.inFlight, "the round spawns right after the pick");
		assert.equal(asks, 1, "the budget menu was asked exactly once");
		const cp = loadCheckpoint(workdir, runId);
		assert.ok(cp.status === "ok");
		assert.equal(cp.checkpoint.execution?.reviewBudget, 1, "the budget is persisted");
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" });
		await restoring;
		await __awaitReviewRoundForTests();
		assert.equal(asks, 1, "no second ask for the same run");
		assert.equal(getExecution(), null, "the passing round completed the run");
		ctl.drainAll();
		__setAuditRunnerForTests(null);
	});

	it("falls back to the default 3 with a visible note when no budget menu exists", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		const ex = getExecution()!;
		assert.equal(ex.reviewBudget, 3, "the no-UI default applies");
		assert.equal(ex.reviewBudgetDefaulted, true, "and it is marked as the fallback");
		const notes = ctx.entries.filter((e) => e.customType === "pi-plans-review-budget-default");
		assert.equal(notes.length, 1, "one visible note, never silent");
		assert.match(String(notes[0].content), /default/);
		assert.match(
			String(notes[0].content),
			/no budget menu is available in this session/,
			"the note names the missing menu surface",
		);
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" });
		await restoring;
		await __awaitReviewRoundForTests();
		ctl.drainAll();
		__setAuditRunnerForTests(null);
	});

	it("completes at an exhausted budget with an unresolved high — no rollback, no append, no wake", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		// One round, then the budget is spent.
		getExecution()!.reviewBudget = 1;
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "pass with a high", findings: [highFinding("F-001")] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "the run completes at the exhausted budget");
		const cp = loadCheckpoint(workdir, runId);
		assert.ok(cp.status === "ok");
		assert.equal(cp.checkpoint.phase, "completed");
		assert.equal(ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed").length, 0, "no fix wake on the tolerated round");
		assert.equal(/Task-4/.test(fs.readFileSync(planPath, "utf8")), false, "no plan task was appended");
		const done = ctx.entries.filter((e) => e.customType === "pi-plans-complete");
		assert.equal(done.length, 1);
		assert.match(String(done[0].content), /review budget exhausted/, "the completion discloses the exhausted budget");
		assert.match(String(done[0].content), /F-001/, "and names the tolerated high finding");
		ctl.drainAll();
		__setAuditRunnerForTests(null);
	});

	it("still wakes and repairs a high finding when the budget is NOT exhausted", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		getExecution()!.reviewBudget = 3;
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "pass with a high", findings: [highFinding("F-001")] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution();
		assert.notEqual(ex, null, "the run does not complete with a live high inside the budget");
		assert.equal(ex!.tasks.find((t) => t.id === "Task-1")?.status, "pending", "the mapped task rolled back");
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
		assert.equal(wakes.length, 1, "exactly one repair wake");
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("unlimited: three identical no-report rounds trip the no-progress valve", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		getExecution()!.reviewBudget = "unlimited";
		// A spawn failure carries no report: the signature must still advance
		// (round-1 F-002) — otherwise the valve could never catch a dead runner.
		__setAuditRunnerForTests(async () => null);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const ex = getExecution()!;
		assert.equal(ex.audit.rounds, 3, "three rounds committed before the valve");
		assert.equal(ex.reviewRoundsTotal, 3, "the cumulative counter agrees");
		assert.equal(ex.stall.paused, true, "the valve pauses the run");
		assert.match(ex.stall.pausedReason ?? "", /^execution review stalled/);
		assert.match(ex.stall.pausedReason ?? "", /3 consecutive rounds/);
		assert.equal(ex.reviewNoProgress?.streak, 3);
		assert.ok(ctx.entries.some((e) => e.customType === "pi-plans-review-paused"), "the pause is in-band");
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("unlimited: the run-cumulative hard cap pauses at 50 rounds", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		getExecution()!.reviewBudget = "unlimited";
		getExecution()!.reviewRoundsTotal = 49;
		__setAuditRunnerForTests(async () => null);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		const ex = getExecution()!;
		assert.equal(ex.reviewRoundsTotal, 50, "the cap counts the whole run");
		assert.equal(ex.stall.paused, true);
		assert.match(ex.stall.pausedReason ?? "", /execution review exhausted 50 rounds/);
		assert.match(ex.stall.pausedReason ?? "", /unlimited budget safety cap/);
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("the at-pause grant re-asks the budget; Esc keeps the pause, an unlimited pick adds 50", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		getExecution()!.reviewBudget = "unlimited";
		getExecution()!.reviewRoundsTotal = 49;
		__setAuditRunnerForTests(async () => null);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		assert.equal(getExecution()!.stall.paused, true, "paused at the hard cap");
		const { resumeActiveExecution } = await import("../src/exec.ts");
		// Esc (cancelled menu) keeps the pause — never a silent grant.
		const declined = await resumeActiveExecution(ctxWithBudgetMenu(workdir, null));
		assert.equal(declined.resumed, false);
		assert.equal(declined.budgetDeclined, true);
		assert.equal(getExecution()!.stall.paused, true, "the pause stands after Esc");
		// Picking unlimited lifts the cap by exactly one window and resets the
		// per-grant counters — the cumulative total never resets.
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const grantingCtx = ctxWithBudgetMenu(workdir, "unlimited");
		const granted = await resumeActiveExecution(grantingCtx);
		assert.equal(granted.resumed, true);
		assert.equal(granted.grantedBudget, "unlimited");
		const ex = getExecution()!;
		assert.equal(ex.reviewCapExtension, 50, "the unlimited grant extends the hard cap");
		assert.equal(ex.audit.rounds, 0, "the per-grant round counter resets");
		assert.equal(ex.reviewRoundsTotal, 50, "the run-cumulative counter does not");
		assert.equal(ex.reviewNoProgress, undefined, "the valve window restarts");
		assert.equal(ex.stall.paused, false, "the run resumed");
		assert.ok(
			grantingCtx.entries.some((e) => e.customType === "pi-plans-review-budget-granted" && /hard cap now 100 rounds/.test(String(e.content))),
			"the grant names the lifted cap",
		);
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("a headless session keeps the default budget and can still be granted at a pause (round-1 F-001)", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		// The SDK's ui.select is REQUIRED, so a real headless context carries a
		// function that cannot ask. This host throws if the code ever calls it.
		const headlessCtx = {
			...ctx,
			hasUI: false,
			ui: {
				...(ctx as { ui: Record<string, unknown> }).ui,
				select: async (): Promise<string | undefined> => {
					throw new Error("headless select must never be called");
				},
			},
		} as typeof ctx;
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(headlessCtx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		await tick();
		const ex = getExecution()!;
		assert.equal(ex.reviewBudget, 3, "a headless session gets the default budget");
		assert.equal(ex.reviewBudgetDefaulted, true, "and it is marked as the fallback");
		assert.ok(ex.review.inFlight, "the round spawned without asking");
		const cp = loadCheckpoint(workdir, runId);
		assert.ok(cp.status === "ok");
		assert.equal(cp.checkpoint.execution?.reviewBudget, 3, "the default is persisted");
		// A cancelled round ends the chain without burning budget or
		// self-scheduling; the next restore then sees an exhausted budget.
		ctl.resolveRound({ cancelled: true } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const live = getExecution()!;
		live.audit.rounds = 3;
		live.reviewRoundsTotal = 3;
		live.audit.failed = ["VC-001"];
		await restoreFromSession(headlessCtx, [{ type: "custom", customType: "pi-plans-exec", data: live }]);
		assert.equal(getExecution()!.stall.paused, true, "an owed review at an exhausted budget pauses");
		const { resumeActiveExecution } = await import("../src/exec.ts");
		const granted = await resumeActiveExecution(headlessCtx);
		assert.equal(granted.resumed, true, "a headless grant is not declined");
		assert.equal(granted.budgetDeclined, undefined, "no menu decline path in a headless session");
		assert.equal(granted.grantedBudget, 3, "the headless grant keeps the current budget");
		assert.equal(getExecution()!.stall.paused, false, "the run resumes instead of staying paused forever");
		assert.equal(getExecution()!.audit.rounds, 0, "and the per-grant counter reset");
		ctl.resolveRound({ cancelled: true } as never);
		await __awaitReviewRoundForTests();
		await stopExecution(headlessCtx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("an auto-approve session never asks for the budget (recorded plan decision)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		// A TUI-capable host: without the auto-approve gate this would ask.
		const answering = ctxWithBudgetMenu(workdir, "1 round", "tui", () => {
			throw new Error("auto-approve must not ask for the budget");
		});
		const previous = process.env.PI_PLANS_AUTO_APPROVE;
		process.env.PI_PLANS_AUTO_APPROVE = "1";
		try {
			const ctl = controlledRunner();
			__setAuditRunnerForTests(ctl.runner);
			const restoring = restoreFromSession(answering, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
			await tick();
			assert.equal(getExecution()!.reviewBudget, 3, "auto-approve takes the default budget");
			assert.equal(getExecution()!.reviewBudgetDefaulted, true);
			ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" });
			await restoring;
			await __awaitReviewRoundForTests();
			ctl.drainAll();
		} finally {
			if (previous === undefined) delete process.env.PI_PLANS_AUTO_APPROVE;
			else process.env.PI_PLANS_AUTO_APPROVE = previous;
		}
		__setAuditRunnerForTests(null);
		await stopExecution(ctx, "teardown");
	});

	it("the budget counters and the valve state survive a session restore", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const live = getExecution()!;
		live.reviewBudget = "unlimited";
		live.reviewRoundsTotal = 7;
		live.reviewCapExtension = 50;
		live.reviewNoProgress = { key: "VC-002|VC-001|", streak: 2 };
		// A cancelled round neither burns the budget nor mutates the counters.
		__setAuditRunnerForTests(async () => ({ cancelled: true }) as never);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: live }]);
		const ex = getExecution()!;
		assert.equal(ex.reviewBudget, "unlimited", "the budget survives");
		assert.equal(ex.reviewRoundsTotal, 7, "the cumulative counter survives (no free window)");
		assert.equal(ex.reviewCapExtension, 50, "the granted extension survives");
		assert.deepEqual(ex.reviewNoProgress, { key: "VC-002|VC-001|", streak: 2 }, "the valve streak survives");
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});
});

/**
 * v0.10: the single non-high repair cycle. A round whose actionable findings
 * are all `medium`/`low` grants one repair wake (mapped `medium` rolls back
 * through the pure finding-driven union; unmapped `medium` and every `low`
 * get a `fix <id>:` task appended) and the immediately following round
 * re-judges. The cycle is exempt from a numeric budget but still bounded by
 * the unlimited hard cap, and a completion with findings left over must
 * disclose every disposition instead of claiming the review passed.
 */
describe("non-high repair cycle (v0.10)", () => {
	const finding = (
		id: string,
		severity: "high" | "medium" | "low",
		taskIds: string[],
		extra: Partial<{ note: string; proposedTask: string }> = {},
	) => ({ id, severity, taskIds, note: `${id} note`, evidence: "src/lib", raw: `- \` ${id}\` raw`, ...extra });

	const snapshot = () => [{ type: "custom" as const, customType: "pi-plans-exec", data: getExecution() }];
	/** A ctx whose native budget select answers with the given pick. */
	const menuCtx = (workdir: string, pick: string) => {
		const base = makeCtx(workdir, "tui");
		const ui = (base as { ui: Record<string, unknown> }).ui;
		return {
			...base,
			ui: {
				...ui,
				select: async (_title: string, options: string[]): Promise<string | undefined> =>
					options.find((option) => option.startsWith(pick)) ?? options[0],
			},
		} as typeof base;
	};
	const wakes = (ctx: { entries: Array<{ customType: string; content?: string }> }) =>
		ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed");
	const completions = (ctx: { entries: Array<{ customType: string; content?: string }> }) =>
		ctx.entries.filter((e) => e.customType === "pi-plans-complete");

	it("medium: mapped tasks roll back, the unmapped one is appended, exactly one wake", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-001", "medium", ["Task-1"]), finding("F-002", "medium", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.ok(ex, "the run stays open for the repair cycle");
		assert.equal(ex.reviewNonHighRepair, "granted");
		assert.equal(ex.tasks.find((t) => t.id === "Task-1")!.status, "pending", "a mapped medium rolls back");
		assert.equal(ex.tasks.find((t) => t.id === "Task-2")!.status, "complete", "untouched work stays done");
		const appended = ex.tasks.find((t) => /^fix F-002:/.test(t.title));
		assert.ok(appended, "the unmapped medium gets a repair task");
		assert.match(appended!.title, /appended by execution review round 1/);
		assert.match(fs.readFileSync(planPath, "utf8"), /- `Task-3`: fix F-002: F-002 note/, "the plan file carries the bullet");
		assert.equal(wakes(ctx).length, 1, "exactly one wake");
		// v0.10 (VC-004): a pure finding-driven medium rollback keeps the VC
		// passes — only a fail-driven rollback invalidates them.
		assert.deepEqual(ex.items.map((item) => item.done), [true, true], "the medium rollback invalidates no VC pass");
		// v0.10 (VC-004): the per-turn injection names the pending non-highs
		// while the cycle is in flight (a wake alone would be lost on resume).
		const injection = executionContextMessage(ctx);
		assert.ok(injection, "the executor still gets a context message");
		assert.match(String(injection), /pending medium\/low findings \(the single non-high repair cycle\)/);
		assert.match(String(injection), /F-001 \(medium\)/);
		assert.match(String(injection), /F-002 \(medium\)/);
		assert.match(String(injection), /skipReason "deferred: <reason>"/);
		const cp = loadCheckpoint(workdir, runId).checkpoint;
		assert.equal(cp.execution?.reviewNonHighRepair, "granted", "the flag rides the checkpoint");
		assert.equal(cp.execution?.reviewNonHighCredits, 1, "credit 1 while granted");
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
	});

	it("low: never rolls back verified work and appends one task per finding", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-010", "low", ["Task-2"]), finding("F-011", "low", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(ex.tasks.find((t) => t.id === "Task-2")!.status, "complete", "a low never rolls back");
		assert.equal(ex.tasks.find((t) => t.id === "Task-1")!.status, "complete");
		assert.ok(ex.tasks.find((t) => /^fix F-010:/.test(t.title)), "the mapped low is appended, not rolled back");
		assert.ok(ex.tasks.find((t) => /^fix F-011:/.test(t.title)), "the unmapped low is appended");
		assert.equal(wakes(ctx).length, 1);
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
	});

	it("a high/fail-driven pass carries lows without consuming the one-shot", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({
			round: 1,
			passed: ["VC-002"],
			failed: ["VC-001"],
			undeterminable: [],
			report: "r1",
			findings: [finding("F-020", "high", ["Task-1"]), finding("F-021", "low", [])],
		} as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.equal(ex.reviewNonHighRepair, "available", "the fail-driven pass leaves the one-shot available");
		assert.ok(ex.tasks.find((t) => /^fix F-021:/.test(t.title)), "the low rode along as an appended task");
		// Re-close the reopened/appended work; the low-only round now gets the cycle.
		for (const t of ex.tasks) if (t.status !== "complete" && t.status !== "skipped") applyTaskUpdate(ex.tasks, t.id, "complete", "fixed");
		persistTaskProgress(ctx);
		const settle = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 2, passed: ["VC-001"], failed: [], undeterminable: [], report: "r2", findings: [finding("F-021", "low", [])] } as never);
		await settle;
		await __awaitReviewRoundForTests();
		const after = getExecution()!;
		assert.equal(after.reviewNonHighRepair, "granted", "the low-only round now grants the cycle");
		assert.equal(wakes(ctx).length, 2, "a second wake for the cycle");
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
	});

	it("the credited re-review round launches and a still-reported finding completes with an honest ledger", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-001", "medium", ["Task-1"]), finding("F-002", "low", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		const appended = ex.tasks.find((t) => /^fix F-002:/.test(t.title))!;
		// The executor repairs and re-closes; the re-review round must still run.
		applyTaskUpdate(ex.tasks, "Task-1", "complete", "fixed the medium");
		applyTaskUpdate(ex.tasks, appended.id, "complete", "fixed the low");
		persistTaskProgress(ctx);
		const callsBefore = ctl.calls();
		const settle2 = restoreFromSession(ctx, snapshot());
		await tick();
		assert.equal(ctl.calls(), callsBefore + 1, "the credited re-review round launched");
		ctl.resolveRound({ round: 2, passed: [], failed: [], undeterminable: [], report: "r2", findings: [finding("F-001", "medium", ["Task-1"]), finding("F-002", "low", [])] } as never);
		await settle2;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "the one-shot is spent, so the run completes");
		const done = completions(ctx);
		assert.equal(done.length, 1);
		const text = String(done[0].content);
		assert.doesNotMatch(text, /execution review passed/, "a finding-bearing completion never claims the review passed");
		assert.match(text, /2 finding\(s\) without a resolved verdict: 2 unresolved, 0 deferred/);
		assert.match(text, /F-001 \(medium\) — unresolved/, "the rolled-back medium has no repair task");
		assert.match(text, /F-002 \(low\) — repair claimed — still reported \(task Task-3\)/, "a closed repair task with a still-reported id is labelled honestly");
		assert.match(text, /The single non-high repair cycle has already been spent\./);
		ctl.drainAll();
	});

	it("deferred: a skipped repair task is disclosed with its reason", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-030", "low", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		const appended = ex.tasks.find((t) => /^fix F-030:/.test(t.title))!;
		const skipped = applyTaskUpdate(ex.tasks, appended.id, "skipped", undefined, "deferred: not worth the churn");
		assert.equal(skipped.ok, true);
		persistTaskProgress(ctx);
		const settle2 = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 2, passed: [], failed: [], undeterminable: [], report: "r2", findings: [finding("F-030", "low", [])] } as never);
		await settle2;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null);
		const text = String(completions(ctx)[0].content);
		assert.doesNotMatch(text, /execution review passed/);
		assert.match(text, /F-030 \(low\) — deferred: not worth the churn/);
		assert.match(text, /0 unresolved, 1 deferred/);
		ctl.drainAll();
	});

	it("a replay does not double-append a repeatedly reported unmapped finding", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-040", "high", [], { proposedTask: "harden the guard" })] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		const appended = ex.tasks.find((t) => /^fix F-040:/.test(t.title))!;
		applyTaskUpdate(ex.tasks, appended.id, "complete", "tried");
		persistTaskProgress(ctx);
		const settle2 = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 2, passed: [], failed: [], undeterminable: [], report: "r2", findings: [finding("F-040", "high", [], { proposedTask: "harden the guard" })] } as never);
		await settle2;
		await __awaitReviewRoundForTests();
		const planText = fs.readFileSync(planPath, "utf8");
		const bullets = planText.split("\n").filter((line) => line.startsWith("- `Task-") && line.includes("fix F-040:"));
		assert.equal(bullets.length, 1, "the prefix dedup keeps exactly one repair task");
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
	});

	it("a spent numeric budget still funds the exempt cycle and its re-review", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		getExecution()!.reviewBudget = 1;
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-050", "medium", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		assert.ok(ex, "a spent budget does not swallow the non-high cycle");
		assert.equal(ex.audit.rounds, 1, "round 1 is a committed round");
		assert.equal(ex.reviewNonHighCredits, 1, "billed count = 1 - 1 = 0: not exhausted");
		const appended = ex.tasks.find((t) => /^fix F-050:/.test(t.title))!;
		applyTaskUpdate(ex.tasks, appended.id, "complete", "fixed");
		persistTaskProgress(ctx);
		const callsBefore = ctl.calls();
		const settle2 = restoreFromSession(ctx, snapshot());
		await tick();
		assert.equal(ctl.calls(), callsBefore + 1, "the exempt re-review round commits past the numeric budget");
		ctl.resolveRound({ round: 2, passed: [], failed: [], undeterminable: [], report: "r2", findings: [] } as never);
		await settle2;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "the clean re-review completes");
		assert.match(String(completions(ctx)[0].content), /execution review passed/, "a finding-free completion keeps the pass framing");
		assert.match(String(completions(ctx)[0].content), /repaired during the cycle/, "the cleared repair is shown as repaired, not left behind");
		ctl.drainAll();
	});

	it("a spent budget with a mixed high+medium round keeps the high-priority tolerant completion", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		getExecution()!.reviewBudget = 1;
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-060", "high", ["Task-1"]), finding("F-061", "medium", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "the tolerated high completion fires");
		const ex = loadCheckpoint(workdir, "unused").checkpoint; // no-op read guard (path checked below)
		void ex;
		const text = String(completions(ctx)[0].content);
		assert.match(text, /review budget exhausted/);
		assert.doesNotMatch(text, /execution review passed/);
		assert.match(text, /F-061 \(medium\) — unresolved/, "the medium is disclosed, not cycled");
		assert.equal(wakes(ctx).length, 0, "no wake: the tolerant path never rolls back or appends");
		ctl.drainAll();
	});

	it("unlimited at the hard cap with a granted cycle completes and discloses the unjudged cycle", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const live = getExecution()!;
		live.reviewBudget = "unlimited";
		live.reviewRoundsTotal = 50;
		live.audit.rounds = 50;
		live.reviewNonHighRepair = "granted";
		live.reviewNonHighCredits = 1;
		live.audit.findings = [finding("F-070", "low", [])] as never;
		// Every check already passed (the granted cycle is the only thing owed).
		for (const item of live.items) item.done = true;
		__setAuditRunnerForTests(async () => {
			throw new Error("no round may spawn at the cap");
		});
		await restoreFromSession(ctx, snapshot());
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "the cap completes the run");
		const text = String(completions(ctx)[0].content);
		assert.doesNotMatch(text, /execution review passed/);
		assert.match(text, /granted but could not be re-judged/);
		assert.match(text, /F-070 \(low\) — unresolved/);
		__setAuditRunnerForTests(null);
	});

	it("a legacy checkpoint without the flag never reopens a cycle for already-recorded findings", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const live = getExecution()!;
		live.audit.rounds = 1;
		live.audit.findings = [finding("F-080", "medium", [])] as never;
		// Checks already passed before the upgrade; the residual is what a
		// pre-v0.10 checkpoint carries (no flag at all).
		for (const item of live.items) item.done = true;
		delete (live as { reviewNonHighRepair?: unknown }).reviewNonHighRepair;
		delete (live as { reviewNonHighCredits?: unknown }).reviewNonHighCredits;
		let spawned = 0;
		__setAuditRunnerForTests(async () => {
			spawned += 1;
			return { round: 1, passed: [], failed: [], undeterminable: [], report: "", findings: [] } as never;
		});
		await restoreFromSession(ctx, snapshot());
		await __awaitReviewRoundForTests();
		assert.equal(spawned, 0, "legacy findings never owe a repair round");
		assert.ok(getExecution(), "legacy findings neither grant a cycle nor spuriously complete the run");
		assert.equal(getExecution()!.reviewNonHighRepair, undefined, "the flag stays absent");
		assert.equal(wakes(ctx).length, 0);
		__setAuditRunnerForTests(null);
	});

	it("a no-report re-review round completes with the honest ledger instead of spinning", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		const restoring = restoreFromSession(ctx, snapshot());
		await tick();
		ctl.resolveRound({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "r1", findings: [finding("F-090", "low", [])] } as never);
		await restoring;
		await __awaitReviewRoundForTests();
		const ex = getExecution()!;
		const appended = ex.tasks.find((t) => /^fix F-090:/.test(t.title))!;
		applyTaskUpdate(ex.tasks, appended.id, "complete", "fixed");
		persistTaskProgress(ctx);
		const settle2 = restoreFromSession(ctx, snapshot());
		await tick();
		// Round 2 produces NO report. Plan Task-2.5 pins the fail-closed
		// boundary: the preserved finding completes with the honest ledger (the
		// granted cycle counts as spent) instead of spawning another round that
		// only ever burns budget toward a cap pause.
		ctl.resolveRound(null);
		await settle2;
		await __awaitReviewRoundForTests();
		assert.equal(getExecution(), null, "a no-report round completes with disclosure, not a spin");
		assert.equal(ctl.calls(), 2, "no third round was spawned");
		const text = String(completions(ctx)[0].content);
		assert.doesNotMatch(text, /execution review passed/);
		assert.match(text, /F-090 \(low\) — repair claimed — still reported \(task Task-3\)/);
		assert.match(text, /granted but could not be re-judged/);
		ctl.drainAll();
	});

	it("a /plans-execute grant normalizes the credit against the flag (no stale free round)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		// A granted cycle pending at an exhausted (billed) numeric budget with a
		// check still owed: the restore pauses at the cap, and the grant zeroes
		// `audit.rounds` — the credit must be re-derived from the flag there.
		const live = getExecution()!;
		live.audit.rounds = 4; // billed 4 - 1 = 3 of 3 → exhausted
		live.audit.findings = [finding("F-095", "medium", [])] as never;
		live.reviewBudget = 3;
		live.reviewRoundsTotal = 4;
		live.reviewNonHighRepair = "granted";
		live.reviewNonHighCredits = 1;
		const ctl = controlledRunner();
		__setAuditRunnerForTests(ctl.runner);
		await restoreFromSession(ctx, snapshot());
		assert.equal(getExecution()!.stall.paused, true, "billed 3 of 3 pauses");
		const { resumeActiveExecution } = await import("../src/exec.ts");
		const granted = await resumeActiveExecution(menuCtx(workdir, "2"));
		assert.equal(granted.resumed, true);
		assert.equal(granted.grantedBudget, 2);
		const ex = getExecution()!;
		assert.equal(ex.audit.rounds, 0, "the per-grant counter resets");
		assert.equal(ex.reviewNonHighRepair, "granted", "the pending cycle survives the grant");
		assert.equal(ex.reviewNonHighCredits, 1, "the credit is re-derived from the flag, never stale");
		assert.equal(ex.stall.paused, false);
		await tick();
		assert.equal(ctl.calls(), 1, "the credited re-review round launches inside the fresh window (billed from 0)");
		ctl.drainAll();
		await stopExecution(ctx, "teardown");
		__setAuditRunnerForTests(null);
	});

	it("a used flag never carries a stale credit into a restored window", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const live = getExecution()!;
		for (const item of live.items) item.done = true;
		live.audit.findings = [finding("F-098", "low", [])] as never;
		live.reviewNonHighRepair = "used";
		live.reviewNonHighCredits = 1; // a stale monotonic counter from a pre-fix build
		__setAuditRunnerForTests(async () => {
			throw new Error("no round may spawn for a spent cycle");
		});
		await restoreFromSession(ctx, snapshot());
		assert.equal(getExecution()!.reviewNonHighCredits, 0, "the credit is derived from `used`, not trusted");
		__setAuditRunnerForTests(null);
	});

	it("the dashboard review counter reports the billed round count (v0.10)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const live = getExecution()!;
		live.audit.rounds = 1;
		live.audit.findings = [finding("F-096", "low", [])] as never;
		live.reviewBudget = 3;
		live.reviewNonHighRepair = "granted";
		live.reviewNonHighCredits = 1;
		const statuses: string[] = [];
		(ctx as { ui: { setStatus: (key: string, text: string) => void } }).ui.setStatus = (_key, text) => statuses.push(text);
		const { updateStatusWidget } = await import("../src/exec.ts");
		updateStatusWidget(ctx);
		const text = statuses.join("\n");
		assert.match(text, /review r0\/3/, "the granted cycle is billed: round 0 of 3, not the raw 1");
		__setAuditRunnerForTests(null);
	});

	it("TERMINATION.md lists non-high findings as unresolved (v0.10)", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTerminal(planPath, workdir);
		const live = getExecution()!;
		live.audit.findings = [finding("F-097", "medium", [])] as never;
		const { terminationSummary, renderTerminationRecord } = await import("../src/exec.ts");
		const record = renderTerminationRecord(terminationSummary(live, "run-1"), { at: "2026-10-05T00:00:00Z" });
		assert.match(record, /- F-097 \(unresolved\)/, "non-high ids are labelled unresolved, never residual");
		__setAuditRunnerForTests(null);
	});

	it("the reviewer brief renders the executor's per-finding disposition (v0.10)", async () => {
		const { buildAuditTask } = await import("../src/auditor.ts");
		const checks = [{ id: "VC-001", text: "`VC-001` covers `Task-1`; pass condition: x", done: false }];
		const tasks = buildTaskView(parsePlanTasks("## Tasks\n\n- Task-1: a — wave: 1\n"), {});
		const prior = [
			{ id: "F-001", severity: "medium" as const, taskIds: ["Task-1"], note: "medium item", evidence: "src/a.ts", raw: "" },
			{ id: "F-002", severity: "low" as const, taskIds: [], note: "low item", evidence: "src/b.ts", raw: "" },
		];
		const dispositions = new Map([
			["F-001", "repaired by Task-3; no longer reported"],
			["F-002", "deferred: not worth the churn"],
		]);
		const task = buildAuditTask("/tmp/PLAN_v1.md", checks, tasks, 4, prior, dispositions);
		assert.match(task, /`F-001` — severity: medium; tasks: Task-1; note: medium item; disposition: repaired by Task-3/);
		assert.match(task, /`F-002` — severity: low; tasks: none; note: low item; disposition: deferred: not worth the churn/);
	});
});
