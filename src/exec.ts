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
import { TERMINAL_RUN_STATUSES, getRun, latestRun, lintPlanIntoNotices, loadConfig, readActive, resolveStateRootOrNull, runDirPath, setRunStatus, StateError, utcNow } from "./state.ts";
import { resolveUiLanguage, type UiLanguage } from "./ui-language.ts";
import { bindRun, resolveActiveRun } from "./run-context.ts";
import type { SubagentProgressEvent } from "./subagent.ts";
import { OwnershipError } from "./run-ownership.ts";
import {
	applyExecutionApproved,
	applyExecutionCompleted,
	applyExecutionHeadChanged,
	applyExecutionProgress,
	applyExecutionStopped,
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
	type WorkflowCheckpoint,
} from "./workflow-state.ts";
import { graphBlockForExecutor } from "./code-graph/prompts.ts";
import { resolveGraphMode } from "./code-graph/mode.ts";
import {
	parseChecklist,
	parsePlanTasks,
	flattenTasks,
	type CheckItem,
	type PlanTasks,
} from "./plan.ts";
import {
	allTasksTerminal,
	auditRollbackSet,
	auditableChecks,
	buildTaskView,
	currentTask,
	findingsRollbackSet,
	flattenTaskViews,
	invalidateChecksForRolledBackTasks,
	maxWave,
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
} from "./dashboard.ts";
import { REVIEW_MAX_ROUNDS, presolvedCheckIds, runCompletionAudit, writeReviewRoundReport, type AuditOutcome, type AuditRoundResult, type ReviewFinding } from "./auditor.ts";
import type { ReviewFindingRecord } from "./workflow-state.ts";
import { staleReloadHint as probeStaleReload } from "./staleness.ts";
import { messaging } from "./messaging.ts";
import { RefineOverlayController, refineOverlayContext } from "./refine-ui.ts";
import { applyRefineProgress, applyRefineResult, type RefineLaneState } from "./refine-ui-state.ts";
import { resolveReviewerSpawn } from "./thinking-levels.ts";
import { loadGlobalConfig, reviewerReady } from "./global-state.ts";
import { matchesTerminalKey } from "./terminal-keys.ts";

export interface ExecState {
	planPath: string;
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
	/** Chrome language for panel/status strings; undefined → "en". */
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
	review: { attempts: number; consecutiveDiscards: number; inFlight: InFlightReview | null };
	/** Per-settle audit latch (v0.7.1): a settled round fires the completion
	 * audit at most once, so the turn_end / agent_before_settle / resume entry
	 * points cannot double-consume a round when several land in one settle.
	 * Created on demand by auditLatchOf(); every construction path may omit it. */
	auditLatch?: { auditedThisSettle: boolean; activity: number };
}

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
const STALL_MAX_ROUNDS = 3;

let execution: ExecState | null = null;

export const EXECUTION_CONTINUE_CUSTOM_TYPE = "pi-plans-exec-continue";
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
	error?: string;
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
		legacyPlan: planTasks.legacy,
		startedAt: utcNow(),
		usage: { inToks: cp.execution.usage.inToks, outToks: cp.execution.usage.outToks },
		uiLanguage: resolveUiLanguage(ctx.cwd),
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
		review: { attempts: 0, consecutiveDiscards: 0, inFlight: null },
		auditLatch: { auditedThisSettle: false, activity: 0 },
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
	persist(ctx);
	updateStatusWidget(ctx);
	return {
		status: "loaded",
		planPath,
		doneVcIds: [...cp.execution.doneVcIds],
		reverifyAll,
		pausedReason: cp.execution.pausedReason,
		legacyPlan: planTasks.legacy,
		legacyDelegate,
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
					auditRounds: current.audit.rounds > 0 || current.audit.running ? current.audit.rounds : null,
					auditFailed: current.audit.failed,
					auditUndeterminable: current.audit.undeterminable,
					findings: current.audit.findings,
					reviewRunning: current.audit.running === true || current.review.inFlight !== null,
					startedAt: current.startedAt,
					usage: current.usage,
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
			auditRounds: execution.audit.rounds > 0 ? execution.audit.rounds : null,
			auditFailed: execution.audit.failed,
			auditUndeterminable: execution.audit.undeterminable,
			findings: execution.audit.findings,
			reviewRunning: execution.audit.running === true || execution.review.inFlight !== null,
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
		return names.some((name) => /^PLAN_v\d+\.(md|markdown)$/i.test(name));
	} catch {
		return false;
	}
}

