/**
 * Plan-execution loop (v0.6.1): the tracked execution mode for accepted
 * plans, driven by the plan's task tree.
 *
 * When the user approves the execution handoff, the extension switches into
 * execution mode: every agent turn is injected with the current wave and
 * remaining tasks, task progress flows in exclusively through the
 * `plans_update_task` tool (status + evidence), the task dashboard shows
 * live progress (compact aboveEditor widget; Ctrl+Shift+T expands the full
 * tree), a stall watchdog pauses the run when consecutive rounds produce no
 * task-state change, and when every task reaches a terminal state an
 * independent execution reviewer verifies the plan's verification checks in
 * a detached, overlay-visible loop — failed checks roll their covered tasks
 * back to pending (audit-flow-only channel), and five committed rounds pause
 * the run for the user in every mode (fail-closed, never a silent stop).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	buildPiPlansVccCompaction,
	compactionCurrentI,
	entryCurrentIMarkers,
	formatVccCompactionStats,
	loadVccSettings,
	PLANNING_PREPLAN_COMPACT_HINT,
	scaffoldVccSettings,
	shouldScheduleAutoContinue,
	type CompactionEntryLike,
	type PiPlansCompactionPhase,
	type PiPlansVccPhaseContext,
	type PiPlansVccSettings,
	type VccCompactionBuildResult,
	type VccCompactionStats,
} from "./compaction.ts";
import {
	clearDisplacedAbort,
	consumeDisplacedAbort,
	isAbortErrorMessage,
	markPrePlanCompactPending,
	pendingDisplacedAbort,
} from "./compaction-lifecycle.ts";
import { TERMINAL_RUN_STATUSES, getRun, latestRun, lintPlanIntoNotices, listRuns, loadConfig, readActive, resolveStateRootOrNull, runDirPath, setRunStatus, StateError, utcNow } from "./state.ts";
import { resolveUiLanguage, hugeChrome, terminationChrome, type UiLanguage } from "./ui-language.ts";
import { parseHugePlanName, hugePlanFileName } from "./huge-plan.ts";
import { bindRun, resolveActiveRun } from "./run-context.ts";
import type { SubagentProgressEvent } from "./subagent.ts";
import { OwnershipError } from "./run-ownership.ts";
import {
	applyExecutionApproved,
	applyExecutionCompleted,
	applyExecutionHeadChanged,
	applyExecutionProgress,
	applyExecutionStopped,
	applyHugeVersionCompleted,
	createCheckpoint,
	applyExecutionPlanAmended,
	loadCheckpoint,
	mutateCheckpoint,
	planIdentityOf,
	resolveHeadAt,
	resolveWorktreeRoot,
	sha256File,
	StaleCheckpointError,
	type ExecutionApproval,
	type ExecutionBlocked,
	type ExecutionCheckpoint,
	type ReviewNonHighRepairState,
	type WorkflowCheckpoint,
} from "./workflow-state.ts";
import { graphBlockForExecutor } from "./code-graph/prompts.ts";
import { resolveGraphMode } from "./code-graph/mode.ts";
import {
	parseChecklist,
	parsePlanTasks,
	CHECKLIST_HEADERS,
	flattenTasks,
	type CheckItem,
	type PlanTasks,
} from "./plan.ts";
import {
	allTasksTerminal,
	auditRollbackSet,
	auditableChecks,
	blockedReviewTasks,
	buildTaskView,
	currentTask,
	findingsRollbackSet,
	flattenTaskViews,
	invalidateChecksForRolledBackTasks,
	maxWave,
	rollbackCoverageIds,
	taskIsTerminal,
	taskProgress,
	taskProgressMap,
	type TaskProgressMap,
	type TaskView,
} from "./tasks.ts";
import { isAutoApproveEnabled as isAutoApproveEnabledLocal } from "./auto-approve.ts";
import {
	DASHBOARD_WIDGET_KEY,
	deriveDashboardModel,
	formatDashboardSummaryLine,
	formatElapsed,
	renderDashboardLines,
	renderDashboardTreeLines,
	type HugeProgress,
} from "./dashboard.ts";
import { planReviewLanes, presolvedCheckIds, runCompletionAudit, writeReviewRoundReport, type AuditLane, type AuditOutcome, type AuditRoundResult, type ReviewDirection, type ReviewFinding } from "./auditor.ts";
import { askReviewerCount, DEFAULT_REVIEWER_COUNT, sanitizeDirections } from "./reviewer-count.ts";
import {
	DEFAULT_REVIEW_BUDGET,
	LEGACY_REVIEW_MAX_ROUNDS,
	NO_PROGRESS_MAX_STREAK,
	REVIEW_CAP_PAUSE_PREFIX,
	REVIEW_NO_PROGRESS_PAUSE_PREFIX,
	UNLIMITED_HARD_CAP,
	askReviewBudget,
	budgetExhausted,
	bumpNoProgress,
	formatReviewBudget,
	isReviewPauseReason,
	noProgressSignature,
	noProgressTripped,
	resolveStoredBudget,
	reviewBudgetPanelAvailable,
	unlimitedHardCapCeiling,
	type NoProgressState,
	type ReviewBudget,
} from "./review-budget.ts";
import type { ExecutionReviewers, ReviewFindingRecord } from "./workflow-state.ts";
import { staleReloadHint as probeStaleReload } from "./staleness.ts";
import { messaging } from "./messaging.ts";
import { fleetUi, fleetUiHost } from "./fleet-ui.ts";
import { executorLabel, isDelegated, type ExecutorChoice } from "./executor-config.ts";
import { openFleetGroup, type FleetRun } from "./fleet-run.ts";
import { resolveReviewerSpawn } from "./thinking-levels.ts";
import { loadGlobalConfig, reviewerReady } from "./global-state.ts";
import { matchesTerminalKey } from "./terminal-keys.ts";

export interface ExecState {
	planPath: string;
	/** Where this run executes. Absent / current-session: the main session does
	 * the work. Delegated: worker sessions on another model do it
	 * (src/exec-delegate.ts) and the main session only supervises. */
	executor?: ExecutorChoice;
	/** Execution-review reviewers: how many run in parallel per round (decided
	 * right before round 1; absent = undecided, one reviewer) and the
	 * complementary directions the executor suggested. */
	reviewers?: ExecutionReviewers;
	/** Verification checks (VC-###) — the audit's contract. */
	items: CheckItem[];
	/** Parsed plan task model (kept for re-deriving the view). */
	planTasks: PlanTasks;
	/** Live task tree (the single source of progress). */
	tasks: TaskView[];
	/** True when the plan parsed through the legacy I-### fallback. */
	legacyPlan: boolean;
	startedAt: string;
	usage: { inToks: number; outToks: number };
	/** Chrome language for dashboard/status strings; undefined → "en". */
	uiLanguage?: UiLanguage;
	/** Stall watchdog (v0.6.1): consecutive settled rounds without a task
	 * status change; auto-pause at the cap. */
	stall: { rounds: number; lastSnapshot: string | null; paused: boolean; pausedReason?: string };
	/** Completion-audit bookkeeping. `rounds` is the BUDGET counter — charged
	 * only when a round outcome commits (never on discard/cancel) — and is the
	 * only piece persisted. */
	audit: { rounds: number; failed: string[]; undeterminable: string[]; running: boolean; findings: ReviewFinding[] };
	/** Execution-review loop (v0.8), memory-only: the attempt index names the
	 * per-round report files; consecutiveDiscards bounds the fingerprint
	 * re-run loop; inFlight owns the round's abort lifecycle. */
	review: { attempts: number; consecutiveDiscards: number; inFlight: InFlightReview | null; budgetAsking?: boolean };
	/** Per-settle audit latch (v0.7.1): a settled round fires the completion
	 * audit at most once, so the turn_end / agent_before_settle / resume entry
	 * points cannot double-consume a round when several land in one settle.
	 * Created on demand by auditLatchOf(); every construction path may omit it. */
	auditLatch?: { auditedThisSettle: boolean; activity: number };
	/** v0.9.2: outstanding blocker from the newest failed review round — the
	 * authoritative rollback set captured at commit time plus the still-open
	 * tasks among it. Memory mirror of `execution.blocked`; null = nothing
	 * blocks the review. */
	blocked: ExecBlocked | null;
	/** v0.9.2: blocker ids as observed at the PREVIOUS blocked wake — the
	 * ladder's progress baseline. Memory-only: `blocked.tasks` is re-synced by
	 * `persistTaskProgress` on every task close (so it stays fresh for the
	 * resume brief), which would make a comparison against it meaningless.
	 * Absent after a restore/resume → the next blocked wake restarts the count. */
	blockedWakeTasks?: string[];
	/** v0.9.2: highest escalation level already surfaced as a visible system
	 * line. Memory-only (never persisted/snapshotted) so a restored session
	 * re-notifies once. */
	blockedNotifiedLevel?: number;
	/** v0.9.3: the per-run execution-review budget. Resolved exactly once —
	 * right before round 1 — from the picker or the no-UI default, then
	 * persisted. `undefined` = not decided yet (never conflated with a legacy
	 * checkpoint, which `loadExecutionFromCheckpoint` resolves to 5). */
	reviewBudget?: ReviewBudget;
	/** v0.9.3: the budget came from the fallback (no UI/headless/auto-approve),
	 * not from a user pick — the expanded dashboard row marks it `(default)`
	 * and the resume brief repeats the note. Persisted so a later session can
	 * still tell the difference. */
	reviewBudgetDefaulted?: boolean;
	/** v0.9.3: committed review rounds across the whole run (never reset by a
	 * grant) — the unlimited budget's cumulative hard-cap counter. */
	reviewRoundsTotal: number;
	/** v0.9.3: rounds added to the unlimited hard cap by explicit grants. */
	reviewCapExtension: number;
	/** v0.9.3: no-progress valve state (unlimited budget only). */
	reviewNoProgress?: NoProgressState;
	/** v0.10: execution-review non-high repair flag. ABSENT = a checkpoint
	 * written by a pre-v0.10 build (or a run that never committed a reported
	 * round): non-high findings keep the legacy no-owed semantics. */
	reviewNonHighRepair?: ReviewNonHighRepairState;
	/** v0.10: mirror of `reviewNonHighCredit(ex)` (1 iff the flag is
	 * `"granted"`), persisted so checkpoints are self-describing. All budget
	 * arithmetic reads the derived helper, never this field. */
	reviewNonHighCredits: number;
}

/** Live blocker record (see `ExecutionBlocked` in workflow-state.ts). */
type ExecBlocked = ExecutionBlocked;

/** One in-flight review round: owns its abort lifecycle, its fingerprint of
 * the audited subject, and the per-round one-shot wake token (v0.8). */
interface InFlightReview {
	controller: AbortController;
	/** Budget round this attempt belongs to (audit.rounds + 1 at spawn). */
	budgetRound: number;
	/** Monotonic attempt ordinal; names the round report file. */
	attempt: number;
	fingerprint: string;
	wakeSent: boolean;
}

/**
 * D-008 (issue #3): re-resolve the chrome language and repaint the dashboard
 * and status bar right after a `set-language` change.
 */
export function refreshUiLanguage(ctx: ExtensionContext): void {
	if (execution) execution.uiLanguage = resolveUiLanguage(ctx.cwd);
	if (typeof ctx.ui?.setStatus !== "function" || !ctx.ui?.theme) return;
	updateStatusWidget(ctx);
}

/** Consecutive no-progress rounds before the watchdog pauses (D-021). */
export const STALL_MAX_ROUNDS = 3;

let execution: ExecState | null = null;

/** Drives delegated worker sessions (registered by src/exec-delegate.ts,
 * which this module loads lazily so the two never import each other at
 * load time). */
export interface DelegateDriver {
	/** (Re)start driving workers for `ex`; idempotent while a run is live. */
	resume(ctx: ExtensionContext, ex: ExecState): void;
	/** Forward a review round's repair brief to the workers owning the reopened tasks. */
	repair(ctx: ExtensionContext, ex: ExecState, content: string): void;
	/** The run ended or was replaced: tear down every worker session. */
	dispose(outcome: "completed" | "stopped"): void;
}

let delegateDriver: DelegateDriver | null = null;

export function setDelegateDriver(driver: DelegateDriver | null): void {
	delegateDriver = driver;
}

export function isDelegatedExecution(ex: ExecState | null = execution): boolean {
	return isDelegated(ex?.executor);
}

async function ensureDelegateDriver(): Promise<DelegateDriver | null> {
	if (!delegateDriver) await import("./exec-delegate.ts");
	return delegateDriver;
}

function disposeDelegate(outcome: "completed" | "stopped"): void {
	delegateDriver?.dispose(outcome);
}

/** Start (or continue) the delegated workers for the live execution. */
async function resumeDelegation(ctx: ExtensionContext): Promise<void> {
	const ex = execution;
	if (!ex || !isDelegatedExecution(ex)) return;
	const driver = await ensureDelegateDriver();
	if (driver && execution === ex) driver.resume(ctx, ex);
}

/** One owed-review entry for the delegated orchestrator: the main session
 * never settles, so it launches the same round the settle handler would. */
export function triggerOwedReview(ctx: ExtensionContext): Promise<void> | null {
	if (!pendingAudit()) return null;
	latchAuditThisSettle();
	return launchReviewRound(ctx);
}

/** A review round found work to repair. Normally one triggerTurn wakes the
 * executor in the main session; a delegated run forwards the same brief to
 * the workers instead (the message still shows in the transcript). */
const DELEGATED_REPAIR_NOTE =
	"[delegated run] This review brief was forwarded to the workers that own the reopened tasks. You are the supervisor: do not act on it yourself (no edits, no plans_update_task).";

function sendRepairWake(
	ctx: ExtensionContext,
	ex: ExecState,
	message: { customType: string; content: string; display: boolean },
): void {
	if (isDelegatedExecution(ex) && delegateDriver) {
		// The workers get the brief as written; the transcript copy the main
		// session sees says it is forwarded, so the supervisor does not act on it.
		messaging().sendMessage(
			{ ...message, content: `${DELEGATED_REPAIR_NOTE}\n\n${message.content}` },
			{ triggerTurn: false },
		);
		delegateDriver.repair(ctx, ex, message.content);
		return;
	}
	messaging().sendMessage(message, { triggerTurn: true });
}

export const EXECUTION_CONTINUE_CUSTOM_TYPE = "pi-plans-exec-continue";
/** v0.9.2: visible escalation line — never replays after a restart. */
export const EXECUTION_BLOCKED_CUSTOM_TYPE = "pi-plans-exec-blocked";
/** Legacy v0.6.0 continuation message type — filtered on restore. */
const LEGACY_GOAL_WAIT_CUSTOM_TYPE = "pi-plans-goal-wait";

interface ContinuationRuntime {
	owner: ExecState;
	session: ExtensionContext["sessionManager"];
	handled: boolean;
	stopReason?: string;
	wakeId?: string;
}

// Dispatch identity belongs to a live session, never to a persisted state.
let continuationRuntime: ContinuationRuntime | null = null;

function resetContinuationRuntime(ctx: ExtensionContext): void {
	continuationRuntime = execution
		? { owner: execution, session: ctx.sessionManager, handled: false }
		: null;
}

function currentContinuationRuntime(ctx: ExtensionContext): ContinuationRuntime | null {
	return continuationRuntime?.owner === execution && continuationRuntime.session === ctx.sessionManager
		? continuationRuntime
		: null;
}

// Execution-loop persistence is deferred until the agent settles so turn_end
// never causes session writes during a streaming run.
let pendingExecutionFlush = false;

export function consumePendingExecutionFlush(): boolean {
	const pending = pendingExecutionFlush;
	pendingExecutionFlush = false;
	return pending;
}

function requestExecutionFlush(): void {
	pendingExecutionFlush = true;
}

export function drainExecutionFlush(ctx: ExtensionContext): void {
	if (!execution || !pendingExecutionFlush) return;
	pendingExecutionFlush = false;
	persist(ctx);
	updateStatusWidget(ctx);
}

export function getExecution(): ExecState | null {
	return execution;
}

export interface CheckpointExecutionLoad {
	/** Where the run executes (absent = the current session). */
	executor?: ExecutorChoice;
	status: "loaded" | "no-execution" | "plan-missing" | "plan-mismatch" | "no-checkpoint" | "corrupt";
	planPath?: string;
	doneVcIds?: string[];
	reverifyAll?: boolean;
	pausedReason?: string;
	/** v0.6.1: true when the checkpoint parsed through the legacy fallback. */
	legacyPlan?: boolean;
	/** v0.6.1 (D-020): true when an orphaned v0.6.0 delegated executor was
	 * detected — resume requires a fresh handoff approval. */
	legacyDelegate?: boolean;
	/** v0.9.1 (F-005): unresolved findings from the newest committed round,
	 * so the /resume-plans brief can surface outstanding highs before the
	 * per-turn injection ever runs. */
	findings?: ReviewFinding[];
	/** v0.9.2: persisted blocker of the newest failed round, so the resume
	 * brief can name the open tasks that keep the review from starting. */
	blocked?: ExecutionBlocked | null;
	/** v0.9.3: the persisted per-run review budget (or undefined when the run
	 * never picked one — a legacy checkpoint resolves to 5 in the live state,
	 * see `reviewBudgetDefaulted`). */
	reviewBudget?: ReviewBudget;
	reviewBudgetDefaulted?: boolean;
	reviewRoundsTotal?: number;
	reviewCapExtension?: number;
	error?: string;
}

/** v0.9.2: a checkpoint written before `execution.blocked` existed still names
 * its blocker — `audit.lastResult` records the newest failed round's ids and
 * the coverage cascade is pure, so the rollback set can be reconstructed
 * WITHOUT re-applying anything (the tree already carries the reopen's outcome;
 * re-applying it would revert tasks the executor has since re-closed).
 * Finding-driven rounds (`highs: F-…`) carry no coverage and stay without a
 * record — the wake still states that no round can start while tasks are open. */
function blockedFromFailedIds(
	failedIds: readonly string[],
	round: number,
	tasks: TaskView[],
	checklist: CheckItem[],
): ExecBlocked | null {
	if (failedIds.length === 0) return null;
	const rolledBack = rollbackCoverageIds(tasks, checklist, failedIds, []);
	if (rolledBack.length === 0) return null;
	const open = blockedReviewTasks(tasks, rolledBack);
	if (open.length === 0) return null;
	return { rolledBack, tasks: open, round, escalatedRounds: 0, since: utcNow() };
}

function backfillBlocked(
	checkpoint: ExecutionCheckpoint,
	tasks: TaskView[],
	checklist: CheckItem[],
): ExecBlocked | null {
	const last = checkpoint.audit?.lastResult?.trim() ?? "";
	// A findings-only ledger (`highs:` / `medium/low:`) carries no check ids —
	// there is no coverage cascade to reconstruct from it.
	if (last.length === 0 || last.startsWith("highs:") || last.startsWith("medium/low:")) return null;
	const failed = last.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
	return blockedFromFailedIds(failed, checkpoint.audit?.rounds ?? 0, tasks, checklist);
}

/**
 * Shared restore primitive: load the executing state from a run checkpoint
 * into THIS session. Authorization is kept only when the recorded approval
 * matches the current plan digest; a HEAD change keeps the authorization but
 * re-opens previously closed tasks (D-023: reverifyAll → task statuses are
 * dropped and re-run).
 */
