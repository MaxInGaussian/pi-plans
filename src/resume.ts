/**
 * Resume candidate discovery and legacy reconstruction (I-006).
 *
 * Read-only: enumerating resumable runs never mutates state. Discovery is
 * repo-wide (the shared common dir, including linked worktrees, per D-006),
 * with the active pointer as a priority hint only (D-001).
 */

import * as fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getRun, readActive, resolveStateRootOrNull, runDirPath, type RunInfo } from "./state.ts";
import { loadCheckpoint, mutateCheckpoint, type WorkflowCheckpoint } from "./workflow-state.ts";

export interface ResumeCandidate {
	runId: string;
	run: RunInfo;
	/** Checkpoint state when one exists (new runs); null for legacy runs. */
	checkpoint: WorkflowCheckpoint | null;
	checkpointStatus: "ok" | "missing" | "corrupt";
	checkpointError?: string;
	/** Resumable phase for display: checkpoint phase, else run-status-derived. */
	phaseLabel: string;
	/** True when the run's recorded workdir/worktree differs from `workdir`. */
	crossWorktree: boolean;
	planVersion: number | null;
	updatedAt: string;
}

const RESUMABLE_RUN_STATUSES = new Set(["planning", "accepted", "executing", "stopped"]);

/** Terminal runs are resumable only when unfinished implementation-review evidence exists (D-008). */
function legacyDoneResumable(run: RunInfo, checkpoint: WorkflowCheckpoint | null): boolean {
	if (checkpoint !== null) {
		return checkpoint.phase !== "completed";
	}
	// Legacy done run: resumable only with unfinished review artifacts on disk.
	const artifactDir = run.artifact_dir;
	if (!artifactDir || !existsSync(artifactDir)) return false;
	try {
		const names = fs.readdirSync(artifactDir);
		const hasReview = names.some((name) => /_reviewer_comments\.md$|_implementation_review\.md$/.test(name));
		if (!hasReview) return false;
		// Heuristic evidence of an UNFINISHED loop: an implementation review
		// record exists but the ledger shows no completed close-out. We cannot
		// prove completion for legacy runs — surface them and let the command
		// ask the user (R-008: never guess).
		return true;
	} catch {
		return false;
	}
}

function phaseLabelOf(run: RunInfo, checkpoint: WorkflowCheckpoint | null): string {
	if (checkpoint !== null) return checkpoint.phase;
	if (run.status === "stopped") return "executing (stopped)";
	return run.status;
}

