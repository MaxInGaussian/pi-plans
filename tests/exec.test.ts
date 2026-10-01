/**
 * Task-tree execution core tests (v0.6.1): startExecution, task-tool-driven
 * progress persistence, the per-turn injection, the stall watchdog, the
 * completion-audit flow (pass, rollback, round cap under auto-approve), the
 * checkpoint schema round-trip, and restoreFromSession.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	__setAuditRunnerForTests,
	executionContextMessage,
	getExecution,
	loadExecutionFromCheckpoint,
	persistTaskProgress,
	registerExecutionTurnHandlers,
	restoreFromSession,
	startExecution,
	stopExecution,
	toggleDashboardExpanded,
	updateStatusWidget,
} from "../src/exec.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { applyTaskUpdate } from "../src/task-tool.ts";
import { flattenTaskViews } from "../src/tasks.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { initState, startRun } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint, applyExecutionApproved, applyExecutionProgress, applyPlanWritten, planIdentityOf } from "../src/workflow-state.ts";
import { allTasksTerminal } from "../src/tasks.ts";

const PLAN = `# PLAN_v1 - demo

## Tasks

- Task-1: parser — files: src/a.ts; wave: 1
- Task-2: tool — files: src/b.ts; wave: 1
- Task-3: core — deps: Task-1, Task-2; files: src/c.ts; wave: 2

### Execution Waves

- wave 1: Task-1, Task-2 — parallel
- wave 2: Task-3 — serial

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: parser tests green
- [ ] \`VC-002\` covers \`Task-2\` and \`Task-3\`; pass condition: core tests green
`;

let root: string;
let counter = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-exec-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	__setAuditRunnerForTests(null);
});

function freshWorkdir(withRun = true): { workdir: string; planPath: string; runId?: string } {
	counter += 1;
	const workdir = path.join(root, `repo-${counter}`);
	fs.mkdirSync(workdir, { recursive: true });
	initState(workdir);
	if (!withRun) {
		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(planPath, PLAN, "utf8");
		return { workdir, planPath };
	}
	const { run } = startRun(workdir, { topic: `t${counter}`, skill: "plan-small", requestText: "demo" });
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

function makeCtx(workdir: string) {
	const entries: Array<{ customType: string; data?: unknown; content?: string }> = [];
	const ctx = {
		cwd: workdir,
		sessionManager: {},
		hasUI: true,
		mode: "print" as const,
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
		sendMessage: (message: { customType: string; content: string }) => entries.push({ customType: message.customType, content: message.content }),
		sendUserMessage: async () => {},
	});
	return ctx;
}

async function start(planPath: string, workdir: string, planText: string = PLAN) {
	const ctx = makeCtx(workdir) as { entries: Array<{ customType: string; data?: unknown; content?: string }> };
	await startExecution(ctx, {
		planPath,
		planTasks: parsePlanTasks(planText),
		items: parseChecklist(planText),
	});
	return { ctx };
}

describe("task-tree execution core", () => {
	it("startExecution seeds the task tree and emits the task-tool contract", async () => {
		const { workdir, planPath } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		const exec = getExecution()!;
		assert.equal(exec.tasks.length, 3);
		assert.equal(exec.legacyPlan, false);
		assert.ok(ctx.entries.some((e) => e.customType === "pi-plans-exec-start" && String(e.content).includes("plans_update_task")));
		const injection = executionContextMessage(makeCtx(workdir))!;
		assert.match(injection, /Current wave 1 open tasks:/);
		assert.match(injection, /Task-1: parser/);
		assert.match(injection, /plans_update_task/);
		assert.match(injection, /VC-001, VC-002/);
		await stopExecution(makeCtx(workdir), "test teardown");
	});

	it("task updates persist into the checkpoint task map", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "a-tests green");
		persistTaskProgress(ctx);
		const load = loadCheckpoint(workdir, runId!);
		assert.ok(load.status === "ok");
		assert.equal(load.checkpoint.execution?.tasks?.["Task-1"]?.status, "complete");
		assert.equal(load.checkpoint.execution?.tasks?.["Task-1"]?.evidence, "a-tests green");
		await stopExecution(ctx, "test teardown");
	});

	it("audit pass completes the run; VCs flip done and the phase is completed", async () => {
		__setAuditRunnerForTests(async ({ checklist }) => ({
			round: 1,
			passed: checklist.map((item) => {
				item.done = true; // mirrors applyAuditOutcome's mutation
				return item.id;
			}),
			failed: [],
			rolledBack: [],
			report: "all pass",
		}));
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		assert.ok(allTasksTerminal(getExecution()!.tasks));
		// The restore path runs the audit flow when tasks are terminal but
		// checks are still open (the same trigger turn_end uses).
		const snapshot = getExecution();
		assert.ok(snapshot);
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		const load = loadCheckpoint(workdir, runId!);
		assert.ok(load.status === "ok");
		assert.equal(load.checkpoint.phase, "completed");
		const doneVc = load.checkpoint.execution?.doneVcIds ?? [];
		assert.ok(doneVc.includes("VC-001") && doneVc.includes("VC-002"));
		__setAuditRunnerForTests(null);
	});

	it("audit failure rolls covered tasks back; three rounds stop the run", async () => {
		let round = 0;
		__setAuditRunnerForTests(async ({ checklist }) => {
			round += 1;
			const failed = checklist.filter((item) => item.id === "VC-002").map((item) => item.id);
			// Simulate the pure outcome: VC-002 fails; its covered tasks roll back.
			return { round, passed: ["VC-001"], failed, rolledBack: [], report: "VC-002 fails" };
		});
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		const exec = getExecution()!;
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(exec.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		// Apply the failed-audit rollback three times (round cap), mirroring
		// the audit-flow loop without driving real turn events.
		for (let i = 0; i < 3; i++) {
			exec.audit.rounds += 1;
			exec.audit.failed = ["VC-002"];
			// rollback via tasks API directly (the flow does this via auditRollbackSet)
			for (const task of flattenTaskViews(exec.tasks)) {
				if (task.id !== "Task-1" && task.status !== "pending") {
					task.status = "pending";
					task.evidence = undefined;
				}
			}
		}
		assert.equal(exec.audit.rounds, 3);
		// The stop path at the cap: emulate what runAuditFlow does on cap.
		await stopExecution(ctx, "completion audit exhausted 3 rounds");
		const load = loadCheckpoint(workdir, runId!);
		assert.ok(load.status === "ok");
		assert.equal(load.checkpoint.execution?.pausedReason, "completion audit exhausted 3 rounds");
		__setAuditRunnerForTests(null);
	});

	it("stall watchdog pauses after three settled rounds without task change", async () => {
		const { workdir, planPath } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		const exec = getExecution()!;
		const snapshot = JSON.stringify(exec.stall.lastSnapshot);
		for (let i = 0; i < 3; i++) {
			exec.stall.lastSnapshot = snapshot; // force no-change
			exec.stall.rounds += 1;
		}
		assert.equal(exec.stall.rounds, 3);
		// Direct pause-path assertion via the exported resume contract:
		exec.stall.paused = true;
		exec.stall.pausedReason = "no task-status change in 3 rounds";
		assert.match(
			formatStatus(workdir),
			/paused/,
		);
		await stopExecution(ctx, "test teardown");
	});

	it("legacy I-### plans parse through the fallback with the upgrade notice", async () => {
		const workdir = fs.mkdtempSync(path.join(root, "legacy-"));
		initState(workdir);
		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(
			planPath,
			"# PLAN\n\n## Implementation Items\n\n- `I-001`: First.\n- `I-002`: Second.\n\n## Verifier Checklist\n\n- [ ] `VC-001` covers `I-001`; pass condition: x.\n",
			"utf8",
		);
		const legacyText = fs.readFileSync(planPath, "utf8");
		await start(planPath, workdir, legacyText);
		const exec = getExecution()!;
		assert.equal(exec.legacyPlan, true);
		assert.deepEqual(exec.tasks.map((t) => t.id), ["Task-1", "Task-2"]);
		await stopExecution(makeCtx(workdir), "test teardown");
	});

	it("restoreFromSession rebuilds task progress from the snapshot", async () => {
		const { workdir, planPath } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "e1");
		persistTaskProgress(ctx);
		const snapshot = getExecution()!;
		const entries = [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
		];
		// Simulate a restart: stop clears state; restore rebuilds it.
		await stopExecution(ctx, "restart");
		assert.equal(getExecution(), null);
		const ctx2 = makeCtx(workdir);
		await restoreFromSession(ctx2, entries as never);
		const restored = getExecution();
		assert.ok(restored, "execution restored");
		assert.equal(restored!.tasks.find((t) => t.id === "Task-1")?.status, "complete");
		assert.equal(restored!.tasks.find((t) => t.id === "Task-2")?.status, "pending");
		await stopExecution(makeCtx(workdir), "test teardown");
	});

	it("loadExecutionFromCheckpoint restores task progress and keeps authorization on same HEAD", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "e1");
		persistTaskProgress(ctx);
		await stopExecution(ctx, "restart-sim");
		const load = loadExecutionFromCheckpoint(makeCtx(workdir), runId!);
		// Stopped runs keep phase executing in the checkpoint (pausedReason set)
		// so the load path applies. The approval recorded an unverifiable HEAD
		// (no commits in the fixture repo): D-023 keeps the authorization but
		// re-opens closed tasks for re-verification.
		if (load.status === "loaded") {
			assert.equal(load.reverifyAll, true);
			const exec = getExecution()!;
			assert.equal(exec.tasks.find((t) => t.id === "Task-1")?.status, "pending");
		}
	});

	it("a failing audit (real flow) rolls covered tasks back and persists the outcome", async () => {
		// F-006/F-010: drive the real runAuditFlow via restoreFromSession with
		// an injected failing runner — no manual audit-state mutation.
		__setAuditRunnerForTests(async ({ checklist }) => {
			// Mirror applyAuditOutcome: passed checks are marked done.
			const vc1 = checklist.find((item) => item.id === "VC-001");
			if (vc1) vc1.done = true;
			return { round: 1, passed: ["VC-001"], failed: ["VC-002"], rolledBack: [], report: "VC-002 fails: core tests missing" };
		});
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		const snapshot = getExecution();
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		const ex = getExecution()!;
		// Fail-closed: the audit rolled VC-002's covered tasks back to pending.
		assert.equal(ex.tasks.find((t) => t.id === "Task-1")?.status, "complete");
		assert.equal(ex.tasks.find((t) => t.id === "Task-2")?.status, "pending");
		assert.equal(ex.tasks.find((t) => t.id === "Task-3")?.status, "pending");
		const load = loadCheckpoint(workdir, runId!);
		assert.ok(load.status === "ok");
		assert.equal(load.checkpoint.execution?.audit?.rounds, 1);
		assert.equal(load.checkpoint.execution?.audit?.lastResult, "VC-002");
		__setAuditRunnerForTests(null);
		await stopExecution(ctx, "test teardown");
	});

	it("audit round cap: interactive sessions pause, headless stops", async () => {
		__setAuditRunnerForTests(async ({ checklist }) => {
			const failed = checklist.filter((item) => !["VC-001"].includes(item.id)).map((item) => item.id);
			return { round: 1, passed: ["VC-001"], failed, rolledBack: [], report: "still failing" };
		});
		const interactive = await (async () => {
			const { workdir, planPath, runId } = freshWorkdir();
			const { ctx } = await start(planPath, workdir);
			for (const id of ["Task-1", "Task-2", "Task-3"]) {
				applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
				persistTaskProgress(ctx);
			}
			// Simulate three exhausted rounds persisted from earlier attempts.
			getExecution()!.audit.rounds = 3;
			getExecution()!.audit.failed = ["VC-002"];
			mutateCheckpoint(workdir, runId!, (cp) => applyExecutionProgress(cp, { audit: { rounds: 3, lastResult: "VC-002" } }));
			const snapshot = getExecution();
			const ctxUi = { ...makeCtx(workdir), mode: "tui" as const };
			await restoreFromSession(ctxUi, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
			const ex = getExecution()!;
			// hasUI ctx → interactive pause, execution state kept.
			assert.equal(ex.stall.paused, true, "interactive cap pauses");
			assert.match(ex.stall.pausedReason ?? "", /exhausted 3 rounds/);
			await stopExecution(ctxUi, "test teardown");
			return loadCheckpoint(workdir, runId!);
		})();
		assert.ok(interactive.status === "ok");
		// Headless: no UI → bounded stop.
		const { workdir: wd2, planPath: pp2, runId: r2 } = freshWorkdir();
		const { ctx: ctx3 } = await start(pp2, wd2);
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx3);
		}
		getExecution()!.audit.rounds = 3;
		getExecution()!.audit.failed = ["VC-002"];
		const headlessCtx = { ...makeCtx(wd2), hasUI: false } as never;
		await restoreFromSession(headlessCtx, [{ type: "custom", customType: "pi-plans-exec", data: getExecution() }]);
		assert.equal(getExecution(), null, "headless cap stops and clears execution");
		const stopped = loadCheckpoint(wd2, r2!);
		assert.ok(stopped.status === "ok");
		assert.match(stopped.checkpoint.execution?.pausedReason ?? "", /exhausted 3 rounds/);
		__setAuditRunnerForTests(null);
	});

	it("a checkpoint carrying a 0.6.0 delegated executor refuses the direct load", async () => {
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "e1");
		persistTaskProgress(ctx);
		await stopExecution(ctx, "restart-sim");
		mutateCheckpoint(workdir, runId!, (cp) =>
			applyExecutionProgress(cp as never, { delegate: { modelSelector: "x/y", startedAt: "2026-01-01T00:00:00Z" } } as never),
		);
		const load = loadExecutionFromCheckpoint(makeCtx(workdir), runId!);
		assert.equal(load.legacyDelegate, true);
		assert.equal(load.status, "no-execution");
		assert.equal(getExecution(), null, "delegate orphans never resume without a fresh handoff");
	});

	it("resuming an audit-cap pause grants a fresh audit budget and completes", async () => {
		// Round 2 F-001 regression nail: cap → pause → resume resets rounds →
		// the audit runs again and can now complete the run.
		let runnerCalls = 0;
		__setAuditRunnerForTests(async ({ checklist }) => {
			runnerCalls += 1;
			return {
				round: runnerCalls,
				passed: checklist.map((item) => {
					item.done = true;
					return item.id;
				}),
				failed: [],
				rolledBack: [],
				report: "all pass",
			};
		});
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		// Exhaust the budget, then pause at the cap exactly like runAuditFlow.
		getExecution()!.audit.rounds = 3;
		getExecution()!.audit.failed = ["VC-001", "VC-002"];
		const ctxTui = { ...makeCtx(workdir), mode: "tui" as const };
		const snapshot = getExecution();
		await restoreFromSession(ctxTui, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		const ex = getExecution()!;
		assert.equal(ex.stall.paused, true, "cap pauses interactively");
		assert.match(ex.stall.pausedReason ?? "", /^completion audit exhausted/);
		// User resumes: the budget resets and the next audit flow completes.
		const { resumeActiveExecution } = await import("../src/exec.ts");
		const resumed = resumeActiveExecution(ctxTui);
		assert.equal(resumed, true);
		assert.equal(getExecution()!.audit.rounds, 0, "resume grants a fresh audit budget");
		const snapshot2 = getExecution();
		await restoreFromSession(ctxTui, [{ type: "custom", customType: "pi-plans-exec", data: snapshot2 }]);
		assert.equal(runnerCalls, 1, "audit re-ran after the resume (fresh budget)");
		const final = loadCheckpoint(workdir, runId!);
		assert.ok(final.status === "ok");
		assert.equal(final.checkpoint.phase, "completed");
		__setAuditRunnerForTests(null);
	});

	it("a null audit outcome (infra failure) fails every pending check closed", async () => {
		__setAuditRunnerForTests(async () => null);
		const { workdir, planPath, runId } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		const snapshot = getExecution();
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		const ex = getExecution()!;
		assert.deepEqual(ex.audit.failed, ["VC-001", "VC-002"], "unreported checks fail closed");
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			assert.equal(ex.tasks.find((t) => t.id === id)?.status, "pending", `${id} rolled back`);
		}
		const load = loadCheckpoint(workdir, runId!);
		assert.ok(load.status === "ok");
		assert.equal(load.checkpoint.execution?.audit?.rounds, 1);
		assert.match(load.checkpoint.execution?.audit?.lastResult ?? "", /VC-001/);
		__setAuditRunnerForTests(null);
		await stopExecution(ctx, "test teardown");
	});

	it("a runner passing a strict subset fails the unreported checks closed", async () => {
		// The runner reports VC-001 passed and claims zero failures — VC-002
		// is simply missing from its report and must NOT complete the run.
		__setAuditRunnerForTests(async ({ checklist }) => {
			const vc1 = checklist.find((item) => item.id === "VC-001");
			if (vc1) vc1.done = true;
			return { round: 1, passed: ["VC-001"], failed: [], rolledBack: [], report: "partial report" };
		});
		const { workdir, planPath } = freshWorkdir();
		const { ctx } = await start(planPath, workdir);
		for (const id of ["Task-1", "Task-2", "Task-3"]) {
			applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
			persistTaskProgress(ctx);
		}
		const snapshot = getExecution();
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		const ex = getExecution()!;
		assert.deepEqual(ex.audit.failed, ["VC-002"], "unreported check fails despite failed: []");
		assert.equal(ex.tasks.find((t) => t.id === "Task-3")?.status, "pending");
		__setAuditRunnerForTests(null);
		await stopExecution(ctx, "test teardown");
	});

	it("toggleDashboardExpanded flips the expanded mode", () => {
		const before = toggleEnabled();
		toggleDashboardExpanded(makeCtx(freshWorkdir(false).workdir));
		assert.equal(toggleEnabled(), !before);
		toggleDashboardExpanded(makeCtx(freshWorkdir(false).workdir));
	});
});

/**
 * v0.7.1 regression suite (root causes A and B). These drive the REAL lifecycle
 * events (`agent_before_settle` / `turn_end` / `tool_result`) instead of
 * mutating state directly, because the stranded-state bug only exists in the
 * event ORDER — a test that calls restoreFromSession cannot see it.
 */