export function loadExecutionFromCheckpoint(
	ctx: ExtensionContext,
	runId: string,
): CheckpointExecutionLoad {
	const load = loadCheckpoint(ctx.cwd, runId);
	if (load.status === "missing") return { status: "no-checkpoint" };
	if (load.status === "corrupt") return { status: "corrupt", error: load.error };
	const cp = load.checkpoint;
	if (!cp.execution || cp.phase !== "executing") return { status: "no-execution" };
	const planPath = cp.plan?.path;
	if (!planPath || !fs.existsSync(planPath)) {
		return { status: "plan-missing", error: planPath ? `plan file vanished: ${planPath}` : "checkpoint has no plan identity" };
	}
	const planText = fs.readFileSync(planPath, "utf8");
	if (sha256File(planPath) !== cp.plan.sha256) {
		return {
			status: "plan-mismatch" as const,
			error: `plan file changed since the approval record (${planPath}); re-approve via /plans-execute before executing`,
		};
	}
	const items = parseChecklist(planText);
	if (items.length === 0) {
		return { status: "plan-missing", error: `${planPath} has no parsable verification checks` };
	}
	const planTasks = parsePlanTasks(planText);
	if (planTasks.tasks.length === 0) {
		return { status: "plan-missing", error: `${planPath} has no parsable tasks (## Tasks or legacy ## Implementation Items)` };
	}
	const headNow = resolveHeadAt(ctx.cwd);
	const headUnverifiable = cp.execution.approval === null || cp.execution.approval.headAtApproval === null;
	const headChanged =
		cp.execution.approval !== null &&
		cp.execution.approval.headAtApproval !== null &&
		cp.execution.approval.headAtApproval !== headNow;
	// D-023: reverifyAll re-opens every closed task (statuses dropped); a
	// normal restore replays the persisted task progress map.
	const reverifyAll = cp.execution.reverifyAll === true || headChanged || headUnverifiable;
	const progress: TaskProgressMap = reverifyAll ? {} : (cp.execution.tasks ?? {});
	const tasks = buildTaskView(planTasks, progress);
	// v0.8: a review-cap pause SURVIVES the restore — the budget must stay
	// bounded across restarts; only /plans-execute grants a fresh one. The
	// legacy v0.7 prefix stays dual-matched for one release.
	const wasReviewCapPause = isReviewCapPause(cp.execution.pausedReason);
	// Any live round from the replaced session graph dies here (CF2-002).
	abortInFlightReview();
	disposeDelegate("stopped");
	if (!reverifyAll) {
		for (const id of cp.execution.doneVcIds) {
			const item = items.find((candidate) => candidate.id === id);
			if (item) item.done = true;
		}
	}
	execution = {
		planPath,
		items,
		planTasks,
		tasks,
		executor: cp.execution.executor,
		reviewers: cp.execution.reviewers,
		legacyPlan: planTasks.legacy,
		startedAt: utcNow(),
		usage: { inToks: cp.execution.usage.inToks, outToks: cp.execution.usage.outToks },
		uiLanguage: resolveUiLanguage(ctx.cwd),
		// v0.9.2: the persisted blocker survives a restore so the resume brief
		// and the dashboard can name it; a reverifyAll restore drops it together
		// with the task progress it described. Pre-feature checkpoints are
		// backfilled from the newest failed round's ids.
		blocked: reverifyAll ? null : (cp.execution.blocked ?? backfillBlocked(cp.execution, tasks, items)),
		// D-020: a paused legacy (or stopped) execution rebuilds unpaused — the
		// resume itself is the user's intent; the reason is surfaced in the
		// resume brief instead. EXCEPT a review-cap pause (v0.8): it must
		// survive restores paused and at its committed round count, or the
		// 5-round budget would never bound anything across restarts.
		stall: {
			rounds: cp.execution.stallRounds ?? 0,
			lastSnapshot: null,
			paused: wasReviewCapPause,
			pausedReason: wasReviewCapPause ? (cp.execution.pausedReason ?? undefined) : undefined,
		},
		audit: {
			rounds: cp.execution.audit?.rounds ?? 0,
			failed: [],
			undeterminable: cp.execution.audit?.undeterminable ?? [],
			findings: toReviewFindings(cp.execution.audit?.findings),
			running: false,
		},
		review: { attempts: 0, consecutiveDiscards: 0, inFlight: null, budgetAsking: false },
		auditLatch: { auditedThisSettle: false, activity: 0 },
		// v0.9.3: the review budget survives a restore; a checkpoint written
		// before the feature that already spent rounds keeps the legacy 5-round
		// bound instead of being cut to the new default mid-flight.
		reviewBudget: resolveStoredBudget(cp.execution.reviewBudget, cp.execution.audit?.rounds ?? 0),
		reviewBudgetDefaulted: cp.execution.reviewBudgetDefaulted === true,
		reviewRoundsTotal: cp.execution.reviewRoundsTotal ?? 0,
		reviewCapExtension: cp.execution.reviewCapExtension ?? 0,
		reviewNoProgress: cp.execution.reviewNoProgress ?? undefined,
		// v0.10: the flag is the source of truth; the persisted credit mirror is
		// recomputed (never trusted) so a contradictory checkpoint normalizes.
		reviewNonHighRepair: cp.execution.reviewNonHighRepair ?? undefined,
		reviewNonHighCredits: cp.execution.reviewNonHighRepair === "granted" ? 1 : 0,
	};
	execution.stall.lastSnapshot = stallSnapshot();
	executionRunId = runId;
	bindRun(ctx.sessionManager, ctx.cwd, runId);
	resetContinuationRuntime(ctx);
	pendingExecutionFlush = false;
	resetExecutionCompactionState(ctx);
	// D-020: an orphaned v0.6.0 delegated executor never survives a restart.
	// Its checkpoint delegate marker REFUSES the direct load — the run must
	// re-enter through the execution handoff so the C-006 approval gate
	// applies; execution restarts from the first task after re-approval.
	const legacyDelegate = cp.execution.delegate !== undefined;
	if (legacyDelegate) {
		try {
			ctx.ui.notify?.(
				"pi-plans: this run was mid-flight under a v0.6.0 delegated executor (removed in v0.6.1). Re-approve via /plans-execute; execution restarts from the first task (the 0.6.0 progress record cannot map onto the task tree).",
				"warning",
			);
		} catch {
			/* best-effort */
		}
		// Refuse the load: no execution state may activate without the fresh
		// C-006 handoff approval.
		execution = null;
		executionRunId = null;
		return {
			status: "no-execution",
			legacyDelegate: true,
			error: "orphaned v0.6.0 delegated executor; re-approve via /plans-execute (execution restarts from the first task)",
		};
	}
	if (headChanged) {
		withExecutionCheckpoint(ctx, (current) => applyExecutionHeadChanged(current));
	}
	// A backfilled blocker is authoritative from here on: persist it once so a
	// later restart reads the record instead of re-deriving it.
	if (!reverifyAll && (cp.execution.blocked ?? null) === null && execution!.blocked !== null) {
		withExecutionCheckpoint(ctx, (current) => applyExecutionProgress(current, { blocked: execution!.blocked }));
	}
	persist(ctx);
	updateStatusWidget(ctx);
	// A delegated run restores its workers; they pick up the open tasks.
	void resumeDelegation(ctx);
	return {
		status: "loaded",
		executor: execution?.executor,
		planPath,
		doneVcIds: [...cp.execution.doneVcIds],
		reverifyAll,
		pausedReason: cp.execution.pausedReason,
		legacyPlan: planTasks.legacy,
		legacyDelegate,
		findings: toReviewFindings(cp.execution.audit?.findings),
		// The LIVE record: a pre-feature checkpoint is backfilled (and persisted)
		// above, so the resume brief sees the reconstructed blocker.
		blocked: execution?.blocked ?? null,
		reviewBudget: execution?.reviewBudget,
		reviewBudgetDefaulted: execution?.reviewBudgetDefaulted === true,
		reviewRoundsTotal: execution?.reviewRoundsTotal ?? 0,
		reviewCapExtension: execution?.reviewCapExtension ?? 0,
	};
}

const EXECUTION_COMPACTION_RESUME_MESSAGE = "Continue execution.";

interface ExecutionCompactionState {
	inFlight: boolean;
	resumeGuard: boolean;
	cooldownActive: boolean;
	lastAttemptReason: string | null;
	lastSuccessfulUsagePercent: number | null;
	lastSuccessfulAt: string | null;
	rearmPending: boolean;
	terminalBackoffTokens: number | null;
	pendingStats: VccCompactionStats | null;
	pendingFollowUpPrompt: string | null;
	pendingContinueAfterThresholdCompact: boolean;
}

type ExecutionCompactionSession = { __executionCompaction?: ExecutionCompactionState };
type ExecutionCompactionContext = ExtensionContext & { sessionManager?: ExecutionCompactionSession };

function getExecutionCompactionSession(ctx: ExtensionContext, create = false): ExecutionCompactionSession | undefined {
	const carrier = ctx as ExecutionCompactionContext;
	if (carrier.sessionManager) return carrier.sessionManager;
	if (!create) return undefined;
	carrier.sessionManager = {};
	return carrier.sessionManager;
}

function executionCompactionState(ctx: ExtensionContext): ExecutionCompactionState | undefined {
	return getExecutionCompactionSession(ctx)?.__executionCompaction;
}

function ensureExecutionCompactionState(ctx: ExtensionContext): ExecutionCompactionState {
	const session = getExecutionCompactionSession(ctx, true)!;
	return (session.__executionCompaction ??= {
		inFlight: false,
		resumeGuard: false,
		cooldownActive: false,
		lastAttemptReason: null,
		lastSuccessfulUsagePercent: null,
		lastSuccessfulAt: null,
		rearmPending: false,
		terminalBackoffTokens: null,
		pendingStats: null,
		pendingFollowUpPrompt: null,
		pendingContinueAfterThresholdCompact: false,
	});
}

function resetExecutionCompactionState(ctx: ExtensionContext): void {
	const session = getExecutionCompactionSession(ctx);
	if (!session) return;
	delete session.__executionCompaction;
}

function consumeExecutionCompactionResumeGuard(ctx: ExtensionContext): boolean {
	const state = executionCompactionState(ctx);
	if (!state?.resumeGuard) return false;
	state.resumeGuard = false;
	return true;
}

export function shouldTriggerExecutionCompaction(_ctx: ExtensionContext): boolean {
	return false;
}

export function handleExecutionTurnCompaction(ctx: ExtensionContext): void {
	consumeExecutionCompactionResumeGuard(ctx);
}

function formatToks(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function formatExecutionStatusLine(execution: ExecState): string {
	const progress = taskProgress(execution.tasks);
	let line = `⌛ plans tasks ${progress.done}/${progress.total}: spent ${formatElapsed(execution.startedAt)} · ${formatToks(execution.usage.inToks)} in-toks · ${formatToks(execution.usage.outToks)} out-toks`;
	if (execution.stall.paused) {
		line += ` · ⏸ paused (${execution.stall.pausedReason ?? "stalled"})`;
	}
	return line;
}

/** Resolve the run topic for dashboard headers (falls back to the run id). */
function panelTopic(ctx: ExtensionContext): string {
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (active) {
		const run = getRun(ctx.cwd, active.run_id);
		if (run?.topic) return run.topic;
		return active.run_id;
	}
	return "pi-plans";
}

let dashboardRegistered = false;
let dashboardExpanded = false;

/** Toggle the dashboard's expanded tree view (Ctrl+Shift+T). */
export function toggleDashboardExpanded(ctx: ExtensionContext): void {
	dashboardExpanded = !dashboardExpanded;
	dashboardRegistered = false; // force re-registration with the new mode
	updateStatusWidget(ctx);
}

export function isDashboardExpanded(): boolean {
	return dashboardExpanded;
}

/**
 * Register/update the task dashboard (aboveEditor widget) for the current
 * execution, or unregister it when execution is gone. The compact and the
 * expanded tree view share one widget key so they never stack.
 */
function updatePanelWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
	if (!execution) {
		if (dashboardRegistered) {
			ctx.ui.setWidget(DASHBOARD_WIDGET_KEY, undefined);
			dashboardRegistered = false;
		}
		return;
	}
	if (dashboardRegistered) return;
	ctx.ui.setWidget(
		DASHBOARD_WIDGET_KEY,
		(ui, _theme) => ({
			render(width: number) {
				const theme = (ui as { theme?: { fg(color: string, text: string): string } }).theme ?? _theme;
				const current = execution;
				if (!current) return [];
				const model = deriveDashboardModel(panelTopic(ctx), current.tasks, current.items, {
					paused: current.stall.paused,
					pausedReason: current.stall.pausedReason,
					auditRounds: billedRounds(current) > 0 || current.audit.running || nonHighRepairPending(current) ? billedRounds(current) : null,
					auditFailed: current.audit.failed,
					auditUndeterminable: current.audit.undeterminable,
					findings: current.audit.findings,
					reviewRunning: current.audit.running === true || current.review.inFlight !== null,
					blockedTasks: blockedTaskIds(current),
					blockedRound: current.blocked?.round ?? null,
					startedAt: current.startedAt,
					usage: current.usage,
					huge: hugeDashboardPayload(ctx),
				});
				const lines = dashboardExpanded
					? renderDashboardTreeLines(model, width, theme)
					: renderDashboardLines(model, width, theme);
				return lines;
			},
		}),
		{ placement: "aboveEditor" },
	);
	dashboardRegistered = true;
}

export function updateStatusWidget(ctx: ExtensionContext): void {
	updatePanelWidget(ctx);
	if (execution && typeof ctx.ui.setStatus === "function" && ctx.ui.theme) {
		const model = deriveDashboardModel(panelTopic(ctx), execution.tasks, execution.items, {
			paused: execution.stall.paused,
			pausedReason: execution.stall.pausedReason,
			auditRounds: billedRounds(execution) > 0 || nonHighRepairPending(execution) ? billedRounds(execution) : null,
			auditFailed: execution.audit.failed,
			auditUndeterminable: execution.audit.undeterminable,
			huge: hugeDashboardPayload(ctx),
			findings: execution.audit.findings,
			reviewRunning: execution.audit.running === true || execution.review.inFlight !== null,
			blockedTasks: blockedTaskIds(execution),
			blockedRound: execution.blocked?.round ?? null,
			reviewBudget: execution.reviewBudget ?? null,
			reviewRoundsTotal: execution.reviewRoundsTotal,
			reviewCapExtension: execution.reviewCapExtension,
			reviewBudgetDefaulted: execution.reviewBudgetDefaulted === true,
		});
		ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("accent", formatDashboardSummaryLine(model)));
		return;
	}
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (active && typeof ctx.ui.setStatus === "function" && ctx.ui.theme) {
		const status = getRun(ctx.cwd, active.run_id)?.status ?? latestRun(ctx.cwd)?.status;
		if (status === "done") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("success", `🎯 plans: ${active.run_id} (done)`));
			return;
		}
		if (status === "abandoned") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("error", `🚫 plans: ${active.run_id}`));
			return;
		}
		if (status === "stopped") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("warning", `⛔ plans: ${active.run_id}`));
			return;
		}
		if (status === "accepted") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("warning", `⌛ plans: ${active.run_id}`));
			return;
		}
		if (status === "executing") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("accent", `⌛ plans: ${active.run_id} (executing)`));
			return;
		}
		if (status === "verifying") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("accent", `🔎 plans: ${active.run_id} (verifying)`));
			return;
		}
		if (status === "planning") {
			const emoji = parseLatestPlanExists(active.artifact_dir) ? "📝" : "💬";
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("muted", `${emoji} plans: ${active.run_id}`));
			return;
		}
	}
	if (typeof ctx.ui?.setStatus === "function" && ctx.ui.theme) {
		const terminalLatest = latestRun(ctx.cwd);
		if (terminalLatest && TERMINAL_RUN_STATUSES.has(terminalLatest.status)) {
			if (terminalLatest.status === "done") {
				ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("success", `🎯 plans: ${terminalLatest.run_id} (done)`));
			} else {
				ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("error", `🚫 plans: ${terminalLatest.run_id}`));
			}
			return;
		}
		ctx.ui.setStatus("pi-plans", undefined);
	}
}

function parseLatestPlanExists(artifactDir: string): boolean {
	try {
		const names = fs.readdirSync(artifactDir);
		return names.some((name) => /^PLAN_v\d+\.(md|markdown)$/i.test(name) || parseHugePlanName(name) !== null);
	} catch {
		return false;
	}
}

/** plan-huge (v0.9.5): dashboard payload for the current version stream. */
function hugeDashboardPayload(ctx: ExtensionContext): HugeProgress | null {
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (!active) return null;
	const load = loadCheckpoint(ctx.cwd, active.run_id);
	if (load.status !== "ok" || !load.checkpoint.huge) return null;
	const huge = load.checkpoint.huge;
	const current = huge.versions[huge.currentIndex];
	if (!current) return null;
	const statusLabel = hugeChrome(resolveUiLanguage(ctx.cwd)).statusLabel(current.status);
	return { version: current.label, index: huge.currentIndex + 1, total: huge.versions.length, statusLabel };
}

/** plan-huge: label of the run's current version (for version-scoped review
 * reports), or null for ordinary runs. */
function currentHugeVersionLabel(ctx: ExtensionContext): string | null {
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (!active) return null;
	const load = loadCheckpoint(ctx.cwd, active.run_id);
	if (load.status !== "ok" || !load.checkpoint.huge) return null;
	return load.checkpoint.huge.versions[load.checkpoint.huge.currentIndex]?.label ?? null;
}

/** plan-huge: review reports archived under the version's own directory. */
function hugeVersionReviewReports(workdir: string, runId: string, version: string): string[] {
	const runDir = runDirPath(workdir, runId);
	if (runDir === null) return [];
	const dir = path.join(runDir, "execution-review", version);
	try {
		return fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => path.posix.join("execution-review", version, name));
	} catch {
		return [];
	}
}

function persist(ctx: ExtensionContext): void {
	if (!execution) return;
	messaging().appendEntry("pi-plans-exec", {
		planPath: execution.planPath,
		items: execution.items,
		planTasks: execution.planTasks,
		tasks: execution.tasks,
		executor: execution.executor,
		reviewers: execution.reviewers,
		legacyPlan: execution.legacyPlan,
		startedAt: execution.startedAt,
		usage: execution.usage,
		stall: execution.stall,
		blocked: execution.blocked,
		// v0.9.3 (round-1 F-005): the review budget rides the session snapshot
		// too — a /reload restore rebuilds the live state from it, and a
		// restored counter must NOT hand the run a free unlimited window.
		reviewBudget: execution.reviewBudget,
		reviewBudgetDefaulted: execution.reviewBudgetDefaulted,
		reviewRoundsTotal: execution.reviewRoundsTotal,
		reviewCapExtension: execution.reviewCapExtension,
		reviewNoProgress: execution.reviewNoProgress,
		reviewNonHighRepair: execution.reviewNonHighRepair,
		reviewNonHighCredits: reviewNonHighCredit(execution),
		audit: { rounds: execution.audit.rounds, failed: execution.audit.failed, findings: execution.audit.findings },
	});
}

/** Checkpoint bookkeeping for the executing run; best-effort for legacy runs
 * without checkpoints. */
function withExecutionCheckpoint(ctx: ExtensionContext, mutator: (cp: WorkflowCheckpoint) => WorkflowCheckpoint): void {
	if (!execution) return;
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (!active || active.run_id !== executionRunId) return;
	try {
		mutateCheckpoint(ctx.cwd, active.run_id, mutator);
	} catch (error) {
		if (error instanceof OwnershipError || error instanceof StaleCheckpointError) throw error;
		/* legacy run or corrupt checkpoint: session snapshot still carries the loop */
	}
}

let executionRunId: string | null = null;

export interface StartExecutionInput {
	planPath: string;
	planTasks: PlanTasks;
	items: CheckItem[];
	/** Chosen at the handoff; absent = the current session. */
	executor?: ExecutorChoice;
}

export async function startExecution(
	ctx: ExtensionContext,
	input: StartExecutionInput,
): Promise<boolean> {
	// v0.9.4 (Q-5): a terminal run must never be revived — `/plans-execute
	// <planPath>` bypasses the run picker, and `setRunStatus` has no transition
	// guard, so flipping a done run back to "executing" would leave the status
	// contradicting the completed checkpoint. Refuse before any state change.
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	const activeStatus = active ? getRun(ctx.cwd, active.run_id)?.status : undefined;
	if (active && activeStatus && TERMINAL_RUN_STATUSES.has(activeStatus)) {
		// plan-huge (v0.9.5): a terminal status with versions still open is a
		// contradiction — keep refusing, but say what the run actually needs.
		const load = loadCheckpoint(ctx.cwd, active.run_id);
		const openVersions =
			load.status === "ok" && load.checkpoint.huge
				? load.checkpoint.huge.versions.filter((version) => version.status !== "done").length
				: 0;
		if (openVersions > 0) {
			ctx.ui.notify(
				`run ${active.run_id} is ${activeStatus} while ${openVersions} version(s) are still open; plan the next version instead of executing this one.`,
				"warning",
			);
			return false;
		}
		ctx.ui.notify(terminationChrome(resolveUiLanguage(ctx.cwd)).guardNotice(active.run_id, activeStatus), "warning");
		return false;
	}
	// An unbound session with nothing but terminal runs resolves `null` above
	// (readActive skips terminal runs). Refuse only when the PLAN itself belongs
	// to a terminal run's artifact directory: an unrelated plan in such a workdir
	// keeps the pre-existing unattributed path instead of being refused with a
	// notice about a run it never touched.
	if (!active) {
		const resolvedPlan = path.resolve(input.planPath);
		const owner = listRuns(ctx.cwd).find((run) => {
			if (!TERMINAL_RUN_STATUSES.has(run.status)) return false;
			const dir = run.artifact_dir;
			if (typeof dir !== "string" || dir.trim() === "") return false;
			return resolvedPlan.startsWith(`${path.resolve(dir)}${path.sep}`);
		});
		if (owner) {
			ctx.ui.notify(terminationChrome(resolveUiLanguage(ctx.cwd)).guardNotice(owner.run_id, owner.status), "warning");
			return false;
		}
	}
	// A fresh handoff replaces any live run — abort its in-flight review round first.
	abortInFlightReview();
	disposeDelegate("stopped");
	const tasks = buildTaskView(input.planTasks);
	execution = {
		planPath: input.planPath,
		executor: input.executor,
		items: input.items,
		planTasks: input.planTasks,
		tasks,
		legacyPlan: input.planTasks.legacy,
		startedAt: utcNow(),
		usage: { inToks: 0, outToks: 0 },
		uiLanguage: resolveUiLanguage(ctx.cwd),
		stall: { rounds: 0, lastSnapshot: null, paused: false },
		blocked: null,
		audit: { rounds: 0, failed: [], undeterminable: [], findings: [], running: false },
		review: { attempts: 0, consecutiveDiscards: 0, inFlight: null, budgetAsking: false },
		auditLatch: { auditedThisSettle: false, activity: 0 },
		// v0.9.3: a fresh handoff starts with NO budget — the picker resolves it
		// (or the no-UI default applies) right before round 1.
		reviewBudget: undefined,
		reviewRoundsTotal: 0,
		reviewCapExtension: 0,
		reviewNonHighCredits: 0,
	};
	// Seed the watchdog baseline only after `execution` points at the new state
	// (stallSnapshot reads the live execution).
	execution.stall.lastSnapshot = stallSnapshot();
	resetContinuationRuntime(ctx);
	pendingExecutionFlush = false;
	resetExecutionCompactionState(ctx);
	persist(ctx);
	executionRunId = active?.run_id ?? null;
	if (active) {
		bindRun(ctx.sessionManager, ctx.cwd, active.run_id);
		try {
			const load = loadCheckpoint(ctx.cwd, active.run_id);
			if (load.status === "missing") {
				createCheckpoint(ctx.cwd, { runId: active.run_id, originWorkdir: ctx.cwd, workdir: ctx.cwd });
			}
			const approval: ExecutionApproval = {
				plan: planIdentityOf(path.resolve(input.planPath), 1),
				worktree: resolveWorktreeRoot(ctx.cwd) ?? path.resolve(ctx.cwd),
				headAtApproval: resolveHeadAt(ctx.cwd),
				approvedAt: utcNow(),
			};
			mutateCheckpoint(ctx.cwd, active.run_id, (cp) => {
				const withPlan = cp.plan === null ? { ...cp, plan: approval.plan } : cp;
				const aligned = withPlan.nextAction === "accept-execute"
					? withPlan
					: { ...withPlan, nextAction: "accept-execute" as const };
				const approved = applyExecutionApproved(aligned, approval);
				return input.executor ? applyExecutionProgress(approved, { executor: input.executor }) : approved;
			});
			lintPlanIntoNotices(ctx.cwd, active.run_id, path.resolve(input.planPath));
		} catch (error) {
			if (error instanceof StateError && /does not match/.test(error.message)) throw error;
			/* legacy/corrupt checkpoint: run status still transitions below */
		}
		try {
			setRunStatus(ctx.cwd, active.run_id, "executing");
		} catch {
			/* best-effort */
		}
	}
	const progress = taskProgress(tasks);
	messaging().sendMessage(
		{
			customType: "pi-plans-exec-start",
			content: isDelegated(input.executor)
				? `**pi-plans: executing** \`${input.planPath}\` — ${progress.total} task(s) in ${input.planTasks.legacy ? "legacy" : "task-tree"} mode, ${input.items.length} verification check(s), delegated to ${executorLabel(input.executor)}. The workers report progress themselves and the dashboard tracks every task (Ctrl+Shift+T expands the tree); you supervise — do not implement the tasks or call \`plans_update_task\` yourself.`
				: `**pi-plans: executing** \`${input.planPath}\` — ${progress.total} task(s) in ${input.planTasks.legacy ? "legacy" : "task-tree"} mode, ${input.items.length} verification check(s). Report progress with the \`plans_update_task\` tool; the dashboard tracks every task (Ctrl+Shift+T expands the tree).`,
			display: true,
		},
		{ triggerTurn: false },
	);
	updateStatusWidget(ctx);
	if (isDelegated(input.executor)) await resumeDelegation(ctx);
	return true;
}

