/**
 * The /resume-plans command (I-006): discover the worktree's working plan,
 * restore it into the CURRENT session, and kick exactly one continuation.
 *
 * Guarantees (PLAN_v2):
 * - D-009: busy sessions or a run actively owned elsewhere only notify — no
 *   queueing, no interruption, no takeover.
 * - R-009: print/json sessions never run the flow; corrupt checkpoints and
 *   missing files report and change nothing.
 * - D-007: cross-worktree resumes require explicit confirmation; artifacts
 *   copy without overwriting; approval and VC validity reset.
 * - R-007: after every dialog the world is re-checked; one kickoff max.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { loadExecutionFromCheckpoint } from "./exec.ts";
import { formatReviewBudget, isReviewPauseReason, unlimitedHardCapCeiling } from "./review-budget.ts";
import { bindRun, boundRunId } from "./run-context.ts";
import { acquireOwnership, OwnershipError, releaseOwnership } from "./run-ownership.ts";
import { loadConfig, resolveArtifactRoot, resolveStateRootOrNull, setRunStatus, updateRunWorkdir } from "./state.ts";
import {
	applyMigration,
	mutateCheckpoint,
	resolveHeadAt,
	resolveWorktreeRoot,
	sha256File,
	type WorkflowCheckpoint,
} from "./workflow-state.ts";
import {
	listResumeCandidates,
	pickDefaultCandidate,
	readDecisionLedger,
	reconcileCheckpointWithLedger,
	type ResumeCandidate,
} from "./resume.ts";
import { messaging } from "./messaging.ts";

/** One kickoff per invocation; repeat invocations are blocked by the idle check. */
let inFlight = false;

export async function resumePlansCommand(
	ctx: ExtensionContext,
	baseDir: string,
): Promise<void> {
	if (inFlight) {
		ctx.ui.notify("/resume-plans is already running in this session.", "info");
		return;
	}
	inFlight = true;
	try {
		await run(ctx, baseDir);
	} finally {
		inFlight = false;
	}
}

