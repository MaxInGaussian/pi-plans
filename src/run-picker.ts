/**
 * Shared run picker (v0.6.0 multi-run support): a descriptive selector form
 * used by /plans-abandon, /plans-execute, and /resume-plans whenever more than
 * one candidate run exists in the workdir. Labels show topic · status · skill ·
 * updated_at, width-fitted; the recommended run (session binding or shared
 * active) is listed first.
 */

import * as path from "node:path";
import { readdirSync } from "node:fs";
import { boundRunId } from "./run-context.ts";
import { listRuns, TERMINAL_RUN_STATUSES, type RunSummary } from "./state.ts";
import { parseHugePlanName } from "./huge-plan.ts";
import { truncateToWidth, visibleWidth } from "./refine-ui-helpers.ts";

export interface RunPickerContext {
	cwd: string;
	sessionManager: unknown;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
	};
}

/** Pick-window budget: keep labels to one selector row in normal terminals. */
const LABEL_WIDTH_BUDGET = 88;

/** True when the run's artifact dir contains at least one plan file: the
 * legacy `PLAN_vN.md` or a plan-huge stream (`PLAN_overall_vN.md`,
 * `PLAN_vX.Y.Z_vN.md`). */
function hasPlanFile(run: RunSummary): boolean {
	try {
		return readdirSync(run.artifact_dir).some(
			(name) => /^PLAN_v\d+\.md$/i.test(name) || parseHugePlanName(name) !== null,
		);
	} catch {
		return false;
	}
}

/** Non-terminal runs (planning/accepted/executing/stopped) with ≥1 plan file. */
export function executionCandidates(workdir: string): RunSummary[] {
	return listRuns(workdir).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status) && hasPlanFile(run));
}

/** Non-terminal runs (anything that can still be abandoned). */
export function abandonCandidates(workdir: string): RunSummary[] {
	return listRuns(workdir).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
}

/** One-line descriptive label: topic · status · skill · updated_at. */
export function runPickerLabel(run: RunSummary, recommended: boolean): string {
	const label = `${recommended ? "★ " : ""}${run.topic} · ${run.status} · ${run.skill} · ${run.updated_at} · ${run.run_id}`;
	if (visibleWidth(label) <= LABEL_WIDTH_BUDGET) return label;
	return truncateToWidth(label, LABEL_WIDTH_BUDGET, "");
}

/**
 * Show the descriptive run picker. Returns the chosen RunSummary, or null when
 * cancelled / no UI. `candidates` must be pre-sorted newest-first (listRuns
 * order); the recommended run is moved to the front.
 */
export async function pickRun(
	ctx: RunPickerContext,
	options: { candidates: RunSummary[]; recommendedId?: string | null; title: string },
): Promise<RunSummary | null> {
	const candidates = [...options.candidates];
	if (options.recommendedId) {
		const index = candidates.findIndex((run) => run.run_id === options.recommendedId);
		if (index > 0) {
			const [recommended] = candidates.splice(index, 1);
			candidates.unshift(recommended);
		}
	}
	const labels = candidates.map((run) => runPickerLabel(run, run.run_id === options.recommendedId));
	const selected = await ctx.ui.select(options.title, labels);
	if (selected === undefined) return null;
	const index = labels.indexOf(selected);
	return candidates[index] ?? null;
}

/**
 * Resolve the run a command should operate on, binding-first:
 * 1. the session-bound run when it is among the candidates;
 * 2. exactly one candidate → direct (no form — 0.5.7 parity);
 * 3. zero candidates → null;
 * 4. multiple candidates → the descriptive picker (recommended = bound run).
 */
export async function resolveCommandRun(
	ctx: RunPickerContext,
	options: { candidates: RunSummary[]; title: string },
): Promise<RunSummary | null> {
	const bound = boundRunId(ctx.sessionManager, ctx.cwd);
	const boundCandidate = bound ? options.candidates.find((run) => run.run_id === bound) ?? null : null;
	if (boundCandidate !== null) return boundCandidate;
	if (options.candidates.length === 0) return null;
	if (options.candidates.length === 1) return options.candidates[0];
	return pickRun(ctx, { ...options, recommendedId: bound });
}

/** Convert a RunSummary into the ActiveInfo shape used downstream. */
export function activeInfoOf(run: RunSummary, stateRoot: string): { run_id: string; run_dir: string; artifact_dir: string } {
	return { run_id: run.run_id, run_dir: path.join(stateRoot, "runs", run.run_id), artifact_dir: run.artifact_dir };
}