/** Persist the live task progress (called by the task status tool). */
export function persistTaskProgress(ctx: ExtensionContext): void {
	if (!execution) return;
	// Any task-state change resets the stall watchdog baseline.
	execution.stall.rounds = 0;
	execution.stall.lastSnapshot = stallSnapshot();
	// v0.9.2: closing a reopened task shrinks the blocker; when the last one
	// closes the record is dropped so no stale blocker outlives the repair.
	if (execution.blocked) {
		execution.blocked.tasks = blockedReviewTasks(execution.tasks, execution.blocked.rolledBack);
		if (execution.blocked.tasks.length === 0) {
			execution.blocked = null;
			execution.blockedWakeTasks = undefined;
		}
	}
	withExecutionCheckpoint(ctx, (cp) =>
		applyExecutionProgress(cp, {
			tasks: taskProgressMap(execution!.tasks),
			doneVcIds: execution!.items.filter((item) => item.done).map((item) => item.id),
			stallRounds: execution!.stall.rounds,
			blocked: execution!.blocked,
			audit: {
				rounds: execution!.audit.rounds,
				lastResult: execution!.audit.failed.length > 0 ? execution!.audit.failed.join(",") : undefined,
				undeterminable: execution!.audit.undeterminable.length > 0 ? execution!.audit.undeterminable : undefined,
				// v0.9: audit writes are replace-semantics — every writer must
				// carry findings or a task update would silently wipe them.
				findings: execution!.audit.findings,
			},
		}),
	);
	persist(ctx);
}

/** Record one assistant turn: accumulate usage only (markers are gone). */
export function recordExecutionTurn(
	ctx: ExtensionContext,
	usage?: { input: number; output: number },
): void {
	if (!execution) return;
	if (usage) {
		execution.usage.inToks += usage.input;
		execution.usage.outToks += usage.output;
	}
	withExecutionCheckpoint(ctx, (cp) =>
		applyExecutionProgress(cp, {
			usage: usage ? { inToks: usage.input, outToks: usage.output } : undefined,
		}),
	);
	requestExecutionFlush();
	updateStatusWidget(ctx);
}

/** Test hook: replace the audit subagent with a deterministic function. */
let auditRunnerForTests: ((input: { planPath: string; checklist: CheckItem[]; tasks: TaskView[]; round: number; priorFindings: ReviewFinding[]; findingDispositions?: ReadonlyMap<string, string>; lanes?: AuditLane[] }) => Promise<Awaited<ReturnType<typeof runCompletionAudit>>>) | null = null;

export function __setAuditRunnerForTests(
	runner: ((input: { planPath: string; checklist: CheckItem[]; tasks: TaskView[]; round: number; priorFindings: ReviewFinding[]; findingDispositions?: ReadonlyMap<string, string>; lanes?: AuditLane[] }) => Promise<Awaited<ReturnType<typeof runCompletionAudit>>>) | null,
): void {
	auditRunnerForTests = runner;
}

export function registerExecutionTurnHandlers(
	ext: ExtensionAPI,
	onTurnEnd?: (ctx: ExtensionContext) => Promise<void> | void,
): void {
	let lastAssistantUsage: { input: number; output: number } | null = null;
	ext.on("agent_start", async (_event, ctx) => {
		const runtime = currentContinuationRuntime(ctx);
		if (!runtime) return;
		runtime.handled = false;
		runtime.stopReason = undefined;
		// v0.7.1: a new agent run opens a new settle window (per-settle latch).
		if (execution) resetSettleLatch();
	});
	ext.on("before_agent_start", async (_event, ctx) => {
		const runtime = currentContinuationRuntime(ctx);
		if (runtime) runtime.wakeId = undefined;
	});
	ext.on("input", async (event, ctx) => {
		if (event.source === "interactive" || event.source === "rpc") resumeGoalWaitIfPaused(ctx);
	});
	ext.on("agent_settled", async (_event, ctx) => {
		drainExecutionFlush(ctx);
		maybeContinuationFollowUp(ctx);
	});
	// v0.7.1: `agent_settled` is notification-only per pi's contract, so the
	// audit fallback lives on `agent_before_settle` — the final ACTIONABLE
	// boundary. It is what makes a terminal-but-unaudited run self-heal with
	// zero user input, instead of stranding until a manual /plans-execute.
	ext.on("agent_before_settle", async (_event, ctx) => {
		if (!pendingAudit() || isDelegatedExecution()) return;
		const runtime = currentContinuationRuntime(ctx);
		if (runtime?.handled) return;
		// The continuation wake owns this settle: if the loop already woke the
		// agent to fix rolled-back work, the audit waits for the next settle
		// (Q-2 single-wake guarantee) rather than emitting a second wake.
		if (runtime && !allTasksTerminal(runtime.owner.tasks)) {
			maybeContinuationFollowUp(ctx);
			return;
		}
		// Fully settled and still owed a review: launch the round under the
		// mode rule — tui/rpc detach (the settle returns NOW and the overlay
		// carries progress); print/json await inline so runtime teardown cannot
		// kill the child. The round's own outcome routing drives the rest.
		latchAuditThisSettle();
		const chain = launchReviewRound(ctx);
		if (chain) await chain;
	});
	ext.on("session_shutdown", async (_event, ctx) => {
		drainExecutionFlush(ctx);
		abortInFlightReview();
		disposeDelegate("stopped");
		execution = null;
		executionRunId = null;
		continuationRuntime = null;
		lastAssistantUsage = null;
	});
	ext.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: { input?: number; output?: number } };
		if (message?.role === "assistant" && message.usage) {
			lastAssistantUsage = { input: message.usage.input ?? 0, output: message.usage.output ?? 0 };
		}
	});
	// v0.7.1 (root cause B): the stall watchdog counted only task-status changes,
	// so a round where the agent legitimately investigated (read code, gathered
	// evidence) without closing a task looked identical to a dead agent. A
	// SUCCESSFUL tool result is real progress; a failed/blocked tool is not, so
	// an agent looping on the same error still trips the cap (F-005, Q-3).
	ext.on("tool_result", async (event, _ctx) => {
		if (!execution) return;
		const result = event as { isError?: boolean; error?: unknown };
		if (result.isError === true || result.error !== undefined) return;
		auditLatchOf(execution).activity += 1;		// Real progress: rebase the watchdog so this round counts as a change.
		execution.stall.rounds = 0;
		execution.stall.lastSnapshot = stallSnapshot();
	});

	ext.on("turn_end", async (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (!message || message.role !== "assistant") {
			updateStatusWidget(ctx);
			return;
		}
		const runtime = currentContinuationRuntime(ctx);
		if (runtime) runtime.stopReason = message.stopReason;
		const projection = (event.message as { usage?: { input?: number; output?: number } }).usage;
		const raw = projection ?? lastAssistantUsage;
		lastAssistantUsage = null;
		const usage = raw ? { input: raw.input ?? 0, output: raw.output ?? 0 } : undefined;
		if (usage) recordExecutionTurn(ctx, usage);
		if (getExecution() && !isDelegatedExecution() && pendingAudit() && !auditLatchOf(execution!).auditedThisSettle) {
			latchAuditThisSettle();
			const chain = launchReviewRound(ctx);
			if (chain) await chain;
		}
		await onTurnEnd?.(ctx);
	});
}

/** ==== Execution-review loop (v0.8) ====
 *
 *  When every task is terminal and checks are still owed, the run enters the
 *  `verifying` status and a DETACHED read-only reviewer round runs in the
 *  background (tui/rpc): the settle handler returns immediately and the
 *  executor is truly idle while the overlay shows live progress. In print/json
 *  modes the settle handler keeps AWAITING the round inline — runtime
 *  teardown at settle would otherwise kill a detached child and swallow the
 *  pause signal.
 *
 *  Budget: `audit.rounds` counts COMMITTED rounds only (pass, fail, or
 *  undeterminable); discards and cancellations burn nothing. Undeterminable
 *  rounds self-schedule the retry inside the loop (no wake). Two consecutive
 *  fingerprint discards commit as an undeterminable round so the loop stays
 *  bounded. Exhaustion pauses in EVERY mode (fail-closed) with an in-band
 *  `pi-plans-review-paused` message; the ONLY fresh-budget surface is
 *  /plans-execute — ordinary input and session restores never refill.
 *
 *  Lifecycle: each round owns a session-scoped AbortController (never
 *  ctx.signal, which is turn-scoped), aborted from session_shutdown,
 *  stopExecution, startExecution, and restoreFromSession. Outcomes are
 *  guarded by execution identity (`execution !== owner` → silent discard).
 *
 *  Completion stays fail-closed AND never fail-open: a run completes only
 *  when every pending check was affirmatively passed. */
function isReviewCapPause(reason: string | undefined | null): boolean {
	return isReviewPauseReason(reason);
}

/** v0.9.3: the counters that bound an unlimited budget. */
function budgetCounters(ex: ExecState): { reviewRoundsTotal: number; reviewCapExtension: number } {
	return { reviewRoundsTotal: ex.reviewRoundsTotal, reviewCapExtension: ex.reviewCapExtension };
}

/** The budget in force for this run; a legacy checkpoint resolves to 5 during
 * load, so this is only a guard for hand-built test states. */
function activeBudget(ex: ExecState): ReviewBudget {
	return ex.reviewBudget ?? LEGACY_REVIEW_MAX_ROUNDS;
}

function budgetSpent(ex: ExecState): boolean {
	// v0.10: the numeric budget bills committed rounds MINUS the single exempt
	// non-high repair cycle (credit 1 iff the flag is `"granted"`); the
	// unlimited hard cap keeps counting raw `reviewRoundsTotal` (decision 7).
	return budgetExhausted(activeBudget(ex), Math.max(0, ex.audit.rounds - reviewNonHighCredit(ex)), budgetCounters(ex));
}

/** v0.10: the committed-round count as BILLED against a numeric budget — raw
 * rounds minus the single exempt non-high cycle. Display and message surfaces
 * use this so a granted cycle never reads as exhausted. */
function billedRounds(ex: ExecState): number {
	return Math.max(0, ex.audit.rounds - reviewNonHighCredit(ex));
}

/** `3` / `∞` — the budget as shown in status lines and messages. */
function budgetLabel(ex: ExecState): string {
	return formatReviewBudget(activeBudget(ex));
}

/**
 * v0.9.3: whether the budget menu may be opened in THIS session. Beyond the
 * native-surface check, auto-approve sessions never ask — the recorded plan
 * decision routes headless/auto-approve runs to the default budget
 * (`PI_PLANS_AUTO_APPROVE=1` exists for unattended harnesses, where a native
 * selector would either hang or answer meaninglessly).
 * The identifier keeps its historical name (`reviewBudgetPanelUsable` /
 * `reviewBudgetPanelAvailable`), but the surface it guards is the native select
 * menu — see src/review-budget.ts.
 */
function reviewBudgetPanelUsable(ctx: ExtensionContext): boolean {
	return !isAutoApproveEnabledLocal() && reviewBudgetPanelAvailable(ctx);
}

/** Persist a freshly resolved budget (and the counters) in one revision. */
function persistResolvedBudget(ctx: ExtensionContext, ex: ExecState): void {
	withExecutionCheckpoint(ctx, (cp) =>
		applyExecutionProgress(cp, {
			reviewBudget: ex.reviewBudget ?? null,
			reviewBudgetDefaulted: ex.reviewBudgetDefaulted === true,
			reviewRoundsTotal: ex.reviewRoundsTotal,
			reviewCapExtension: ex.reviewCapExtension,
		}),
	);
	persist(ctx);
	updateStatusWidget(ctx);
}

/** One visible note whenever the fallback (rather than a user pick) decided
 * the budget — never a silent bound (v0.9.3, Q-3). `"unavailable"` covers both
 * a session with no menu at all and a selector that threw (the catch in
 * `askReviewBudget` must never strand the run). */
function notifyDefaultBudget(ex: ExecState, why: "unavailable" | "cancelled"): void {
	const budget = formatReviewBudget(ex.reviewBudget ?? DEFAULT_REVIEW_BUDGET);
	messaging().sendMessage(
		{
			customType: "pi-plans-review-budget-default",
			content:
				why === "unavailable"
					? `**pi-plans: execution review budget: ${budget} (default)** — no budget menu is available in this session, so the default budget applies. The review runs up to ${budget} round(s) before pausing for /plans-execute.`
					: `**pi-plans: execution review budget: ${budget} (default)** — the budget menu was closed without a choice, so the default budget applies. The review runs up to ${budget} round(s) before pausing for /plans-execute.`,
			display: true,
		},
		{ triggerTurn: false },
	);
}

/** Synchronous fallback: apply (and persist) the default budget. Used when no
 * native menu exists at all — the headless/print/json and auto-approve paths —
 * so the first round needs no extra async hop. */
function applyDefaultReviewBudget(ctx: ExtensionContext, ex: ExecState): void {
	if (ex.reviewBudget !== undefined) return;
	ex.reviewBudget = DEFAULT_REVIEW_BUDGET;
	ex.reviewBudgetDefaulted = true;
	notifyDefaultBudget(ex, "unavailable");
	persistResolvedBudget(ctx, ex);
}

/**
 * Resolve the per-run review budget exactly once, immediately before the first
 * round. The menu ask is async; every other case is handled up front by
 * `applyDefaultReviewBudget`. `budgetAsking` keeps a second settle (or a
 * restore while the menu is open) from opening a second ask.
 */
async function askReviewBudgetForRun(ctx: ExtensionContext, ex: ExecState): Promise<void> {
	if (ex.reviewBudget !== undefined || ex.review.budgetAsking) return;
	ex.review.budgetAsking = true;
	try {
		const picked = await askReviewBudget(ctx, ex.uiLanguage, undefined);
		if (execution !== ex || ex.reviewBudget !== undefined) return;
		ex.reviewBudget = picked ?? DEFAULT_REVIEW_BUDGET;
		ex.reviewBudgetDefaulted = picked === null;
		if (picked === null) notifyDefaultBudget(ex, "cancelled");
		persistResolvedBudget(ctx, ex);
	} finally {
		ex.review.budgetAsking = false;
	}
}

/** Persist the reviewer settings (count and suggested directions). */
function persistReviewers(ctx: ExtensionContext, ex: ExecState): void {
	withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { reviewers: ex.reviewers ?? null }));
	persist(ctx);
	updateStatusWidget(ctx);
}

/** Reviewers per round for this run: the decided count, or one. */
export function reviewerCountOf(ex: ExecState): number {
	return ex.reviewers?.count ?? DEFAULT_REVIEWER_COUNT;
}

/** No menu available: record the default count so the run never re-asks. */
function applyDefaultReviewerCount(ctx: ExtensionContext, ex: ExecState): void {
	if (ex.reviewers?.count !== undefined) return;
	ex.reviewers = { ...ex.reviewers, count: DEFAULT_REVIEWER_COUNT };
	persistReviewers(ctx, ex);
}

/**
 * Ask how many reviewers the execution review should run, once per run, right
 * before round 1 (every task is terminal and the pending checks are known).
 * Shares the `budgetAsking` guard with the budget ask so a second settle
 * cannot open a second menu while this one is open.
 */
async function askReviewerCountForRun(ctx: ExtensionContext, ex: ExecState, pendingChecks: number): Promise<void> {
	if (ex.reviewers?.count !== undefined || ex.review.budgetAsking) return;
	ex.review.budgetAsking = true;
	try {
		const picked = await askReviewerCount(ctx, ex.uiLanguage, pendingChecks);
		if (execution !== ex || ex.reviewers?.count !== undefined) return;
		ex.reviewers = { ...ex.reviewers, count: picked ?? DEFAULT_REVIEWER_COUNT };
		persistReviewers(ctx, ex);
	} finally {
		ex.review.budgetAsking = false;
	}
}

/**
 * Record the directions the executor suggests for the reviewers (the
 * `plans_review_directions` tool). Replaces any earlier suggestion; invalid
 * entries are dropped and reported back to the caller.
 */
export function setSuggestedReviewDirections(ctx: ExtensionContext, ex: ExecState, value: unknown): { accepted: ReviewDirection[]; dropped: string[] } {
	const { directions, dropped } = sanitizeDirections(value);
	if (directions.length > 0) {
		ex.reviewers = { ...ex.reviewers, directions };
		persistReviewers(ctx, ex);
	}
	return { accepted: directions, dropped };
}

/** The currently-running (or self-scheduling) review chain; the sanctioned
 * test seam awaits this. */
let activeReviewChain: Promise<void> | null = null;

function abortInFlightReview(): void {
	const inFlight = execution?.review.inFlight;
	if (inFlight) {
		try {
			inFlight.controller.abort();
		} catch {
			/* already aborted */
		}
		if (execution) execution.review.inFlight = null;
	}
	activeReviewChain = null;
}

/** v0.9: unresolved high-severity findings from the newest committed round.
 * Presence in the newest round's report IS the unresolved set (stable ids:
 * a problem is resolved only by no longer being reported). */
function unresolvedHighFindings(ex: ExecState): ReviewFinding[] {
	return ex.audit.findings.filter((f) => f.severity === "high");
}

/** v0.9: checkpoint records -> runtime findings. Invalid severities degrade to
 * "malformed" (recorded, non-blocking) — the same never-fail posture as the
 * report parser. */
function toReviewFindings(records?: ReviewFindingRecord[]): ReviewFinding[] {
	if (!records) return [];
	return records.map((r) => {
		const severity = (r.severity === "high" || r.severity === "medium" || r.severity === "low") ? r.severity : "malformed";
		return { id: r.id, severity, taskIds: Array.isArray(r.taskIds) ? r.taskIds : [], proposedTask: r.proposedTask, note: r.note ?? "", evidence: r.evidence ?? "", raw: r.raw ?? "" };
	});
}

/** v0.10: unresolved non-high findings — the repair-eligible set. `malformed`
 * severities are recorded but never actionable (same never-fail posture as
 * the report parser). */
function unresolvedRepairableFindings(ex: ExecState): ReviewFinding[] {
	return ex.audit.findings.filter((f) => f.severity === "medium" || f.severity === "low");
}

/** v0.10 (Q1): billed-round credit of the single non-high repair cycle — 1
 * exactly while the flag is `"granted"`, 0 otherwise. NEVER read the persisted
 * mirror for arithmetic: the flag is the source of truth, so a fresh
 * `/plans-execute` window (which zeroes `audit.rounds`) cannot bill negative. */
function reviewNonHighCredit(ex: ExecState): number {
	return ex.reviewNonHighRepair === "granted" ? 1 : 0;
}

/** v0.10: the review is owed while a non-high repair cycle is pending — the
 * flag is `"available"`/`"granted"` (present, i.e. this run has committed a
 * reported round under the new policy) and repairable findings exist. An
 * ABSENT flag means a legacy checkpoint: non-high findings never widen the
 * owed predicate there (decision 6). */
function nonHighRepairPending(ex: ExecState): boolean {
	if (ex.reviewNonHighRepair !== "available" && ex.reviewNonHighRepair !== "granted") return false;
	return unresolvedRepairableFindings(ex).length > 0;
}

/** v0.9: findings widen the owed predicate — an unresolved high finding keeps
 * the review owed even when every check is done (the stranded-high path),
 * mirroring how a failed check keeps it owed today. */
function reviewOwed(ex: ExecState): boolean {
	return allTasksTerminal(ex.tasks) && reviewOutstanding(ex);
}

/** v0.9.2: the review is outstanding wherever the tree stands — checks still
 * owed, an unresolved high finding, or a pending non-high repair cycle.
 * `reviewOwed` ANDs this with allTasksTerminal; the blocked wake needs exactly
 * the half that stays true while tasks are open, because that is the state in
 * which the review cannot start (and in which `pendingAudit` is false by
 * construction). */
function reviewOutstanding(ex: ExecState): boolean {
	return auditableChecks(ex.items, ex.tasks).some((item) => !item.done) || unresolvedHighFindings(ex).length > 0 || nonHighRepairPending(ex);
}

/** v0.9.2: live blocker ids — the newest failed round's rollback set
 * intersected with the still-open tasks. Always recomputed from the tree: the
 * stored `tasks` list may predate the last status change. */
function blockedTaskIds(ex: ExecState): string[] {
	return ex.blocked ? blockedReviewTasks(ex.tasks, ex.blocked.rolledBack) : [];
}

/** v0.9.2: one visible system line per escalation level, so the user sees the
 * loop escalating before the watchdog pauses it. Memory-only latch (the
 * restored state re-notifies once, which is the useful behavior). */
function notifyBlockedEscalation(ctx: ExtensionContext, ex: ExecState): void {
	const level = ex.blocked?.escalatedRounds ?? 0;
	if (!ex.blocked || level === 0 || ex.blockedNotifiedLevel === level) return;
	ex.blockedNotifiedLevel = level;
	const ids = blockedTaskIds(ex);
	try {
		messaging().sendMessage(
			{
				customType: EXECUTION_BLOCKED_CUSTOM_TYPE,
				content: `**pi-plans: execution blocked (wake ${level}/${STALL_MAX_ROUNDS})** — review round ${ex.blocked.round + 1} cannot start: ${ids.join(", ")} ${ids.length === 1 ? "was" : "were"} reopened by round ${ex.blocked.round} and ${ids.length === 1 ? "is" : "are"} still open. Close them with \`plans_update_task\` (the review starts by itself once every task is terminal).`,
				display: true,
			},
			{ triggerTurn: false },
		);
	} catch {
		/* best-effort: the wake below still carries the same blocker */
	}
}

/** v0.9.2: the pause reason names the real blocker instead of the watchdog's
 * own metric. Single line, never a review-cap prefix (`isReviewCapPause`
 * matches "execution review exhausted" / "completion audit exhausted"). */
function blockedPauseReason(ex: ExecState): string {
	const ids = blockedTaskIds(ex);
	const round = ex.blocked?.round ?? ex.audit.rounds;
	const head = ids.slice(0, 3).join(", ");
	const more = ids.length > 3 ? `, +${ids.length - 3} more` : "";
	return `blocked: review round ${round + 1} cannot start — ${ids.length} task(s) reopened by round ${round} still open (${head}${more})`;
}

function runDirOf(ctx: ExtensionContext): string | null {
	const runId = executionRunId ?? resolveActiveRun(ctx.sessionManager, ctx.cwd)?.run_id ?? null;
	return runId ? runDirPath(ctx.cwd, runId) : null;
}

function setRunStatusForReview(ctx: ExtensionContext, status: "verifying" | "executing"): void {
	const runId = executionRunId ?? resolveActiveRun(ctx.sessionManager, ctx.cwd)?.run_id ?? null;
	if (!runId) return;
	try {
		const current = getRun(ctx.cwd, runId)?.status;
		if (current !== status && current !== "done" && current !== "abandoned") {
			setRunStatus(ctx.cwd, runId, status);
		}
	} catch {
		/* best-effort */
	}
}

/** Round fingerprint (Q-fingerprint-scope): plan digest + git HEAD +
 * covered-file mtimes. A change between round start and resolve means the
 * reviewer judged a subject that no longer exists — discard and re-run. */
