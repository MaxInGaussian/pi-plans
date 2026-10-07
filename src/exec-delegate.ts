/**
 * Delegated execution: worker sessions on a model/effort the user picked at
 * the handoff do the implementation while the main session supervises.
 *
 * Progress flows through a `plans_update_task` tool that each worker session
 * receives directly. The tool closes over the live execution state, so a
 * finished task repaints the dashboard immediately — and the worker's agent
 * loop simply continues with its next task. Completion is never inferred from
 * a session ending.
 *
 * Scheduling is per wave: the open tasks of the lowest open wave are grouped
 * by shared files (so one worker owns every task touching a file), balanced
 * over the workers, and sent as a prompt. Workers keep their session across
 * waves and repair rounds; a wave only starts once the previous one is fully
 * terminal.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { agentHostOf, startAgentSession, type AgentHandle } from "./agent-session.ts";
import { openFleetGroup, type FleetRun } from "./fleet-run.ts";
import {
	STALL_MAX_ROUNDS,
	completeExecution,
	getExecution,
	pauseForStall,
	persistTaskProgress,
	recordExecutionTurn,
	setDelegateDriver,
	toggleDashboardExpanded,
	triggerOwedReview,
	updateStatusWidget,
	type DelegateDriver,
	type ExecState,
} from "./exec.ts";
import { resolveActiveRun } from "./run-context.ts";
import { recordSubagent } from "./state.ts";
import { stripFrontmatter, type SubagentResult, type SubagentUsage } from "./subagent.ts";
import { UpdateTaskParams, applyTaskUpdate } from "./task-tool.ts";
import { allTasksTerminal, flattenTaskViews, taskIsTerminal, type TaskView } from "./tasks.ts";
import { matchesTerminalKey } from "./terminal-keys.ts";
import { executorLabel, type ExecutorChoice } from "./executor-config.ts";

const EXECUTOR_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
/** One prompt may run for hours of real work; the per-run cap only catches a hang. */
const WORKER_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Consecutive failed runs of one worker before the run pauses. */
const MAX_WORKER_FAILURES = 2;

// ---------------------------------------------------------------------------
// Pure scheduling helpers
// ---------------------------------------------------------------------------

/** A top-level open task plus every non-terminal task under it. */
export interface Unit {
	task: TaskView;
	ids: string[];
	files: string[];
}

export function unitsOf(openTopLevel: TaskView[]): Unit[] {
	return openTopLevel.map((task) => {
		const nodes = flattenTaskViews([task]).filter((node) => !taskIsTerminal(node));
		return { task, ids: nodes.map((node) => node.id), files: [...new Set(flattenTaskViews([task]).flatMap((node) => node.files))] };
	});
}

/**
 * Group units that must share a worker: any two units touching a common file
 * (transitively). Units that declare no files cannot be proven disjoint from
 * anything, so they share one group.
 */
export function groupUnits(units: Unit[]): Unit[][] {
	const parent = units.map((_unit, index) => index);
	const find = (index: number): number => {
		let root = index;
		while (parent[root] !== root) root = parent[root]!;
		while (parent[index] !== root) {
			const next = parent[index]!;
			parent[index] = root;
			index = next;
		}
		return root;
	};
	const union = (a: number, b: number): void => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA !== rootB) parent[rootB] = rootA;
	};
	const firstByFile = new Map<string, number>();
	let firstWithoutFiles = -1;
	units.forEach((unit, index) => {
		if (unit.files.length === 0) {
			if (firstWithoutFiles === -1) firstWithoutFiles = index;
			else union(firstWithoutFiles, index);
			return;
		}
		for (const file of unit.files) {
			const seen = firstByFile.get(file);
			if (seen === undefined) firstByFile.set(file, index);
			else union(seen, index);
		}
	});
	const groups = new Map<number, Unit[]>();
	units.forEach((unit, index) => {
		const root = find(index);
		const group = groups.get(root) ?? [];
		group.push(unit);
		groups.set(root, group);
	});
	return [...groups.values()];
}

const weightOf = (group: Unit[]): number => group.reduce((sum, unit) => sum + unit.ids.length, 0);

/**
 * Spread groups over the given worker slots: biggest first onto the least
 * loaded slot, except that a group whose tasks were all owned by one slot
 * before goes back to it (that worker still has the context).
 */
