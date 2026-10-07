/**
 * Delegated execution: worker sessions report task progress through an
 * in-process tool while their agent loops keep running; waves reuse the same
 * sessions; review rounds route repairs back to the owning worker.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	__awaitReviewRoundForTests,
	__setAuditRunnerForTests,
	executionContextMessage,
	getExecution,
	loadExecutionFromCheckpoint,
	restoreFromSession,
	startExecution,
	stopExecution,
} from "../src/exec.ts";
import { __currentDelegateRun, assignGroups, buildWorkerBrief, groupUnits, unitsOf } from "../src/exec-delegate.ts";
import { __setSessionFactoryForTests } from "../src/agent-session.ts";
import { fleet } from "../src/agent-fleet.ts";
import { fleetUi } from "../src/fleet-ui.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { buildTaskView, taskProgress } from "../src/tasks.ts";
import { initState, startRun } from "../src/state.ts";
import { applyExecutionApproved, applyPlanWritten, createCheckpoint, loadCheckpoint, mutateCheckpoint, planIdentityOf } from "../src/workflow-state.ts";
import type { ExecutorChoice } from "../src/executor-config.ts";
import { FakeSession, type FakeApi } from "./fake-agent-session.ts";

const PLAN = `# PLAN_v1 - delegated fixture

## Tasks

- Task-1: engine — files: lib/a.js; wave: 1
- Task-2: report — files: lib/b.js; wave: 1
- Task-3: engine docs — deps: Task-1; files: lib/a.js; wave: 2

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`, \`Task-3\`; pass condition: engine works; evidence: tests; metric: green.
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: report written; evidence: file; metric: green.
`;

const choice = (workers: number): ExecutorChoice => ({ mode: "delegated", workers, model_selector: "fake/worker", thinking_level: "high" });

let root = "";
let counter = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-delegate-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
	__setSessionFactoryForTests(null);
	__setAuditRunnerForTests(null);
	if (getExecution()) await stopExecution(makeCtx(root), "teardown");
	fleetUi.detach();
	fleet.clear();
});

function freshWorkdir(): { workdir: string; planPath: string; runId: string } {
	counter += 1;
	const workdir = path.join(root, `repo-${counter}`);
	fs.mkdirSync(path.join(workdir, "lib"), { recursive: true });
	initState(workdir);
	const { run } = startRun(workdir, { topic: `d${counter}`, skill: "plan-small", requestText: "demo" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
	fs.mkdirSync(run.artifact_dir, { recursive: true });
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

const entries: Array<{ customType: string; content?: string; triggerTurn?: boolean }> = [];

function makeCtx(workdir: string) {
	const ctx = {
		cwd: workdir,
		sessionManager: {},
		hasUI: true,
		mode: "tui",
		model: { provider: "fake", id: "main" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
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
		appendEntry: () => {},
		sendMessage: (message: { customType: string; content: string }, options?: { triggerTurn?: boolean }) =>
			entries.push({ customType: message.customType, content: message.content, triggerTurn: options?.triggerTurn }),
	} as never);
	return ctx;
}

const tick = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
};

async function waitFor(condition: () => boolean, label: string, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

type ToolCall = (params: { taskId: string; status: "complete" | "skipped"; evidence?: string; skipReason?: string }) => Promise<{ content: Array<{ text: string }> }>;

interface WorkerCall {
	brief: string;
	tool: ToolCall;
	api: FakeApi;
	/** Index of this session among those created (stable worker identity). */
	session: number;
}

/** Route every worker session to `script`; the custom tool is the real one built by the orchestrator. */
function installWorkers(script: (call: WorkerCall) => Promise<void> | void): { sessions: FakeSession[]; options: Array<Record<string, unknown>> } {
	const sessions: FakeSession[] = [];
	const options: Array<Record<string, unknown>> = [];
	__setSessionFactoryForTests(async (opts) => {
		const index = sessions.length;
		options.push(opts);
		const tool = (opts.customTools as Array<{ execute: (...args: unknown[]) => Promise<never> }>)[0]!;
		const session = new FakeSession(async (api) => {
			await script({
				brief: api.prompt,
				api,
				session: index,
				tool: ((params) => tool.execute("call", params, undefined, undefined, undefined)) as ToolCall,
			});
			api.say(`session ${index} done`);
		});
		sessions.push(session);
		return { session };
	});
	return { sessions, options };
}