function captureReviewFingerprint(ctx: ExtensionContext, ex: ExecState): string {
	const parts: string[] = [];
	try {
		parts.push(createHash("sha256").update(fs.readFileSync(ex.planPath, "utf8")).digest("hex"));
	} catch {
		parts.push("plan-unreadable");
	}
	try {
		parts.push(execSync("git rev-parse HEAD", { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim());
	} catch {
		parts.push("no-head");
	}
	const covered = new Set<string>();
	for (const task of flattenTaskViews(ex.tasks)) {
		for (const file of task.files ?? []) covered.add(file);
	}
	const mtimes: string[] = [];
	for (const file of [...covered].sort()) {
		try {
			mtimes.push(`${file}:${fs.statSync(path.resolve(ctx.cwd, file)).mtimeMs}`);
		} catch {
			mtimes.push(`${file}:missing`);
		}
	}
	parts.push(mtimes.join("|"));
	return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** Round timeout: a committed round is minutes, never the 60-min subagent
 * default — a hung child must surface as a spawn-failure round, not park the
 * run in verifying for an hour (CF2-010). */
const REVIEW_ROUND_TIMEOUT_MS = 20 * 60 * 1000;

/** Reviewer-role pinning (Q-role-fallback): a CONFIRMED delegated role pins
 * the spawn's model+thinking and labels the overlay with the role; an
 * unconfirmed or current-session role inherits the session default with the
 * "session default" label — a detached round NEVER opens the interactive
 * first-use panel. */
function reviewSpawnProfile(): { model?: string; thinkingLevel?: string; label: string } {
	try {
		const reviewer = loadGlobalConfig().config.reviewer;
		if (reviewer.mode !== "current-session" && reviewerReady(reviewer)) {
			const spawn = resolveReviewerSpawn(reviewer);
			if (spawn.modelSelector) {
				return { model: spawn.modelSelector, thinkingLevel: spawn.thinkingLevel ?? undefined, label: spawn.label };
			}
		}
	} catch {
		/* fall through to the session default */
	}
	return { label: "session default" };
}

/** Fleet group of the in-flight (or most recent) execution-review round. */
let reviewRun: FleetRun | null = null;

/** The reopen surface: focuses the newest execution-review agent's overlay.
 * Inert when no review round has run yet. */
export function reopenReviewOverlay(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || ctx.hasUI !== true) return;
	fleetUi.attach(fleetUiHost(ctx), {
		lang: execution?.uiLanguage,
		onUnhandledKey: (data) => {
			if (matchesTerminalKey(data, "ctrl+shift+t")) toggleDashboardExpanded(ctx);
		},
	});
	fleetUi.openLatest("auditor");
}

function pauseReviewCap(ctx: ExtensionContext, ex: ExecState): void {
	const highs = unresolvedHighFindings(ex);
	const detail =
		ex.audit.failed.length > 0
			? `failed: ${ex.audit.failed.join(", ")}${highs.length > 0 ? `; high findings: ${highs.map((f) => f.id).join(", ")}` : ""}`
			: highs.length > 0
				? `high findings: ${highs.map((f) => f.id).join(", ")}`
				: `unreadable verdicts: ${ex.audit.undeterminable.join(", ") || "unknown"}`;
	// v0.9.3: the reason names the budget actually in force — the numeric round
	// count, or the unlimited hard cap that stopped the loop.
	const scope =
		activeBudget(ex) === "unlimited"
			? `${unlimitedHardCapCeiling(budgetCounters(ex))} rounds (unlimited budget safety cap)`
			: `${activeBudget(ex)} round${activeBudget(ex) === 1 ? "" : "s"}`;
	const reason = `${REVIEW_CAP_PAUSE_PREFIX} ${scope} (${detail}). Only /plans-execute — an explicit user confirmation — grants a fresh budget (and re-opens the ${formatReviewBudget(activeBudget(ex))} picker; ordinary messages and session restores do not). (Or close the failed checks' tasks as skipped to pass them as skipped-pass.)`;
	pauseForStall(ctx, reason);
	// In-band, headless-visible pause signal (the pi-plans-exec-stop pattern):
	// pauseForStall's ui.notify is optional and absent headless, so the pause
	// must also land in the session stream every mode can read.
	messaging().sendMessage(
		{ customType: "pi-plans-review-paused", content: `**pi-plans: ${reason}**`, display: true },
		{ triggerTurn: false },
	);
}

/** v0.9.3: the unlimited budget's no-progress valve — three consecutive
 * committed rounds with an identical outcome signature cannot converge, so
 * the run pauses fail-closed instead of burning rounds silently. */
function pauseReviewNoProgress(ctx: ExtensionContext, ex: ExecState): void {
	const streak = ex.reviewNoProgress?.streak ?? NO_PROGRESS_MAX_STREAK;
	const highs = unresolvedHighFindings(ex);
	const detail =
		ex.audit.failed.length > 0
			? `failed: ${ex.audit.failed.join(", ")}${highs.length > 0 ? `; high findings: ${highs.map((f) => f.id).join(", ")}` : ""}`
			: highs.length > 0
				? `high findings: ${highs.map((f) => f.id).join(", ")}`
				: `unreadable verdicts: ${ex.audit.undeterminable.join(", ") || "unknown"}`;
	const reason = `${REVIEW_NO_PROGRESS_PAUSE_PREFIX} — ${streak} consecutive rounds reported the same outcome (${detail}). Only /plans-execute — an explicit user confirmation — grants a fresh budget (and re-opens the budget picker; ordinary messages and session restores do not).`;
	pauseForStall(ctx, reason);
	messaging().sendMessage(
		{ customType: "pi-plans-review-paused", content: `**pi-plans: ${reason}**`, display: true },
		{ triggerTurn: false },
	);
}

/** v0.9.3: the single gate every round spawn passes through. Returns false
 * when the run was paused (no round may start). The unlimited valve order is
 * deliberate: no-progress is checked first so its reason wins when both hold. */
function reviewBudgetGate(ctx: ExtensionContext, ex: ExecState): boolean {
	if (activeBudget(ex) === "unlimited" && noProgressTripped(ex.reviewNoProgress)) {
		pauseReviewNoProgress(ctx, ex);
		return false;
	}
	if (budgetSpent(ex)) {
		pauseReviewCap(ctx, ex);
		return false;
	}
	return true;
}

async function startReviewRound(ctx: ExtensionContext): Promise<void> {
	if (!execution) return;
	const ex = execution;
	// Skipped-pass checks resolve without a subagent round.
	for (const id of presolvedCheckIds(ex.items, ex.tasks)) {
		const item = ex.items.find((candidate) => candidate.id === id);
		if (item) item.done = true;
	}
	// Only auditable checks (with task coverage) gate completion; checks that
	// cover no task can never be verified and never block or complete.
	const pendingChecks = auditableChecks(ex.items, ex.tasks).filter((item) => !item.done);
	// v0.9: unresolved high findings block the fast completion path — they
	// keep the review owed instead (liveness: a high can never be completed
	// around, only fixed or paused at the cap). v0.10: a pending non-high
	// repair cycle blocks it too, so the credited re-review round always runs
	// before any disclosure-only completion.
	if (pendingChecks.length === 0 && unresolvedHighFindings(ex).length === 0 && !nonHighRepairPending(ex)) {
		await completeExecution(ctx);
		return;
	}
	if (ex.stall.paused || ex.review.inFlight || ex.review.budgetAsking) return;
	// v0.9.3: the budget is resolved right here — every task is terminal, the
	// review is genuinely owed, and this is the last moment before round 1.
	// No menu → the default applies synchronously (no extra tick, so a
	// detached settle still shows the round in flight immediately); a menu ask →
	// one await, guarded against a second settle by `budgetAsking`.
	if (ex.reviewBudget === undefined && !reviewBudgetPanelUsable(ctx)) applyDefaultReviewBudget(ctx, ex);
	if (ex.reviewBudget === undefined) {
		await askReviewBudgetForRun(ctx, ex);
		if (execution !== ex || ex.reviewBudget === undefined) return;
	}
	if (pendingChecks.length === 0) {
		// Every verification check is satisfied; only unresolved highs keep the
		// review owed. With the budget spent there is no round left to buy, so
		// the run completes and DISCLOSES the highs (v0.9.3, Q-2).
		if (budgetSpent(ex)) {
			await completeExecution(ctx);
			return;
		}
	}
	if (!reviewBudgetGate(ctx, ex)) return;
	// How many reviewers share this run's review: asked once, only when there
	// are at least two checks to split (otherwise one reviewer is the whole
	// round and nothing is stored, so a later round with more checks may ask).
	if (ex.reviewers?.count === undefined && pendingChecks.length > 1) {
		if (!reviewBudgetPanelUsable(ctx)) applyDefaultReviewerCount(ctx, ex);
		else {
			await askReviewerCountForRun(ctx, ex, pendingChecks.length);
			if (execution !== ex || ex.stall.paused || ex.review.inFlight) return;
		}
	}
	// Phase transition: the executor is done with its tasks; the review loop
	// owns the run until it converges (or pauses at the cap).
	setRunStatusForReview(ctx, "verifying");
	const round: InFlightReview = {
		controller: new AbortController(),
		budgetRound: ex.audit.rounds + 1,
		attempt: ex.review.attempts + 1,
		fingerprint: captureReviewFingerprint(ctx, ex),
		wakeSent: false,
	};
	ex.review.attempts = round.attempt;
	ex.review.inFlight = round;
	ex.audit.running = true; // dashboard mirror (the v0.8 model lands with the overlay task)
	const spawn = reviewSpawnProfile();
	const laneId = `review-round-${round.attempt}`;
	// Multi-reviewer round: the pending checks are split evenly and every
	// reviewer digs along its own direction (executor-suggested, else the
	// back-up aspects). Empty = the unchanged single-reviewer round.
	const reviewLanes: AuditLane[] = planReviewLanes(pendingChecks, reviewerCountOf(ex), ex.reviewers?.directions, ex.audit.findings);
	const multi = reviewLanes.length > 1;
	const fleetLaneIds = multi ? reviewLanes.map((lane) => lane.id) : [laneId];
	const completedLanes = new Set<string>();
	// A UI failure must NEVER kill the round itself: the fleet list is
	// best-effort chrome.
	const run = openFleetGroup(ctx, {
		role: "auditor",
		groupId: `execution-review-${round.attempt}-${Date.now().toString(36)}`,
		lanes: multi
			? reviewLanes.map((lane) => ({ id: lane.id, label: `Reviewer ${lane.index + 1}/${lane.total} · ${lane.id}` }))
			: [{ id: laneId, label: `Execution review round ${round.attempt}` }],
		modelLabel: spawn.label,
		lang: ex.uiLanguage,
		// pi-tui has no key bubbling: forward the dashboard toggle.
		onUnhandledKey: (data) => {
			if (matchesTerminalKey(data, "ctrl+shift+t")) toggleDashboardExpanded(ctx);
		},
	});
	reviewRun = run;
	updateStatusWidget(ctx);
	let result: AuditRoundResult;
	try {
		result = auditRunnerForTests
			? await auditRunnerForTests({ planPath: ex.planPath, checklist: ex.items, tasks: ex.tasks, round: round.attempt, priorFindings: ex.audit.findings, findingDispositions: findingDispositionMap(ex), lanes: reviewLanes })
			: await runCompletionAudit(ctx, {
				planPath: ex.planPath,
				checklist: ex.items,
				tasks: ex.tasks,
				round: round.attempt,
				priorFindings: ex.audit.findings,
				// v0.10: the previous round's per-finding dispositions ride the
				// brief so a deliberate decline is visible to the reviewer.
				findingDispositions: findingDispositionMap(ex),
				model: spawn.model,
				thinkingLevel: spawn.thinkingLevel,
				timeoutMs: REVIEW_ROUND_TIMEOUT_MS,
				signal: round.controller.signal,
				onProgress: (event) => run.group.update(laneId, event),
				lanes: reviewLanes,
				onLaneProgress: (id, event) => run.group.update(id, event),
				onLaneResult: (id, laneResult) => {
					completedLanes.add(id);
					run.group.complete(id, laneResult);
				},
			});
	} catch (error) {
		if (ex.review.inFlight === round) {
			ex.review.inFlight = null;
			ex.audit.running = false;
		}
		for (const id of fleetLaneIds) {
			if (!completedLanes.has(id)) run.group.complete(id, { ok: false, output: "", stderr: "", turns: 0, errorMessage: String(error) });
		}
		run.close();
		if (reviewRun === run) reviewRun = null;
		messaging().sendMessage(
			{ customType: "pi-plans-review-error", content: `pi-plans: execution review round threw: ${String(error)}`, display: true },
			{ triggerTurn: false },
		);
		updateStatusWidget(ctx);
		return;
	}
	// Terminal lane state; the finished agent stays in the list so its
	// transcript can still be read until the next round replaces it.
	const cancelledResult = result !== null && typeof result === "object" && "cancelled" in result;
	try {
		for (const id of fleetLaneIds) {
			if (completedLanes.has(id)) continue;
			run.group.complete(id, {
				ok: !cancelledResult,
				output: result && "report" in result ? result.report : "",
				stderr: "",
				turns: 0,
				...(cancelledResult ? { cancelled: true as const } : {}),
			});
		}
	} catch {
		/* cosmetic only */
	}
	run.close();
	if (reviewRun === run) reviewRun = null;
	await handleReviewOutcome(ctx, ex, round, result, pendingChecks.map((item) => item.id));
}

async function handleReviewOutcome(
	ctx: ExtensionContext,
	owner: ExecState,
	round: InFlightReview,
	result: AuditRoundResult,
	pendingIds: string[],
): Promise<void> {
	// Identity guard: a restore, stop, or fresh handoff replaced the run —
	// drop this outcome silently (CF2-002).
	if (execution !== owner) return;
	if (owner.review.inFlight !== round) return;
	owner.review.inFlight = null;
	owner.audit.running = false;
	if (result !== null && typeof result === "object" && "cancelled" in result) {
		// Aborted by shutdown/stop/restore/tree-switch: no round, no budget, no wake.
		updateStatusWidget(ctx);
		return;
	}
	const outcome = result;
	const reportText = outcome?.report ?? "(review subagent failed to run)";
	const fingerprintNow = captureReviewFingerprint(ctx, owner);
	const coveredTaskIds = flattenTaskViews(owner.tasks).map((task) => task.id);
	if (fingerprintNow !== round.fingerprint) {
		// The audited subject moved under the reviewer (Q-C): discard, re-run
		// without budget burn; two consecutive discards commit as undeterminable
		// so a mutating user cannot loop the loop for free (Q-discard-bound).
		owner.review.consecutiveDiscards += 1;
		const runDir = runDirOf(ctx);
		if (runDir) {
			writeReviewRoundReport(runDir, {
				versionSegment: currentHugeVersionLabel(ctx) ?? undefined,
				budgetRound: round.budgetRound,
				attempt: round.attempt,
				outcome: "discarded",
				passed: [],
				failed: [],
				undeterminable: pendingIds,
				// v0.9.1 (F-014): the discard report must not understate a
				// round whose embedded report carries highs.
				findings: owner.audit.findings,
				discardedReason: "fingerprint changed between round start and resolve (worktree/plan moved under the reviewer)",
				fingerprintCaptured: round.fingerprint,
				fingerprintFound: fingerprintNow,
				coveredTaskIds,
				report: reportText,
			});
		}
		if (owner.review.consecutiveDiscards >= 2) {
			owner.review.consecutiveDiscards = 0;
			await commitReviewOutcome(
				ctx,
				owner,
				round,
				{ passed: [], failed: [], undeterminable: pendingIds, report: `(two consecutive fingerprint discards — committed as an undeterminable round)\n\n${reportText}` },
				pendingIds,
			);
			return;
		}
		persist(ctx);
		updateStatusWidget(ctx);
		await maybeContinueReview(ctx, owner);
		return;
	}
	owner.review.consecutiveDiscards = 0;
	await commitReviewOutcome(ctx, owner, round, outcome, pendingIds);
}

/** v0.9 (findings-driven fix loop): append plan tasks for high findings no
 * existing task owns. The reviewer stays read-only — it proposes the title
 * (proposed-task); this machinery applies it with provenance, so every high
 * finding always has an owner the executor can close, and the stable F-###
 * id rides in the task title for traceability. Best-effort: an unwritable
 * plan must not crash the loop (the finding then stays stranded and the cap
 * pause surfaces it). Returns the appended task ids. */
function appendFindingTasks(ex: ExecState, findings: ReviewFinding[]): string[] {
	const appended: string[] = [];
	// v0.10 (F-008): idempotency — a finding whose `fix <id>:` task already
	// exists in the tree is never appended twice. The title carries a round
	// suffix, so the match is a PREFIX match; this applies to highs too (a
	// repeatedly reported unmapped high double-appended before this).
	const alreadyAppended = new Set<string>();
	for (const task of flattenTaskViews(ex.tasks)) {
		const match = /^fix (F-\d+):/.exec(task.title);
		if (match) alreadyAppended.add(match[1]);
	}
	const pending = findings.filter((finding) => !alreadyAppended.has(finding.id));
	if (pending.length === 0) return appended;
	let next = flattenTaskViews(ex.tasks).reduce((max, t) => {
		const m = /^Task-(\d+)$/.exec(t.id);
		return m ? Math.max(max, Number(m[1])) : max;
	}, 0);
	const wave = maxWave(ex.tasks) + 1;
	try {
		const planText = fs.readFileSync(ex.planPath, "utf8");
		const lines = planText.split("\n");
		// Insert inside the Tasks section: before the Execution Waves
		// subsection when present, else before the FIRST checklist header the
		// plan uses (v0.9.1 F-013: legacy plans say `## Verifier Checklist`,
		// and an EOF fallback would land outside every parsed section), else
		// at EOF; walk back over blank separators so the bullet lands
		// adjacent to its siblings.
		let insertAt = lines.length;
		const wavesIdx = lines.findIndex((l) => /^###\s+Execution Waves/.test(l));
		const checklistIdx = lines.findIndex((l) => CHECKLIST_HEADERS.some((h) => new RegExp(`^##\\s+${h}`).test(l)));
		if (wavesIdx !== -1) insertAt = wavesIdx;
		else if (checklistIdx !== -1) insertAt = checklistIdx;
		while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
		// v0.9.1 (F-012): reviewer text becomes task-title metadata at parse
		// time — strip the microsyntax metacharacters (em/en dashes, `--`
		// separators, the `;` field delimiter) so an embedded token can never
		// split title from tail or forge fields.
		const sanitize = (text: string): string => text.replace(/[—–]/g, "-").replace(/-{2,}/g, "-").replace(/;/g, ",");
		const entries: Array<{ id: string; title: string }> = [];
		const newLines: string[] = [];
		for (const h of pending) {
			next += 1;
			const id = `Task-${next}`;
			const title = `fix ${h.id}: ${sanitize(h.proposedTask ?? h.note ?? "address the finding")} (appended by execution review round ${ex.audit.rounds})`;
			// v0.9.1 (F-006): carry the wave in the bullet tail so a re-parse
			// restores the same wave the live tree assigned — without it the
			// appended remediation task fell back to wave 1 on restore and
			// hijacked the ▸ anchor.
			newLines.push(`- \`${id}\`: ${title} — wave: ${wave}`);
			entries.push({ id, title });
		}
		lines.splice(insertAt, 0, ...newLines);
		fs.writeFileSync(ex.planPath, lines.join("\n"), "utf8");
		// v0.9.1 (F-008): only a successful plan write mints the live tasks —
		// pushing before the write left checkpoint entries the plan file does
		// not contain whenever the write failed.
		for (const entry of entries) {
			ex.tasks.push({ id: entry.id, title: entry.title, wave, deps: [], files: [], status: "pending", children: [] });
			appended.push(entry.id);
		}
	} catch {
		/* best-effort: stranded highs surface via the cap pause */
	}
	return appended;
}

async function commitReviewOutcome(
	ctx: ExtensionContext,
	ex: ExecState,
	round: InFlightReview,
	outcome: AuditOutcome | null,
	pendingIds: string[],
): Promise<void> {
	// The budget is charged only when an outcome commits — never on discard
	// or cancellation (CF2-003).
	ex.audit.rounds = round.budgetRound;
	// v0.9.3: the run-cumulative counter never resets — it is what bounds an
	// unlimited budget across grants (Q-4).
	ex.reviewRoundsTotal += 1;
	const passed = pendingIds.filter((id) => (outcome?.passed ?? []).includes(id));
	const failed = pendingIds.filter((id) => (outcome?.failed ?? []).includes(id));
	// Anything the round neither passed nor failed is undeterminable: the
	// report omitted the check, spelled the verdict unreadably, or the
	// subagent never ran.
	const undeterminable = pendingIds.filter((id) => !passed.includes(id) && !failed.includes(id));
	// v0.9: the newest round's reported findings ARE the unresolved set
	// (stable ids — a problem is resolved only by no longer being reported).
	// v0.9.1 (F-001): only a REAL parsed report is authoritative. A round that
	// produced no report at all — spawn failure (outcome === null) or the
	// two-consecutive-discard synthesis — must PRESERVE the unresolved set:
	// clearing it let the vacuous completion guard (empty pendingIds) mark a
	// run done with its high finding silently dropped.
	const reported = outcome !== null && outcome.findings !== undefined;
	const findings = reported ? outcome.findings : ex.audit.findings;
	ex.audit.findings = findings;
	const highs = findings.filter((f) => f.severity === "high");
	// v0.9.3: the no-progress valve's signature is computed HERE, from the
	// post-classification triple — a spawn-failure round (`outcome === null`)
	// and a discard synthesis have no findings array of their own, but the
	// preserved unresolved set plus the derived verdicts still describe a
	// concrete, comparable outcome (round-1 F-002).
	ex.reviewNoProgress = bumpNoProgress(ex.reviewNoProgress, noProgressSignature(failed, undeterminable, highs.map((f) => f.id)));
	// Findings are actionable only when this round actually reported them;
	// see the fix-loop branch below (v0.9.1, F-001).
	const actionableHighs = reported ? highs : [];
	// v0.10: the non-high classification. `medium` rides the union rollback;
	// `low` never rolls back verified work (decision 1); both are appended
	// when they own no task. `malformed` is never actionable.
	const actionableNonHighs = reported
		? findings.filter((f) => f.severity === "medium" || f.severity === "low")
		: [];
	// v0.10 flag state machine: ONLY a real report advances it (a no-report
	// round preserves findings and flag alike, exactly like the unresolved set
	// above). `granted` → `used` HERE — the re-review round just committed, so
	// the single non-high cycle is spent whatever its verdicts say.
	if (reported) {
		ex.reviewNonHighRepair = ex.reviewNonHighRepair === "granted" ? "used" : (ex.reviewNonHighRepair ?? "available");
		// Keep the persisted mirror in sync with the flag it is derived from.
		ex.reviewNonHighCredits = reviewNonHighCredit(ex);
	}
	// v0.10: one ledger string for the checkpoint's `lastResult` — failed
	// check ids keep their existing shape, findings get a severity-tagged list
	// that the v0.9.2 blocker backfill knows not to parse as check ids.
	const findingLedger = [
		actionableHighs.length > 0 ? `highs: ${actionableHighs.map((f) => f.id).join(",")}` : "",
		actionableNonHighs.length > 0 ? `medium/low: ${actionableNonHighs.map((f) => f.id).join(",")}` : "",
	].filter((part) => part.length > 0).join(" | ");
	const coveredTaskIds = flattenTaskViews(ex.tasks).map((task) => task.id);
	const reportText = outcome?.report ?? "(review subagent failed to run)";
	let reportPath: string | null = null;
	{
		const runDir = runDirOf(ctx);
		if (runDir) {
			reportPath = writeReviewRoundReport(runDir, {
				versionSegment: currentHugeVersionLabel(ctx) ?? undefined,
				budgetRound: round.budgetRound,
				attempt: round.attempt,
				outcome: outcome === null
					? "spawn-failed"
					: failed.length > 0 || actionableHighs.length > 0 || actionableNonHighs.length > 0
						? "failed"
						: undeterminable.length > 0 ? "undeterminable" : "passed",
				passed,
				failed,
				undeterminable,
				findings,
				fingerprintCaptured: round.fingerprint,
				coveredTaskIds,
				report: reportText,
			});
		}
	}
	// Partial progress counts: a check affirmed this round is done even when
	// a sibling failed, so a later round only re-judges what is still open.
	for (const id of passed) {
		const item = ex.items.find((candidate) => candidate.id === id);
		if (item) item.done = true;
	}

	// v0.9.3 (Q-2/F-003): the exhausted-budget completion. EVERY check this
	// round still owed affirmed, only unresolved highs remain, and the budget
	// cannot buy another round — the run completes, tolerating the highs (they
	// stay in the round report and the checkpoint; `completeExecution`
	// discloses them). Evaluated BEFORE the fix branch on purpose: the
	// tolerated round must not roll back tasks, append plan tasks, rewrite the
	// approved plan, or wake the executor for a run that is about to be done.
	if (budgetSpent(ex) && passed.length === pendingIds.length && highs.length > 0) {
		ex.audit.failed = [];
		ex.audit.undeterminable = [];
		ex.blocked = null;
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(ex.tasks),
				doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
				blocked: null,
				reviewRoundsTotal: ex.reviewRoundsTotal,
				reviewNoProgress: ex.reviewNoProgress ?? null,
				reviewNonHighRepair: ex.reviewNonHighRepair ?? null,
				reviewNonHighCredits: reviewNonHighCredit(ex),
				audit: { rounds: ex.audit.rounds, passed: true, findings },
			}),
		);
		persist(ctx);
		messaging().sendMessage(
			{
				customType: "pi-plans-review-tolerated",
				content: `**pi-plans: review budget exhausted (${budgetLabel(ex)}) — completing with ${highs.length} unresolved high finding(s): ${highs.map((f) => f.id).join(", ")}** — every verification check passed; the finding(s) remain in the round reports.`,
				display: true,
			},
			{ triggerTurn: false },
		);
		await completeExecution(ctx);
		return;
	}

	// v0.10 (decisions 1/2/7, Q3/Q5): the single non-high repair cycle. It is
	// granted only when this report's actionable findings are ALL non-high, the
	// one-shot is still `"available"`, and it runs BEFORE the tolerant/high
	// paths below so a spent numeric budget cannot swallow it — the credit
	// bills the cycle instead. A high/fail-driven pass (next branch) carries
	// non-highs as ride-alongs WITHOUT consuming the one-shot.
	if (
		failed.length === 0
		&& actionableHighs.length === 0
		&& actionableNonHighs.length > 0
		&& ex.reviewNonHighRepair === "available"
	) {
		ex.reviewNonHighRepair = "granted";
		ex.reviewNonHighCredits = reviewNonHighCredit(ex);
		ex.audit.failed = [];
		ex.audit.undeterminable = undeterminable;
		const knownIds = new Set(coveredTaskIds);
		// `medium` (and only medium) rolls back its mapped tasks — a PURE
		// finding-driven rollback keeps earlier VC passes (no invalidation),
		// exactly like a high's. `low` never touches the task tree's verified
		// work; it (and any unmapped medium) is appended as a repair task.
		const mappedMediumIds = [...new Set(
			actionableNonHighs.filter((f) => f.severity === "medium").flatMap((f) => f.taskIds).filter((id) => knownIds.has(id)),
		)];
		const mediumRolledBack = findingsRollbackSet(ex.tasks, mappedMediumIds);
		const appendable = actionableNonHighs.filter(
			(f) => f.severity === "low" || !f.taskIds.some((id) => knownIds.has(id)),
		);
		const amended = appendable.length > 0 ? appendFindingTasks(ex, appendable) : [];
		ex.blocked = mediumRolledBack.length > 0
			? {
				rolledBack: [...mediumRolledBack],
				tasks: blockedReviewTasks(ex.tasks, mediumRolledBack),
				round: ex.audit.rounds,
				escalatedRounds: 0,
				since: utcNow(),
			}
			: null;
		ex.blockedWakeTasks = undefined;
		withExecutionCheckpoint(ctx, (cp) => {
			const amendedCp = amended.length > 0
				? applyExecutionPlanAmended(cp, planIdentityOf(ex.planPath, cp.plan?.version ?? 1), ex.audit.rounds)
				: cp;
			return applyExecutionProgress(amendedCp, {
				tasks: taskProgressMap(ex.tasks),
				doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
				blocked: ex.blocked,
				reviewRoundsTotal: ex.reviewRoundsTotal,
				reviewNoProgress: ex.reviewNoProgress ?? null,
				reviewNonHighRepair: ex.reviewNonHighRepair,
				reviewNonHighCredits: reviewNonHighCredit(ex),
				audit: { rounds: ex.audit.rounds, lastResult: findingLedger, findings },
			});
		});
		if (mediumRolledBack.length > 0 || amended.length > 0) {
			ex.stall.rounds = 0;
			ex.stall.lastSnapshot = stallSnapshot();
			setRunStatusForReview(ctx, "executing");
		}
		persist(ctx);
		updateStatusWidget(ctx);
		if (!round.wakeSent) {
			round.wakeSent = true;
			const openTasks = flattenTaskViews(ex.tasks).filter((task) => !taskIsTerminal(task)).map((task) => task.id);
			const stranded = mediumRolledBack.length === 0 && amended.length === 0;
			const nonHighLines = actionableNonHighs
				.map((f) => `- ${f.id} (${f.severity})${f.taskIds.length ? ` (${f.taskIds.join(", ")})` : ""}: ${f.note}`)
				.join("\n");
			const reportRef = reportPath
				? `Full round report: ${reportPath}`
				: `Full round report (run dir unwritable — inline):\n\n---\n${reportText.slice(0, 4000)}`;
			const content = `**pi-plans: execution review round ${ex.audit.rounds} found ${actionableNonHighs.length} medium/low finding(s)** — this grants the single non-high repair cycle (exempt from the numeric budget; the hard cap still counts it). Medium findings rolled back their mapped tasks: ${mediumRolledBack.join(", ") || "(none mapped)"}.${amended.length > 0 ? ` Repair tasks appended to the plan: ${amended.join(", ")}.` : ""}\n\nNon-high findings:\n${nonHighLines}\n\nFix them and re-close the affected tasks with \`plans_update_task\` (evidence records the repair), or decline one with status \`skipped\` and \`skipReason: "deferred: <reason>"\`. The re-review round runs automatically once all tasks are terminal again.${stranded ? ` No task covers the finding(s) and none could be appended — the task tree stayed terminal; the next settle re-runs the review automatically.` : ""}\n\n${reportRef}`;
			sendRepairWake(ctx, ex, {
				customType: "pi-plans-audit-failed",
				content: `${content}\n\nStill open: ${openTasks.join(", ") || "(none — the tree is terminal)"}`,
				display: true,
			});
		}
		return; // The agent repairs; the credited re-review round is owed.
	}

	// v0.9 fix loop — evaluated BEFORE the completion branch so an unresolved
	// high finding can never complete the run (liveness). Failed checks and
	// high findings drive ONE union rollback and exactly one executor wake;
	// high wins over the undeterminable self-schedule (a finding is
	// actionable independent of verdict evidence). v0.9.1 (F-001): verdicts
	// are authoritative whenever a report exists, but the FINDINGS-driven
	// half of the branch needs a findings-bearing report — a no-findings
	// round (spawn failure, discard synthesis, legacy shape) preserves the
	// unresolved set and self-schedules instead of rolling back on it.
	if (failed.length > 0 || actionableHighs.length > 0) {
		ex.audit.failed = failed;
		ex.audit.undeterminable = undeterminable;
		const rolledBack: string[] = [];
		for (const id of failed) {
			rolledBack.push(...auditRollbackSet(ex.tasks, ex.items, id));
		}
		// Invalidation is the VC-fail invariant ONLY: a check re-verifies its
		// reopened tasks when a FAILED check rolled them back. A pure
		// finding-driven rollback keeps earlier passes — the findings channel
		// itself re-examines the repaired work next round (stable ids).
		if (rolledBack.length > 0) invalidateChecksForRolledBackTasks(ex.items, ex.tasks, rolledBack);
		const knownIds = new Set(coveredTaskIds);
		const mappedHighIds = [...new Set(actionableHighs.flatMap((h) => h.taskIds).filter((id) => knownIds.has(id)))];
		const highRolledBack = findingsRollbackSet(ex.tasks, mappedHighIds);
		// v0.10: this pass is high/fail-driven, so this round's non-highs ride
		// along WITHOUT consuming the one-shot (decision 3). Mapped mediums roll
		// back with the high cascade; unmapped mediums and every low are appended.
		const mappedMediumIds = [...new Set(
			actionableNonHighs.filter((f) => f.severity === "medium").flatMap((f) => f.taskIds).filter((id) => knownIds.has(id)),
		)];
		const mediumRolledBack = findingsRollbackSet(ex.tasks, mappedMediumIds);
		const unmappedHighs = actionableHighs.filter((h) => !h.taskIds.some((id) => knownIds.has(id)));
		const appendableNonHighs = actionableNonHighs.filter(
			(f) => f.severity === "low" || !f.taskIds.some((id) => knownIds.has(id)),
		);
		const amended = unmappedHighs.length > 0 || appendableNonHighs.length > 0
			? appendFindingTasks(ex, [...unmappedHighs, ...appendableNonHighs])
			: [];
		const allRolledBack = [...new Set([...rolledBack, ...highRolledBack, ...mediumRolledBack])];
		// v0.9.2: capture the round's rollback set HERE. The reopen helpers above
		// mutate the tree and report only flipped nodes, so this is the only
		// moment the authoritative provenance exists; the still-open subset is
		// what blocks the next round and what wakes/pauses name explicitly.
		ex.blocked = allRolledBack.length > 0
			? {
				rolledBack: [...allRolledBack],
				tasks: blockedReviewTasks(ex.tasks, allRolledBack),
				round: ex.audit.rounds,
				escalatedRounds: 0,
				since: utcNow(),
			}
			: null;
		ex.blockedWakeTasks = undefined;
		withExecutionCheckpoint(ctx, (cp) => {
			// v0.9.1 (F-002): appending finding tasks rewrote the approved plan;
			// re-stamp the checkpoint's plan identity in the same revision so a
			// later /resume-plans accepts the amended plan instead of rejecting
			// it as plan-mismatch (which would cost a full re-approval).
			const amendedCp = amended.length > 0
				? applyExecutionPlanAmended(cp, planIdentityOf(ex.planPath, cp.plan?.version ?? 1), ex.audit.rounds)
				: cp;
			return applyExecutionProgress(amendedCp, {
				tasks: taskProgressMap(ex.tasks),
				doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
				blocked: ex.blocked,
				reviewRoundsTotal: ex.reviewRoundsTotal,
				reviewNoProgress: ex.reviewNoProgress ?? null,
				reviewNonHighRepair: ex.reviewNonHighRepair ?? null,
				reviewNonHighCredits: reviewNonHighCredit(ex),
				audit: { rounds: ex.audit.rounds, lastResult: failed.join(",") || findingLedger || undefined, findings },
			});
		});
		if (allRolledBack.length > 0 || amended.length > 0) {
			// Rolling back (or appending) is itself forward progress for the
			// watchdog, but NOT for audit.rounds: that counter stays monotonic
			// so the repair loop is bounded. The repair belongs to the
			// executor — back to executing.
			ex.stall.rounds = 0;
			ex.stall.lastSnapshot = stallSnapshot();
			setRunStatusForReview(ctx, "executing");
		}
		persist(ctx);
		updateStatusWidget(ctx);
		// v0.8 wake, generalized (v0.9): per-round one-shot token — exactly one
		// triggerTurn per committed fix-needing outcome, even when the round
		// resolves long after the settle that spawned it.
		if (!round.wakeSent) {
			round.wakeSent = true;
			const openTasks = flattenTaskViews(ex.tasks)
				.filter((task) => !taskIsTerminal(task))
				.map((task) => task.id);
			const stranded = allRolledBack.length === 0 && amended.length === 0;
			const highLines = actionableHighs.map((h) => `- ${h.id}${h.taskIds.length ? ` (${h.taskIds.join(", ")})` : ""}: ${h.note}`).join("\n");
			const nonHighLines = actionableNonHighs
				.map((f) => `- ${f.id} (${f.severity})${f.taskIds.length ? ` (${f.taskIds.join(", ")})` : ""}: ${f.note}`)
				.join("\n");
			const reportRef = reportPath
				? `Full round report: ${reportPath}`
				: `Full round report (run dir unwritable — inline):\n\n---\n${reportText.slice(0, 4000)}`;
			// v0.9.1 (F-004): a pure VC-fail round keeps the v0.8 lead — never
			// announce "0 high-severity findings" over an empty block. v0.10: the
			// lead names non-high findings when the round carries them too.
			const findingsLead = actionableHighs.length > 0
				? `**pi-plans: execution review round ${ex.audit.rounds} found ${actionableHighs.length} high-severity finding(s)**${failed.length > 0 ? ` and failed checks: ${failed.join(", ")}` : ""}${actionableNonHighs.length > 0 ? ` and ${actionableNonHighs.length} medium/low finding(s)` : ""}.`
				: `**pi-plans: execution review round ${ex.audit.rounds} failed** — checks: ${failed.join(", ")}${actionableNonHighs.length > 0 ? ` and ${actionableNonHighs.length} medium/low finding(s)` : ""}.`;
			const findingsBlock = actionableHighs.length > 0 ? `\n\nHigh findings:\n${highLines}` : "";
			const nonHighBlock = actionableNonHighs.length > 0 ? `\n\nNon-high findings (medium/low):\n${nonHighLines}` : "";
			const content = `${findingsLead} Rolled back tasks: ${allRolledBack.join(", ") || "(none covered)"}${amended.length > 0 ? `. Tasks appended to the plan for unmapped findings: ${amended.join(", ")}` : ""}.${findingsBlock}${nonHighBlock}\n\nFix them and re-close the affected tasks with \`plans_update_task\` (evidence records the repair), or decline one with status \`skipped\` and \`skipReason: "deferred: <reason>"\`. The review reruns automatically once all tasks are terminal again.${budgetSpent(ex) ? (activeBudget(ex) === "unlimited" ? ` This was round ${ex.reviewRoundsTotal} against the unlimited budget's ${unlimitedHardCapCeiling(budgetCounters(ex))}-round safety cap: the next terminal-task cycle pauses the run for review.` : ` This was round ${billedRounds(ex)} of ${budgetLabel(ex)}: the next terminal-task cycle pauses the run for review (or completes if every check passed).`) : ""}${stranded ? ` No task covers the finding(s) and none could be appended — the task tree stayed terminal; the next settle re-runs the review automatically.` : ""}\n\n${reportRef}`;
			sendRepairWake(ctx, ex, {
				customType: "pi-plans-audit-failed",
				content: `${content}\n\nStill open: ${openTasks.join(", ") || "(none — the tree is terminal)"}`,
				display: true,
			});
		}
		return; // The agent repairs; the next settle re-enters the loop.
	}

	// Fail-closed completion: every pending check affirmatively passed AND no
	// high finding remains. The highs guard is explicit (v0.9.1, F-001): a
	// no-report round skips the fix branch above, so this is the last line
	// against vacuously completing an empty-pendingIds round with an
	// unresolved high. An all-undeterminable round yields failed === [] —
	// completing here would be fail-open, marking a run done with nothing
	// verified. v0.10 (plan Task-2.5): the condition is deliberately UNCHANGED
	// by the non-high repair flag — findings preserved by a no-report round
	// complete here with the honest disclosure instead of spinning another
	// round (and possibly a cap pause) that only a real report could repair.
	if (passed.length === pendingIds.length && highs.length === 0) {
		ex.audit.failed = [];
		ex.audit.undeterminable = [];
		// v0.9.2: a passing audit ends the blocker — the review consumed it.
		ex.blocked = null;
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(ex.tasks),
				doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
				blocked: null,
				reviewRoundsTotal: ex.reviewRoundsTotal,
				reviewNoProgress: ex.reviewNoProgress ?? null,
				reviewNonHighRepair: ex.reviewNonHighRepair ?? null,
				reviewNonHighCredits: reviewNonHighCredit(ex),
				audit: { rounds: ex.audit.rounds, passed: true, findings },
			}),
		);
		await completeExecution(ctx);
		return;
	}

	// Undeterminable-only round: the loop self-schedules the retry (Q-B) — no
	// wake, no message; the dashboard/overlay carries the round counter.
	ex.audit.failed = failed;
	ex.audit.undeterminable = undeterminable;
	withExecutionCheckpoint(ctx, (cp) =>
		applyExecutionProgress(cp, {
			tasks: taskProgressMap(ex.tasks),
			doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
			reviewRoundsTotal: ex.reviewRoundsTotal,
			reviewNoProgress: ex.reviewNoProgress ?? null,
			reviewNonHighRepair: ex.reviewNonHighRepair ?? null,
			reviewNonHighCredits: reviewNonHighCredit(ex),
			audit: { rounds: ex.audit.rounds, lastResult: failed.join(",") || undefined, findings },
		}),
	);
	persist(ctx);
	updateStatusWidget(ctx);
	await maybeContinueReview(ctx, ex);
}