export function assignGroups(groups: Unit[][], slots: number[], owner: (unit: Unit) => number | undefined = () => undefined): Map<number, Unit[]> {
	const load = new Map(slots.map((slot) => [slot, 0] as const));
	const result = new Map<number, Unit[]>();
	for (const group of [...groups].sort((a, b) => weightOf(b) - weightOf(a))) {
		const owners = new Set(group.map((unit) => owner(unit)).filter((slot): slot is number => slot !== undefined));
		const preferred = owners.size === 1 ? [...owners][0]! : undefined;
		let target = preferred !== undefined && load.has(preferred) ? preferred : undefined;
		if (target === undefined) {
			target = slots.reduce((best, slot) => (load.get(slot)! < load.get(best)! ? slot : best), slots[0]!);
		}
		result.set(target, [...(result.get(target) ?? []), ...group]);
		load.set(target, load.get(target)! + weightOf(group));
	}
	return result;
}

export interface BriefInput {
	ex: ExecState;
	workerLabel: string;
	workerCount: number;
	units: Unit[];
	otherOpenIds: string[];
	repairNotes: string[];
	nudge?: string;
}

export function buildWorkerBrief(input: BriefInput): string {
	const { ex, units } = input;
	const wave = Math.min(...units.map((unit) => unit.task.wave));
	const lines = units.map((unit) => {
		const children = unit.task.children.length ? ` (${unit.ids.filter((id) => id !== unit.task.id).join(", ")})` : "";
		const files = unit.files.length ? ` — files: ${unit.files.join(", ")}` : "";
		const deps = unit.task.deps.length ? ` — deps: ${unit.task.deps.join(", ")}` : "";
		return `- ${unit.task.id}${children}: ${unit.task.title}${deps}${files}`;
	});
	const done = flattenTaskViews(ex.tasks).filter((task) => taskIsTerminal(task)).map((task) => task.id);
	const checks = ex.items.map((item) => `- ${item.id}: ${item.text.length > 220 ? `${item.text.slice(0, 217)}...` : item.text}`).join("\n");
	const parts = [
		`[PI-PLANS EXECUTION — worker ${input.workerLabel} of ${input.workerCount}]`,
		`Implement your part of the accepted plan at ${ex.planPath}.`,
		`Your assigned tasks (wave ${wave}):\n${lines.join("\n")}`,
		done.length > 0 ? `Already complete: ${done.join(", ")}.` : "",
		input.otherOpenIds.length > 0
			? `Other workers are implementing ${input.otherOpenIds.join(", ")} in parallel in the same worktree. Stay inside your own tasks' files.`
			: "",
		`Report each task the moment it is done with the plans_update_task tool (taskId, status "complete" with evidence, or "skipped" with a skipReason). The tool returns at once: keep working through your remaining tasks in this same session and stop only when every assigned task is closed.`,
		`After all tasks are terminal an independent reviewer verifies these checks:\n${checks}`,
		...input.repairNotes.map((note) => `Repair brief from the supervisor (a review round reopened tasks):\n${note}`),
		input.nudge ?? "",
	];
	return parts.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface Worker {
	index: number;
	laneId: string;
	label: string;
	handle: AgentHandle | null;
	starting: Promise<AgentHandle | null> | null;
	startError: string;
	assigned: Set<string>;
	running: boolean;
	failures: number;
	stallRounds: number;
	/** Session-lifetime usage already accounted into the run. */
	accounted: SubagentUsage;
	usage: SubagentUsage | undefined;
}

const emptyUsage = (): SubagentUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function loadExecutorPrompt(): string {
	const file = new URL("../agents/executor.md", import.meta.url);
	return stripFrontmatter(fs.readFileSync(file, "utf8"));
}

function taskById(ex: ExecState, id: string): TaskView | undefined {
	return flattenTaskViews(ex.tasks).find((task) => task.id === id);
}

export class DelegateRun {
	readonly ex: ExecState;
	ctx: Parameters<DelegateDriver["resume"]>[0];
	private readonly choice: ExecutorChoice;
	private readonly workers: Worker[];
	private readonly fleetRun: FleetRun;
	private readonly systemPrompt: string;
	private readonly owners = new Map<string, number>();
	private repairNotes: string[] = [];
	disposed = false;
	private driving = false;
	private again = false;

	constructor(ctx: DelegateRun["ctx"], ex: ExecState, systemPrompt: string = loadExecutorPrompt()) {
		this.ctx = ctx;
		this.ex = ex;
		this.choice = ex.executor!;
		this.systemPrompt = systemPrompt;
		const count = Math.max(1, this.choice.workers);
		this.workers = Array.from({ length: count }, (_unused, index) => ({
			index,
			laneId: `worker-${index + 1}`,
			label: count === 1 ? "executor" : `executor-${index + 1}`,
			handle: null,
			starting: null,
			startError: "",
			assigned: new Set<string>(),
			running: false,
			failures: 0,
			stallRounds: 0,
			accounted: emptyUsage(),
			usage: undefined,
		}));
		const modelLabel = `${this.choice.model_selector ?? "?"}${this.choice.thinking_level ? `:${this.choice.thinking_level}` : ""}`;
		this.fleetRun = openFleetGroup(ctx, {
			role: "executor",
			groupId: `executor-${Date.now().toString(36)}`,
			lanes: this.workers.map((worker) => ({ id: worker.laneId, label: worker.label })),
			modelLabel,
			lang: ex.uiLanguage,
			onUnhandledKey: (data) => {
				if (matchesTerminalKey(data, "ctrl+shift+t")) toggleDashboardExpanded(this.ctx);
			},
		});
		// Until a worker gets work it is waiting, not queued.
		for (const worker of this.workers) this.fleetRun.group.setIdle(worker.laneId, true);
	}

	start(): void {
		void this.drive();
	}

	/** Clear the failure ladders and continue (the user resumed a pause). */
	reset(ctx: DelegateRun["ctx"]): void {
		this.ctx = ctx;
		for (const worker of this.workers) {
			worker.failures = 0;
			worker.stallRounds = 0;
		}
	}

	addRepair(content: string): void {
		this.repairNotes.push(content);
		void this.drive();
	}

	kick(): void {
		void this.drive();
	}

	// -- scheduling -------------------------------------------------------

	private async drive(): Promise<void> {
		if (this.disposed) return;
		if (this.driving) {
			this.again = true;
			return;
		}
		this.driving = true;
		try {
			do {
				this.again = false;
				await this.step();
			} while (this.again && !this.disposed);
		} finally {
			this.driving = false;
		}
	}

	private async step(): Promise<void> {
		const ex = getExecution();
		if (ex !== this.ex) {
			this.dispose("stopped");
			return;
		}
		if (ex.stall.paused || ex.review.inFlight || ex.review.budgetAsking) return;
		const open = ex.tasks.filter((task) => !taskIsTerminal(task));
		if (open.length === 0) {
			if (this.workers.some((worker) => worker.running)) return;
			await this.finishToReview(ex);
			return;
		}
		const busy = new Set(this.workers.flatMap((worker) => (worker.running ? [...worker.assigned] : [])));
		const wave = Math.min(...open.map((task) => task.wave));
		const waveOpen = open.filter((task) => task.wave === wave);
		const todo = waveOpen.filter((task) => !flattenTaskViews([task]).some((node) => busy.has(node.id)));
		const idle = this.workers.filter((worker) => !worker.running);
		if (todo.length === 0 || idle.length === 0) return;

		const groups = groupUnits(unitsOf(todo));
		const plan = assignGroups(groups, idle.map((worker) => worker.index), (unit) => this.owners.get(unit.task.id));
		const otherOpenIds = open.map((task) => task.id);
		for (const [slot, units] of plan) {
			const worker = this.workers[slot]!;
			const mine = new Set(units.map((unit) => unit.task.id));
			this.launch(worker, units, otherOpenIds.filter((id) => !mine.has(id)));
		}
	}

	private async finishToReview(ex: ExecState): Promise<void> {
		if (!allTasksTerminal(ex.tasks)) return;
		const chain = triggerOwedReview(this.ctx);
		if (chain) {
			chain.catch(() => {
				/* surfaced through the review messages */
			});
			return;
		}
		if (!ex.review.inFlight && !ex.review.budgetAsking && !ex.stall.paused && getExecution() === ex) {
			// Nothing is owed: every check is already satisfied.
			await completeExecution(this.ctx);
		}
	}

	private launch(worker: Worker, units: Unit[], otherOpenIds: string[], nudge?: string): void {
		worker.assigned = new Set(units.flatMap((unit) => unit.ids));
		for (const id of worker.assigned) this.owners.set(id, worker.index);
		this.runBrief(worker, buildWorkerBrief({
			ex: this.ex,
			workerLabel: worker.label,
			workerCount: this.workers.length,
			units,
			otherOpenIds,
			repairNotes: this.takeRepairNotes(),
			nudge,
		}));
	}

	private takeRepairNotes(): string[] {
		const notes = this.repairNotes;
		this.repairNotes = [];
		return notes;
	}

	private runBrief(worker: Worker, brief: string): void {
		worker.running = true;
		this.fleetRun.group.setIdle(worker.laneId, false);
		this.updateNote(worker);
		void (async () => {
			let result: SubagentResult;
			try {
				const handle = await this.ensureHandle(worker);
				result = handle
					? await handle.run(brief)
					: { ok: false, output: "", stderr: "", turns: 0, errorMessage: worker.startError || "worker session could not start" };
			} catch (error) {
				result = { ok: false, output: "", stderr: "", turns: 0, errorMessage: error instanceof Error ? error.message : String(error) };
			}
			this.afterRun(worker, result);
		})();
	}

	private openAssigned(worker: Worker): string[] {
		return [...worker.assigned].filter((id) => {
			const task = taskById(this.ex, id);
			return task !== undefined && !taskIsTerminal(task);
		});
	}

	private updateNote(worker: Worker): void {
		const total = worker.assigned.size;
		if (total === 0) return;
		const done = total - this.openAssigned(worker).length;
		this.fleetRun.group.setNote(worker.laneId, `${done}/${total} tasks`);
	}

	private account(worker: Worker, result: SubagentResult): void {
		const usage = result.usage;
		if (!usage) return;
		worker.usage = usage;
		const delta = {
			input: Math.max(0, usage.input - worker.accounted.input),
			output: Math.max(0, usage.output - worker.accounted.output),
		};
		worker.accounted = { ...usage };
		if (delta.input + delta.output > 0) {
			try {
				recordExecutionTurn(this.ctx, delta);
			} catch {
				/* usage accounting is best-effort */
			}
		}
	}

	private afterRun(worker: Worker, result: SubagentResult): void {
		worker.running = false;
		if (this.disposed) return;
		const ex = getExecution();
		if (ex !== this.ex) {
			this.dispose("stopped");
			return;
		}
		this.account(worker, result);
		this.fleetRun.group.setIdle(worker.laneId, true);
		this.updateNote(worker);
		if (!result.ok) {
			if (result.cancelled) {
				pauseForStall(this.ctx, `${worker.label} was stopped`);
				this.dispose("stopped");
				return;
			}
			worker.failures += 1;
			if (worker.failures >= MAX_WORKER_FAILURES) {
				pauseForStall(this.ctx, `${worker.label} failed: ${result.errorMessage ?? "unknown error"}`);
				return;
			}
		} else {
			worker.failures = 0;
		}
		const open = this.openAssigned(worker);
		if (open.length > 0) {
			worker.stallRounds += 1;
			if (worker.stallRounds >= STALL_MAX_ROUNDS) {
				pauseForStall(this.ctx, `${worker.label}: ${open.length} task(s) still open after ${worker.stallRounds} rounds (${open.join(", ")})`);
				return;
			}
			const units = unitsOf(this.ex.tasks.filter((task) => !taskIsTerminal(task) && flattenTaskViews([task]).some((node) => worker.assigned.has(node.id))));
			this.launch(
				worker,
				units,
				this.ex.tasks.filter((task) => !taskIsTerminal(task) && !units.some((unit) => unit.task.id === task.id)).map((task) => task.id),
				`Your run ended while ${open.join(", ")} ${open.length === 1 ? "is" : "are"} still open. Continue with them now, and close each with plans_update_task (complete with evidence, or skipped with a skipReason).`,
			);
			return;
		}
		worker.stallRounds = 0;
		void this.drive();
	}

	// -- sessions ---------------------------------------------------------

	private ensureHandle(worker: Worker): Promise<AgentHandle | null> {
		if (worker.handle) return Promise.resolve(worker.handle);
		if (!worker.starting) {
			worker.starting = (async () => {
				const started = await startAgentSession({
					systemPrompt: this.systemPrompt,
					task: "",
					cwd: this.ctx.cwd,
					host: agentHostOf(this.ctx),
					model: this.choice.model_selector ?? undefined,
					thinkingLevel: this.choice.thinking_level ?? undefined,
					tools: EXECUTOR_TOOLS,
					customTools: [this.buildTool(worker)],
					timeoutMs: WORKER_RUN_TIMEOUT_MS,
					signal: this.fleetRun.signalFor(worker.laneId),
					onProgress: (event) => this.fleetRun.group.update(worker.laneId, event),
				});
				if ("error" in started) {
					worker.startError = started.error;
					worker.starting = null;
					return null;
				}
				worker.handle = started.handle;
				return started.handle;
			})();
		}
		return worker.starting;
	}

	/** The worker's progress channel: updates the live panel and returns at
	 * once — the worker's loop continues with its next task. */
	private buildTool(worker: Worker) {
		return defineTool({
			name: "plans_update_task",
			label: "Update task",
			description:
				'Report progress for one of YOUR assigned tasks: status "complete" with evidence, or "skipped" with a skipReason. Call it the moment a task is done, then continue with your next task. Statuses are immutable once set.',
			promptSnippet: "Report completion of one assigned plan task",
			parameters: UpdateTaskParams,
			execute: async (_toolCallId, params) => {
				const ex = getExecution();
				if (this.disposed || ex !== this.ex) throw new Error("this execution is no longer live; stop working");
				if (!worker.assigned.has(params.taskId)) {
					throw new Error(`${params.taskId} is not assigned to you. Your tasks: ${[...worker.assigned].join(", ") || "(none)"}.`);
				}
				const outcome = applyTaskUpdate(ex.tasks, params.taskId, params.status, params.evidence, params.skipReason);
				if (!outcome.ok) throw new Error(outcome.message);
				worker.failures = 0;
				worker.stallRounds = 0;
				persistTaskProgress(this.ctx);
				updateStatusWidget(this.ctx);
				this.updateNote(worker);
				// Re-evaluate scheduling without blocking this worker's loop.
				void this.drive();
				const remaining = this.openAssigned(worker);
				return {
					content: [{ type: "text", text: `✓ ${outcome.message}. ${remaining.length > 0 ? `Still open for you: ${remaining.join(", ")} — continue.` : "All your assigned tasks are closed."}` }],
					details: { taskId: params.taskId, status: params.status },
				};
			},
		});
	}

	// -- teardown ---------------------------------------------------------

	dispose(outcome: "completed" | "stopped"): void {
		if (this.disposed) return;
		this.disposed = true;
		const completed = outcome === "completed";
		for (const worker of this.workers) {
			const handle = worker.handle;
			if (handle) void handle.abort().finally(() => handle.dispose());
			this.fleetRun.group.complete(worker.laneId, {
				ok: completed,
				output: completed ? `${worker.label} finished` : "",
				stderr: "",
				turns: 0,
				...(completed ? {} : { cancelled: true as const, errorMessage: "execution ended" }),
			});
		}
		this.recordLedger();
		this.fleetRun.close();
	}

	private recordLedger(): void {
		try {
			const active = resolveActiveRun(this.ctx.sessionManager, this.ctx.cwd);
			if (!active) return;
			for (const worker of this.workers) {
				if (!worker.handle) continue;
				recordSubagent(this.ctx.cwd, active.run_id, {
					role: "executor",
					name: `pi-plans-executor-${active.run_id}-${worker.laneId}`,
					model: this.choice.model_selector,
					thinking_level: this.choice.thinking_level,
					usage: worker.usage
						? { input: worker.usage.input, output: worker.usage.output, cache_read: worker.usage.cacheRead, cache_write: worker.usage.cacheWrite, cost: worker.usage.cost }
						: null,
				});
			}
		} catch {
			/* best-effort ledger */
		}
	}
}

// ---------------------------------------------------------------------------
// Driver registration
// ---------------------------------------------------------------------------

let current: DelegateRun | null = null;

const driver: DelegateDriver = {
	resume(ctx, ex) {
		if (current && !current.disposed && current.ex === ex) {
			current.reset(ctx);
			current.kick();
			return;
		}
		current?.dispose("stopped");
		if (!ex.executor || ex.executor.mode !== "delegated") return;
		current = new DelegateRun(ctx, ex);
		current.start();
	},
	repair(ctx, ex, content) {
		if (!current || current.disposed || current.ex !== ex) driver.resume(ctx, ex);
		current?.addRepair(content);
	},
	dispose(outcome) {
		current?.dispose(outcome);
		current = null;
	},
};

setDelegateDriver(driver);

/** Test seam: the live run, if any. */
export function __currentDelegateRun(): DelegateRun | null {
	return current;
}

export { executorLabel };