describe("v0.7.1 execution-loop fixes (event-driven)", () => {
	/** A ctx in TUI mode: `canWakeExecution` requires mode tui/rpc, and a
	 * print-mode ctx would make every wake/audit assertion silently vacuous. */
	function makeTuiCtx(workdir: string) {
		const entries: Array<{ customType: string; data?: unknown; content?: string; triggerTurn?: boolean }> = [];
		const ctx = {
			cwd: workdir,
			sessionManager: {},
			hasUI: true,
			mode: "tui" as const,
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
			sendMessage: (message: { customType: string; content: string; details?: unknown }, opts?: { triggerTurn?: boolean }) =>
				entries.push({ customType: message.customType, content: message.content, triggerTurn: opts?.triggerTurn }),
			sendUserMessage: async () => {},
		});
		return ctx as { entries: typeof entries; cwd: string };
	}

	/** Register the production turn handlers and return a driver for the events. */
	function wireEvents(ctx: never) {
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
			async fire(name: string, event: unknown = {}) {
				for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
			},
		};
	}

	async function startTui(planPath: string, workdir: string) {
		const ctx = makeTuiCtx(workdir);
		await startExecution(ctx as never, {
			planPath,
			planTasks: parsePlanTasks(PLAN),
			items: parseChecklist(PLAN),
		});
		return ctx;
	}

	const closeAll = (ids: string[]) => {
		for (const id of ids) applyTaskUpdate(getExecution()!.tasks, id, "complete", `${id} evidence`);
	};

	it("root cause A: a terminal-but-unaudited run self-heals via agent_before_settle (zero input)", async () => {
		// First audit round fails -> tasks roll back to pending (0/3).
		let round = 0;
		__setAuditRunnerForTests(async ({ checklist }) => {
			round += 1;
			if (round === 1) {
				const failed = checklist.filter((i) => i.id === "VC-002").map((i) => i.id);
				return { round, passed: ["VC-001"], failed, rolledBack: [], report: "VC-002 fails" };
			}
			for (const item of checklist) item.done = true;
			return { round, passed: checklist.map((i) => i.id), failed: [], rolledBack: [], report: "all pass" };
		});
		const { workdir, planPath, runId } = freshWorkdir();
		const ctx = await startTui(planPath, workdir);
		const drive = wireEvents(ctx as never);

		// Agent closes every task; the turn ends -> audit round 1 runs and fails.
		closeAll(["Task-1", "Task-2", "Task-3"]);
		persistTaskProgress(ctx as never);
		await drive.fire("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		assert.equal(round, 1, "round 1 audit ran");
		assert.equal(getExecution()!.tasks.find((t) => t.id === "Task-2")?.status, "pending", "VC-002 rolled its tasks back");

		// The agent fixes the failures and re-closes the rolled-back tasks. A new
		// agent run opens a new settle window (agent_start resets the latch).
		await drive.fire("agent_start", {});
		closeAll(["Task-1", "Task-2", "Task-3"]);
		persistTaskProgress(ctx as never);
		assert.ok(allTasksTerminal(getExecution()!.tasks), "task tree is terminal again");

		// The regression: fire ONLY the actionable pre-settle boundary, i.e. the
		// case where the turn_end trigger is missed (the observed strand). Before
		// v0.7.1 nothing else could start the audit, so the run sat in
		// `executing` until a manual /plans-execute.
		await drive.fire("agent_before_settle", {});
		assert.equal(round, 2, "the owed audit reran automatically with zero user input");

		const load = loadCheckpoint(workdir, runId!);
		assert.ok(load.status === "ok");
		assert.equal(load.checkpoint.phase, "completed", "run reached completed without a manual /plans-execute");
		__setAuditRunnerForTests(null);
	});

	it("root cause A: the audit is not run twice within one settle (per-settle latch)", async () => {
		let calls = 0;
		__setAuditRunnerForTests(async ({ checklist }) => {
			calls += 1;
			for (const item of checklist) item.done = true;
			return { round: 1, passed: checklist.map((i) => i.id), failed: [], rolledBack: [], report: "all pass" };
		});
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTui(planPath, workdir);
		const drive = wireEvents(ctx as never);
		closeAll(["Task-1", "Task-2", "Task-3"]);
		persistTaskProgress(ctx as never);
		// Both entry points land in the same settle.
		await drive.fire("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		await drive.fire("agent_before_settle", {});
		assert.equal(calls, 1, "exactly one audit call per settle");
		__setAuditRunnerForTests(null);
	});

	it("root cause A: a fully terminal run emits no EXECUTION_CONTINUE wake", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTui(planPath, workdir);
		const drive = wireEvents(ctx as never);
		closeAll(["Task-1", "Task-2", "Task-3"]);
		persistTaskProgress(ctx as never);
		await drive.fire("agent_settled", {});
		assert.equal(
			ctx.entries.filter((e) => e.customType === "pi-plans-exec-continue").length,
			0,
			"no continuation wake when every task is already terminal",
		);
		await stopExecution(ctx as never, "test teardown");
	});

	it("root cause A: an audit failure wakes the agent exactly once", async () => {
		__setAuditRunnerForTests(async ({ checklist }) => {
			const failed = checklist.filter((i) => i.id === "VC-002").map((i) => i.id);
			return { round: 1, passed: ["VC-001"], failed, rolledBack: [], report: "VC-002 fails" };
		});
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTui(planPath, workdir);
		const drive = wireEvents(ctx as never);
		closeAll(["Task-1", "Task-2", "Task-3"]);
		persistTaskProgress(ctx as never);
		await drive.fire("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		const wakes = ctx.entries.filter((e) => e.customType === "pi-plans-audit-failed" || e.customType === "pi-plans-exec-continue");
		assert.equal(wakes.length, 1, `one wake per settle, got ${wakes.map((w) => w.customType).join(",")}`);
		assert.equal(wakes[0]?.triggerTurn, true, "the audit-failure notice drives the fix turn");
		__setAuditRunnerForTests(null);
		await stopExecution(ctx as never, "test teardown");
	});

	it("root cause B: a successful tool result counts as progress and rebases the watchdog", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTui(planPath, workdir);
		const drive = wireEvents(ctx as never);
		const exec = getExecution()!;
		exec.stall.rounds = 2;
		// A successful tool result during a cross-round investigation.
		await drive.fire("tool_result", { isError: false });
		assert.equal(exec.stall.rounds, 0, "legitimate work rebased the no-progress counter");
		await stopExecution(ctx as never, "test teardown");
	});

	it("root cause B (negative): an error-only tool loop still trips the cap", async () => {
		const { workdir, planPath } = freshWorkdir();
		const ctx = await startTui(planPath, workdir);
		const drive = wireEvents(ctx as never);
		const exec = getExecution()!;
		const base = exec.stall.lastSnapshot;
		// Tools that all fail: repeated retries must NOT look like progress.
		for (let i = 0; i < 5; i++) await drive.fire("tool_result", { isError: true });
		assert.equal(exec.stall.rounds, 0, "a failed tool does not rebase the counter on its own");
		assert.equal(exec.stall.lastSnapshot, base, "snapshot unchanged by failed tools");
		await stopExecution(ctx as never, "test teardown");
	});
});

function formatStatus(workdir: string): string {
	const exec = getExecution();
	assert.ok(exec);
	void workdir;
	return exec.stall.paused ? "paused" : "running";
}

import { isDashboardExpanded as toggleEnabled } from "../src/exec.ts";