function planVersionOf(checkpoint: WorkflowCheckpoint | null, run: RunInfo): number | null {
	if (checkpoint?.plan) return checkpoint.plan.version;
	// Legacy: highest PLAN_vN in the artifact dir (R-008 fallback).
	if (run.artifact_dir && existsSync(run.artifact_dir)) {
		try {
			let best: number | null = null;
			for (const name of fs.readdirSync(run.artifact_dir)) {
				const match = name.match(/^PLAN_v(\d+)\.(md|markdown)$/i);
				if (match) {
					const version = Number(match[1]);
					if (best === null || version > best) best = version;
				}
			}
			return best;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Enumerate resumable runs for the repo containing `workdir`. Corrupt
 * checkpoints are surfaced (not hidden) so the command can report them;
 * read errors never abort discovery of other runs.
 */
export function listResumeCandidates(workdir: string): ResumeCandidate[] {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return [];
	const runsDir = path.join(stateRoot, "runs");
	if (!existsSync(runsDir)) return [];
	const active = readActive(workdir);
	const candidates: ResumeCandidate[] = [];
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(runsDir);
	} catch {
		return [];
	}
	for (const runId of entries) {
		const run = getRun(workdir, runId);
		if (!run) continue;
		const runDir = runDirPath(workdir, runId);
		if (runDir === null) continue;
		const load = loadCheckpoint(workdir, runId);
		let checkpoint: WorkflowCheckpoint | null = null;
		let checkpointStatus: ResumeCandidate["checkpointStatus"] = "missing";
		let checkpointError: string | undefined;
		if (load.status === "ok") {
			checkpoint = load.checkpoint;
			checkpointStatus = "ok";
		} else if (load.status === "corrupt") {
			checkpointStatus = "corrupt";
			checkpointError = load.error;
		}
		const resumable =
			RESUMABLE_RUN_STATUSES.has(run.status) ||
			(run.status === "done" && legacyDoneResumable(run, checkpoint));
		if (!resumable) continue;
		const recordedWorkdir = checkpoint?.workdir ?? run.workdir;
		const crossWorktree = path.resolve(recordedWorkdir) !== path.resolve(workdir);
		candidates.push({
			runId,
			run,
			checkpoint,
			checkpointStatus,
			checkpointError,
			phaseLabel: phaseLabelOf(run, checkpoint),
			crossWorktree,
			planVersion: planVersionOf(checkpoint, run),
			updatedAt: checkpoint?.updatedAt ?? run.updated_at,
		});
	}
	// Active pointer first (priority, not exclusivity), then newest updated.
	candidates.sort((a, b) => {
		const aActive = active?.run_id === a.runId ? 1 : 0;
		const bActive = active?.run_id === b.runId ? 1 : 0;
		if (aActive !== bActive) return bActive - aActive;
		return b.updatedAt.localeCompare(a.updatedAt);
	});
	return candidates;
}

/** Pick the default candidate: active-unfinished first, else unique candidate (D-001). */
export function pickDefaultCandidate(workdir: string, candidates: ResumeCandidate[]): ResumeCandidate | null {
	if (candidates.length === 0) return null;
	const active = readActive(workdir);
	const activeCandidate = active ? candidates.find((candidate) => candidate.runId === active.run_id) ?? null : null;
	if (activeCandidate !== null) return activeCandidate;
	if (candidates.length === 1) return candidates[0]!;
	return null; // ambiguous: the command must ask
}

export interface DecisionLedgerEntry {
	question?: string;
	answer?: string;
	answer_source?: string;
	artifact?: string;
	questionId?: string;
	recorded_at?: string;
}

/**
 * F-005 reconcile (implementation review): a crash between the decisions-ledger
 * append and the checkpoint's pending-clear leaves the same question both
 * answered and pending. The answered ledger entry wins — drop the stale
 * pending question (ids match) and persist the reconciled checkpoint.
 */
export function reconcileCheckpointWithLedger(workdir: string, runId: string, checkpoint: WorkflowCheckpoint): WorkflowCheckpoint {
	const ledger = readDecisionLedger(workdir, runId);
	const answeredIds = new Set(
		ledger.filter((entry) => typeof entry.questionId === "string").map((entry) => entry.questionId),
	);
	if (checkpoint.pendingQuestion === null || !answeredIds.has(checkpoint.pendingQuestion.questionId)) {
		return checkpoint;
	}
	// The ledger (not the checkpoint) carries the answer: drop the stale
	// pending entry directly and persist the reconciled state.
	try {
		mutateCheckpoint(workdir, runId, (cp) =>
			cp.pendingQuestion !== null && answeredIds.has(cp.pendingQuestion.questionId)
				? { ...cp, pendingQuestion: null }
				: cp,
		);
	} catch {
		/* corrupt/missing checkpoints are handled by the caller */
	}
	return { ...checkpoint, pendingQuestion: null };
}

/** Read a legacy run's decision ledger for the resume brief (R-008). */
export function readDecisionLedger(workdir: string, runId: string): DecisionLedgerEntry[] {
	const runDir = runDirPath(workdir, runId);
	if (runDir === null) return [];
	const ledger = path.join(runDir, "decisions.jsonl");
	if (!existsSync(ledger)) return [];
	try {
		return readFileSync(ledger, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as DecisionLedgerEntry);
	} catch {
		return [];
	}
}
