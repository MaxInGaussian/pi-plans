/**
 * `plans_update_task` tool (v0.6.1): the single channel for execution-phase
 * task status reporting. Each call validates the task exists and the
 * transition is legal (pending → complete | skipped), persists progress to
 * the run checkpoint, and refreshes the dashboard. Closed statuses are
 * immutable here — rollbacks happen exclusively inside the completion-audit
 * flow in src/exec.ts (runAuditFlow), never through this tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getExecution, persistTaskProgress, updateStatusWidget } from "./exec.ts";
import { canTransition, flattenTaskViews } from "./tasks.ts";
import { StateError } from "./state.ts";

export const UpdateTaskParams = Type.Object({
	taskId: Type.String({ description: "Task id from the plan (e.g. Task-3, Task-3.1)" }),
	status: StringEnum(["complete", "skipped"] as const, { description: "New status for the task (pending is audit-only)" }),
	evidence: Type.Optional(
		Type.String({ description: "Evidence backing the completion (test command output, file paths, command result)" }),
	),
	skipReason: Type.Optional(Type.String({ description: "Why the task is skipped (required for status=skipped)" })),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

export interface UpdateTaskResult {
	ok: boolean;
	taskId: string;
	status: "complete" | "skipped";
	message: string;
}

/** Core transition logic, exported for tests. */
export function applyTaskUpdate(
	tasks: ReturnType<typeof flattenTaskViews> extends never ? never : import("./tasks.ts").TaskView[],
	taskId: string,
	status: "complete" | "skipped",
	evidence?: string,
	skipReason?: string,
): { ok: boolean; message: string } {
	const task = flattenTaskViews(tasks).find((candidate) => candidate.id === taskId);
	if (!task) {
		return { ok: false, message: `unknown task: ${taskId} (not in the plan's task tree)` };
	}
	if (status === "skipped" && !skipReason) {
		return { ok: false, message: `skipping ${taskId} requires a skipReason` };
	}
	if (!canTransition(task, status)) {
		return {
			ok: false,
			message: `${taskId} is already ${task.status}; closed tasks are immutable outside the audit rollback channel`,
		};
	}
	task.status = status;
	task.evidence = evidence;
	task.skipReason = status === "skipped" ? skipReason : undefined;
	return { ok: true, message: `${taskId} → ${status}` };
}

export function registerTaskStatusTool(ext: ExtensionAPI): void {
	ext.registerTool({
		name: "plans_update_task",
		label: "Update task",
		description:
			'Report execution progress for one task of the accepted plan: set status "complete" (with evidence) or "skipped" (with skipReason). Fails outside pi-plans execution mode. Statuses are immutable once set — the independent execution reviewer handles any rollback.',
		promptSnippet: "Report plan task completion",
		parameters: UpdateTaskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const execution = getExecution();
			if (!execution) {
				throw new StateError("no live pi-plans execution; task updates are only valid in execution mode");
			}
			const outcome = applyTaskUpdate(execution.tasks, params.taskId, params.status, params.evidence, params.skipReason);
			if (!outcome.ok) {
				throw new StateError(outcome.message);
			}
			persistTaskProgress(ctx);
			updateStatusWidget(ctx);
			const line = `✓ ${outcome.message}`;
			return {
				content: [{ type: "text", text: line }],
				details: { taskId: params.taskId, status: params.status },
			};
		},

		renderCall(args, theme) {
			const parts = [theme.bold("task "), theme.fg("accent", String(args.taskId)), theme.fg("muted", ` → ${String(args.status)}`)];
			return new Text(parts.join(""), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			return new Text(theme.fg("success", raw), 0, 0);
		},
	});
}
