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
 * independent completion auditor verifies the plan's verification checks —
 * failed checks roll their covered tasks back to pending (audit-flow-only
 * channel), and three failed rounds pause for the user (bounded stopped
 * termination under auto-approve/headless).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
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
import { TERMINAL_RUN_STATUSES, getRun, latestRun, lintPlanIntoNotices, loadConfig, readActive, resolveStateRootOrNull, setRunStatus, StateError, utcNow } from "./state.ts";
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
	flattenTaskViews,
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
import { AUDIT_MAX_ROUNDS, presolvedCheckIds, runCompletionAudit } from "./auditor.ts";
import { messaging } from "./messaging.ts";

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
	/** Completion-audit bookkeeping. */
	audit: { rounds: number; failed: string[]; running: boolean };
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
	// An audit-cap pause grants a fresh audit budget on restore (mirrors
	// resumeGoalWaitIfPaused) so the first turn can actually re-audit.
	const wasAuditCapPause = (cp.execution.pausedReason ?? "").startsWith(AUDIT_CAP_PAUSE_PREFIX);
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
		// D-020: a paused legacy (or stopped) execution rebuilds unpaused —
		// the resume itself is the user's intent; the reason is surfaced in
		// the resume brief instead. An audit-cap pause additionally grants a
		// fresh audit budget here (mirrors resumeGoalWaitIfPaused), so the
		// first turn after a cross-session resume can actually re-audit.
			stall: {
			rounds: 0,
			lastSnapshot: null,
			paused: false,
			pausedReason: undefined,
		},
		audit: {
			rounds: wasAuditCapPause ? 0 : (cp.execution.audit?.rounds ?? 0),
			failed: [],
			running: false,
		},
	};
	executionRunId = runId;
	bindRun(ctx.sessionManager, ctx.cwd, runId);
	resetContinuationRuntime(ctx);
	pendingExecutionFlush = false;
	resetExecutionCompactionState(ctx);
	if (wasAuditCapPause) {
		withExecutionCheckpoint(ctx, (cp2) =>
			applyExecutionProgress(cp2, { audit: { rounds: 0, lastResult: undefined }, pausedReason: null }),
		);
	}
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
		audit: { rounds: execution.audit.rounds, failed: execution.audit.failed },
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
		stall: { rounds: 0, lastSnapshot: stallSnapshot(), paused: false },
		audit: { rounds: 0, failed: [], running: false },
	};
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
			audit: {
				rounds: execution!.audit.rounds,
				lastResult: execution!.audit.failed.length > 0 ? execution!.audit.failed.join(",") : undefined,
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
let auditRunnerForTests: ((input: { planPath: string; checklist: CheckItem[]; tasks: TaskView[]; round: number }) => Promise<Awaited<ReturnType<typeof runCompletionAudit>>>) | null = null;

export function __setAuditRunnerForTests(
	runner: ((input: { planPath: string; checklist: CheckItem[]; tasks: TaskView[]; round: number }) => Promise<Awaited<ReturnType<typeof runCompletionAudit>>>) | null,
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
	ext.on("session_shutdown", async (_event, ctx) => {
		drainExecutionFlush(ctx);
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
		if (getExecution() && allTasksTerminal(execution!.tasks) && !execution!.audit.running) {
			await runAuditFlow(ctx);
		}
		await onTurnEnd?.(ctx);
	});
}

/** Audit flow: run the completion auditor, apply pass/rollback, and either
 *  complete the run, keep iterating (rollback), pause at the round cap
 *  (interactive), or stop at the cap (auto-approve/headless — D-022).
 *
 *  Fail-closed completion: a run completes only when EVERY pending check was
 *  affirmatively passed (or resolved skipped-pass); checks the auditor failed
 *  to report count as failed, never as silently passed. */
async function runAuditFlow(ctx: ExtensionContext): Promise<void> {
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
	if (pendingChecks.length === 0) {
		await completeExecution(ctx);
		return;
	}
	if (ex.audit.rounds >= AUDIT_MAX_ROUNDS) {
		// D-022: interactive sessions pause for the user (state kept, tasks
		// intact, resumable); auto-approve/headless terminates bounded.
		if (isInteractiveSession(ctx)) {
			pauseForStall(
				ctx,
				`${AUDIT_CAP_PAUSE_PREFIX} ${AUDIT_MAX_ROUNDS} rounds (failed: ${ex.audit.failed.join(", ") || "unknown"}); review the audit reports and fix the failures, then resume with any message or /plans-execute — resuming grants a fresh three-round audit budget (or close the failed checks' tasks as skipped to pass them as skipped-pass)`,
			);
			return;
		}
		await stopExecution(ctx, `completion audit exhausted ${AUDIT_MAX_ROUNDS} rounds (failed: ${ex.audit.failed.join(", ") || "unknown"})`);
		return;
	}
	ex.audit.running = true;
	ex.audit.rounds += 1;
	updateStatusWidget(ctx);
	let outcome = null as Awaited<ReturnType<typeof runCompletionAudit>>;
	try {
		outcome = auditRunnerForTests
			? await auditRunnerForTests({ planPath: ex.planPath, checklist: ex.items, tasks: ex.tasks, round: ex.audit.rounds })
			: await runCompletionAudit(ctx, {
				planPath: ex.planPath,
				checklist: ex.items,
				tasks: ex.tasks,
				round: ex.audit.rounds,
				signal: ctx.signal,
			});
	} finally {
		ex.audit.running = false;
	}
	// Fail-closed: checks the outcome did not affirmatively pass are failed.
	const reportedPass = new Set(outcome?.passed ?? []);
	const failed = pendingChecks
		.map((item) => item.id)
		.filter((id) => !reportedPass.has(id));
	if (failed.length === 0) {
		ex.audit.failed = [];
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(ex.tasks),
				doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
				audit: { rounds: ex.audit.rounds, passed: true },
			}),
		);
		await completeExecution(ctx);
		return;
	}
	// Failed checks: roll their covered tasks back (always — an unreported or
	// infra-failed audit must reopen work so the loop can continue) and
	// persist progress including checks that passed earlier rounds.
	for (const id of failed) {
		const item = ex.items.find((candidate) => candidate.id === id);
		if (item) item.done = false;
	}
	ex.audit.failed = failed;
	const rolledBack: string[] = [];
	for (const id of failed) {
		rolledBack.push(...auditRollbackSet(ex.tasks, ex.items, id));
	}
	withExecutionCheckpoint(ctx, (cp) =>
		applyExecutionProgress(cp, {
			tasks: taskProgressMap(ex.tasks),
			doneVcIds: ex.items.filter((item) => item.done).map((item) => item.id),
			audit: { rounds: ex.audit.rounds, lastResult: failed.join(",") },
		}),
	);
	ex.stall.rounds = 0;
	ex.stall.lastSnapshot = stallSnapshot();
	persist(ctx);
	updateStatusWidget(ctx);
	const report = outcome?.report ?? "(audit subagent failed to run)";
	messaging().sendMessage(
		{
			customType: "pi-plans-audit-failed",
			content: `**pi-plans: completion audit round ${ex.audit.rounds} failed** — checks: ${failed.join(", ")}. Rolled back tasks: ${rolledBack.join(", ") || "(none covered)"}. Fix the failures and re-close the rolled-back tasks with \`plans_update_task\`; the audit reruns automatically once all tasks are terminal again.${ex.audit.rounds >= AUDIT_MAX_ROUNDS ? ` This was round ${AUDIT_MAX_ROUNDS} of ${AUDIT_MAX_ROUNDS}: interactive sessions pause for review; the next terminal-task cycle stops or pauses the run.` : ""}\n\n---\n${report.slice(0, 4000)}`,
			display: true,
		},
		{ triggerTurn: false },
	);
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
	if (phase === "execution" && run.status !== "executing") return null;
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