async function maybeContinueReview(ctx: ExtensionContext, ex: ExecState): Promise<void> {
	if (execution !== ex) return;
	if (!reviewOwed(ex)) return;
	if (ex.stall.paused) return;
	// The budget gate owns every pause (numeric exhaustion, the unlimited hard
	// cap, and the unlimited no-progress valve). An exhausted budget with every
	// check satisfied has already completed inside commitReviewOutcome; here
	// the review is still owed, so a spent budget pauses.
	if (!reviewBudgetGate(ctx, ex)) return;
	await startReviewRound(ctx);
}

/** Launch a review round under the mode rule: detached (fire-and-forget with
 *  the chain tracked for the test seam) in tui/rpc; awaited inline otherwise
 *  (print/json settle must hold the runtime open through the round). Returns
 *  the chain when the caller must await it, null when detached. */
function launchReviewRound(ctx: ExtensionContext): Promise<void> | null {
	const detach = ctx.mode === "tui" || ctx.mode === "rpc";
	const chain = (async () => {
		await startReviewRound(ctx);
	})();
	activeReviewChain = chain;
	if (detach) {
		chain.catch(() => {
			/* surfaced via the review messages */
		});
		return null;
	}
	return chain;
}

/** Deterministic seam: await the in-flight (or self-scheduling) review chain. */
export function __awaitReviewRoundForTests(): Promise<void> {
	return activeReviewChain ?? Promise.resolve();
}

/** When this module graph was first imported into the running pi process.
 * pi loads extensions once, so a fix written to disk mid-session stays
 * invisible until /reload — which is exactly why an unreadable audit verdict
 * deserves a /reload hint rather than a bare retry. */
const extensionModuleLoadedAt = new Date();

/** The /reload advice when the extension on disk is newer than the copy this
 * process loaded, else null. Shared with /plans via src/staleness.ts so both
 * report the same answer from one probe. */
function staleReloadHint(): string | null {
	try {
		const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
		return probeStaleReload(root, extensionModuleLoadedAt);
	} catch {
		return null;
	}
}

/** True when the session can surface a pause to a human (D-022): interactive
 *  TUI/RPC sessions that are not running under PI_PLANS_AUTO_APPROVE. */
function isInteractiveSession(ctx: ExtensionContext): boolean {
	if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || ctx.hasUI !== true) return false;
	return !isAutoApproveEnabledLocal();
}

const EXECUTION_RESUME_CUSTOM_TYPE = "pi-plans-exec-resume";

/** Exported for the `turn_end` pre-plan draft path (index.ts): it needs the
 *  same active-settings/run resolution the `session_before_compact` path uses. */
export function activeVccSettings(ctx: ExtensionContext, phase: PiPlansCompactionPhase): { settings: PiPlansVccSettings; runId: string; artifactDir: string } | null {
	const stateRoot = resolveStateRootOrNull(ctx.cwd);
	if (!stateRoot) return null;
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (!active) return null;
	const run = getRun(ctx.cwd, active.run_id);
	if (!run) return null;
	if (phase === "planning" && run.status !== "planning") return null;
	if (phase === "execution" && run.status !== "executing" && run.status !== "verifying") return null;
	scaffoldVccSettings(stateRoot);
	return { settings: loadVccSettings(stateRoot), runId: run.run_id, artifactDir: run.artifact_dir };
}

function executionVccContext(): PiPlansVccPhaseContext {
	const current = execution ? currentTask(execution.tasks) : null;
	return {
		phase: "execution",
		planPath: execution?.planPath ?? null,
		currentI: current?.id ?? null,
		remainingVerifierIds: execution?.items.filter((item) => !item.done).map((item) => item.id) ?? [],
		implementationIds: execution ? flattenTaskViews(execution.tasks).map((task) => task.id) : [],
	};
}

export function planningVccContext(branchEntries: CompactionEntryLike[], fallback: { runId?: string; artifactDir?: string }): PiPlansVccPhaseContext {
	let runId: string | null = fallback.runId ?? null;
	let artifactDir: string | null = fallback.artifactDir ?? null;
	let planPath: string | null = null;
	let currentI: string | null = null;
	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === PLANNING_RUN_START_CUSTOM_TYPE) {
			runId = typeof entry.data?.runId === "string" ? entry.data.runId : runId;
			artifactDir = typeof entry.data?.artifactDir === "string" ? entry.data.artifactDir : artifactDir;
		}
		if (entry.type === "custom" && entry.customType === PLANNING_PLAN_WRITTEN_CUSTOM_TYPE) {
			planPath = typeof entry.data?.planPath === "string" ? entry.data.planPath : planPath;
		}
		for (const id of entryCurrentIMarkers(entry)) currentI = id;
		currentI = compactionCurrentI(entry) ?? currentI;
	}
	return { phase: "planning", runId, artifactDir, planPath, currentI };
}