async function begin(workers: number, ctxOverride?: ReturnType<typeof makeCtx>) {
	const { workdir, planPath, runId } = freshWorkdir();
	const ctx = ctxOverride ?? makeCtx(workdir);
	const started = await startExecution(ctx, {
		planPath,
		planTasks: parsePlanTasks(PLAN),
		items: parseChecklist(PLAN),
		executor: choice(workers),
	});
	assert.equal(started, true);
	return { workdir, planPath, runId, ctx };
}

const statuses = (): Record<string, string> =>
	Object.fromEntries((getExecution()?.tasks ?? []).map((task) => [task.id, task.status]));

/** Task ids listed under "Your assigned tasks" in a worker brief. */
const assignedIds = (brief: string): string[] =>
	[...(brief.match(/Your assigned tasks[^\n]*\n((?:- Task-[^\n]*\n?)+)/)?.[1] ?? "").matchAll(/^- (Task-[\d.]+)/gm)].map((m) => m[1]!);

describe("delegated execution: live progress without ending the worker", () => {
	it("a worker closes two tasks inside ONE still-running prompt and the panel shows each as it happens", async () => {
		let releaseFirst: () => void = () => undefined;
		let releaseSecond: () => void = () => undefined;
		const first = new Promise<void>((resolve) => (releaseFirst = resolve));
		const second = new Promise<void>((resolve) => (releaseSecond = resolve));
		const { sessions } = installWorkers(async ({ brief, tool, session }) => {
			if (session !== 0 || !brief.includes("wave 1")) {
				await tool({ taskId: "Task-3", status: "complete", evidence: "docs written" });
				return;
			}
			await first;
			await tool({ taskId: "Task-1", status: "complete", evidence: "engine done" });
			await second;
			await tool({ taskId: "Task-2", status: "complete", evidence: "report done" });
		});
		__setAuditRunnerForTests(async () => ({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "ok" }));
		const { workdir, runId } = await begin(1);

		await waitFor(() => sessions.length === 1 && sessions[0]!.prompts.length === 1, "the wave-1 prompt");
		assert.match(sessions[0]!.prompts[0]!, /Task-1/);
		assert.match(sessions[0]!.prompts[0]!, /Task-2/);
		assert.deepEqual(assignedIds(sessions[0]!.prompts[0]!), ["Task-1", "Task-2"]);

		releaseFirst();
		await waitFor(() => statuses()["Task-1"] === "complete", "Task-1 on the panel");
		// The panel moved while the worker's prompt is still running.
		assert.equal(sessions[0]!.isStreaming, true, "the worker is still inside its prompt");
		assert.equal(statuses()["Task-2"], "pending");
		assert.equal(taskProgress(getExecution()!.tasks).done, 1);
		const persisted = loadCheckpoint(workdir, runId);
		assert.ok(persisted.status === "ok" && persisted.checkpoint.execution?.tasks?.["Task-1"]?.status === "complete", "progress is persisted as it happens");
		assert.equal(sessions[0]!.disposed, false);
		assert.equal(sessions[0]!.prompts.length, 1, "no new prompt was needed for the second task");
		assert.equal(fleet.list().find((entry) => entry.role === "executor")?.note, "1/2 tasks");

		releaseSecond();
		await waitFor(() => statuses()["Task-2"] === "complete" || getExecution() === null, "Task-2 on the panel");
		const done = loadCheckpoint(workdir, runId);
		assert.ok(done.status === "ok" && done.checkpoint.execution?.tasks?.["Task-2"]?.status === "complete");
	});

	it("keeps the same session across waves, then reviews and completes", async () => {
		const { sessions } = installWorkers(async ({ brief, tool }) => {
			if (brief.includes("(wave 1)")) {
				await tool({ taskId: "Task-1", status: "complete", evidence: "a" });
				await tool({ taskId: "Task-2", status: "complete", evidence: "b" });
			} else {
				await tool({ taskId: "Task-3", status: "complete", evidence: "c" });
			}
		});
		let rounds = 0;
		__setAuditRunnerForTests(async () => {
			rounds += 1;
			return { round: rounds, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" };
		});
		const { workdir, runId } = await begin(1);
		await waitFor(() => getExecution() === null, "the run to complete");
		assert.equal(sessions.length, 1, "one worker session served both waves");
		assert.equal(sessions[0]!.prompts.length, 2, "the next wave arrived as a follow-up prompt");
		assert.match(sessions[0]!.prompts[1]!, /Task-3/);
		assert.match(sessions[0]!.prompts[1]!, /wave 2/);
		assert.equal(sessions[0]!.disposed, true, "workers are torn down only when the run ends");
		assert.equal(rounds, 1);
		assert.equal(loadCheckpoint(workdir, runId).status === "ok" && loadCheckpoint(workdir, runId).checkpoint.phase, "completed");
		const lane = fleet.list().find((entry) => entry.role === "executor")!;
		assert.equal(lane.lane.status, "complete");
	});

	it("hands the workers the chosen model, effort, write tools and the progress tool", async () => {
		const { options } = installWorkers(async ({ tool }) => {
			await tool({ taskId: "Task-1", status: "complete", evidence: "a" });
			await tool({ taskId: "Task-2", status: "complete", evidence: "b" });
			await tool({ taskId: "Task-3", status: "complete", evidence: "c" }).catch(() => undefined);
		});
		await begin(1);
		await waitFor(() => options.length === 1, "the worker session");
		assert.deepEqual(options[0]!.model, { provider: "fake", id: "worker" });
		assert.equal(options[0]!.thinkingLevel, "high");
		assert.deepEqual(options[0]!.tools, ["read", "grep", "find", "ls", "edit", "write", "bash", "plans_update_task", "plans_review_directions"]);
		assert.deepEqual((options[0]!.customTools as Array<{ name: string }>).map((tool) => tool.name), ["plans_update_task", "plans_review_directions"]);
		assert.match(String(options[0]!.systemPrompt), /execution worker in the pi-plans workflow/);
	});
});

describe("delegated execution: several workers", () => {
	it("splits a wave over file-disjoint workers, rejects foreign tasks and starts wave 2 only after wave 1", async () => {
		const attempts: string[] = [];
		const order: string[] = [];
		const { sessions } = installWorkers(async ({ brief, tool }) => {
			const ids = assignedIds(brief);
			if (ids.length === 1 && ids[0] === "Task-3") {
				order.push(`wave-2 starts with ${statuses()["Task-1"]}/${statuses()["Task-2"]}`);
				await tool({ taskId: "Task-3", status: "complete", evidence: "docs" });
				return;
			}
			const mine = ids[0]!;
			const theirs = mine === "Task-1" ? "Task-2" : "Task-1";
			try {
				await tool({ taskId: theirs, status: "complete", evidence: "not mine" });
				attempts.push(`${mine}:accepted-foreign`);
			} catch (error) {
				attempts.push(`${mine}:${(error as Error).message}`);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, mine === "Task-1" ? 5 : 40));
			await tool({ taskId: mine, status: "complete", evidence: "mine" });
		});
		__setAuditRunnerForTests(async () => ({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "ok" }));
		await begin(2);
		await waitFor(() => getExecution() === null, "the run to complete");
		assert.equal(attempts.length, 2);
		for (const attempt of attempts) assert.match(attempt, /is not assigned to you/);
		const lanes = fleet.list().filter((entry) => entry.role === "executor");
		assert.deepEqual(lanes.map((entry) => entry.label), ["executor-1", "executor-2"]);
		assert.ok(sessions.length >= 2, "two workers ran in parallel");
		assert.deepEqual(order, ["wave-2 starts with complete/complete"], "wave 2 only starts once every wave-1 task is closed");
	});
});