function stallSnapshot(): string {
	if (!execution) return "";
	return JSON.stringify(taskProgressMap(execution.tasks));
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

/** Prefix of the stall reason used for the audit-cap pause (D-022). */
const AUDIT_CAP_PAUSE_PREFIX = "completion audit exhausted";

/** Called for genuine user input or an explicit same-execution resume.
 * Resuming an audit-cap pause grants a fresh audit budget (three more
 * rounds): the user's explicit resume IS the decision to keep auditing —
 * without this reset the cap pause could never be lifted productively. */
export function resumeGoalWaitIfPaused(ctx: ExtensionContext): boolean {
	const ex = getExecution();
	if (!ex?.stall.paused || !currentContinuationRuntime(ctx)) return false;
	const wasAuditCap = (ex.stall.pausedReason ?? "").startsWith(AUDIT_CAP_PAUSE_PREFIX);
	ex.stall.paused = false;
	ex.stall.pausedReason = undefined;
	ex.stall.rounds = 0;
	ex.stall.lastSnapshot = stallSnapshot();
	if (wasAuditCap) {
		ex.audit.rounds = 0;
		ex.audit.failed = [];
		withExecutionCheckpoint(ctx, (cp) =>
			applyExecutionProgress(cp, {
				tasks: taskProgressMap(ex.tasks),
				audit: { rounds: 0, lastResult: undefined },
				pausedReason: null,
			}),
		);
	} else {
		withExecutionCheckpoint(ctx, (cp) => applyExecutionProgress(cp, { pausedReason: null }));
	}
	persist(ctx);
	updateStatusWidget(ctx);
	return true;
}

export function resumeActiveExecution(ctx: ExtensionContext): boolean {
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
	const planPath = execution.planPath;
	withExecutionCheckpoint(ctx, (cp) => applyExecutionCompleted(cp));
	execution = null;
	executionRunId = null;
	continuationRuntime = null;
	messaging().appendEntry("pi-plans-exec-cleared", { reason: "complete" });
	messaging().sendMessage(
		{
			customType: "pi-plans-complete",
			content: `**Plan complete!** ✅ \`${planPath}\` — completion audit passed.\n\n${summary}`,
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
		? `\nCompletion audit round ${execution.audit.rounds} failed checks: ${execution.audit.failed.join(", ")} — the covered tasks were rolled back to pending; re-close them with evidence after fixing the failures.`
		: "";
	return `[PI-PLANS EXECUTION — write access enabled]
Implement the accepted plan at ${execution.planPath} (tasks ${progress.done}/${progress.total}${execution.legacyPlan ? " · legacy I-### mapping" : ""} · VC ${vcDone}/${execution.items.length}).

Current wave ${currentWave} open tasks:
${waveList}

Remaining open tasks (all waves): ${open.map((task) => task.id).join(", ") || "(none)"}.${rollbackNote}

${graphLine}

Execution rules:
- Work through tasks in wave order (earlier waves first); within a wave, follow the listed dependency order. Wave grouping encodes which tasks could run in parallel — keep their file sets disjoint.
- Report progress ONLY through the \`plans_update_task\` tool: status "complete" with evidence (test command output / file paths), or "skipped" with a skipReason. One call per task; statuses are immutable once set.
- Close subtasks before their parent; a parent is auditable only when every child is terminal.
- When every task is terminal, the independent completion auditor verifies the plan's verification checks (${execution.items.map((item) => item.id).join(", ")}); failed checks roll their covered tasks back automatically.
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
		items = parseChecklist(planText);
	} catch {
		tasks = snapshot.tasks;
	}
	execution = {
		planPath: snapshot.planPath,
		items,
		planTasks,
		tasks,
		legacyPlan: snapshot.legacyPlan,
		startedAt: snapshot.startedAt,
		usage: snapshot.usage ?? { inToks: 0, outToks: 0 },
		uiLanguage: resolveUiLanguage(ctx.cwd),
		stall: { ...snapshot.stall, lastSnapshot: stallSnapshot(), rounds: 0 },
		audit: { rounds: snapshot.audit?.rounds ?? 0, failed: snapshot.audit?.failed ?? [], running: false },
	};
	resetContinuationRuntime(ctx);
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	executionRunId = active?.run_id ?? null;
	if (active) bindRun(ctx.sessionManager, ctx.cwd, active.run_id);
	persist(ctx);
	if (allTasksTerminal(execution.tasks) && !execution.items.every((item) => item.done)) {
		// Terminal tasks without a passing audit: rerun the audit flow.
		await runAuditFlow(ctx);
	}
	updateStatusWidget(ctx);
}