function buildExecutionVccResult(event: SessionBeforeCompactEvent, ctx: ExtensionContext): VccCompactionBuildResult | null {
	if (!execution) return null;
	const active = activeVccSettings(ctx, "execution");
	if (!active) return null;
	return buildPiPlansVccCompaction({
		branchEntries: event.branchEntries as unknown as CompactionEntryLike[],
		preparation: event.preparation,
		customInstructions: event.customInstructions,
		reason: event.reason,
		willRetry: event.willRetry,
		settings: active.settings,
		phaseContext: executionVccContext(),
	});
}

export function buildExecutionCompactionResult(event: SessionBeforeCompactEvent, ctx: ExtensionContext): CompactionResult | null {
	const built = buildExecutionVccResult(event, ctx);
	return built?.kind === "compaction" ? built.compaction : null;
}

export function handleExecutionBeforeCompact(
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
): SessionBeforeCompactResult | undefined {
	if (!execution) return undefined;
	const state = ensureExecutionCompactionState(ctx);
	state.inFlight = true;
	state.lastAttemptReason = event.reason;
	state.pendingStats = null;
	state.pendingFollowUpPrompt = null;
	state.pendingContinueAfterThresholdCompact = false;
	let built: VccCompactionBuildResult | null;
	try {
		built = buildExecutionVccResult(event, ctx);
	} catch (error) {
		state.inFlight = false;
		ctx.ui.notify(`pi-plans: VCC compaction preparation failed; using Pi default compaction (${String(error)}).`, "warning");
		return undefined;
	}
	if (!built || built.kind === "fallback") {
		state.inFlight = false;
		return undefined;
	}
	if (built.kind === "cancel") {
		state.inFlight = false;
		ctx.ui.notify(built.message, "warning");
		return { cancel: true };
	}
	state.pendingStats = built.stats;
	state.pendingFollowUpPrompt = built.followUpPrompt;
	state.pendingContinueAfterThresholdCompact = built.settings.continueAfterThresholdCompact;
	requestExecutionFlush();
	return { compaction: built.compaction };
}

function runtimePiVersion(ctx: ExtensionContext): unknown {
	return (ctx as ExtensionContext & { piVersion?: unknown }).piVersion ?? VERSION;
}

// ---------------------------------------------------------------------------
// Manual compaction resume
//
// A manual compaction (`/compact`, RPC, or an extension request) starts with
// `AgentSession.abort()` and never continues the interrupted turn. When such a
// compaction displaces live pi-plans work, the run would otherwise strand
// until the user types something. The abort is observed from the message
// stream (`noteAssistantMessage` in index.ts) and consumed at the compaction's
// terminal event, so exactly one resume is sent per displaced manual
// compaction — on success AND on failure (a failed compaction still aborted
// the turn).
//
// The gate is the RAW `continueAfterThresholdCompact` setting. It must NOT be
// `shouldScheduleAutoContinue`: that predicate is version-gated by
// PI_SELF_RESUME_VERSION and returns false on pi >= 0.84.4, which would make
// this resume dead code on every supported host.
// ---------------------------------------------------------------------------

interface ManualResumeCarrier {
	__piPlansManualCompactionResume?: { sent: boolean } | null;
}

function manualResumeCarrier(ctx: ExtensionContext): ManualResumeCarrier | null {
	return (ctx.sessionManager as unknown as ManualResumeCarrier) ?? null;
}

/** Clears the once-per-compaction latch (compaction start, user input, or a
 *  fresh agent run). */
export function resetManualCompactionResume(ctx: ExtensionContext): void {
	const carrier = manualResumeCarrier(ctx);
	if (carrier) carrier.__piPlansManualCompactionResume = null;
}

function loadContinueAfterThresholdCompact(ctx: ExtensionContext): boolean {
	const stateRoot = resolveStateRootOrNull(ctx.cwd);
	if (!stateRoot) return false;
	try {
		scaffoldVccSettings(stateRoot);
		return loadVccSettings(stateRoot).continueAfterThresholdCompact;
	} catch {
		return false;
	}
}

/** Lifts the stall pause the settle path latched when the aborted turn looked
 *  like an agent failure, so the resume cannot wake an already-paused run.
 *  A review-budget pause is fail-closed and stays untouched (only
 *  `/plans-execute` lifts it). */
function clearCompactionStallPause(ctx: ExtensionContext): void {
	const ex = getExecution();
	if (!ex?.stall.paused) return;
	if (isReviewPauseReason(ex.stall.pausedReason)) return;
	ex.stall.paused = false;
	ex.stall.pausedReason = undefined;
	ex.stall.rounds = 0;
	ex.stall.lastSnapshot = stallSnapshot();
	if (ex.blocked) {
		ex.blocked.escalatedRounds = 0;
		ex.blockedWakeTasks = undefined;
	}
	withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { pausedReason: null, blocked: ex.blocked }));
	persist(ctx);
	updateStatusWidget(ctx);
}

/** Sends the one resume owed to a displaced manual compaction. Returns whether
 *  a resume was sent; a failed send leaves the attribution in place so the
 *  next compaction end can retry. */
function resumeAfterDisplacedManualCompaction(
	ctx: ExtensionContext,
	phase: CompactionPhase,
	pendingContinueSetting: boolean,
): boolean {
	if (!pendingDisplacedAbort(ctx)) return false;
	if (!pendingContinueSetting && !loadContinueAfterThresholdCompact(ctx)) {
		// Auto-continue disabled: still consume the attribution so it cannot leak
		// into a later compaction of a different kind.
		consumeDisplacedAbort(ctx);
		return false;
	}
	const carrier = manualResumeCarrier(ctx);
	if (carrier?.__piPlansManualCompactionResume?.sent) {
		consumeDisplacedAbort(ctx);
		return false;
	}
	try {
		if (phase === "execution") {
			clearCompactionStallPause(ctx);
			const state = executionCompactionState(ctx);
			if (state) state.resumeGuard = true;
			messaging().sendMessage(
				{
					customType: EXECUTION_RESUME_CUSTOM_TYPE,
					content: EXECUTION_COMPACTION_RESUME_MESSAGE,
					display: false,
				},
				{ triggerTurn: true },
			);
		} else {
			const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
			if (session.__planningCompaction) session.__planningCompaction.resumeGuard = true;
			messaging().sendMessage(
				{
					customType: PLANNING_RESUME_CUSTOM_TYPE,
					content: "Continue planning.",
					display: false,
				},
				{ triggerTurn: true },
			);
		}
		// Latch only AFTER a successful send.
		if (carrier) carrier.__piPlansManualCompactionResume = { sent: true };
		clearDisplacedAbort(ctx);
		return true;
	} catch {
		return false;
	}
}

export async function handleExecutionCompact(ctx: ExtensionContext, event: SessionCompactEvent): Promise<void> {
	if (!execution) return;
	const state = ensureExecutionCompactionState(ctx);
	const stats = state.pendingStats;
	const followUpPrompt = state.pendingFollowUpPrompt;
	const continueAfterThresholdCompact = state.pendingContinueAfterThresholdCompact;
	state.pendingStats = null;
	state.pendingFollowUpPrompt = null;
	state.pendingContinueAfterThresholdCompact = false;
	state.inFlight = false;
	state.lastAttemptReason = event.reason;
	state.cooldownActive = true;
	state.rearmPending = false;
	state.terminalBackoffTokens = null;
	state.lastSuccessfulAt = utcNow();
	state.lastSuccessfulUsagePercent = ctx.getContextUsage()?.percent ?? state.lastSuccessfulUsagePercent;
	state.resumeGuard = false;
	if (!event.willRetry && stats) {
		ctx.ui.notify(formatVccCompactionStats(stats), "info");
		if (followUpPrompt) {
			await messaging().sendUserMessage(followUpPrompt);
		} else if ((event.reason === "threshold" || event.reason === "overflow") && shouldScheduleAutoContinue(continueAfterThresholdCompact, runtimePiVersion(ctx))) {
			state.resumeGuard = true;
			messaging().sendMessage(
				{
					customType: EXECUTION_RESUME_CUSTOM_TYPE,
					content: EXECUTION_COMPACTION_RESUME_MESSAGE,
					display: false,
				},
				{ triggerTurn: true },
			);
		}
	}
	// Outside the stats gate on purpose: a manual compaction can land with
	// pi-default (non-VCC) content or no stats at all, and a displaced turn
	// still needs its single resume.
	if (event.reason === "manual") {
		resumeAfterDisplacedManualCompaction(ctx, "execution", continueAfterThresholdCompact);
	}
	requestExecutionFlush();
	updateStatusWidget(ctx);
}

export function handleExecutionCompactFailed(ctx: ExtensionContext, event: SessionCompactFailedEvent): void {
	if (!execution) return;
	const state = executionCompactionState(ctx);
	const terminal = isTerminalCompactionFailure(event);
	if (terminal) {
		if (state) {
			state.inFlight = false;
			state.resumeGuard = false;
			state.cooldownActive = true;
			state.rearmPending = false;
			state.lastAttemptReason = event.reason;
			const tokens = ctx.getContextUsage()?.tokens;
			state.terminalBackoffTokens = typeof tokens === "number" ? tokens : Number.POSITIVE_INFINITY;
			state.pendingStats = null;
			state.pendingFollowUpPrompt = null;
			state.pendingContinueAfterThresholdCompact = false;
		}
		const message = terminal.kind === "content"
			? "pi-plans: compaction found nothing to summarize; backing off until the session grows past the keep-recent window."
			: "pi-plans: compaction was aborted (provider interruption, user cancel, or a competing manual compact); backing off until the session grows or usage nears the window.";
		ctx.ui.notify(message, "info");
		if (event.reason === "manual") {
			resumeAfterDisplacedManualCompaction(ctx, "execution", false);
		}
		requestExecutionFlush();
		return;
	}
	if (state) {
		state.inFlight = false;
		state.resumeGuard = false;
		state.cooldownActive = false;
		state.rearmPending = false;
		state.lastAttemptReason = event.reason;
		state.pendingStats = null;
		state.pendingFollowUpPrompt = null;
		state.pendingContinueAfterThresholdCompact = false;
	}
	ctx.ui.notify(
		`pi-plans: compaction failed (${event.reason}); execution remains active and will wait for the next eligible turn.`,
		"warning",
	);
	if (event.reason === "manual") {
		resumeAfterDisplacedManualCompaction(ctx, "execution", false);
	}
	requestExecutionFlush();
}

export function filterExecutionResumeMessages<T extends { customType?: string }>(messages: T[]): T[] {
	return messages.filter((message) => message.customType !== EXECUTION_RESUME_CUSTOM_TYPE);
}

// ---------------------------------------------------------------------------
// Planning-phase compaction: Pi core owns scheduling; this hook customizes
// active planning compact events with the same VCC builder used by execution.
// ---------------------------------------------------------------------------

export const PLANNING_RUN_START_CUSTOM_TYPE = "pi-plans-run-start";
export const PLANNING_PLAN_WRITTEN_CUSTOM_TYPE = "pi-plans-plan-written";
const PLANNING_RESUME_CUSTOM_TYPE = "pi-plans-plan-resume";

export { PLANNING_PREPLAN_COMPACT_HINT };
export const PLANNING_PREPLAN_RESUME_CUSTOM_TYPE = "pi-plans-preplan-resume";

/** Pre-plan requests live in `src/compaction-lifecycle.ts`; re-exported here so
 *  the `plans start-run` call site (tools/plans.ts) keeps its import path. The
 *  old consume-and-compact pair is gone: the request now becomes a `turn_end`
 *  boundary draft that never aborts the running turn. */
export { markPrePlanCompactPending };

interface PlanningCompactionState {
	inFlight: boolean;
	resumeGuard: boolean;
	cooldownActive: boolean;
	lastAttemptReason: "manual" | "threshold" | "overflow" | null;
	lastSuccessfulUsagePercent: number | null;
	lastSuccessfulAt: string | null;
	terminalBackoffTokens: number | null;
	pendingStats: VccCompactionStats | null;
	pendingFollowUpPrompt: string | null;
	pendingContinueAfterThresholdCompact: boolean;
}

function ensurePlanningCompactionState(ctx: ExtensionContext): PlanningCompactionState {
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	return (session.__planningCompaction ??= {
		inFlight: false,
		resumeGuard: false,
		cooldownActive: false,
		lastAttemptReason: null,
		lastSuccessfulUsagePercent: null,
		lastSuccessfulAt: null,
		terminalBackoffTokens: null,
		pendingStats: null,
		pendingFollowUpPrompt: null,
		pendingContinueAfterThresholdCompact: false,
	});
}

function isTerminalCompactionFailure(event: { errorMessage?: string; aborted?: boolean }): { kind: "content" | "abort-stream" } | null {
	const message = (event.errorMessage ?? "").toLowerCase();
	if (message.includes("nothing to compact") || message.includes("already compacted") || message.includes("session too small")) {
		return { kind: "content" };
	}
	// Shared abort predicate (src/compaction-lifecycle.ts) so the compaction
	// classifier and the displaced-turn observation cannot drift apart.
	if (isAbortErrorMessage(message)) {
		return { kind: "abort-stream" };
	}
	if (event.aborted === true) {
		return { kind: "abort-stream" };
	}
	return null;
}

type CompactionPhase = "planning" | "execution";

function compactionLifecycleStore(ctx: ExtensionContext): {
	planning: boolean;
	execution: boolean;
} {
	const carrier = ctx.sessionManager as unknown as {
		__piPlansCompactionInFlight?: { planning: boolean; execution: boolean };
	};
	carrier.__piPlansCompactionInFlight ??= { planning: false, execution: false };
	return carrier.__piPlansCompactionInFlight;
}

function isPlanningCustomInstructions(hint: unknown): boolean {
	return typeof hint === "string" && hint.startsWith("pi-plans planning");
}

function isExecutionCustomInstructions(hint: unknown): boolean {
	return typeof hint === "string" && hint.startsWith("pi-plans execution");
}

export function noteCompactionStarted(ctx: ExtensionContext, customInstructions: unknown): void {
	const store = compactionLifecycleStore(ctx);
	// Each compaction gets a fresh once-per-compaction resume latch.
	resetManualCompactionResume(ctx);
	if (isPlanningCustomInstructions(customInstructions)) {
		store.planning = true;
	} else if (isExecutionCustomInstructions(customInstructions)) {
		store.execution = true;
	} else {
		store.planning = true;
		store.execution = true;
	}
}

export function noteCompactionEnded(ctx: ExtensionContext, _customInstructions: unknown): void {
	const store = compactionLifecycleStore(ctx);
	store.planning = false;
	store.execution = false;
}

export function compactionInFlight(ctx: ExtensionContext, phase: CompactionPhase): boolean {
	const store = compactionLifecycleStore(ctx);
	return store[phase];
}

export function shouldTriggerPlanningCompaction(_ctx: ExtensionContext): boolean {
	return false;
}

export function consumePlanningCompactionResumeGuard(ctx: ExtensionContext): boolean {
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	if (!session.__planningCompaction?.resumeGuard) return false;
	session.__planningCompaction.resumeGuard = false;
	return true;
}

export function refreshPlanningCompactionCooldown(_ctx: ExtensionContext): void {
	// Retained for lifecycle compatibility only.
}

export function requestPlanningCompaction(_ctx: ExtensionContext): void {
	// Manual, threshold, and overflow compactions are handled by session_before_compact.
}

function buildPlanningVccResult(event: SessionBeforeCompactEvent, ctx: ExtensionContext): VccCompactionBuildResult | null {
	if (getExecution()) return null;
	const active = activeVccSettings(ctx, "planning");
	if (!active) return null;
	const branchEntries = event.branchEntries as unknown as CompactionEntryLike[];
	return buildPiPlansVccCompaction({
		branchEntries,
		preparation: event.preparation,
		customInstructions: event.customInstructions,
		reason: event.reason,
		willRetry: event.willRetry,
		settings: active.settings,
		phaseContext: planningVccContext(branchEntries, active),
	});
}

export function buildPlanningCompactionResult(event: SessionBeforeCompactEvent, ctx: ExtensionContext): CompactionResult | null {
	const built = buildPlanningVccResult(event, ctx);
	return built?.kind === "compaction" ? built.compaction : null;
}

export function handlePlanningBeforeCompact(
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
): SessionBeforeCompactResult | undefined {
	if (getExecution()) return undefined;
	const state = ensurePlanningCompactionState(ctx);
	state.inFlight = true;
	state.lastAttemptReason = event.reason;
	state.pendingStats = null;
	state.pendingFollowUpPrompt = null;
	state.pendingContinueAfterThresholdCompact = false;
	let built: VccCompactionBuildResult | null;
	try {
		built = buildPlanningVccResult(event, ctx);
	} catch (error) {
		state.inFlight = false;
		ctx.ui.notify(`pi-plans: VCC planning compaction preparation failed; using Pi default compaction (${String(error)}).`, "warning");
		return undefined;
	}
	if (!built || built.kind === "fallback") {
		state.inFlight = false;
		return undefined;
	}
	if (built.kind === "cancel") {
		state.inFlight = false;
		ctx.ui.notify(built.message, "warning");
		return { cancel: true };
	}
	state.pendingStats = built.stats;
	state.pendingFollowUpPrompt = built.followUpPrompt;
	state.pendingContinueAfterThresholdCompact = built.settings.continueAfterThresholdCompact;
	return { compaction: built.compaction };
}

export async function handlePlanningCompact(ctx: ExtensionContext, event: SessionCompactEvent): Promise<void> {
	if (getExecution()) return;
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = session.__planningCompaction;
	if (!state) return;
	const stats = state.pendingStats;
	const followUpPrompt = state.pendingFollowUpPrompt;
	const continueAfterThresholdCompact = state.pendingContinueAfterThresholdCompact;
	state.pendingStats = null;
	state.pendingFollowUpPrompt = null;
	state.pendingContinueAfterThresholdCompact = false;
	state.inFlight = false;
	state.lastAttemptReason = event.reason;
	state.terminalBackoffTokens = null;
	state.cooldownActive = true;
	state.lastSuccessfulAt = utcNow();
	state.lastSuccessfulUsagePercent = ctx.getContextUsage()?.percent ?? state.lastSuccessfulUsagePercent;
	state.resumeGuard = false;
	if (!event.willRetry && stats) {
		ctx.ui.notify(formatVccCompactionStats(stats), "info");
		if (followUpPrompt) {
			await messaging().sendUserMessage(followUpPrompt);
		} else if ((event.reason === "threshold" || event.reason === "overflow") && shouldScheduleAutoContinue(continueAfterThresholdCompact, runtimePiVersion(ctx))) {
			state.resumeGuard = true;
			messaging().sendMessage(
				{
					customType: PLANNING_RESUME_CUSTOM_TYPE,
					content: "Continue planning.",
					display: false,
				},
				{ triggerTurn: true },
			);
		}
	}
	// A user `/compact` during a live planning run aborts the turn and the host
	// never continues it; resume it once when the abort displaced real work.
	if (event.reason === "manual") {
		resumeAfterDisplacedManualCompaction(ctx, "planning", continueAfterThresholdCompact);
	}
}

export function handlePlanningCompactFailed(ctx: ExtensionContext, event: SessionCompactFailedEvent): void {
	if (getExecution()) return;
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = session.__planningCompaction;
	if (!state) return;
	const terminal = isTerminalCompactionFailure(event);
	if (terminal) {
		state.inFlight = false;
		state.resumeGuard = false;
		state.cooldownActive = true;
		state.lastAttemptReason = event.reason;
		const tokens = ctx.getContextUsage()?.tokens;
		state.terminalBackoffTokens = typeof tokens === "number" ? tokens : Number.POSITIVE_INFINITY;
		state.pendingStats = null;
		state.pendingFollowUpPrompt = null;
		state.pendingContinueAfterThresholdCompact = false;
		const message = terminal.kind === "content"
			? "pi-plans: compaction found nothing to summarize; backing off until the session grows past the keep-recent window."
			: "pi-plans: compaction was aborted (provider interruption, user cancel, or a competing manual compact); backing off until the session grows or usage nears the window.";
		ctx.ui.notify(message, "info");
		if (event.reason === "manual") {
			resumeAfterDisplacedManualCompaction(ctx, "planning", false);
		}
		return;
	}
	state.inFlight = false;
	state.resumeGuard = false;
	state.cooldownActive = false;
	state.lastAttemptReason = event.reason;
	state.pendingStats = null;
	state.pendingFollowUpPrompt = null;
	state.pendingContinueAfterThresholdCompact = false;
	ctx.ui.notify(
		`pi-plans: planning compaction failed (${event.reason}); will try again on the next eligible turn.`,
		"warning",
	);
	if (event.reason === "manual") {
		resumeAfterDisplacedManualCompaction(ctx, "planning", false);
	}
}

export function filterPlanningResumeMessages<T extends { customType?: string }>(messages: T[]): T[] {
	return messages.filter((message) => message.customType !== PLANNING_RESUME_CUSTOM_TYPE && message.customType !== PLANNING_PREPLAN_RESUME_CUSTOM_TYPE);
}

export async function stopExecution(ctx: ExtensionContext, reason: string): Promise<void> {
	if (!execution) return;
	// A stopped run's in-flight review round dies with it (typed cancelled —
	// no budget, no wake), and so do its delegated workers.
	abortInFlightReview();
	disposeDelegate("stopped");
	resetExecutionCompactionState(ctx);
	pendingExecutionFlush = false;
	persist(ctx);
	withExecutionCheckpoint(ctx, (cp) => applyExecutionStopped(cp, reason));
	execution = null;
	executionRunId = null;
	continuationRuntime = null;
	messaging().appendEntry("pi-plans-exec-cleared", { reason });
	messaging().sendMessage(
		{
			customType: "pi-plans-exec-stop",
			content: `**pi-plans: execution stopped** — ${reason}`,
			display: true,
		},
		{ triggerTurn: false },
	);
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "stopped");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
}

/** v0.7.1: the per-settle latch, created on demand so no execution-construction
 * path can leave it undefined (a missing latch must degrade to "no latch",
 * never throw inside a lifecycle handler). */
function auditLatchOf(ex: ExecState): ExecState["auditLatch"] {
	if (!ex.auditLatch) ex.auditLatch = { auditedThisSettle: false, activity: 0 };
	return ex.auditLatch;
}

function stallSnapshot(): string {
	if (!execution) return "";
	// v0.7.1: the snapshot carries the round's tool-activity counter, so a round
	// in which the agent legitimately did work (read code, run commands) counts
	// as progress even when no task changed status. Only a round with neither a
	// status change NOR a successful tool result is "no progress".
	return JSON.stringify({ tasks: taskProgressMap(execution.tasks), activity: auditLatchOf(execution).activity });
}