describe("delegated execution: review repairs and stalls", () => {
	it("routes a failed review round back to the worker that owns the reopened task", async () => {
		const briefs: string[] = [];
		installWorkers(async ({ brief, tool }) => {
			briefs.push(brief);
			for (const id of ["Task-1", "Task-2", "Task-3"]) {
				const state = statuses()[id];
				if (state === "pending" && brief.includes(id)) await tool({ taskId: id, status: "complete", evidence: `${id} evidence` });
			}
		});
		let round = 0;
		__setAuditRunnerForTests(async () => {
			round += 1;
			return round === 1
				? { round, passed: ["VC-002"], failed: ["VC-001"], undeterminable: [], report: "VC-001 failed: engine broken" }
				: { round, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "all pass" };
		});
		await begin(1);
		await waitFor(() => getExecution() === null, "the repaired run to complete", 8000);
		assert.equal(round, 2, "the failed round was followed by a passing re-review");
		const repairBrief = briefs.find((brief) => brief.includes("Repair brief from the supervisor"));
		assert.ok(repairBrief, "the owning worker received the repair brief");
		assert.match(repairBrief!, /VC-001/);
		const wake = entries.filter((entry) => entry.customType === "pi-plans-audit-failed").at(-1);
		assert.equal(wake?.triggerTurn, false, "the main session is NOT woken to repair");
		assert.match(wake!.content!, /^\[delegated run\] This review brief was forwarded to the workers/, "the transcript copy tells the supervisor not to act");
		assert.doesNotMatch(repairBrief!, /\[delegated run\]/, "the workers get the brief without the supervisor note");
	});

	it("re-prompts a worker that ends with tasks still open, then pauses at the stall cap", async () => {
		const { sessions } = installWorkers(async () => undefined);
		await begin(1);
		await waitFor(() => getExecution()!.stall.paused, "the stall pause", 8000);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0]!.prompts.length, 3, "initial prompt plus nudges up to the cap");
		assert.match(sessions[0]!.prompts[1]!, /Your run ended while/);
		assert.match(getExecution()!.stall.pausedReason ?? "", /still open after 3 rounds/);
	});

	it("a worker that fails twice pauses the run with its error", async () => {
		__setSessionFactoryForTests(async () => ({
			session: new FakeSession(() => {
				throw new Error("provider down");
			}),
		}));
		await begin(1);
		await waitFor(() => getExecution()!.stall.paused, "the failure pause", 8000);
		assert.match(getExecution()!.stall.pausedReason ?? "", /executor failed: provider down/);
	});
});