function persist(ctx: ExtensionContext): void {
	if (!execution) return;
	messaging().appendEntry("pi-plans-exec", {
		planPath: execution.planPath,
		items: execution.items,
		planTasks: execution.planTasks,
		tasks: execution.tasks,
		legacyPlan: execution.legacyPlan,
		startedAt: execution.startedAt,
		usage: execution.usage,
		stall: execution.stall,
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
}

export async function startExecution(
	ctx: ExtensionContext,
	input: StartExecutionInput,
): Promise<void> {
	// A fresh handoff replaces any live run — abort its in-flight review round first.
	abortInFlightReview();
	const tasks = buildTaskView(input.planTasks);
	execution = {
		planPath: input.planPath,
		items: input.items,
		planTasks: input.planTasks,
		tasks,
		legacyPlan: input.planTasks.legacy,
		startedAt: utcNow(),
		usage: { inToks: 0, outToks: 0 },
		uiLanguage: resolveUiLanguage(ctx.cwd),
		stall: { rounds: 0, lastSnapshot: null, paused: false },
		audit: { rounds: 0, failed: [], undeterminable: [], findings: [], running: false },
		review: { attempts: 0, consecutiveDiscards: 0, inFlight: null },
		auditLatch: { auditedThisSettle: false, activity: 0 },
	};
	// Seed the watchdog baseline only after `execution` points at the new state
	// (stallSnapshot reads the live execution).
	execution.stall.lastSnapshot = stallSnapshot();
	resetContinuationRuntime(ctx);
	pendingExecutionFlush = false;
	resetExecutionCompactionState(ctx);
	persist(ctx);
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
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
				return applyExecutionApproved(aligned, approval);
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
			content: `**pi-plans: executing** \`${input.planPath}\` — ${progress.total} task(s) in ${input.planTasks.legacy ? "legacy" : "task-tree"} mode, ${input.items.length} verification check(s). Report progress with the \`plans_update_task\` tool; the dashboard tracks every task (Ctrl+Shift+T expands the tree).`,
			display: true,
		},
		{ triggerTurn: false },
	);
	updateStatusWidget(ctx);
}