async function run(ctx: ExtensionContext, baseDir: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify?.("/resume-plans needs an interactive session (TUI/RPC); print/json cannot resume.", "warning");
		return;
	}
	if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
		ctx.ui.notify("Agent is busy; run /resume-plans again once the current turn finishes.", "warning");
		return;
	}

	const candidates = listResumeCandidates(ctx.cwd);
	const corrupt = candidates.filter((candidate) => candidate.checkpointStatus === "corrupt");
	if (candidates.length === 0) {
		ctx.ui.notify("No resumable pi-plans run found in this repository.", "info");
		return;
	}

	// v0.6.0 (D-1): a session-bound resumable run resumes directly; the
	// active-pointer auto-win is gone — ambiguity opens the descriptive form.
	const bound = boundRunId(ctx.sessionManager, ctx.cwd);
	const boundCandidate = bound ? candidates.find((candidate) => candidate.runId === bound) ?? null : null;
	let candidate = boundCandidate ?? pickDefaultCandidate(ctx.cwd, candidates);
	if (candidate === null) {
		const labels = candidates.map((entry, index) => {
			const cross = entry.crossWorktree ? " · cross-worktree" : "";
			const plan = entry.planStream
				? `PLAN ${entry.planStream} round ${entry.planVersion ?? 0}`
				: entry.planVersion !== null
					? `PLAN v${entry.planVersion}`
					: "no plan";
			const corruptMark = entry.checkpointStatus === "corrupt" ? " · ⚠ corrupt checkpoint" : "";
			return `${index + 1}. ${entry.runId} · ${entry.phaseLabel} · ${plan}${cross} · ${entry.updatedAt}${corruptMark}`;
		});
		const selected = await ctx.ui.select("Resume which run?", labels);
		if (selected === undefined) {
			ctx.ui.notify("Cancelled; nothing was changed.", "info");
			return;
		}
		const index = labels.indexOf(selected);
		candidate = candidates[index] ?? null;
		if (candidate === null) {
			ctx.ui.notify("Cancelled; nothing was changed.", "info");
			return;
		}
	}

	// Re-check the world after the dialog (R-007).
	if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
		ctx.ui.notify("Agent became busy; run /resume-plans again once the current turn finishes.", "warning");
		return;
	}
	if (candidate.checkpointStatus === "corrupt") {
		ctx.ui.notify(
			`Checkpoint for ${candidate.runId} is corrupt (${candidate.checkpointError ?? "unknown"}). Repair or remove .git/pi-plans/runs/${candidate.runId}/checkpoint.json explicitly; nothing was changed.`,
			"error",
		);
		return;
	}

	// Cross-worktree confirmation + artifact migration (D-007/F-003).
	const crossWorktree = candidate.crossWorktree;
	if (crossWorktree) {
		const source = candidate.checkpoint?.worktreeRoot ?? candidate.run.workdir;
		const ok = await ctx.ui.confirm(
			"Resume this run in the CURRENT worktree?",
			`Run ${candidate.runId} was working in:\n  ${source}\nYou are in:\n  ${path.resolve(ctx.cwd)}\n\nPlanning artifacts are copied (never overwritten); the old execution approval and verified VCs are reset — execution needs re-approval and the VCs are re-verified here. Implementation-review rounds restart from 0 in this worktree (the termination condition is kept).`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled; nothing was changed.", "info");
			return;
		}
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
			ctx.ui.notify("Agent became busy; run /resume-plans again once the current turn finishes.", "warning");
			return;
		}
	}

	// Ownership: a live foreign owner refuses the resume (D-009).
	let ownerToken: string | null = null;
	let ownerGeneration = 0;
	try {
		const owner = acquireOwnership(ctx.cwd, candidate.runId, { sessionId: sessionKey(ctx) });
		ownerToken = owner.processToken;
		ownerGeneration = owner.generation;
	} catch (error) {
		if (error instanceof OwnershipError) {
			ctx.ui.notify(`/resume-plans: ${error.message}`, "error");
			return;
		}
		throw error;
	}

	try {
		if (crossWorktree) {
			const migrated = migrateRunIntoCurrentWorktree(ctx.cwd, candidate);
			if (migrated === null) {
				// F-008 (implementation review): an idle session must not keep
				// the lease after an aborted migration.
				releaseOwnership(ctx.cwd, candidate.runId, ownerToken);
				ctx.ui.notify(
					`Artifact migration for ${candidate.runId} failed (target exists with conflicting content); nothing was changed.`,
					"error",
				);
				return;
			}
		}

		const brief = await buildBrief(ctx, baseDir, candidate);
		if (brief === null) {
			releaseOwnership(ctx.cwd, candidate.runId, ownerToken);
			return; // buildBrief reported the specific problem
		}

		// Exactly one kickoff (R-007). The idle re-check happens above and in
		// buildBrief's dialogs; the message itself starts the continuation.
		await messaging().sendUserMessage(brief.text);
		ctx.ui.notify(`Resumed ${candidate.runId} (${brief.phaseLabel}).`, "info");
	} catch (error) {
		releaseOwnership(ctx.cwd, candidate.runId, ownerToken);
		throw error;
	}
}

function sessionKey(ctx: ExtensionContext): string {
	const session = ctx.sessionManager as unknown as { getSessionId?: () => string };
	try {
		return session.getSessionId?.() ?? null ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** Non-overwriting artifact copy into the current artifact root (D-007). */
export function migrateRunIntoCurrentWorktree(workdir: string, candidate: ResumeCandidate): string | null {
	const stateRoot = loadConfigShared(workdir);
	if (stateRoot === null) return null;
	const config = loadConfig(stateRoot);
	const artifactRoot = resolveArtifactRoot(workdir, config.artifact_root);
	const sourceDir = candidate.run.artifact_dir;
	if (!existsSync(sourceDir)) return null;
	// Artifacts already in a shared location stay put.
	const gitRoot = findGitCommonDir(workdir);
	if (gitRoot !== null && isInside(sourceDir, path.join(gitRoot, "pi-plans"))) return sourceDir;
	const targetDir = path.join(artifactRoot, path.basename(sourceDir));
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const from = path.join(sourceDir, entry.name);
		const to = path.join(targetDir, entry.name);
		if (!existsSync(to)) continue;
		// F-003 (implementation review): an existing target with DIFFERING
		// content aborts the migration — ownership and references never move
		// onto foreign bytes. Identical bytes are a harmless no-op.
		let same = false;
		try {
			same = fs.readFileSync(from, "utf8") === fs.readFileSync(to, "utf8");
		} catch {
			return null;
		}
		if (!same) return null;
	}
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const from = path.join(sourceDir, entry.name);
		const to = path.join(targetDir, entry.name);
		if (existsSync(to)) continue; // identical bytes: skip
		fs.mkdirSync(targetDir, { recursive: true });
		fs.copyFileSync(from, to);
	}
	// Record the migration in the checkpoint + run.json.
	const worktreeRoot = resolveWorktreeRoot(workdir) ?? path.resolve(workdir);
	mutateCheckpoint(workdir, candidate.runId, (cp) =>
		applyMigration(cp, { workdir, worktreeRoot, commonDir: gitRoot ?? path.resolve(workdir, ".git") }),
	);
	if (candidate.checkpoint?.plan) {
		// Re-point the plan reference ONLY when the copy is byte-identical to
		// the recorded digest (F-003).
		const copiedPlan = path.join(targetDir, path.basename(candidate.checkpoint.plan.path));
		if (existsSync(copiedPlan) && sha256File(copiedPlan) === candidate.checkpoint.plan.sha256) {
			mutateCheckpoint(workdir, candidate.runId, (cp) => ({
				...cp,
				plan: cp.plan ? { ...cp.plan, path: copiedPlan } : cp.plan,
			}));
		}
	}
	updateRunWorkdir(workdir, candidate.runId, workdir);
	return targetDir;
}

