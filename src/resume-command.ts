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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { loadExecutionFromCheckpoint } from "./exec.ts";
import { bindRun } from "./run-context.ts";
import { acquireOwnership, OwnershipError, releaseOwnership } from "./run-ownership.ts";
import { loadConfig, resolveStateRootOrNull, setRunStatus, updateRunWorkdir } from "./state.ts";
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

/** One kickoff per invocation; repeat invocations are blocked by the idle check. */
let inFlight = false;

export async function resumePlansCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	baseDir: string,
): Promise<void> {
	if (inFlight) {
		ctx.ui.notify("/resume-plans is already running in this session.", "info");
		return;
	}
	inFlight = true;
	try {
		await run(pi, ctx, baseDir);
	} finally {
		inFlight = false;
	}
}

async function run(pi: ExtensionAPI, ctx: ExtensionContext, baseDir: string): Promise<void> {
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

	let candidate = pickDefaultCandidate(ctx.cwd, candidates);
	if (candidate === null) {
		const labels = candidates.map((entry, index) => {
			const cross = entry.crossWorktree ? " · cross-worktree" : "";
			const plan = entry.planVersion !== null ? `PLAN v${entry.planVersion}` : "no plan";
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
			`Checkpoint for ${candidate.runId} is corrupt (${candidate.checkpointError ?? "unknown"}). Repair or remove .git/pi_plans/runs/${candidate.runId}/checkpoint.json explicitly; nothing was changed.`,
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

		const brief = await buildBrief(pi, ctx, baseDir, candidate);
		if (brief === null) {
			releaseOwnership(ctx.cwd, candidate.runId, ownerToken);
			return; // buildBrief reported the specific problem
		}

		// Exactly one kickoff (R-007). The idle re-check happens above and in
		// buildBrief's dialogs; the message itself starts the continuation.
		await pi.sendUserMessage(brief.text);
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
	let artifactRoot = config.artifact_root;
	if (!path.isAbsolute(artifactRoot)) artifactRoot = path.resolve(workdir, artifactRoot);
	const sourceDir = candidate.run.artifact_dir;
	if (!existsSync(sourceDir)) return null;
	// Artifacts already in a shared location stay put.
	const gitRoot = findGitCommonDir(workdir);
	if (gitRoot !== null && isInside(sourceDir, path.join(gitRoot, "pi_plans"))) return sourceDir;
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
	pi: ExtensionAPI,
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
		const load = loadExecutionFromCheckpoint(pi, ctx, runId);
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
				? `\nThe code state (HEAD) changed since approval: the authorization is KEPT, but every previously verified VC must be re-verified before new work counts. Historically verified (evidence only): ${doneList}.`
				: `\nPreviously verified and still valid: ${doneList}.`;
			const paused = load.pausedReason ? `\nExecution was paused: ${load.pausedReason}. Continue from where it stopped.` : "";
			return {
				phaseLabel: "executing",
				text: `[PI-PLANS RESUME] Execution of run ${runId} continues in this session.\nPlan: ${load.planPath}${reverify}${paused}\nFollow the execution-loop contract: implement in dependency order, verify each VC, and mark completions with [DONE:VC-xxx]. The remaining checklist is injected each turn.`,
			};
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
		const review = cp.implementationReview;
		const condition = review?.terminationCondition;
		const lines: string[] = [
			`[PI-PLANS RESUME] Implementation review of run ${runId} continues in this session.`,
			`Plan: ${cp.plan?.path ?? "(unknown)"}`,
		];
		if (condition === undefined) {
			lines.push(
				`The termination condition was never chosen. Ask it now via ask_choice (autoComplete: false, questionId: "termination-condition"): "How should the implementation-review loop terminate?" Options: goal wait (recommended) / until no high-severity finding (hard cap 5 rounds) / 1 / 2 / 3 rounds. Then persist with plans record-checkpoint (checkpoint: { transition: "implementation-review-configured", terminationCondition: ... }).`,
			);
		} else {
			lines.push(`Termination condition: ${condition}`);
			lines.push(`Completed rounds in this worktree: ${review?.completedRounds ?? 0} (hard cap 5).`);
		}
		const currentRound = review?.currentRoundId
			? cp.reviewRounds.find((round) => round.roundId === review.currentRoundId)
			: undefined;
		if (currentRound) {
			const done = currentRound.lanes.filter((lane) => lane.status === "complete").map((lane) => lane.laneId);
			const pending = currentRound.lanes.filter((lane) => lane.status !== "complete").map((lane) => lane.laneId);
			lines.push(
				`Round ${currentRound.roundId} is in flight — complete lanes: ${done.join(", ") || "none"}; pending/failed lanes: ${pending.join(", ") || "none"}. Resume it with refine (role: "reviewer", target: "implementation", resumeRoundId: "${currentRound.roundId}") so completed lanes are reused, never re-run.`,
			);
		} else {
			lines.push(
				`Start the next round with refine (role: "reviewer", target: "implementation") — do NOT pass a resumeRoundId unless resuming an interrupted round.`,
			);
		}
		lines.push(
			`Record boundaries with plans record-checkpoint: review-consolidated → implementation-round-finished per round; completed (with evidence) when the termination condition is met.`,
		);
		return { phaseLabel: "implementation-review", text: lines.join("\n") };
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
		lines.push(`Current plan: ${cp.plan.path} (v${cp.plan.version}, digest ${cp.plan.sha256.slice(0, 12)}…). Higher versions in the directory are NOT approved for execution without a new handoff.`);
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
	if (candidate.run.status === "done") {
		const ok = await ctx.ui.confirm(
			"Finished run with review artifacts",
			`${candidate.runId} is marked done and has review records, but completion of the implementation-review loop cannot be proven for legacy runs. Resume the review loop anyway?`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled; nothing was changed.", "info");
			return null;
		}
		lines.push(
			`Resume the implementation-review loop: ask the termination condition (questionId: "termination-condition") if unknown, then run rounds with refine (target: "implementation").`,
		);
	}
	lines.push(`Continue only the missing work; never restart the interview from scratch.`);
	return { phaseLabel: candidate.phaseLabel, text: lines.join("\n") };
}
