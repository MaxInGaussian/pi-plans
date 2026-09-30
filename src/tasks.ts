/**
 * Task-tree runtime model (v0.6.1): the execution phase tracks plan tasks
 * (`## Tasks`) as the unit of progress. Status flows in exclusively through
 * the task status tool; completion of the whole run is gated by the
 * independent completion auditor over the plan's verification checks.
 */

import type { CheckItem, PlanTasks, TaskNode, WaveEntry } from "./plan.ts";
import { extractTaskCoverage, flattenTasks, resolveTaskWaves } from "./plan.ts";

export type TaskStatus = "pending" | "complete" | "skipped";

export interface TaskProgress {
	status: TaskStatus;
	/** Evidence recorded with the completion/skip (tool call payload). */
	evidence?: string;
	/** Skip reason, present only for skipped tasks. */
	skipReason?: string;
}

/** Runtime view of one task node: plan metadata merged with live status. */
export interface TaskView {
	id: string;
	title: string;
	wave: number;
	deps: string[];
	files: string[];
	status: TaskStatus;
	evidence?: string;
	skipReason?: string;
	children: TaskView[];
}

/** Serializable progress map persisted in the run checkpoint. */
export type TaskProgressMap = Record<string, TaskProgress>;

/** Build the runtime task tree from parsed plan tasks + persisted progress. */
export function buildTaskView(planTasks: PlanTasks, progress?: TaskProgressMap): TaskView[] {
	const waves = resolveTaskWaves(planTasks);
	const build = (node: TaskNode): TaskView => {
		const state = progress?.[node.id];
		const children = node.children.map(build);
		return {
			id: node.id,
			title: node.title,
			wave: waves.get(node.id) ?? 1,
			deps: node.deps,
			files: node.files,
			status: state?.status ?? "pending",
			evidence: state?.evidence,
			skipReason: state?.skipReason,
			children,
		};
	};
	return planTasks.tasks.map(build);
}

export function flattenTaskViews(tasks: TaskView[]): TaskView[] {
	const out: TaskView[] = [];
	for (const t of tasks) {
		out.push(t);
		out.push(...flattenTaskViews(t.children));
	}
	return out;
}

/** A task counts as terminal when it is skipped, or complete together with
 * every child (parents close last; an open child reopens the parent for
 * scheduling purposes even if the parent itself reported complete). */
export function taskIsTerminal(task: TaskView): boolean {
	if (task.status === "skipped") return true;
	if (task.status !== "complete") return false;
	return task.children.every((child) => taskIsTerminal(child));
}

export function allTasksTerminal(tasks: TaskView[]): boolean {
	return flattenTaskViews(tasks).length > 0 && flattenTaskViews(tasks).every((task) => taskIsTerminal(task));
}

/** Snapshot of statuses for persistence and stall detection. */
export function taskProgressMap(tasks: TaskView[]): TaskProgressMap {
	const map: TaskProgressMap = {};
	for (const task of flattenTaskViews(tasks)) {
		if (task.status === "pending" && task.evidence === undefined && task.skipReason === undefined) continue;
		map[task.id] = {
			status: task.status,
			evidence: task.evidence,
			skipReason: task.skipReason,
		};
	}
	return map;
}

/** Progress aggregation for the dashboard: done counts terminal tasks. */
export function taskProgress(tasks: TaskView[]): { done: number; total: number } {
	const flat = flattenTaskViews(tasks);
	return {
		done: flat.filter((task) => taskIsTerminal(task)).length,
		total: flat.length,
	};
}

/** The current task: the first non-terminal task in wave order, then
 * document order (top-level-first; subtasks close before their parent is
 * re-listed). Deterministic; used for the ▸ anchor in the dashboard and
 * the per-turn injection. */
export function currentTask(tasks: TaskView[]): TaskView | null {
	const flat = flattenTaskViews(tasks);
	const open = flat.filter((task) => !taskIsTerminal(task));
	if (open.length === 0) return null;
	open.sort((a, b) => (a.wave - b.wave) || (flat.indexOf(a) - flat.indexOf(b)));
	return open[0] ?? null;
}

/** Tasks of one wave (top-level only — children belong to their parent). */
export function waveTasks(tasks: TaskView[], wave: number): TaskView[] {
	return tasks.filter((task) => task.wave === wave);
}

export function maxWave(tasks: TaskView[]): number {
	return flattenTaskViews(tasks).reduce((max, task) => Math.max(max, task.wave), 1);
}

/** Legal status transitions for the task status tool: pending may close
 * (complete/skipped); closed states are immutable except through the
 * completion-audit flow (never through the task tool). */
export function canTransition(task: TaskView, next: TaskStatus): boolean {
	if (task.status === next) return false;
	if (task.status === "pending") return next === "complete" || next === "skipped";
	return false;
}

/** Rollback set for a failed verification check: every task in its covers
 * clause (parents cascade to their children, skipped tasks reopen too).
 * Returns the ids that actually reopen. */
export function auditRollbackSet(
	tasks: TaskView[],
	checklist: CheckItem[],
	vcId: string,
): string[] {
	const vc = checklist.find((item) => item.id === vcId);
	if (!vc) return [];
	const covered = new Set(extractTaskCoverage(vc.text));
	const flat = flattenTaskViews(tasks);
	const reopen: string[] = [];
	const reopenNode = (node: TaskView): void => {
		if (node.status !== "pending") {
			node.status = "pending";
			node.evidence = undefined;
			node.skipReason = undefined;
			reopen.push(node.id);
		}
		for (const child of node.children) reopenNode(child);
	};
	for (const node of flat) {
		if (covered.has(node.id)) reopenNode(node);
	}
	return reopen;
}

/** Verification checks that cover no task are excluded from audit (their
 * pass state cannot be derived from task statuses). */
export function auditableChecks(checklist: CheckItem[], tasks: TaskView[]): CheckItem[] {
	const known = new Set(flattenTaskViews(tasks).map((task) => task.id));
	return checklist.filter((item) => {
		const covered = extractTaskCoverage(item.text);
		return covered.length > 0 && covered.some((id) => known.has(id));
	});
}

/** Checks with at least one skipped covered task whose remaining covered
 * tasks are all complete (I-007: a skip whose siblings carry the delivery
 * passes without an audit round). Pure-complete and pure-pending coverages
 * are NOT presolved here — the former the audit affirms, the latter cannot
 * arise once all tasks are terminal. */
export function skippedPassCheckIds(checklist: CheckItem[], tasks: TaskView[]): string[] {
	const byId = new Map(flattenTaskViews(tasks).map((task) => [task.id, task]));
	return auditableChecks(checklist, tasks)
		.filter((item) => {
			const covered = extractTaskCoverage(item.text).filter((id) => byId.has(id));
			if (covered.length === 0) return false;
			const statuses = covered.map((id) => byId.get(id)!.status);
			return statuses.includes("skipped")
				&& statuses.every((status) => status === "skipped" || status === "complete");
		})
		.map((item) => item.id);
}

export type { PlanTasks, TaskNode, WaveEntry };