/** Persist the live task progress (called by the task status tool). */
export function persistTaskProgress(ctx: ExtensionContext): void {
	if (!execution) return;
	// Any task-state change resets the stall watchdog baseline.
	execution.stall.rounds = 0;
	execution.stall.lastSnapshot = stallSnapshot();
	withExecutionCheckpoint(ctx, (cp) =>
		applyExecutionProgress(cp, {
			tasks: taskProgressMap(execution!.tasks),
			doneVcIds: execution!.items.filter((item) => item.done).map((item) => item.id),
			stallRounds: execution!.stall.rounds,
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
let auditRunnerForTests: ((input: { planPath: string; checklist: CheckItem[]; tasks: TaskView[]; round: number; priorFindings: ReviewFinding[] }) => Promise<Awaited<ReturnType<typeof runCompletionAudit>>>) | null = null;

export function __setAuditRunnerForTests(
	runner: ((input: { planPath: string; checklist: CheckItem[]; tasks: TaskView[]; round: number; priorFindings: ReviewFinding[] }) => Promise<Awaited<ReturnType<typeof runCompletionAudit>>>) | null,
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
		if (!pendingAudit()) return;
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
		if (getExecution() && pendingAudit() && !auditLatchOf(execution!).auditedThisSettle) {
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
const REVIEW_CAP_PAUSE_PREFIX = "execution review exhausted";
/** v0.7 protocol value — dual-matched for one release so checkpoints written
 * by older builds keep their cap pause recognized on restore. */
const LEGACY_AUDIT_CAP_PAUSE_PREFIX = "completion audit exhausted";

function isReviewCapPause(reason: string | undefined | null): boolean {
	if (!reason) return false;
	return reason.startsWith(REVIEW_CAP_PAUSE_PREFIX) || reason.startsWith(LEGACY_AUDIT_CAP_PAUSE_PREFIX);
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

/** v0.9: findings widen the owed predicate — an unresolved high finding keeps
 * the review owed even when every check is done (the stranded-high path),
 * mirroring how a failed check keeps it owed today. */
function reviewOwed(ex: ExecState): boolean {
	return allTasksTerminal(ex.tasks)
		&& (auditableChecks(ex.items, ex.tasks).some((item) => !item.done) || unresolvedHighFindings(ex).length > 0);
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

/** Engine-held lane state for the in-flight round: the reopen path builds a
 * fresh one-shot controller seeded from THIS object, so the accumulated
 * transcript survives ESC + reopen (CF2-001 / Q-reopen-seed). */
let reviewLane: RefineLaneState | null = null;
let reviewOverlay: RefineOverlayController | null = null;
let reviewModelLabel: string | undefined;

function freshReviewLane(attempt: number): RefineLaneState {
	return {
		id: `review-round-${attempt}`,
		label: `Execution review round ${attempt}`,
		status: "queued",
		phase: "queued",
		detail: "",
		transcript: [],
		currentTurnIndex: 0,
		scrollOffset: 0,
		followTranscript: true,
		viewportHeight: 1,
	};
}

/** Fresh controller per round (the controller is one-shot: closed latch,
 * overlayPromise bail, terminal-lane early return — reuse drops progress).
 * A UI failure must NEVER kill the round itself — best-effort only. The
 * overlay forwards unhandled keys so Ctrl+Shift+T keeps working while the
 * review overlay holds focus (pi-tui has no key bubbling). */
function openReviewOverlay(ctx: ExtensionContext, lane: RefineLaneState, lang: "en" | "zh" | undefined, modelLabel: string): RefineOverlayController | null {
	if (ctx.mode !== "tui" || ctx.hasUI !== true) return null;
	try {
		const controller = new RefineOverlayController(
			"auditor",
			[{ id: lane.id, label: lane.label }],
			() => {},
			lang ?? "en",
			(data) => {
				if (matchesTerminalKey(data, "ctrl+shift+t")) toggleDashboardExpanded(ctx);
			},
		);
		controller.seedLane(lane);
		controller.open(refineOverlayContext(ctx), modelLabel);
		return controller;
	} catch {
		return null;
	}
}

/** The reopen surface (Task-3.4): rebuilds the overlay from engine-held lane
 * state; inert when no round is in flight. */
export function reopenReviewOverlay(ctx: ExtensionContext): void {
	if (!execution?.review.inFlight || !reviewLane) return;
	// Never stack a second overlay on a live one (Ctrl+Shift+R while open).
	if (reviewOverlay && !reviewOverlay.isClosed()) return;
	const controller = openReviewOverlay(ctx, reviewLane, execution.uiLanguage, reviewModelLabel ?? "session default");
	if (controller) reviewOverlay = controller;
}

function pauseReviewCap(ctx: ExtensionContext, ex: ExecState): void {
	const highs = unresolvedHighFindings(ex);
	const detail =
		ex.audit.failed.length > 0
			? `failed: ${ex.audit.failed.join(", ")}${highs.length > 0 ? `; high findings: ${highs.map((f) => f.id).join(", ")}` : ""}`
			: highs.length > 0
				? `high findings: ${highs.map((f) => f.id).join(", ")}`
				: `unreadable verdicts: ${ex.audit.undeterminable.join(", ") || "unknown"}`;
	const reason = `${REVIEW_CAP_PAUSE_PREFIX} ${REVIEW_MAX_ROUNDS} rounds (${detail}). Only /plans-execute — an explicit user confirmation — grants a fresh five-round budget; ordinary messages and session restores do not. (Or close the failed checks' tasks as skipped to pass them as skipped-pass.)`;
	pauseForStall(ctx, reason);
	// In-band, headless-visible pause signal (the pi-plans-exec-stop pattern):
	// pauseForStall's ui.notify is optional and absent headless, so the pause
	// must also land in the session stream every mode can read.
	messaging().sendMessage(
		{ customType: "pi-plans-review-paused", content: `**pi-plans: ${reason}**`, display: true },
		{ triggerTurn: false },
	);
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
	// around, only fixed or paused at the cap).
	if (pendingChecks.length === 0 && unresolvedHighFindings(ex).length === 0) {
		await completeExecution(ctx);
		return;
	}
	if (ex.stall.paused || ex.review.inFlight) return;
	if (ex.audit.rounds >= REVIEW_MAX_ROUNDS) {
		pauseReviewCap(ctx, ex);
		return;
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
	reviewModelLabel = spawn.label;
	const lane = freshReviewLane(round.attempt);
	reviewLane = lane;
	reviewOverlay = openReviewOverlay(ctx, lane, ex.uiLanguage, spawn.label);
	updateStatusWidget(ctx);
	let result: AuditRoundResult;
	try {
		result = auditRunnerForTests
			? await auditRunnerForTests({ planPath: ex.planPath, checklist: ex.items, tasks: ex.tasks, round: round.attempt, priorFindings: ex.audit.findings })
			: await runCompletionAudit(ctx, {
				planPath: ex.planPath,
				checklist: ex.items,
				tasks: ex.tasks,
				round: round.attempt,
				priorFindings: ex.audit.findings,
				model: spawn.model,
				thinkingLevel: spawn.thinkingLevel,
				timeoutMs: REVIEW_ROUND_TIMEOUT_MS,
				signal: round.controller.signal,
				onProgress: (event) => {
					// The engine owns the lane state; the live controller only repaints.
					applyRefineProgress(lane, event);
					reviewOverlay?.rerender();
				},
			});
	} catch (error) {
		if (ex.review.inFlight === round) {
			ex.review.inFlight = null;
			ex.audit.running = false;
		}
		void reviewOverlay?.close();
		reviewOverlay = null;
		messaging().sendMessage(
			{ customType: "pi-plans-review-error", content: `pi-plans: execution review round threw: ${String(error)}`, display: true },
			{ triggerTurn: false },
		);
		updateStatusWidget(ctx);
		return;
	}
	// Overlay terminal state + close (the controller is one-shot; the engine-held
	// lane keeps the transcript for a later reopen within this round).
	const cancelledResult = result !== null && typeof result === "object" && "cancelled" in result;
	try {
		applyRefineResult(lane, {
			ok: !cancelledResult,
			output: result && "report" in result ? result.report : "",
			stderr: "",
			turns: 0,
			...(cancelledResult ? { cancelled: true as const } : {}),
		});
	} catch {
		/* cosmetic only */
	}
	void reviewOverlay?.close();
	reviewOverlay = null;
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
				budgetRound: round.budgetRound,
				attempt: round.attempt,
				outcome: "discarded",
				passed: [],
				failed: [],
				undeterminable: pendingIds,
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
function appendFindingTasks(ex: ExecState, highs: ReviewFinding[]): string[] {
	const appended: string[] = [];
	let next = flattenTaskViews(ex.tasks).reduce((max, t) => {
		const m = /^Task-(\d+)$/.exec(t.id);
		return m ? Math.max(max, Number(m[1])) : max;
	}, 0);
	const wave = maxWave(ex.tasks) + 1;
	try {
		const planText = fs.readFileSync(ex.planPath, "utf8");
		const lines = planText.split("\n");
		// Insert inside the Tasks section: before the Execution Waves
		// subsection when present, else before the Verification Checks
		// header, else at EOF; walk back over blank separators so the bullet
		// lands adjacent to its siblings.
		let insertAt = lines.length;
		const wavesIdx = lines.findIndex((l) => /^###\s+Execution Waves/.test(l));
		const vcIdx = lines.findIndex((l) => /^##\s+Verification Checks/.test(l));
		if (wavesIdx !== -1) insertAt = wavesIdx;
		else if (vcIdx !== -1) insertAt = vcIdx;
		while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
		const newLines: string[] = [];
		for (const h of highs) {
			next += 1;
			const id = `Task-${next}`;
			const title = `fix ${h.id}: ${h.proposedTask ?? h.note ?? "address the finding"} (appended by execution review round ${ex.audit.rounds})`;
			newLines.push(`- \`${id}\`: ${title}`);
			ex.tasks.push({ id, title, wave, deps: [], files: [], status: "pending", children: [] });
			appended.push(id);
		}
		lines.splice(insertAt, 0, ...newLines);
		fs.writeFileSync(ex.planPath, lines.join("\n"), "utf8");
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
	// Findings are actionable only when this round actually reported them;
	// see the fix-loop branch below (v0.9.1, F-001).
	const actionableHighs = reported ? highs : [];
	const coveredTaskIds = flattenTaskViews(ex.tasks).map((task) => task.id);
	const reportText = outcome?.report ?? "(review subagent failed to run)";
	let reportPath: string | null = null;
	{
		const runDir = runDirOf(ctx);
		if (runDir) {
			reportPath = writeReviewRoundReport(runDir, {
				budgetRound: round.budgetRound,
				attempt: round.attempt,
				outcome: outcome === null
					? "spawn-failed"
					: failed.length > 0 || actionableHighs.length > 0
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
		const unmappedHighs = actionableHighs.filter((h) => !h.taskIds.some((id) => knownIds.has(id)));
		const amended = unmappedHighs.length > 0 ? appendFindingTasks(ex, unmappedHighs) : [];
		const allRolledBack = [...new Set([...rolledBack, ...highRolledBack])];
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
				audit: { rounds: ex.audit.rounds, lastResult: failed.join(",") || `highs: ${actionableHighs.map((h) => h.id).join(",")}`, findings },
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
			const reportRef = reportPath
				? `Full round report: ${reportPath}`
				: `Full round report (run dir unwritable — inline):\n\n---\n${reportText.slice(0, 4000)}`;
			const content = `**pi-plans: execution review round ${ex.audit.rounds} found ${actionableHighs.length} high-severity finding(s)**${failed.length > 0 ? ` and failed checks: ${failed.join(", ")}` : ""}. Rolled back tasks: ${allRolledBack.join(", ") || "(none covered)"}${amended.length > 0 ? `. Tasks appended to the plan for unmapped findings: ${amended.join(", ")}` : ""}.\n\nHigh findings:\n${highLines || "(none — failed checks only)"}\n\nFix them and re-close the affected tasks with \`plans_update_task\`; the review reruns automatically once all tasks are terminal again.${ex.audit.rounds >= REVIEW_MAX_ROUNDS ? ` This was round ${REVIEW_MAX_ROUNDS} of ${REVIEW_MAX_ROUNDS}: the next terminal-task cycle pauses the run for review.` : ""}${stranded ? ` No task covers the finding(s) and none could be appended — the task tree stayed terminal; the next settle re-runs the review automatically.` : ""}\n\n${reportRef}`;
			messaging().sendMessage(
				{
					customType: "pi-plans-audit-failed",
					content: `${content}\n\nStill open: ${openTasks.join(", ") || "(none — the tree is terminal)"}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
		return; // The agent repairs; the next settle re-enters the loop.
	}

	// Fail-closed completion: every pending check affirmatively passed AND no
	// high finding remains. The highs guard is explicit (v0.9.1, F-001): a
	// no-report round skips the fix branch above, so this is the last line
	// against vacuously completing an empty-pendingIds round with an
	// unresolved high. An all-undeterminable round yields failed === [] —
	// completing here would be fail-open, marking a run done with nothing
	// verified.
	if (passed.length === pendingIds.length && highs.length === 0) {
		ex.audit.failed = [];
		ex.audit.undeterminable = [];
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(ex.tasks),
				doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
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
	if (ex.audit.rounds >= REVIEW_MAX_ROUNDS) {
		pauseReviewCap(ctx, ex);
		return;
	}
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

function activeVccSettings(ctx: ExtensionContext, phase: PiPlansCompactionPhase): { settings: PiPlansVccSettings; runId: string; artifactDir: string } | null {
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

function planningVccContext(branchEntries: CompactionEntryLike[], fallback: { runId?: string; artifactDir?: string }): PiPlansVccPhaseContext {
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

interface PrePlanCompactPending {
	runId: string;
}

export function markPrePlanCompactPending(ctx: ExtensionContext, runId: string): void {
	const session = ctx.sessionManager as unknown as { __piPlansPrePlanCompact?: PrePlanCompactPending | null };
	session.__piPlansPrePlanCompact = { runId };
}

export function consumePrePlanCompactPending(ctx: ExtensionContext): PrePlanCompactPending | null {
	const session = ctx.sessionManager as unknown as { __piPlansPrePlanCompact?: PrePlanCompactPending | null };
	const pending = session.__piPlansPrePlanCompact ?? null;
	session.__piPlansPrePlanCompact = null;
	return pending;
}

export function sendPrePlanCompactResume(ctx: ExtensionContext): void {
	messaging().sendMessage(
		{
			customType: PLANNING_PREPLAN_RESUME_CUSTOM_TYPE,
			content: "Continue planning.",
			display: false,
		},
		{ triggerTurn: true },
	);
}

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
	const abortPatterns = [
		"this operation was aborted",
		"aborted",
		"stream ended before a terminal response event",
		"turn prefix summarization failed",
		"auto-compaction failed",
		"context overflow recovery failed",
	];
	if (abortPatterns.some((pattern) => message.includes(pattern))) {
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
}

export function filterPlanningResumeMessages<T extends { customType?: string }>(messages: T[]): T[] {
	return messages.filter((message) => message.customType !== PLANNING_RESUME_CUSTOM_TYPE && message.customType !== PLANNING_PREPLAN_RESUME_CUSTOM_TYPE);
}

export async function stopExecution(ctx: ExtensionContext, reason: string): Promise<void> {
	if (!execution) return;
	// A stopped run's in-flight review round dies with it (typed cancelled —
	// no budget, no wake).
	abortInFlightReview();
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
	return allTasksTerminal(ex.tasks)
		&& (auditableChecks(ex.items, ex.tasks).some((item) => !item.done) || unresolvedHighFindings(ex).length > 0);
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

function pauseForStall(ctx: ExtensionContext, reason: string): void {
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
	// legacy v0.6.0 goal-wait type) never replay after a restart.
	return messages.filter((message) => message.customType !== EXECUTION_CONTINUE_CUSTOM_TYPE
		&& message.customType !== LEGACY_GOAL_WAIT_CUSTOM_TYPE);
}

export function filterContinuationMessages<T extends { customType?: string; details?: unknown }>(messages: T[]): T[] {
	return filterGoalWaitMessages(messages);
}

/** Called for genuine user input or an explicit same-execution resume.
 * v0.8: a REVIEW-CAP pause is never lifted here — ordinary input must not
 * refill the five-round budget (CF2-004); only /plans-execute
 * (resumeActiveExecution) is the explicit confirmation surface. Genuine
 * stall pauses still clear on input as before. */
export function resumeGoalWaitIfPaused(ctx: ExtensionContext): boolean {
	const ex = getExecution();
	if (!ex?.stall.paused || !currentContinuationRuntime(ctx)) return false;
	if (isReviewCapPause(ex.stall.pausedReason)) {
		// Surfaced once per input so the user is not left guessing why the run
		// stays paused; the pause itself and the budget survive untouched.
		ctx.ui.notify?.(
			"pi-plans: the review-round budget is exhausted — run /plans-execute to grant a fresh five-round budget (that confirmation is the only surface that does).",
			"warning",
		);
		return false;
	}
	ex.stall.paused = false;
	ex.stall.pausedReason = undefined;
	ex.stall.rounds = 0;
	ex.stall.lastSnapshot = stallSnapshot();
	withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { pausedReason: null }));
	persist(ctx);
	updateStatusWidget(ctx);
	return true;
}

export function resumeActiveExecution(ctx: ExtensionContext): boolean {
	// v0.8: /plans-execute is THE explicit confirmation surface for a
	// review-cap pause — the only place a fresh five-round budget is granted
	// (Q-confirm-surface). Ordinary input and session restores never refill.
	const pausedEx = getExecution();
	if (pausedEx?.stall.paused && isReviewCapPause(pausedEx.stall.pausedReason)) {
		pausedEx.stall.paused = false;
		pausedEx.stall.pausedReason = undefined;
		pausedEx.stall.rounds = 0;
		pausedEx.stall.lastSnapshot = stallSnapshot();
		pausedEx.audit.rounds = 0;
		pausedEx.audit.failed = [];
		pausedEx.audit.undeterminable = [];
		// v0.9: the fresh budget inherits unresolved findings (stable ids keep
		// counting) — only the round counter resets.
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(pausedEx.tasks),
				audit: { rounds: 0, lastResult: undefined, findings: pausedEx.audit.findings },
				pausedReason: null,
			}),
		);
		persist(ctx);
		updateStatusWidget(ctx);
		messaging().sendMessage(
			{
				customType: "pi-plans-review-budget-granted",
				content: "**pi-plans: fresh five-round review budget granted** — the execution review resumes now.",
				display: true,
			},
			{ triggerTurn: false },
		);
		const grantChain = launchReviewRound(ctx);
		if (grantChain) void grantChain.catch(() => { /* surfaced via the review messages */ });
		return true;
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
		return true;
	}
	if (!resumeGoalWaitIfPaused(ctx)) return false;
	const runtime = currentContinuationRuntime(ctx)!;
	if (canWakeExecution(ctx, runtime)) {
		runtime.handled = true;
		sendContinuationWake(ctx, runtime);
	}
	return true;
}

export async function completeExecution(ctx: ExtensionContext): Promise<void> {
	if (!execution) return;
	resetExecutionCompactionState(ctx);
	pendingExecutionFlush = false;
	persist(ctx);
	const flat = flattenTaskViews(execution.tasks);
	const summary = flat
		.map((task) => `- ${taskIsTerminal(task) && task.status === "skipped" ? "~" : "✓"} \`${task.id}\` ${task.title}`)
		.join("\n");
	// v0.9: residual (non-high) findings are summarized, never silent — the
	// loop converged because nothing high-blocking remained.
	const residualFindings = execution.audit.findings.filter((f) => f.severity !== "high");
	const residualNote = residualFindings.length > 0
		? `\n\nRecorded findings that did not block completion: ${residualFindings.map((f) => `${f.id} (${f.severity})`).join(", ")} — see the execution-review round reports under the run directory.`
		: "";
	const planPath = execution.planPath;
	withExecutionCheckpoint(ctx, (cp) => applyExecutionCompleted(cp));
	execution = null;
	executionRunId = null;
	continuationRuntime = null;
	messaging().appendEntry("pi-plans-exec-cleared", { reason: "complete" });
	messaging().sendMessage(
		{
			customType: "pi-plans-complete",
			content: `**Plan complete!** ✅ \`${planPath}\` — execution review passed.\n\n${summary}${residualNote}`,
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

/** Injection text for before_agent_start while executing. */
export function executionContextMessage(ctx: ExtensionContext): string | null {
	if (!execution) return null;
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
	return `[PI-PLANS EXECUTION — write access enabled]
Implement the accepted plan at ${execution.planPath} (tasks ${progress.done}/${progress.total}${execution.legacyPlan ? " · legacy I-### mapping" : ""} · VC ${vcDone}/${execution.items.length}).

Current wave ${currentWave} open tasks:
${waveList}

Remaining open tasks (all waves): ${open.map((task) => task.id).join(", ") || "(none)"}.${rollbackNote}${highFindingsNote}

${graphLine}

Execution rules:
- Work through tasks in wave order (earlier waves first); within a wave, follow the listed dependency order. Wave grouping encodes which tasks could run in parallel — keep their file sets disjoint.
- Report progress ONLY through the \`plans_update_task\` tool: status "complete" with evidence (test command output / file paths), or "skipped" with a skipReason. One call per task; statuses are immutable once set.
- Close subtasks before their parent; a parent is auditable only when every child is terminal.
- When every task is terminal, the independent execution reviewer verifies the plan's verification checks (${execution.items.map((item) => item.id).join(", ")}); failed checks roll their covered tasks back automatically.
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
		legacyPlan: snapshot.legacyPlan,
		startedAt: snapshot.startedAt,
		usage: snapshot.usage ?? { inToks: 0, outToks: 0 },
		uiLanguage: resolveUiLanguage(ctx.cwd),
		stall: { ...snapshot.stall, lastSnapshot: null },
		audit: {
			rounds: snapshot.audit?.rounds ?? 0,
			failed: snapshot.audit?.failed ?? [],
			undeterminable: [],
			findings: toReviewFindings(snapshot.audit?.findings),
			running: false,
		},
		review: { attempts: 0, consecutiveDiscards: 0, inFlight: null },
		auditLatch: { auditedThisSettle: false, activity: 0 },
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
	updateStatusWidget(ctx);
}
