/**
 * Planning write guard: while a planning run is active (status planning or
 * accepted) and execution has not been approved, edit/write may only target
 * planning artifacts — the pi-plans state dir, the active run's artifact
 * directory, and the pi-plans reference cache.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getRun, readActive, resolveStateRootOrNull } from "./state.ts";

const GUARDED_TOOLS = new Set(["write", "edit"]);
const GUARDED_STATUSES = new Set(["planning", "accepted"]);

export interface GuardInput {
	workdir: string;
	toolName: string;
	rawPath: string;
}

/** Returns a block reason when the write must be blocked, or null when allowed. */
export function planningWriteBlockReason(input: GuardInput): string | null {
	if (!GUARDED_TOOLS.has(input.toolName)) return null;
	const active = readActive(input.workdir);
	if (!active) return null;
	const run = getRun(input.workdir, active.run_id);
	if (!run || !GUARDED_STATUSES.has(run.status)) return null;

	const target = path.resolve(input.workdir, input.rawPath.replace(/^@/, ""));
	const stateRoot = resolveStateRootOrNull(input.workdir);
	const allowedRoots = [stateRoot, active.artifact_dir, path.join(os.homedir(), ".cache", "pi-plans")].filter(
		(root): root is string => root !== null,
	);
	const allowed = allowedRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
	if (allowed) return null;

	return `pi-plans: active planning run "${active.run_id}" is read-only outside planning artifacts. Allowed write roots: ${allowedRoots.join(", ")}. Finish planning and get execution approval (execute_plan tool or /plans-execute), or abandon the run (/plans-abandon).`;
}