/**
 * v0.7.1: shared "the execution review is owed" predicate. Every entry point
 * that can start the audit (turn_end, agent_before_settle, restoreFromSession,
 * the resume path) goes through this so they can never disagree.
 *
 * Semantics (unchanged from restoreFromSession's guard, F-006): a check that
 * covers no task never gates completion, so only auditable checks count.
 */
function pendingAudit(ex: ExecState | null = execution): ex is ExecState {
	if (!ex) return false;
	// A paused run is never self-driven: the stall / review-cap pause is an
	// explicit "hand control back" signal, and resuming it is the user's call.
	// This also bounds the zero-input continue loop in agent_before_settle.
	if (ex.stall.paused) return false;
	if (ex.review.inFlight) return false;
	// The budget menu is open: the review is being resolved, not owed anew.
	if (ex.review.budgetAsking) return false;
	// One owed predicate, shared with reviewOwed/reviewOutstanding (v0.10):
	// pending checks, unresolved highs, or a pending non-high repair cycle.
	return allTasksTerminal(ex.tasks) && reviewOutstanding(ex);
}

/** v0.7.1: record that this settle already ran (or declined) its audit, so a
 * second entry point in the same settle cannot re-consume a round. */
function latchAuditThisSettle(): void {
	if (execution) auditLatchOf(execution).auditedThisSettle = true;
}

/** v0.7.1: called on agent_start — a new agent run is a new settle window, so
 * the latch and the activity counter both reset here. */
function resetSettleLatch(): void {
	if (!execution) return;
	const latch = auditLatchOf(execution);
	latch.auditedThisSettle = false;
	latch.activity = 0;
}

export function pauseForStall(ctx: ExtensionContext, reason: string): void {
	const ex = getExecution();
	if (!ex) return;
	ex.stall.paused = true;
	ex.stall.pausedReason = reason;
	withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { pausedReason: reason }));
	persist(ctx);
	ctx.ui.notify?.(
		`pi-plans: execution paused (${reason}). Send any message or run /plans-execute to resume.`,
		"warning",
	);
	updateStatusWidget(ctx);
}

function canWakeExecution(ctx: ExtensionContext, runtime: ContinuationRuntime): boolean {
	const compaction = executionCompactionState(ctx);
	return currentContinuationRuntime(ctx) === runtime
		&& (ctx.mode === "tui" || ctx.mode === "rpc")
		&& !allTasksTerminal(runtime.owner.tasks)
		&& !runtime.owner.stall.paused
		&& ctx.isIdle()
		&& !ctx.hasPendingMessages()
		&& !ctx.signal?.aborted
		&& !compactionInFlight(ctx, "execution")
		&& !compaction?.inFlight
		&& !compaction?.resumeGuard
		&& compaction?.pendingFollowUpPrompt == null;
}

function sendContinuationWake(ctx: ExtensionContext, runtime: ContinuationRuntime): boolean {
	// A delegated run is driven by its workers, never by waking the main model.
	if (isDelegatedExecution(runtime.owner)) return false;
	if (!canWakeExecution(ctx, runtime)) return false;
	try {
		const content = executionContextMessage(ctx);
		if (!content) return false;
		runtime.wakeId = randomUUID();
		messaging().sendMessage({
			customType: EXECUTION_CONTINUE_CUSTOM_TYPE,
			content,
			display: false,
			details: { wakeId: runtime.wakeId },
		}, { triggerTurn: true });
		return true;
	} catch (error) {
		runtime.wakeId = undefined;
		pauseForStall(ctx, `continuation failed: ${String(error)}`);
		return false;
	}
}

/** Only a fully settled agent run can need an extra wake, never a tool turn. */
function maybeContinuationFollowUp(ctx: ExtensionContext): void {
	const runtime = currentContinuationRuntime(ctx);
	if (!runtime || runtime.handled || !ctx.isIdle()) return;
	if (isDelegatedExecution(runtime.owner)) return;
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
	if (runtime.stopReason === "error" || runtime.stopReason === "aborted" || ctx.signal?.aborted) {
		runtime.handled = true;
		pauseForStall(ctx, runtime.stopReason === "error" ? "agent failed" : "agent interrupted");
		return;
	}
	// v0.7.1: a fully-terminal run that still owes an audit is NOT a
	// continuation case — the audit owns that state (agent_before_settle).
	// Return without waking: emitting EXECUTION_CONTINUE here would send the
	// agent back to redo work it has already finished (F-003).
	if (execution && allTasksTerminal(execution.tasks) && pendingAudit(execution)) return;
	if (runtime.stopReason !== "stop" || !canWakeExecution(ctx, runtime)) return;
	runtime.handled = true;
	const ex = runtime.owner;
	// v0.9.2: while a failed round's tasks are still open, the next round
	// cannot start — and this ladder must NOT ride `stall.rounds`, which any
	// successful tool call resets: an executor that investigates but never
	// closes the reopened tasks has to escalate (and eventually pause) anyway.
	const blockedIds = blockedTaskIds(ex);
	if (ex.blocked && blockedIds.length > 0) {
		// Progress = fewer blockers than at the PREVIOUS blocked wake. The
		// stored `blocked.tasks` cannot serve as that baseline: every task
		// close re-syncs it, so it always equals the live set and the ladder
		// would only ever increment (review round 1, F-001). A same-size but
		// different set counts as no progress; a new member counts as none.
		const baseline = ex.blockedWakeTasks;
		const progressed = baseline !== undefined && blockedIds.length < baseline.length;
		ex.blockedWakeTasks = [...blockedIds];
		ex.blocked.escalatedRounds = progressed ? 0 : ex.blocked.escalatedRounds + 1;
		ex.blocked.tasks = blockedIds;
		withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { blocked: ex.blocked }));
		if (ex.blocked.escalatedRounds >= STALL_MAX_ROUNDS) {
			pauseForStall(ctx, blockedPauseReason(ex));
			return;
		}
		notifyBlockedEscalation(ctx, ex);
		persist(ctx);
		updateStatusWidget(ctx);
		sendContinuationWake(ctx, runtime);
		return;
	}
	const snapshot = stallSnapshot();
	const changed = ex.stall.lastSnapshot !== null && snapshot !== ex.stall.lastSnapshot;
	ex.stall.lastSnapshot = snapshot;
	if (changed) {
		ex.stall.rounds = 0;
	} else {
		ex.stall.rounds += 1;
	}
	if (ex.stall.rounds >= STALL_MAX_ROUNDS) {
		pauseForStall(ctx, `no task-status change in ${ex.stall.rounds} rounds`);
		return;
	}
	persist(ctx);
	updateStatusWidget(ctx);
	sendContinuationWake(ctx, runtime);
}

export function filterGoalWaitMessages<T extends { customType?: string; details?: unknown }>(messages: T[]): T[] {
	// v0.6.1: continuation wakes are one-shot; stale ones (including the
	// legacy v0.6.0 goal-wait type) never replay after a restart. v0.9.2: the
	// visible escalated-blocked line is one-shot for the same reason.
	return messages.filter((message) => message.customType !== EXECUTION_CONTINUE_CUSTOM_TYPE
		&& message.customType !== EXECUTION_BLOCKED_CUSTOM_TYPE
		&& message.customType !== LEGACY_GOAL_WAIT_CUSTOM_TYPE);
}

export function filterContinuationMessages<T extends { customType?: string; details?: unknown }>(messages: T[]): T[] {
	return filterGoalWaitMessages(messages);
}

/** Called for genuine user input or an explicit same-execution resume.
 * v0.8: a REVIEW pause is never lifted here — ordinary input must not
 * refill the review budget (CF2-004); only /plans-execute
 * (resumeActiveExecution) is the explicit confirmation surface. Genuine
 * stall pauses still clear on input as before. */
export function resumeGoalWaitIfPaused(ctx: ExtensionContext): boolean {
	const ex = getExecution();
	if (!ex?.stall.paused || !currentContinuationRuntime(ctx)) return false;
	if (isReviewPauseReason(ex.stall.pausedReason)) {
		// Surfaced once per input so the user is not left guessing why the run
		// stays paused; the pause itself and the budget survive untouched.
		// v0.9.3: the note names the budget actually in force and the fact that
		// the confirmation re-opens the picker.
		ctx.ui.notify?.(
			`pi-plans: the review budget is exhausted (${budgetLabel(ex)}) — run /plans-execute to grant a fresh budget (it re-opens the round-count picker; that confirmation is the only surface that does).`,
			"warning",
		);
		return false;
	}
	ex.stall.paused = false;
	ex.stall.pausedReason = undefined;
	ex.stall.rounds = 0;
	ex.stall.lastSnapshot = stallSnapshot();
	// v0.9.2: a resume grants a fresh escalation ladder (the blocker itself is
	// still recorded, so the next wake names it) and never a fresh review
	// budget — that stays `/plans-execute`-only.
	if (ex.blocked) {
		ex.blocked.escalatedRounds = 0;
		ex.blockedWakeTasks = undefined;
	}
	withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { pausedReason: null, blocked: ex.blocked }));
	persist(ctx);
	updateStatusWidget(ctx);
	void resumeDelegation(ctx);
	return true;
}

/** Outcome of an explicit `/plans-execute` resume, so the calling tool can
 * report what actually happened (v0.9.3: the grant may re-open the picker). */
export interface ResumeOutcome {
	resumed: boolean;
	/** Set when the pause was lifted by a budget grant. */
	grantedBudget?: ReviewBudget;
	/** True when the user closed the budget menu — the pause stands. */
	budgetDeclined?: boolean;
}

export async function resumeActiveExecution(ctx: ExtensionContext): Promise<ResumeOutcome> {
	// v0.8: /plans-execute is THE explicit confirmation surface for a review
	// pause — the only place a fresh budget is granted (Q-confirm-surface).
	// Ordinary input and session restores never refill.
	// v0.9.3: the grant re-opens the budget picker with the current value named
	// in the menu title (the native selector has no preselection parameter); Esc
	// keeps the run paused (an explicit confirmation is the
	// only way forward). Headless sessions, which have no menu to show, keep
	// the current budget instead of stranding the run.
	const pausedEx = getExecution();
	if (pausedEx?.stall.paused && isReviewPauseReason(pausedEx.stall.pausedReason)) {
		const previous = activeBudget(pausedEx);
		let granted = previous;
		if (reviewBudgetPanelUsable(ctx)) {
			const picked = await askReviewBudget(ctx, pausedEx.uiLanguage, previous);
			if (picked === null) {
				messaging().sendMessage(
					{
						customType: "pi-plans-review-budget-declined",
						content: `**pi-plans: review budget unchanged (${formatReviewBudget(previous)})** — the run stays paused. Run /plans-execute and pick a round count to continue.`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return { resumed: false, budgetDeclined: true };
			}
			granted = picked;
			// Q-4: only a grant that lands on `unlimited` lifts the hard cap —
			// the cumulative counter itself never resets.
			if (granted === "unlimited") {
				pausedEx.reviewCapExtension += UNLIMITED_HARD_CAP;
			}
		}
		pausedEx.stall.paused = false;
		pausedEx.stall.pausedReason = undefined;
		pausedEx.stall.rounds = 0;
		pausedEx.stall.lastSnapshot = stallSnapshot();
		pausedEx.audit.rounds = 0;
		pausedEx.audit.failed = [];
		pausedEx.audit.undeterminable = [];
		// v0.9.3: a fresh budget window also resets the no-progress valve.
		pausedEx.reviewNoProgress = undefined;
		// v0.9.2: the explicit confirmation also refreshes the blocked ladder
		// (the blocker set itself survives — it still names what stays open).
		if (pausedEx.blocked) {
			pausedEx.blocked.escalatedRounds = 0;
			pausedEx.blockedWakeTasks = undefined;
		}
		// v0.9: the fresh budget inherits unresolved findings (stable ids keep
		// counting) — only the round counter resets.
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(pausedEx.tasks),
				audit: { rounds: 0, lastResult: undefined, findings: pausedEx.audit.findings },
				blocked: pausedEx.blocked,
				reviewBudget: granted,
				reviewBudgetDefaulted: pausedEx.reviewBudgetDefaulted === true,
				reviewRoundsTotal: pausedEx.reviewRoundsTotal,
				reviewCapExtension: pausedEx.reviewCapExtension,
				reviewNoProgress: null,
				pausedReason: null,
			}),
		);
		persist(ctx);
		updateStatusWidget(ctx);
		const grantedNote = granted === "unlimited"
			? `unlimited review budget granted (hard cap now ${unlimitedHardCapCeiling(budgetCounters(pausedEx))} rounds; the run has spent ${pausedEx.reviewRoundsTotal})`
			: `fresh ${formatReviewBudget(granted)}-round review budget granted`;
		messaging().sendMessage(
			{
				customType: "pi-plans-review-budget-granted",
				content: `**pi-plans: ${grantedNote}** — the execution review resumes now.`,
				display: true,
			},
			{ triggerTurn: false },
		);
		const grantChain = launchReviewRound(ctx);
		if (grantChain) void grantChain.catch(() => { /* surfaced via the review messages */ });
		return { resumed: true, grantedBudget: granted };
	}
	// v0.7.1 (root cause A): a terminal-but-unaudited run used to fall through
	// to `return false` here, so `/plans-execute` answered "already executing"
	// and the run stayed stranded until a full re-entry or a session restore.
	// It is not paused, so the pause path below cannot see it — check it first
	// and run the owed review instead of reporting "nothing to resume".
	if (!execution?.stall.paused && pendingAudit()) {
		latchAuditThisSettle();
		const chain = launchReviewRound(ctx);
		if (chain) void chain.catch(() => { /* surfaced via the review messages */ });
		return { resumed: true };
	}
	if (!resumeGoalWaitIfPaused(ctx)) return { resumed: false };
	const runtime = currentContinuationRuntime(ctx)!;
	if (canWakeExecution(ctx, runtime)) {
		runtime.handled = true;
		sendContinuationWake(ctx, runtime);
	}
	return { resumed: true };
}

/** v0.10: index of the repair tasks the review appended (`fix <id>:` title
 * prefix) — the provenance the completion ledger and the reviewer brief read. */
function repairTaskIndex(ex: ExecState): Map<string, TaskView> {
	const repairTasks = new Map<string, TaskView>();
	for (const task of flattenTaskViews(ex.tasks)) {
		const match = /^fix (F-\d+):/.exec(task.title);
		if (match && !repairTasks.has(match[1])) repairTasks.set(match[1], task);
	}
	return repairTasks;
}

/** v0.10: per-finding disposition text, resolved from task provenance:
 * `deferred: <reason>` (the finding's appended `fix <id>:` task was skipped
 * with a `deferred:` skipReason), `repair claimed — still reported` (that task
 * is complete but the newest round still lists the id), `unresolved` (no such
 * task, or it is not terminal), and `fixed (...)` for a repair task whose
 * finding no longer appears in the newest round. */
function findingDispositionMap(ex: ExecState): Map<string, string> {
	const repairTasks = repairTaskIndex(ex);
	const dispositions = new Map<string, string>();
	for (const finding of ex.audit.findings) {
		const task = repairTasks.get(finding.id);
		const skipReason = task?.skipReason?.trim() ?? "";
		if (task && task.status === "skipped" && /^deferred\b/i.test(skipReason)) {
			dispositions.set(finding.id, `deferred: ${skipReason.replace(/^deferred\s*:?\s*/i, "") || "no reason recorded"}`);
		} else if (task && task.status === "complete") {
			dispositions.set(finding.id, `repair claimed — still reported (task ${task.id})`);
		} else {
			dispositions.set(finding.id, `unresolved${task ? ` (task ${task.id} is ${task.status})` : " (no repair task)"}`);
		}
	}
	for (const [id, task] of repairTasks) {
		if (task.status === "complete" && !dispositions.has(id)) dispositions.set(id, `fixed (repaired by ${task.id}; no longer reported)`);
	}
	return dispositions;
}

/** v0.10: the honest completion ledger — one line per finding the review left
 * behind (plus `fixed` lines for repaired ones), and the split the completion
 * headline needs: a finding is "unresolved" unless its repair task was closed
 * (`fixed`) or explicitly declined (`deferred: …`). */
function completionFindingLedger(ex: ExecState): { lines: string[]; unresolvedIds: string[]; deferredIds: string[] } {
	const severity = new Map(ex.audit.findings.map((f) => [f.id, f.severity]));
	const dispositions = findingDispositionMap(ex);
	const lines: string[] = [];
	const unresolvedIds: string[] = [];
	const deferredIds: string[] = [];
	for (const [id, disposition] of dispositions) {
		const sev = severity.get(id);
		lines.push(sev === undefined ? `${id} — ${disposition}` : `${id} (${sev}) — ${disposition}`);
		if (sev === undefined) continue; // a `fixed` line: the finding is gone from the round
		if (/^deferred\b/i.test(disposition)) deferredIds.push(id);
		else if (!/^fixed\b/.test(disposition)) unresolvedIds.push(id);
	}
	return { lines, unresolvedIds, deferredIds };
}

/** v0.10 (F-008): the huge-version completion message. It is keyed on the
 * newest round's finding COUNT, never on the completion ledger's line count —
 * a fully repaired cycle still renders `fixed` lines but must keep the ✅
 * headline (the same rule the non-huge branch follows). Exported for tests. */
export function hugeVersionCompletionMessage(input: {
	version: string;
	position: string;
	planPath: string;
	next: string | null;
	findingCount: number;
	unresolvedCount: number;
	deferredCount: number;
	summary: string;
	residualNote: string;
}): string {
	const tail = `(${input.position}) \`${input.planPath}\` — the run stays in planning${input.next ? `; the next version is ${input.next}` : ""}. Plan the next version with the plan-huge skill — or with plan-with-refs when references must shape it; the overall plan is never executable.\n\n${input.summary}${input.residualNote}`;
	return input.findingCount > 0
		? `**Version ${input.version} complete — ${input.findingCount} review finding(s) without a resolved verdict: ${input.unresolvedCount} unresolved, ${input.deferredCount} deferred.** ⚠️ ${tail}`
		: `**Version ${input.version} complete** ✅ ${tail}`;
}

export async function completeExecution(ctx: ExtensionContext): Promise<void> {
	if (!execution) return;
	disposeDelegate("completed");
	resetExecutionCompactionState(ctx);
	pendingExecutionFlush = false;
	persist(ctx);
	const flat = flattenTaskViews(execution.tasks);
	const summary = flat
		.map((task) => `- ${taskIsTerminal(task) && task.status === "skipped" ? "~" : "✓"} \`${task.id}\` ${task.title}`)
		.join("\n");
	// v0.10: residual findings are summarized HONESTLY — never as "did not
	// block completion". The ledger resolves each finding's disposition from
	// task provenance (`fixed` / `repair claimed — still reported` / `deferred:
	// <reason>` / `unresolved`), so a reader can tell a repaired-and-cleared
	// finding from one the executor declined. Captured BEFORE `execution` is
	// cleared below.
	const remainingFindings = execution.audit.findings;
	const findingLedger = completionFindingLedger(execution);
	const residualNote = findingLedger.lines.length > 0
		? `\n\n${remainingFindings.length > 0 ? "Execution-review findings left behind:" : "Execution-review findings repaired during the cycle:"}\n${findingLedger.lines.map((line) => `- ${line}`).join("\n")}\n  Every finding also stays in the round reports under the run directory.`
		: "";
	// v0.10: a completion may NOT claim the review passed while the newest
	// round still lists findings — the headline states what is left and names
	// the one-shot cycle's state.
	const cycleNote = remainingFindings.length === 0
		? ""
		: execution.reviewNonHighRepair === "granted"
			? " The single non-high repair cycle was granted but could not be re-judged (the review cap was reached); it counts as spent."
			: execution.reviewNonHighRepair === "used" ? " The single non-high repair cycle has already been spent." : "";
	// v0.9.3 (Q-2, round-1 F-004): an exhausted budget may complete WITH
	// unresolved high findings — the completion surface must say so instead of
	// claiming "execution review passed".
	const toleratedHighs = execution.audit.findings.filter((f) => f.severity === "high");
	const toleratedNote = toleratedHighs.length > 0
		? `\n\n⚠️ The review budget was exhausted (${budgetLabel(execution)}) before these high-severity finding(s) could be resolved: ${toleratedHighs.map((f) => f.id).join(", ")} — every verification check passed; the finding(s) remain in the round reports under the run directory.`
		: "";
	const planPath = execution.planPath;
	// plan-huge (v0.9.5): a version completion archives the version (VCs, tasks,
	// plan identity, review reports, review budget) and loops the run back to
	// planning; only the LAST version completes the run. The run stays
	// non-terminal between versions, so /plans, the status widget and
	// /resume-plans keep seeing it.
	const activeForHuge = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	const hugeVersion = activeForHuge ? currentHugeVersionLabel(ctx) : null;
	const hugeReports =
		activeForHuge && hugeVersion ? hugeVersionReviewReports(ctx.cwd, activeForHuge.run_id, hugeVersion) : [];
	let hugeLooped: { version: string; next: string | null; position: string } | null = null;
	withExecutionCheckpoint(ctx, (cp) => {
		if (!cp.huge) return applyExecutionCompleted(cp);
		const index = cp.huge.currentIndex;
		const current = cp.huge.versions[index];
		const next = cp.huge.versions.find((version, i) => i > index && version.status !== "done") ?? null;
		const after = applyHugeVersionCompleted(cp, { reviewReports: hugeReports });
		if (after.phase !== "completed") {
			hugeLooped = {
				version: current?.label ?? "?",
				next: next?.label ?? null,
				position: `${index + 1}/${cp.huge.versions.length}`,
			};
		}
		return after;
	});
	if (hugeLooped !== null) {
		const looped = hugeLooped as { version: string; next: string | null; position: string };
		execution = null;
		executionRunId = null;
		continuationRuntime = null;
		messaging().appendEntry("pi-plans-exec-cleared", { reason: "huge-version-complete" });
		messaging().sendMessage(
			{
				customType: "pi-plans-huge-version-complete",
				content: hugeVersionCompletionMessage({
					version: looped.version,
					position: looped.position,
					planPath,
					next: looped.next,
					findingCount: remainingFindings.length,
					unresolvedCount: findingLedger.unresolvedIds.length,
					deferredCount: findingLedger.deferredIds.length,
					summary,
					residualNote,
				}),
				display: true,
			},
			{ triggerTurn: false },
		);
		if (activeForHuge) {
			try {
				setRunStatus(ctx.cwd, activeForHuge.run_id, "planning");
			} catch {
				/* best-effort */
			}
		}
		updateStatusWidget(ctx);
		return;
	}
	execution = null;
	executionRunId = null;
	continuationRuntime = null;
	messaging().appendEntry("pi-plans-exec-cleared", { reason: "complete" });
	messaging().sendMessage(
		{
			customType: "pi-plans-complete",
			content: toleratedHighs.length > 0
				? `**Plan complete (review budget exhausted).** ⚠️ \`${planPath}\` — all verification checks passed; ${toleratedHighs.length} high-severity finding(s) stayed unresolved.\n\n${summary}${residualNote}${toleratedNote}`
				: remainingFindings.length > 0
					? `**Plan complete — every verification check passed; the execution review left ${remainingFindings.length} finding(s) without a resolved verdict: ${findingLedger.unresolvedIds.length} unresolved, ${findingLedger.deferredIds.length} deferred.** ⚠️ \`${planPath}\`${cycleNote}\n\n${summary}${residualNote}`
					: `**Plan complete!** ✅ \`${planPath}\` — execution review passed.\n\n${summary}${residualNote}`,
			display: true,
		},
		{ triggerTurn: false },
	);
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "done");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
}