describe("delegated execution: lifecycle and main session", () => {
	it("stopping the run aborts and disposes every worker and cancels their lanes", async () => {
		const { sessions } = installWorkers(async ({ api }) => {
			await api.aborted;
		});
		const { ctx } = await begin(1);
		await waitFor(() => sessions.length === 1 && sessions[0]!.isStreaming, "the worker to be mid-prompt");
		await stopExecution(ctx, "user stop");
		await waitFor(() => sessions[0]!.disposed, "the worker session to be disposed");
		assert.equal(fleet.list().find((entry) => entry.role === "executor")?.lane.status, "cancelled");
		assert.equal(__currentDelegateRun(), null);
	});

	it("tells the main session it is only supervising", async () => {
		installWorkers(async ({ api }) => {
			await api.aborted;
		});
		const { ctx } = await begin(2);
		const message = executionContextMessage(ctx)!;
		assert.match(message, /\[PI-PLANS EXECUTION — delegated\]/);
		assert.match(message, /2 workers · fake\/worker:high/);
		assert.match(message, /Do NOT edit or write files yourself/);
		assert.doesNotMatch(message, /write access enabled/);
		await tick();
	});

	it("never wakes the main model for continuation while delegated", async () => {
		installWorkers(async ({ api }) => {
			await api.aborted;
		});
		const { ctx } = await begin(1);
		await tick();
		assert.equal(entries.some((entry) => entry.customType === "pi-plans-exec-continue"), false);
		await __awaitReviewRoundForTests();
		void ctx;
	});
});

