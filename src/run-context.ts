/**
 * Session-bound run attribution (I-002).
 *
 * The shared `active.json` pointer is repo-wide and races across sessions
 * and linked worktrees. This module keeps the CURRENT session's run binding
 * (keyed by the SessionManager identity so it never leaks across session
 * replacement) and resolves "the run this session is working on" with the
 * binding first, falling back to the shared pointer for sessions that never
 * bound a run (legacy behavior).
 */

import * as path from "node:path";
import { getRun, readActive, runDirPath, type ActiveInfo } from "./state.ts";

interface RunBinding {
	runId: string;
	workdir: string;
	/** SessionManager identity — stable within one session, replaced on /new, /resume, /fork. */
	session: unknown;
}

let binding: RunBinding | null = null;

/** Bind this session to a run. Called on start-run, execution start, and /resume-plans. */
export function bindRun(session: unknown, workdir: string, runId: string): void {
	binding = { runId, workdir: path.resolve(workdir), session };
}

/** Clear the binding (only the session that owns it may clear it). */
export function clearRunBinding(session: unknown): void {
	if (binding?.session === session) binding = null;
}

/** The run id bound to THIS session for THIS workdir, or null. */
export function boundRunId(session: unknown, workdir: string): string | null {
	if (binding === null) return null;
	if (binding.session !== session) return null;
	if (path.resolve(binding.workdir) !== path.resolve(workdir)) return null;
	return binding.runId;
}

/** Test isolation: drop any binding without a session identity check. */
export function resetRunBindingForTests(): void {
	binding = null;
}

/** Resolve full ActiveInfo for an explicit run id; null when the run does not exist. */
export function activeInfoById(workdir: string, runId: string): ActiveInfo | null {
	const runDir = runDirPath(workdir, runId);
	if (runDir === null) return null; // bound run vanished: fall back to the shared pointer
	const run = getRun(workdir, runId);
	if (run === null) return null;
	return { run_id: runId, run_dir: runDir, artifact_dir: run.artifact_dir };
}

/**
 * Resolve the run this session should attribute work to. A session-bound
 * run always wins; sessions without a binding keep the legacy
 * shared-pointer behavior.
 */
export function resolveActiveRun(session: unknown, workdir: string): ActiveInfo | null {
	if (session !== undefined && session !== null) {
		const runId = boundRunId(session, workdir);
		if (runId !== null) {
			const bound = activeInfoById(workdir, runId);
			if (bound !== null) return bound;
		}
	}
	return readActive(workdir);
}

/** Entry shape accepted by {@link restoreRunBindingFromSession}. */
export interface RunStartEntryLike {
	type: string;
	customType?: string;
	data?: { runId?: unknown };
}

/**
 * Restore the session's run binding from `pi-plans-run-start` entries on the
 * current branch (the same pattern autocomplete restore uses). Only entries
 * on the current branch count — abandoned branches must not steal
 * attribution.
 */
export function restoreRunBindingFromSession(session: unknown, workdir: string, entries: RunStartEntryLike[]): string | null {
	let lastRunId: string | null = null;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "pi-plans-run-start") {
			const runId = entry.data?.runId;
			if (typeof runId === "string" && runId !== "") lastRunId = runId;
		}
	}
	if (lastRunId === null) return null;
	if (runDirPath(workdir, lastRunId) === null) return null; // run deleted since
	bindRun(session, workdir, lastRunId);
	return lastRunId;
}