// ---------------------------------------------------------------------------
// User-authorized termination (/plans-terminate, v0.9.4)
// ---------------------------------------------------------------------------

/** What a user-authorized termination must disclose (PLAN_v2, decisions Q1–Q5). */
export interface TerminationSummary {
	planPath: string;
	/** Run the termination is attributed to; null when the session is unbound. */
	runId: string | null;
	/** Committed review rounds across the whole run (never the per-grant counter). */
	committedRounds: number;
	/** The budget in force when the user terminated (`3` / `∞`). */
	budgetLabel: string;
	/** Auditable checks that never passed, in plan order. */
	unverifiedVcIds: string[];
	/** Tasks that are not terminal, in tree order. */
	openTaskIds: string[];
	/** High-severity findings still recorded. */
	highFindings: string[];
	/** Non-high findings still recorded. */
	residualFindings: string[];
	/** Fewer than three committed rounds — the confirm dialog warns. */
	fewRounds: boolean;
	/** The review round this termination aborts, when one is in flight. */
	abortedRound: { budgetRound: number; attempt: number } | null;
}

/** Pure projection of the termination disclosure (no I/O, no state change). */
export function terminationSummary(ex: ExecState, runId: string | null = executionRunId): TerminationSummary {
	const auditable = new Set(auditableChecks(ex.items, ex.tasks).map((item) => item.id));
	const inFlight = ex.review.inFlight;
	return {
		planPath: ex.planPath,
		runId,
		committedRounds: ex.reviewRoundsTotal,
		budgetLabel: budgetLabel(ex),
		unverifiedVcIds: ex.items.filter((item) => item.done !== true && auditable.has(item.id)).map((item) => item.id),
		openTaskIds: flattenTaskViews(ex.tasks).filter((task) => !taskIsTerminal(task)).map((task) => task.id),
		highFindings: ex.audit.findings.filter((finding) => finding.severity === "high").map((finding) => finding.id),
		residualFindings: ex.audit.findings.filter((finding) => finding.severity !== "high").map((finding) => finding.id),
		fewRounds: ex.reviewRoundsTotal < 3,
		abortedRound: inFlight ? { budgetRound: inFlight.budgetRound, attempt: inFlight.attempt } : null,
	};
}

/** `TERMINATION.md` body — English, like the round reports; the chat surfaces
 * are localized through `terminationChrome`. */
export function renderTerminationRecord(summary: TerminationSummary, meta: { at: string }): string {
	const list = (ids: string[]): string => (ids.length > 0 ? ids.map((id) => `- ${id}`).join("\n") : "none");
	const lines = [
		"# Termination record — /plans-terminate",
		"",
		"## Terminated at",
		meta.at,
		"",
		"## Plan",
		summary.planPath,
		"",
		"## Run",
		summary.runId ?? "(unbound)",
		"",
		"## Committed review rounds",
		`${summary.committedRounds}${summary.fewRounds ? " (fewer than 3)" : ""}`,
		"",
		"## Budget",
		summary.budgetLabel,
		"",
		"## Unverified checks",
		list(summary.unverifiedVcIds),
		"",
		"## Open tasks",
		list(summary.openTaskIds),
		"",
		"## Unresolved findings",
		list([
			...summary.highFindings.map((id) => `${id} (high)`),
			...summary.residualFindings.map((id) => `${id} (unresolved)`),
		]),
	];
	if (summary.abortedRound) {
		const { budgetRound, attempt } = summary.abortedRound;
		lines.push(
			"",
			"## Aborted in-flight round",
			`round ${budgetRound} attempt ${attempt} — execution-review/round-${budgetRound}-attempt-${attempt}.md (outcome: cancelled)`,
		);
	}
	lines.push(
		"",
		"## Notes",
		"The run was terminated by the user; it is recorded as done and cannot be resumed.",
		"Unverified checks and open tasks were left untouched — this record is the disclosure, not a waiver.",
		"",
	);
	return lines.join("\n");
}

/** The chat message shown after a termination (localized, bounded per line). */
function terminationMessage(summary: TerminationSummary, lang: UiLanguage, recordPath: string | null, recordWritten: boolean): string {
	const chrome = terminationChrome(lang);
	const ids = (list: string[]): string => (list.length > 0 ? `: ${list.join(", ")}` : "");
	return [
		// No `✅`: a terminated run deliberately keeps `audit.passed = false`, so a
		// pass-looking tick would contradict the checkpoint. Only ⚠️ with highs.
		`${chrome.terminatedHeading}${summary.highFindings.length > 0 ? " ⚠️" : ""} \`${summary.planPath}\``,
		chrome.roundsLabel(summary.committedRounds, summary.budgetLabel),
		`${chrome.unverifiedLabel(summary.unverifiedVcIds.length)}${ids(summary.unverifiedVcIds)}`,
		`${chrome.openTasksLabel(summary.openTaskIds.length)}${ids(summary.openTaskIds)}`,
		`${chrome.highsLabel(summary.highFindings.length)}${ids(summary.highFindings)}`,
		`${chrome.residualLabel(summary.residualFindings.length)}${ids(summary.residualFindings)}`,
		summary.fewRounds ? chrome.fewRoundsNote(summary.committedRounds) : "",
		summary.abortedRound ? chrome.abortedRoundLabel(summary.abortedRound.budgetRound, summary.abortedRound.attempt) : "",
		chrome.doneNotice,
		recordWritten && recordPath ? chrome.recordLine(recordPath) : chrome.recordUnavailable,
	]
		.filter((line) => line !== "")
		.join("\n");
}

/**
 * End the run by explicit user decision (v0.9.4). Mirrors `completeExecution`
 * but records the termination: the in-flight round is aborted with a
 * `cancelled` report, the checkpoint completes with `audit.passed = false`
 * and `audit.lastResult = "terminated by user"` (existing schema fields — no
 * workflow-state change), `TERMINATION.md` lands next to `PLAN_vN.md`, and the
 * session snapshot is tombstoned so a reload cannot resurrect the loop.
 *
 * `summary` is the disclosure snapshot the user approved, but the REVIEW-ROUND
 * facts are re-read from the live loop here: the confirm dialog can stay open
 * for minutes, during which a round may commit (its report file already
 * exists) or a new one may launch. Returns false when the loop is already gone
 * (the caller reports that to the user instead of claiming a termination).
 */
export async function terminateExecution(ctx: ExtensionContext, summary: TerminationSummary): Promise<boolean> {
	if (!execution) return false;
	const lang = execution.uiLanguage ?? "en";
	const effective: TerminationSummary = {
		...summary,
		committedRounds: execution.reviewRoundsTotal,
		budgetLabel: budgetLabel(execution),
		fewRounds: execution.reviewRoundsTotal < 3,
		abortedRound: execution.review.inFlight
			? { budgetRound: execution.review.inFlight.budgetRound, attempt: execution.review.inFlight.attempt }
			: null,
	};
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	// 1. The aborted round leaves its own evidence line first: once `execution`
	//    is gone the round's async handler is dropped by the ownership guard,
	//    so this is the only chance to record the cancel. Writing it for a round
	//    that already committed would overwrite that round's own report — hence
	//    the live in-flight source above.
	if (effective.abortedRound) {
		// Same evidence root as every other round report: the execution's run
		// (`runDirOf` is executionRunId-first), not the session binding.
		const runDir = runDirOf(ctx);
		if (runDir) {
			const { budgetRound, attempt } = effective.abortedRound;
			writeReviewRoundReport(runDir, {
				versionSegment: currentHugeVersionLabel(ctx) ?? undefined,
				budgetRound,
				attempt,
				outcome: "cancelled",
				passed: [],
				failed: [],
				undeterminable: [],
				coveredTaskIds: [],
				report: "Round aborted by /plans-terminate before it returned; the user terminated the run.",
			});
		}
	}
	// 2. Abort before clearing: typed cancelled, no budget charge, no wake.
	abortInFlightReview();
	resetExecutionCompactionState(ctx);
	pendingExecutionFlush = false;
	persist(ctx);
	withExecutionCheckpoint(ctx, (cp) => {
		const completed = applyExecutionCompleted(cp);
		if (!completed.execution) return completed;
		return {
			...completed,
			execution: {
				...completed.execution,
				audit: {
					...(completed.execution.audit ?? { rounds: 0 }),
					passed: false,
					lastResult: "terminated by user",
				},
			},
		};
	});
	// 3. Durable record beside the plan (best-effort, like the round reports).
	//    A missing or empty `artifact_dir` must degrade to "record unavailable":
	//    the checkpoint is already completed here, so a throw would leave the run
	//    `executing` with a completed checkpoint and a live loop, and an empty
	//    path would write TERMINATION.md into the process cwd.
	const artifactDir = active?.artifact_dir;
	let recordPath: string | null = null;
	let recordWritten = false;
	if (typeof artifactDir === "string" && artifactDir.trim() !== "") {
		try {
			recordPath = path.join(artifactDir, "TERMINATION.md");
			fs.mkdirSync(path.dirname(recordPath), { recursive: true });
			fs.writeFileSync(recordPath, renderTerminationRecord(effective, { at: utcNow() }), "utf8");
			recordWritten = true;
		} catch {
			recordWritten = false;
		}
	}
	// 4. Drop the loop state and tombstone the snapshot.
	execution = null;
	executionRunId = null;
	continuationRuntime = null;
	messaging().appendEntry("pi-plans-exec-cleared", { reason: "terminated by user via /plans-terminate" });
	messaging().sendMessage(
		{
			customType: "pi-plans-terminate",
			content: terminationMessage(effective, lang, recordPath, recordWritten),
			display: true,
		},
		{ triggerTurn: false },
	);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "done");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
	return true;
}

/** Injection text for before_agent_start while executing. */
/** Supervisor brief for a delegated run: the main session must not do the
 * workers' job. */
function delegatedContextMessage(ex: ExecState): string {
	const progress = taskProgress(ex.tasks);
	const open = flattenTaskViews(ex.tasks).filter((task) => !taskIsTerminal(task)).map((task) => task.id);
	return `[PI-PLANS EXECUTION — delegated]
The accepted plan at ${ex.planPath} is being implemented by delegated worker sessions (${executorLabel(ex.executor)}); tasks ${progress.done}/${progress.total}.

You are the supervisor. Do NOT edit or write files yourself and do NOT call \`plans_update_task\`: the workers report progress and the dashboard updates live. Answer the user's questions, relay status, and use /plans-stop if they ask to stop. The independent execution review starts by itself once every task is terminal; failed rounds are repaired by the same workers.

Open tasks: ${open.join(", ") || "(none)"}.`;
}

export function executionContextMessage(ctx: ExtensionContext): string | null {
	if (!execution) return null;
	if (isDelegatedExecution(execution)) return delegatedContextMessage(execution);
	const flat = flattenTaskViews(execution.tasks);
	const open = flat.filter((task) => !taskIsTerminal(task));
	const cur = currentTask(execution.tasks);
	const currentWave = cur?.wave ?? 1;
	const inWave = open.filter((task) => task.wave === currentWave);
	const waveList = inWave.map((task) => `- ${task.id}${task.children.length ? ` (${task.children.map((c) => c.id).join(", ")})` : ""}: ${task.title}${task.files.length ? ` — files: ${task.files.join(", ")}` : ""}`).join("\n") || "(none — take the next wave)";
	const progress = taskProgress(execution.tasks);
	const vcDone = execution.items.filter((item) => item.done).length;
	const mode = resolveGraphMode(ctx?.cwd ?? process.cwd());
	const graphLine =
		mode === "config-unavailable"
			? `${graphBlockForExecutor(false)}\n[pi-plans: config unreadable this turn; graph features are off until .git/pi-plans/config.json is repaired]`
			: graphBlockForExecutor(mode === "enabled");
	const rollbackNote = execution.audit.failed.length > 0
		? `\nExecution review round ${execution.audit.rounds} failed checks: ${execution.audit.failed.join(", ")} — the covered tasks were rolled back to pending; re-close them with evidence after fixing the failures.`
		: "";
	const unresolvedHighs = unresolvedHighFindings(execution);
	const highFindingsNote = unresolvedHighs.length > 0
		? `\nExecution review round ${execution.audit.rounds} unresolved high-severity findings:\n${unresolvedHighs.map((f) => `- ${f.id}${f.taskIds.length ? ` (${f.taskIds.join(", ")})` : ""}: ${f.note}`).join("\n")}\nFix them, then re-close the affected tasks with evidence.`
		: "";
	// v0.10: while the single non-high repair cycle is pending, the executor's
	// per-turn context names the medium/low findings too — the wake message
	// alone would be lost on a session that resumed after the wake.
	const pendingNonHighs = nonHighRepairPending(execution) ? unresolvedRepairableFindings(execution) : [];
	const nonHighFindingsNote = pendingNonHighs.length > 0
		? `\nExecution review round ${execution.audit.rounds} pending medium/low findings (the single non-high repair cycle):\n${pendingNonHighs.map((f) => `- ${f.id} (${f.severity})${f.taskIds.length ? ` (${f.taskIds.join(", ")})` : ""}: ${f.note}`).join("\n")}\nFix them and re-close the affected tasks with evidence, or decline one with status "skipped" and skipReason "deferred: <reason>".`
		: "";
	// v0.9.2: the wake must answer "is the review running?" explicitly. The
	// previous text left the executor waiting for a round that cannot start
	// while the tree is open (the exact stall this feature fixes).
	const blockedIds = blockedTaskIds(execution);
	const blockedRound = execution.blocked?.round ?? execution.audit.rounds;
	const outstanding = reviewOutstanding(execution);
	const reviewLine = execution.review.inFlight
		? `\nReview: round ${billedRounds(execution) + 1}/${budgetLabel(execution)} IS RUNNING (read-only reviewer verifying) — do not wait on it and do not re-close tasks for it.`
		: blockedIds.length > 0 && outstanding
			? `\nReview: NO round is running — the task tree is not terminal, so the review cannot start. It starts by itself the moment every task is terminal (round ${billedRounds(execution) + 1}/${budgetLabel(execution)}).`
			: "";
	const escalated = (execution.blocked?.escalatedRounds ?? 0) > 0;
	const blockedLine = blockedIds.length > 0 && outstanding
		? `\nBLOCKED — ${blockedIds.length} task(s) reopened by round ${blockedRound} are still open:\n${blockedIds.map((id) => `- ${id} (reopened by round ${blockedRound}) — close with \`plans_update_task\`: status "complete" with evidence, or "skipped" with a skipReason. Closing a child does NOT close its parent; a parent with an open child is not terminal.`).join("\n")}${escalated ? `\nThis is blocked wake ${execution.blocked?.escalatedRounds}/${STALL_MAX_ROUNDS}: if these tasks stay open, the watchdog pauses the run and a human has to resume it.` : ""}`
		: "";
	return `[PI-PLANS EXECUTION — write access enabled]
Implement the accepted plan at ${execution.planPath} (tasks ${progress.done}/${progress.total}${execution.legacyPlan ? " · legacy I-### mapping" : ""} · VC ${vcDone}/${execution.items.length}).

Current wave ${currentWave} open tasks:
${waveList}

Remaining open tasks (all waves): ${open.map((task) => task.id).join(", ") || "(none)"}.${rollbackNote}${highFindingsNote}${nonHighFindingsNote}${reviewLine}${blockedLine}

${graphLine}

Execution rules:
- Work through tasks in wave order (earlier waves first); within a wave, follow the listed dependency order. Wave grouping encodes which tasks could run in parallel — keep their file sets disjoint.
- Report progress ONLY through the \`plans_update_task\` tool: status "complete" with evidence (test command output / file paths), or "skipped" with a skipReason. One call per task; statuses are immutable once set.
- Close subtasks before their parent; a parent is auditable only when every child is terminal.
- After a FAILED review round, every reopened task must be re-closed with fresh evidence — PARENTS INCLUDED. Closing a task's children does NOT close the task: a parent that still has an open child is not terminal, and the review cannot start until the whole tree is terminal.
- NEVER wait for the review. While any task is open, the review is not running and nothing will re-close tasks for you: an open task is your work queue — close it with evidence or skip it with a skipReason.
- When every task is terminal, the independent execution reviewer(s) verify the plan's verification checks (${execution.items.map((item) => item.id).join(", ")}); failed checks roll their covered tasks back automatically.
- Before your LAST \`plans_update_task\` call, call \`plans_review_directions\` once with 2-3 complementary, non-overlapping directions the reviewers should dig into beyond the checks (what you touched, risky seams, what you were unsure about; name real files and modules). It is optional: without it the reviewers use fixed back-up aspects.
- Simplest implementation that fully meets the task: no speculative abstractions, configuration, or indirection; keep components modular with clearly separated concerns.
- Architectural decisions are for the long term: no stopgaps. Remove the obsolete paths this change obsoletes.
- Prefer established, well-maintained libraries when they reduce complexity; check the project's existing dependencies before adding a package or reimplementing common functionality.
- MINIMUM tests: trivial one-liners get no test; non-trivial logic gets exactly one minimal check; reuse the repo's test runner when one exists.
- For subprocess-backed verification, when a step needs a subprocess result before proceeding, poll with backoff \`5s -> 10s -> 20s -> 40s -> 80s\`, then keep polling at 80s.`;
}

interface SessionEntry {
	type: string;
	customType?: string;
	data?: ExecState;
	message?: { role: string; content: Array<{ type: string; text?: string }> };
}

/**
 * Rebuild execution state from the session on start/resume. Finds the last
 * pi-plans-exec snapshot; the task tree is rebuilt from the persisted
 * snapshot (tool-driven progress survives restarts without text replay).
 */
export async function restoreFromSession(ctx: ExtensionContext, entries: SessionEntry[]): Promise<void> {
	disposeDelegate("stopped");
	pendingExecutionFlush = false;
	continuationRuntime = null;
	resetExecutionCompactionState(ctx);
	let snapshot: ExecState | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "pi-plans-exec" && entry.data) {
			snapshot = entry.data;
			break;
		}
		if (entry.type === "custom" && entry.customType === "pi-plans-exec-cleared") {
			execution = null;
			updateStatusWidget(ctx);
			return;
		}
	}
	if (!snapshot) {
		execution = null;
		updateStatusWidget(ctx);
		return;
	}
	if (!fs.existsSync(snapshot.planPath)) {
		execution = null;
		updateStatusWidget(ctx);
		return;
	}
	// Re-derive the task tree from the plan file (fresh parse) merged with
	// the snapshot's persisted statuses — a stale parse cannot freeze progress.
	let tasks: TaskView[];
	let items: CheckItem[] = snapshot.items.map((item) => ({ ...item }));
	let planTasks = snapshot.planTasks;
	try {
		const planText = fs.readFileSync(snapshot.planPath, "utf8");
		planTasks = parsePlanTasks(planText);
		const snapshotProgress = taskProgressMap(snapshot.tasks ?? []);
		tasks = buildTaskView(planTasks, snapshotProgress);
		// Fresh text wins, but the satisfied state survives the re-parse: a
		// mid-loop session restore (v0.9.1, found via F-001's self-schedule
		// path) must not hand the next round a brief that re-judges checks an
		// earlier round already passed — that burned budget on every /reload.
		const snapDone = new Set(snapshot.items.filter((c) => c.done).map((c) => c.id));
		items = parseChecklist(planText).map((item) => (snapDone.has(item.id) ? { ...item, done: true } : item));
	} catch {
		tasks = snapshot.tasks;
	}
	// The snapshot cannot carry an in-flight round (it is memory-only); abort
	// any live one from the previous session graph and rebuild fresh (CF2-002).
	abortInFlightReview();
	execution = {
		planPath: snapshot.planPath,
		items,
		planTasks,
		tasks,
		executor: snapshot.executor,
		reviewers: snapshot.reviewers,
		legacyPlan: snapshot.legacyPlan,
		startedAt: snapshot.startedAt,
		usage: snapshot.usage ?? { inToks: 0, outToks: 0 },
		uiLanguage: resolveUiLanguage(ctx.cwd),
		stall: { ...snapshot.stall, lastSnapshot: null },
		// v0.9.2: a snapshot taken by a pre-feature build carries the live failed
		// set but no blocker record; reconstruct it so the very first wake after
		// a /reload (the recovery path for an already-stuck run) names the tasks.
		blocked: snapshot.blocked ?? blockedFromFailedIds(snapshot.audit?.failed ?? [], snapshot.audit?.rounds ?? 0, tasks, items),
		audit: {
			rounds: snapshot.audit?.rounds ?? 0,
			failed: snapshot.audit?.failed ?? [],
			undeterminable: [],
			findings: toReviewFindings(snapshot.audit?.findings),
			running: false,
		},
		review: { attempts: 0, consecutiveDiscards: 0, inFlight: null, budgetAsking: false },
		auditLatch: { auditedThisSettle: false, activity: 0 },
		// v0.9.3 (round-1 F-005): the snapshot's budget/counters survive a
		// /reload — an unset budget stays unset (the picker runs before round 1),
		// a legacy snapshot resolves to the 5-round bound via the audit counter.
		reviewBudget: resolveStoredBudget(snapshot.reviewBudget, snapshot.audit?.rounds ?? 0),
		reviewBudgetDefaulted: snapshot.reviewBudgetDefaulted === true,
		reviewRoundsTotal: snapshot.reviewRoundsTotal ?? 0,
		reviewCapExtension: snapshot.reviewCapExtension ?? 0,
		reviewNoProgress: snapshot.reviewNoProgress ?? undefined,
		reviewNonHighRepair: snapshot.reviewNonHighRepair ?? undefined,
		reviewNonHighCredits: snapshot.reviewNonHighRepair === "granted" ? 1 : 0,
	};
	execution.stall.lastSnapshot = stallSnapshot();
	resetContinuationRuntime(ctx);
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	executionRunId = active?.run_id ?? null;
	if (active) bindRun(ctx.sessionManager, ctx.cwd, active.run_id);
	persist(ctx);
	if (pendingAudit()) {
		// Self-heal (v0.8): a verifying run with pending checks restarts its
		// round exactly once per resume — the full predicate (paused, in-flight,
		// budget) lives inside startReviewRound. Restores never grant budget.
		latchAuditThisSettle();
		const chain = launchReviewRound(ctx);
		if (chain) await chain;
	}
	await resumeDelegation(ctx);
	updateStatusWidget(ctx);
}