describe("delegated execution: persistence and restore", () => {
	it("stores the choice in the run checkpoint and clears it on stop", async () => {
		installWorkers(async ({ api }) => {
			await api.aborted;
		});
		const { workdir, runId, ctx } = await begin(2);
		const stored = loadCheckpoint(workdir, runId);
		assert.ok(stored.status === "ok");
		assert.deepEqual(stored.checkpoint.execution?.executor, choice(2));
		await stopExecution(ctx, "stop");
		const after = loadCheckpoint(workdir, runId);
		assert.ok(after.status === "ok");
		assert.equal(after.checkpoint.execution?.executor, undefined, "a stop drops the choice; the next handoff asks again");
	});

	it("a delegated start message tells the main session it supervises; a current-session one still asks for plans_update_task", async () => {
		installWorkers(async ({ api }) => {
			await api.aborted;
		});
		entries.length = 0;
		await begin(2);
		const delegated = entries.find((entry) => entry.customType === "pi-plans-exec-start");
		assert.ok(delegated, "start message sent");
		assert.match(delegated!.content!, /delegated to 2 workers · fake\/worker:high/);
		assert.match(delegated!.content!, /you supervise — do not implement the tasks or call `plans_update_task` yourself/);
		assert.doesNotMatch(delegated!.content!, /Report progress with the `plans_update_task` tool/);
		await stopExecution(makeCtx(root), "next");

		entries.length = 0;
		const { workdir, planPath } = freshWorkdir();
		await startExecution(makeCtx(workdir), { planPath, planTasks: parsePlanTasks(PLAN), items: parseChecklist(PLAN) });
		const local = entries.find((entry) => entry.customType === "pi-plans-exec-start");
		assert.match(local!.content!, /Report progress with the `plans_update_task` tool/);
		assert.doesNotMatch(local!.content!, /delegated/);
	});

	it("a current-session handoff stores no executor block and never starts workers", async () => {
		const { sessions } = installWorkers(async () => undefined);
		const { workdir, planPath, runId } = freshWorkdir();
		await startExecution(makeCtx(workdir), { planPath, planTasks: parsePlanTasks(PLAN), items: parseChecklist(PLAN) });
		await tick();
		const stored = loadCheckpoint(workdir, runId);
		assert.ok(stored.status === "ok");
		assert.equal(stored.checkpoint.execution?.executor, undefined);
		assert.equal(sessions.length, 0);
		assert.equal(fleet.list().length, 0);
		assert.doesNotMatch(executionContextMessage(makeCtx(workdir))!, /delegated/);
	});

	it("restores the workers from the checkpoint after a restart and continues the open tasks", async () => {
		const { sessions } = installWorkers(async ({ brief, tool, api }) => {
			if (sessions.length === 1) {
				await api.aborted;
				return;
			}
			for (const id of assignedIds(brief)) await tool({ taskId: id, status: "complete", evidence: "after restart" });
		});
		__setAuditRunnerForTests(async () => ({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "ok" }));
		const { workdir, runId, ctx } = await begin(1);
		await waitFor(() => sessions.length === 1 && sessions[0]!.isStreaming, "the first worker");
		// A restart: the in-memory run is gone, the checkpoint remains.
		const load = loadExecutionFromCheckpoint(ctx, runId);
		assert.equal(load.status, "loaded");
		assert.deepEqual(getExecution()!.executor, choice(1));
		await waitFor(() => sessions[0]!.disposed, "the old worker to be torn down");
		await waitFor(() => getExecution() === null, "the restored run to complete", 8000);
		assert.ok(sessions.length >= 2, "a fresh worker session took over");
		const done = loadCheckpoint(workdir, runId);
		assert.ok(done.status === "ok" && done.checkpoint.phase === "completed");
	});

	it("restores the workers from a session snapshot", async () => {
		const { sessions } = installWorkers(async ({ brief, tool, api }) => {
			if (sessions.length === 1) {
				await api.aborted;
				return;
			}
			for (const id of assignedIds(brief)) await tool({ taskId: id, status: "complete", evidence: "restored" });
		});
		__setAuditRunnerForTests(async () => ({ round: 1, passed: ["VC-001", "VC-002"], failed: [], undeterminable: [], report: "ok" }));
		const { ctx } = await begin(1);
		await waitFor(() => sessions.length === 1 && sessions[0]!.isStreaming, "the first worker");
		const snapshot = JSON.parse(JSON.stringify(getExecution()));
		await restoreFromSession(ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		assert.deepEqual(getExecution()!.executor, choice(1));
		await waitFor(() => getExecution() === null, "the restored run to complete", 8000);
		assert.ok(sessions.length >= 2);
	});

	it("a corrupt executor block fails the checkpoint load instead of being guessed", async () => {
		installWorkers(async ({ api }) => {
			await api.aborted;
		});
		const { workdir, runId, ctx } = await begin(1);
		const file = path.join(workdir, ".git", "pi-plans", "runs", runId, "checkpoint.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		raw.execution.executor = { mode: "delegated", workers: 0, model_selector: "a/b", thinking_level: null };
		fs.writeFileSync(file, JSON.stringify(raw));
		assert.equal(loadExecutionFromCheckpoint(ctx, runId).status, "corrupt");
	});
});

describe("delegated scheduling helpers", () => {
	const tasks = buildTaskView(parsePlanTasks(PLAN));

	it("groups units that share a file and balances groups over workers", () => {
		const units = unitsOf(tasks);
		const groups = groupUnits(units);
		assert.equal(groups.length, 2, "Task-1 and Task-3 share lib/a.js");
		const shared = groups.find((group) => group.length === 2)!;
		assert.deepEqual(shared.map((unit) => unit.task.id).sort(), ["Task-1", "Task-3"]);
		const plan = assignGroups(groups, [0, 1]);
		assert.equal(plan.size, 2);
		const owners = [...plan.entries()].map(([slot, list]) => [slot, list.map((unit) => unit.task.id).sort()]);
		assert.deepEqual(owners.find(([, ids]) => (ids as string[]).includes("Task-1"))![1], ["Task-1", "Task-3"]);
	});

	it("puts units without declared files in one group (cannot prove them disjoint)", () => {
		const plan = parsePlanTasks(`# P\n\n## Tasks\n\n- Task-1: a — wave: 1\n- Task-2: b — wave: 1\n\n## Verification Checks\n\n- [ ] \`VC-001\` covers \`Task-1\`; pass condition: x; evidence: y; metric: z.\n`);
		const groups = groupUnits(unitsOf(buildTaskView(plan)));
		assert.equal(groups.length, 1);
		assert.equal(groups[0]!.length, 2);
	});

	it("sends a group back to the slot that owned its tasks", () => {
		const groups = groupUnits(unitsOf(tasks));
		const plan = assignGroups(groups, [0, 1], (unit) => (unit.task.id === "Task-2" ? 1 : unit.task.id === "Task-1" || unit.task.id === "Task-3" ? 0 : undefined));
		assert.deepEqual(plan.get(0)!.map((unit) => unit.task.id).sort(), ["Task-1", "Task-3"]);
		assert.deepEqual(plan.get(1)!.map((unit) => unit.task.id), ["Task-2"]);
	});

	it("falls back to the least loaded slot when the owner is not available", () => {
		const groups = groupUnits(unitsOf(tasks));
		const plan = assignGroups(groups, [1], () => 0);
		assert.equal(plan.size, 1);
		assert.equal(plan.get(1)!.length, 3);
	});

	it("lists unresolved review findings that touch the assigned tasks (or no task) in the brief", () => {
		const units = unitsOf(tasks).filter((unit) => unit.task.id === "Task-2");
		const brief = buildWorkerBrief({
			ex: {
				planPath: "/p/PLAN_v1.md",
				items: parseChecklist(PLAN),
				tasks,
				audit: {
					findings: [
						{ id: "F-001", severity: "high", taskIds: ["Task-2"], note: "report drops the last row" },
						{ id: "F-002", severity: "medium", taskIds: ["Task-1"], note: "belongs to someone else" },
						{ id: "F-003", severity: "low", taskIds: [], note: "unmapped naming nit" },
					],
				},
			} as never,
			workerLabel: "executor-2",
			workerCount: 2,
			units,
			otherOpenIds: [],
			repairNotes: [],
		});
		assert.match(brief, /Unresolved review findings you must address/);
		assert.match(brief, /- F-001 \(high\) \[Task-2\]: report drops the last row/);
		assert.match(brief, /- F-003 \(low\): unmapped naming nit/);
		assert.doesNotMatch(brief, /F-002/);
		const clean = buildWorkerBrief({ ex: { planPath: "/p", items: parseChecklist(PLAN), tasks, audit: { findings: [] } } as never, workerLabel: "executor", workerCount: 1, units, otherOpenIds: [], repairNotes: [] });
		assert.doesNotMatch(clean, /Unresolved review findings/);
	});

	it("writes a brief with the assignment, files, parallel workers and the report contract", () => {
		const units = unitsOf(tasks).filter((unit) => unit.task.id === "Task-2");
		const brief = buildWorkerBrief({
			ex: { planPath: "/p/PLAN_v1.md", items: parseChecklist(PLAN), tasks } as never,
			workerLabel: "executor-2",
			workerCount: 2,
			units,
			otherOpenIds: ["Task-1", "Task-3"],
			repairNotes: ["VC-001 failed"],
		});
		assert.match(brief, /worker executor-2 of 2/);
		assert.match(brief, /- Task-2: report — files: lib\/b\.js/);
		assert.match(brief, /Other workers are implementing Task-1, Task-3 in parallel/);
		assert.match(brief, /plans_update_task/);
		assert.match(brief, /VC-002/);
		assert.match(brief, /Repair brief from the supervisor[\s\S]*VC-001 failed/);
	});
});
