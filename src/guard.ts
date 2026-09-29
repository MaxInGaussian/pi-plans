/**
 * Planning write guard: while a planning run is active (status planning or
 * accepted) and execution has not been approved, edit/write may only target
 * planning artifacts — the pi-plans state dir, the active run's artifact
 * directory, and the pi-plans reference cache.
 */

import * as os from "node:os";
import * as path from "node:path";
import { activeInfoById } from "./run-context.ts";
import { getRun, loadConfig, readActive, resolveStateRootOrNull } from "./state.ts";

const GUARDED_TOOLS = new Set(["write", "edit"]);
const GUARDED_STATUSES = new Set(["planning", "accepted"]);

/** True when running inside a delegated executor child (PI_PLANS_EXECUTOR=1). */
export function isExecutorChild(): boolean {
	return process.env.PI_PLANS_EXECUTOR === "1";
}

export interface GuardInput {
	workdir: string;
	toolName: string;
	rawPath: string;
	/** Session-bound run id (I-002); when provided it overrides the shared active pointer. null = no binding. */
	activeRunId?: string | null;
}

/** Returns a block reason when the write must be blocked, or null when allowed. */
export function planningWriteBlockReason(input: GuardInput): string | null {
	if (!GUARDED_TOOLS.has(input.toolName)) return null;
	// Delegated executor children write natively with the parent's approval
	// already recorded — the guard must never block them, even when another
	// session's planning run is the newest non-terminal run in the workdir.
	if (isExecutorChild()) return null;
	// Executor children also pin their run via PI_PLANS_RUN_ID; honor it for
	// any child that is not marked executor (defense in depth).
	const envRunId = typeof process.env.PI_PLANS_RUN_ID === "string" ? process.env.PI_PLANS_RUN_ID.trim() : "";
	const active =
		envRunId !== ""
			? activeInfoById(input.workdir, envRunId)
			: input.activeRunId !== undefined && input.activeRunId !== null
				? activeInfoById(input.workdir, input.activeRunId)
				: readActive(input.workdir);
	if (!active) return null;
	const run = getRun(input.workdir, active.run_id);
	if (!run || !GUARDED_STATUSES.has(run.status)) return null;

	const target = path.resolve(input.workdir, input.rawPath.replace(/^@/, ""));
	const stateRoot = resolveStateRootOrNull(input.workdir);
	const allowedRoots = [stateRoot, active.artifact_dir, path.join(os.homedir(), ".cache", "pi-plans")].filter(
		(root): root is string => root !== null,
	);
	// A configured refs root (plan-with-refs downloads) is writable while planning.
	if (stateRoot !== null) {
		try {
			const config = loadConfig(stateRoot);
			if (config.refs_root) {
				allowedRoots.push(
					path.isAbsolute(config.refs_root) ? config.refs_root : path.resolve(input.workdir, config.refs_root),
				);
			}
		} catch {
			/* config read failed: no extra root */
		}
	}
	const allowed = allowedRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
	if (allowed) return null;

	return `pi-plans: active planning run "${active.run_id}" is read-only outside planning artifacts (this session is not bound to it; if you are operating on a different run, bind it via /resume-plans or pick the run explicitly). Allowed write roots: ${allowedRoots.join(", ")}. Finish planning and get execution approval (execute_plan tool or /plans-execute), or abandon the run (/plans-abandon).`;
}