function loadConfigShared(workdir: string): string | null {
	return resolveStateRootOrNull(workdir);
}

function findGitCommonDir(workdir: string): string | null {
	const root = resolveStateRootOrNull(workdir);
	return root === null ? null : path.dirname(root);
}

function isInside(child: string, parent: string): boolean {
	const resolvedChild = path.resolve(child);
	const resolvedParent = path.resolve(parent);
	return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

export interface ResumeBrief {
	phaseLabel: string;
	text: string;
}

async function buildBrief(
	ctx: ExtensionContext,
	baseDir: string,
	candidate: ResumeCandidate,
): Promise<ResumeBrief | null> {
	const runId = candidate.runId;
	// F-005 reconcile (implementation review): the answered ledger entry wins
	// over a stale pending question left by a crash between the two writes.
	const cp = candidate.checkpoint === null
		? null
		: reconcileCheckpointWithLedger(ctx.cwd, runId, candidate.checkpoint);
	const run = candidate.run;

	if (cp === null) {
		// Legacy run (R-008): rebuild context from artifacts; ask the user
		// only for the missing essentials.
		return buildLegacyBrief(ctx, baseDir, candidate);
	}

	if (cp.phase === "completed") {
		ctx.ui.notify(`${runId} is completed; nothing to resume.`, "info");
		return null;
	}

	bindRun(ctx.sessionManager, ctx.cwd, runId);

	if (cp.phase === "executing") {
		const load = loadExecutionFromCheckpoint(ctx, runId);
		if (load.status === "loaded") {
			if (run.status === "stopped" || run.status === "accepted") {
				try {
					setRunStatus(ctx.cwd, runId, "executing");
				} catch {
					/* best-effort */
				}
			}
			const doneList = (load.doneVcIds ?? []).join(", ") || "none";
			const reverify = load.reverifyAll
				? `\nThe code state (HEAD) changed since approval: the authorization is KEPT, but every previously closed task was re-opened and must be re-done. Historically verified checks (evidence only): ${doneList}.`
				: `\nPreviously verified and still valid: ${doneList}.`;
			// v0.9.3: one shared predicate for every review pause (numeric
			// exhaustion, the unlimited hard cap, the no-progress valve) — the
			// three prefixes live in src/review-budget.ts so this surface can
			// never drift from the pause writer (round-1 F-007).
			const paused = load.pausedReason
				? isReviewPauseReason(load.pausedReason)
					? `\nExecution had been paused: ${load.pausedReason} — this pause survives the resume; run /plans-execute to grant a fresh review budget (it re-opens the round-count picker).`
					: `\nExecution had been paused: ${load.pausedReason} — the pause is cleared by this resume; continue from where it stopped.`
				: "";
			// v0.9.3 (Q-5): the brief repeats the budget and marks the no-UI
			// fallback, so a resumed run never hides which bound is in force.
			const budgetLine = load.reviewBudget !== undefined
				? `\nExecution review budget: ${formatReviewBudget(load.reviewBudget)}${load.reviewBudgetDefaulted ? " (default)" : ""}${
						load.reviewBudget === "unlimited"
							? ` · hard cap ${unlimitedHardCapCeiling({ reviewRoundsTotal: load.reviewRoundsTotal ?? 0, reviewCapExtension: load.reviewCapExtension ?? 0 })} rounds (spent ${load.reviewRoundsTotal ?? 0})`
							: ""
					}.`
				: "";
			const legacy = load.legacyPlan ? "\nThis plan parses through the legacy I-### compatibility mapping; upgrade it to the ## Tasks format at the next revision." : "";
			// v0.9.1 (F-005): outstanding highs surface in the brief itself, not
			// only in the per-turn injection.
			const highs = (load.findings ?? []).filter((f) => f.severity === "high");
			const highLine = highs.length > 0
				? `\nUnresolved high-severity findings from review round (stable ids): ${highs.map((f) => `${f.id}${f.taskIds.length ? ` (${f.taskIds.join(", ")})` : ""}: ${f.note}`).join("; ")} — fix them, then re-close the affected tasks.`
				: "";
			const blockedLine = (load.blocked?.tasks.length ?? 0) > 0
				? `\nReview blocked: ${load.blocked!.tasks.join(", ")} ${load.blocked!.tasks.length === 1 ? "was" : "were"} reopened by execution review round ${load.blocked!.round} and ${load.blocked!.tasks.length === 1 ? "is" : "are"} still open — close ${load.blocked!.tasks.length === 1 ? "it" : "them"} with plans_update_task (complete + evidence, or skipped + skipReason); the review starts by itself once every task is terminal. No review round is running while these are open.`
				: "";
			// v0.8: a verifying run keeps checkpoint phase "executing" but the run
			// STATUS is verifying — surface which loop owns the run right now.
			const verifying = run.status === "verifying";
			return {
				phaseLabel: verifying ? "verifying" : "executing",
				text: `[PI-PLANS RESUME] ${verifying ? "Execution review of" : "Execution of"} run ${runId} continues in this session.\nPlan: ${load.planPath}${reverify}${budgetLine}${paused}${legacy}${highLine}${blockedLine}\n${verifying ? "The task tree is terminal and the execution-review loop owns the run: when all tasks are terminal and checks are still owed, a read-only reviewer round runs automatically (status verifying → done when every check passes). If a check fails, its tasks roll back to pending — fix and re-close them with plans_update_task." : "Follow the execution-loop contract: work through tasks in wave order, report every task with the plans_update_task tool (status + evidence / skipReason), and let the execution reviewer verify the checks. The current wave and remaining tasks are injected each turn."}`,
			};
		}
		if (load.legacyDelegate) {
			ctx.ui.notify(
				`Cannot resume ${runId} directly: it was mid-flight under a v0.6.0 delegated executor (removed in v0.6.1). Run /plans-execute to re-approve the handoff; execution restarts from the first task (0.6.0 progress cannot map onto the task tree).`,
				"warning",
			);
			return null;
		}
		if (load.status === "plan-missing" || load.status === "plan-mismatch") {
			ctx.ui.notify(`Cannot resume ${runId}: ${load.error ?? "plan file missing"}.`, "error");
			return null;
		}
		if (load.status === "corrupt") {
			ctx.ui.notify(`Cannot resume ${runId}: corrupt checkpoint (${load.error}).`, "error");
			return null;
		}
		ctx.ui.notify(`Cannot resume ${runId}: no in-flight execution in the checkpoint.`, "error");
		return null;
	}

	if (cp.phase === "implementation-review") {
		// v0.6.1 (D-018/D-020): the implementation-review loop is gone; a
		// legacy 0.6.0 checkpoint in this phase maps to execution completed.
		// The run flips to done so the status line and run registry agree.
		try {
			setRunStatus(ctx.cwd, runId, "done");
		} catch {
			/* best-effort */
		}
		ctx.ui.notify(
			`${runId} finished under the removed v0.6.0 implementation-review loop; mapped to done. Its historical acceptance stands; no review loop to resume.`,
			"info",
		);
		return null;
	}

	// planning / reviewing: rebuild the workflow context (R-002/R-003).
	const skillDir = path.join(baseDir, "skills", run.skill);
	const skillPath = existsSync(path.join(skillDir, "SKILL.md"))
		? path.join(skillDir, "SKILL.md")
		: path.join(baseDir, "skills", "planning", "SKILL.md");
	const lines: string[] = [
		`[PI-PLANS RESUME] Planning run ${runId} continues in this session (phase: ${cp.phase}).`,
		`Original request: ${run.request_text}`,
		`Skill: read ${skillPath} and follow its contract (do NOT re-run start-run; this run already exists).`,
		`Artifact directory: ${run.artifact_dir}`,
	];
	if (cp.plan) {
		const streamLabel = cp.plan.stream ? `${cp.plan.stream} round ${cp.plan.version}` : `v${cp.plan.version}`;
		lines.push(`Current plan: ${cp.plan.path} (${streamLabel}, digest ${cp.plan.sha256.slice(0, 12)}…). Higher versions in the directory are NOT approved for execution without a new handoff.`);
	} else {
		lines.push("No plan version recorded yet — continue the interview.");
	}
	const answered = cp.answeredQuestions;
	if (answered.length > 0) {
		lines.push(`Already answered (do NOT re-ask):`);
		for (const entry of answered.slice(-12)) {
			lines.push(`- [${entry.questionId}] ${entry.answer} (${entry.source})`);
		}
	}
	if (cp.pendingQuestion) {
		lines.push(
			`PENDING question (re-ask exactly this via ask_choice with the same questionId): [${cp.pendingQuestion.questionId}] ${cp.pendingQuestion.question} Options: ${cp.pendingQuestion.options.join(" / ")}`,
		);
	}
	if (cp.pendingQuestions.length > 0) {
		lines.push(
			`PENDING batch (${cp.pendingQuestions.length} questions; re-ask via one ask_choice call with the same questions[] and questionIds): ${cp.pendingQuestions
				.map((q) => `[${q.questionId}] ${q.question}`)
				.join(" / ")}`,
		);
	}
	for (const round of cp.reviewRounds) {
		if (round.consolidated) continue;
		const done = round.lanes.filter((lane) => lane.status === "complete").map((lane) => lane.laneId);
		const pending = round.lanes.filter((lane) => lane.status !== "complete").map((lane) => lane.laneId);
		if (done.length === 0 && pending.length === 0) continue;
		lines.push(
			`Review round ${round.roundId} (${round.role}/${round.target}) is unfinished — completed lanes: ${done.join(", ") || "none"}; pending: ${pending.join(", ") || "none"}. Resume with refine (resumeRoundId: "${round.roundId}") so completed lanes are reused; then consolidate and record via plans record-checkpoint (transition: "review-consolidated").`,
		);
	}
	lines.push(`Next action: ${cp.nextAction}. Continue the planning workflow — only the missing work, never a full restart.`);
	return { phaseLabel: cp.phase, text: lines.join("\n") };
}

/** Legacy runs without checkpoints (R-008): rebuild what is provable, ask for the rest. */
async function buildLegacyBrief(
	ctx: ExtensionContext,
	baseDir: string,
	candidate: ResumeCandidate,
): Promise<ResumeBrief | null> {
	const run = candidate.run;
	const ledger = readDecisionLedger(ctx.cwd, candidate.runId);
	const skillDir = path.join(baseDir, "skills", run.skill);
	const skillPath = existsSync(path.join(skillDir, "SKILL.md"))
		? path.join(skillDir, "SKILL.md")
		: path.join(baseDir, "skills", "planning", "SKILL.md");
	const lines: string[] = [
		`[PI-PLANS RESUME] Legacy run ${candidate.runId} (no checkpoint) continues in this session.`,
		`Original request: ${run.request_text}`,
		`Skill: read ${skillPath} and follow its contract (do NOT re-run start-run).`,
		`Artifact directory: ${run.artifact_dir}`,
	];
	if (ledger.length > 0) {
		lines.push(`Recorded decisions (do NOT re-ask):`);
		for (const entry of ledger.slice(-12)) {
			lines.push(`- ${entry.question ?? "?"} → ${entry.answer ?? "?"}`);
		}
	}
	// F-009 (implementation review): legacy resumes bind too, so attribution
	// does not fall back to the shared pointer for the rest of the session.
	bindRun(ctx.sessionManager, ctx.cwd, candidate.runId);
	if (run.status === "executing" || run.status === "stopped") {
		const ok = await ctx.ui.confirm(
			"Legacy execution run",
			`${candidate.runId} has no durable approval evidence (created before checkpoints). Execution must be re-approved: the plan's verified progress cannot be proven, so VCs start unverified. Continue to the execution handoff question?`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled; nothing was changed.", "info");
			return null;
		}
		lines.push(
			`This run predates durable checkpoints: treat every VC as unverified and re-run the execution handoff (execute_plan or /plans-execute) for explicit approval before writing any code.`,
		);
	}
	lines.push(`Continue only the missing work; never restart the interview from scratch.`);
	return { phaseLabel: candidate.phaseLabel, text: lines.join("\n") };
}

