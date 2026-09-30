/**
 * Planning write guard: while a planning run is active (status planning or
 * accepted) and execution has not been approved, edit/write may only target
 * planning artifacts — the pi-plans state dir, the active run's artifact
 * directory, and the pi-plans reference cache. Other runs' artifact
 * directories are denied outright, including when they sit inside the state
 * root (the default artifact root does).
 */

import * as os from "node:os";
import * as path from "node:path";
import { activeInfoById } from "./run-context.ts";
import { getRun, listRuns, loadConfig, readActive, resolveStateRootOrNull } from "./state.ts";

const GUARDED_TOOLS = new Set(["write", "edit"]);
const GUARDED_STATUSES = new Set(["planning", "accepted"]);

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
	const active =
		input.activeRunId !== undefined && input.activeRunId !== null
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

	// The artifact root defaults inside the state root, so the blanket stateRoot
	// allowance above also covers every other run's plans. Deny those explicitly
	// before the allowed check: a run's artifacts stay read-only for the session
	// that is not bound to that run, wherever the artifact root lives.
	const otherRunArtifactDirs = listRuns(input.workdir)
		.filter((run) => run.run_id !== active.run_id)
		.map((run) => path.resolve(input.workdir, run.artifact_dir));
	if (otherRunArtifactDirs.some((dir) => target === dir || target.startsWith(`${dir}${path.sep}`))) {
		return `pi-plans: planning artifacts of other runs are read-only while "${active.run_id}" is active. Bind the run you mean via /resume-plans, or pick the run explicitly.`;
	}
	if (allowed) return null;

	return `pi-plans: active planning run "${active.run_id}" is read-only outside planning artifacts (this session is not bound to it; if you are operating on a different run, bind it via /resume-plans or pick the run explicitly). Allowed write roots: ${allowedRoots.join(", ")}. Finish planning and get execution approval (execute_plan tool or /plans-execute), or abandon the run (/plans-abandon).`;
}
