/**
 * Plan-execution loop: the tracked execution mode for accepted plans.
 *
 * When the user approves the execution handoff, the extension switches into
 * execution mode: every agent turn is injected with the remaining verifier
 * checklist, assistant messages are scanned for [DONE:VC-xxx] markers, and
 * progress is reported through the bottom status bar until every item passes.
 */

import * as fs from "node:fs";
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
	scaffoldVccSettings,
	shouldScheduleAutoContinue,
	type CompactionEntryLike,
	type PiPlansCompactionPhase,
	type PiPlansVccPhaseContext,
	type PiPlansVccSettings,
	type VccCompactionBuildResult,
	type VccCompactionStats,
} from "./compaction.ts";
import { getRun, readActive, resolveStateRootOrNull, setRunStatus, utcNow } from "./state.ts";
import { graphBlockForExecutor } from "./code-graph/prompts.ts";
import { resolveGraphMode } from "./code-graph/mode.ts";
import {
	extractCoverage,
	latestPlanVersion,
	resolveImplStatuses,
	scanDoneMarkers,
	scanImplMarkers,
	scanCurrentIMarkers,
	resolveCurrentI,
	inferCurrentI,
	type CheckItem,
	type ImplItem,
	type ImplMarkerState,
} from "./plan.ts";

export interface ExecState {
	planPath: string;
	items: CheckItem[];
	startedAt: string;
	usage: { inToks: number; outToks: number };
	implItems?: ImplItem[];
	implStatus?: Record<string, ImplMarkerState>;
	currentI?: string;
}

let execution: ExecState | null = null;

// Execution-loop persistence is deferred until the agent settles so turn_end
// never causes session writes during a streaming run.
let pendingExecutionFlush = false;

export function consumePendingExecutionFlush(): boolean {
	const pending = pendingExecutionFlush;
	pendingExecutionFlush = false;
	return pending;
}

function requestExecutionFlush(_pi: ExtensionAPI, _ctx: ExtensionContext): void {
	// Unconditional defer. turn_end fires mid-run in a gap between agent
	// operations where isIdle() reads true; persistence happens only at the
	// drain points: agent_settled, the next before_agent_start, and stop/complete.
	pendingExecutionFlush = true;
}

export function drainExecutionFlush(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!execution || !pendingExecutionFlush) return;
	pendingExecutionFlush = false;
	persist(pi);
	updateStatusWidget(ctx);
}

export function getExecution(): ExecState | null {
	return execution;
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
	/** Terminal failure metadata is retained for diagnostics, not proactive retry. */
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

export function computeExecutionProgress(execution: ExecState): { done: number; total: number } {
	const implItems = execution.implItems ?? [];
	if (implItems.length) {
		const statuses = resolveImplStatuses(implItems, execution.items, execution.implStatus);
		const counted = implItems.filter((impl) =>
			execution.items.some((item) => extractCoverage(item.text).includes(impl.id)),
		);
		const total = counted.length > 0 ? counted.length : implItems.length;
		const vcDone = counted.filter((impl) => statuses[impl.id] === "vc-passed").length;
		const currentIndex = execution.currentI
			? implItems.findIndex((impl) => impl.id === execution.currentI)
			: -1;
		return {
			done: Math.min(total, Math.max(vcDone, currentIndex < 0 ? 0 : currentIndex)),
			total,
		};
	}
	return {
		done: execution.items.filter((item) => item.done).length,
		total: execution.items.length,
	};
}

function formatElapsed(startedAt: string): string {
	const total = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
	const h = String(Math.floor(total / 3600)).padStart(2, "0");
	const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
	const sec = String(total % 60).padStart(2, "0");
	return `${h}:${m}:${sec}`;
}

function formatToks(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function formatExecutionStatusLine(execution: ExecState): string {
	const progress = computeExecutionProgress(execution);
	return `⌛ plans ${progress.done}/${progress.total}: spent ${formatElapsed(execution.startedAt)} · ${formatToks(execution.usage.inToks)} in-toks · ${formatToks(execution.usage.outToks)} out-toks`;
}

export function updateStatusWidget(ctx: ExtensionContext): void {
	if (execution) {
		const line = formatExecutionStatusLine(execution);
		ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("accent", line));
		return;
	}
	const active = readActive(ctx.cwd);
	if (active) {
		// Idle indicator depends on the run's lifecycle, not just its existence:
		// done reads as finished, abandoned as closed, stopped/accepted as paused.
		const status = getRun(ctx.cwd, active.run_id)?.status;
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
		if (status === "planning") {
			// Planning phase: 💬 while still in Q&A, 📝 once a PLAN draft exists
			// — kept until execution starts (then ⌛ takes over).
			const emoji = latestPlanVersion(active.artifact_dir) ? "📝" : "💬";
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("muted", `${emoji} plans: ${active.run_id}`));
			return;
		}
		// unknown status: no indicator.
	}
	ctx.ui.setStatus("pi-plans", undefined);
}

function persist(pi: ExtensionAPI): void {
	if (!execution) return;
	pi.appendEntry("pi-plans-exec", {
		planPath: execution.planPath,
		items: execution.items,
		startedAt: execution.startedAt,
		usage: execution.usage,
		implItems: execution.implItems,
		implStatus: execution.implStatus,
		currentI: execution.currentI,
	});
}

export async function startExecution(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	planPath: string,
	items: CheckItem[],
	implItems?: ImplItem[],
): Promise<void> {
	execution = { planPath, items, startedAt: utcNow(), usage: { inToks: 0, outToks: 0 }, implItems: implItems ?? [], implStatus: {} };
	pendingExecutionFlush = false; // fresh run: no inherited flush debt
	resetExecutionCompactionState(ctx);
	persist(pi);
	const active = readActive(ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "executing");
		} catch {
			/* status bookkeeping is best-effort */
		}
	}
	pi.sendMessage(
		{
			customType: "pi-plans-exec-start",
			content: `**pi-plans: executing** \`${planPath}\` — ${items.length} verifier item(s). Progress appears in the bottom status bar; mark verified items with \`[DONE:VC-xxx]\`.`,
			display: true,
		},
		{ triggerTurn: false },
	);
	updateStatusWidget(ctx);
}

/** Record one assistant turn: accumulate usage and mark any completed items. */
export function recordExecutionTurn(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	_completedIds: string[],
	usage?: { input: number; output: number },
): void {
	if (!execution) return;
	if (usage) {
		execution.usage.inToks += usage.input;
		execution.usage.outToks += usage.output;
	}
	requestExecutionFlush(pi, _ctx);
	updateStatusWidget(_ctx);
}

export function registerExecutionTurnHandlers(
	pi: ExtensionAPI,
	onTurnEnd?: (ctx: ExtensionContext) => Promise<void> | void,
): void {
	// The turn_end projection does not carry usage; message_end delivers the
	// full assistant message, so cache it here and consume it per turn.
	let lastAssistantUsage: { input: number; output: number } | null = null;
	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: { input?: number; output?: number } };
		if (message?.role === "assistant" && message.usage) {
			lastAssistantUsage = { input: message.usage.input ?? 0, output: message.usage.output ?? 0 };
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (!message || message.role !== "assistant") {
			updateStatusWidget(ctx);
			return;
		}
		const text = (message.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		const changedIds = applyDoneMarkers(text);
		const changedImpls = applyImplMarkers(text);
		const changedCurrentI = applyCurrentIMarker(text);
		const projection = (event.message as { usage?: { input?: number; output?: number } }).usage;
		const raw = projection ?? lastAssistantUsage;
		lastAssistantUsage = null; // consumed: never re-attribute a stale turn
		const usage = raw ? { input: raw.input ?? 0, output: raw.output ?? 0 } : undefined;
		if (usage || changedIds.length > 0 || changedImpls.length > 0 || changedCurrentI) {
			// Attribute this turn's usage now; `[DONE]` markers still only mark completion.
			recordExecutionTurn(pi, ctx, changedIds, usage);
		}
		if (getExecution() && isExecutionComplete()) {
			await completeExecution(pi, ctx);
		}
		await onTurnEnd?.(ctx);
	});
}

const EXECUTION_RESUME_CUSTOM_TYPE = "pi-plans-exec-resume";

function activeVccSettings(ctx: ExtensionContext, phase: PiPlansCompactionPhase): { settings: PiPlansVccSettings; runId: string; artifactDir: string } | null {
	const stateRoot = resolveStateRootOrNull(ctx.cwd);
	if (!stateRoot) return null;
	const active = readActive(ctx.cwd);
	if (!active) return null;
	const run = getRun(ctx.cwd, active.run_id);
	if (!run) return null;
	if (phase === "planning" && run.status !== "planning") return null;
	if (phase === "execution" && run.status !== "executing") return null;
	scaffoldVccSettings(stateRoot);
	return { settings: loadVccSettings(stateRoot), runId: run.run_id, artifactDir: run.artifact_dir };
}

function executionVccContext(): PiPlansVccPhaseContext {
	return {
		phase: "execution",
		planPath: execution?.planPath ?? null,
		currentI: execution?.currentI ?? null,
		remainingVerifierIds: execution?.items.filter((item) => !item.done).map((item) => item.id) ?? [],
		implementationIds: execution?.implItems?.map((item) => item.id) ?? [],
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
	pi: ExtensionAPI,
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
	requestExecutionFlush(pi, ctx);
	return { compaction: built.compaction };
}

function runtimePiVersion(ctx: ExtensionContext): unknown {
	return (ctx as ExtensionContext & { piVersion?: unknown }).piVersion ?? VERSION;
}

export async function handleExecutionCompact(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionCompactEvent): Promise<void> {
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
			await pi.sendUserMessage?.(followUpPrompt);
		} else if ((event.reason === "threshold" || event.reason === "overflow") && shouldScheduleAutoContinue(continueAfterThresholdCompact, runtimePiVersion(ctx))) {
			state.resumeGuard = true;
			pi.sendMessage(
				{
					customType: EXECUTION_RESUME_CUSTOM_TYPE,
					content: EXECUTION_COMPACTION_RESUME_MESSAGE,
					display: false,
				},
				{ triggerTurn: true },
			);
		}
	}
	requestExecutionFlush(pi, ctx);
	updateStatusWidget(ctx);
}


export function handleExecutionCompactFailed(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionCompactFailedEvent): void {
	if (!execution) return;
	const state = executionCompactionState(ctx);
	const terminal = isTerminalCompactionFailure(event);
	if (terminal) {
		// Pi refused or aborted the compaction. Hold the cooldown and re-arm
		// only after real growth or high-watermark pressure so the loop stops.
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
		requestExecutionFlush(pi, ctx);
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
	requestExecutionFlush(pi, ctx);
}

export function filterExecutionResumeMessages<T extends { customType?: string }>(messages: T[]): T[] {
	return messages.filter((message) => message.customType !== EXECUTION_RESUME_CUSTOM_TYPE);
}

// ---------------------------------------------------------------------------
// Planning-phase compaction: Pi core owns scheduling; this hook customizes
// active planning compact events with the same VCC builder used by execution.
// The two state machines are kept independent (different memory slot and
// snapshot key) so execution never bleeds into planning.
// ---------------------------------------------------------------------------

export const PLANNING_RUN_START_CUSTOM_TYPE = "pi-plans-run-start";
export const PLANNING_PLAN_WRITTEN_CUSTOM_TYPE = "pi-plans-plan-written";
const PLANNING_RESUME_CUSTOM_TYPE = "pi-plans-plan-resume";

interface PlanningCompactionState {
	inFlight: boolean;
	resumeGuard: boolean;
	cooldownActive: boolean;
	lastAttemptReason: "manual" | "threshold" | "overflow" | null;
	lastSuccessfulUsagePercent: number | null;
	lastSuccessfulAt: string | null;
	/** Terminal "nothing to compact" backoff: tokens observed when Pi refused. */
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
	// abort/stream class: explicit event names only, so that provider blips
	// (network down, etc.) stay retryable.
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
	// Aborted with no recognized message: still an abort-class terminal so the
	// next eligible turn does not immediately retry the same operation.
	if (event.aborted === true) {
		return { kind: "abort-stream" };
	}
	return null;
}

/** Session-scoped phase-local "compaction in flight" guard.
 *  - Set on `session_before_compact` for the phase attributed by the custom
 *    instructions hint; auto-compaction (no hint) marks both phases defensively.
 *  - Cleared on `session_compact` and `session_compact_failed`.
 *  - Retained so lifecycle events expose the same phase-local state to tests
 *    and future Pi core schema additions. */
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
		// Auto-compaction (threshold/overflow/manual without our hint) marks both.
		store.planning = true;
		store.execution = true;
	}
}

/** Pi core's `SessionCompactEvent` / `SessionCompactFailedEvent` do not carry
 *  `customInstructions` in any emission site, so the END side has no way to
 *  know which phase the compaction belonged to. Clearing both phases is the
 *  safe default — the per-phase start side (above) already encodes the hint
 *  attribution. The hint parameter is retained for API symmetry and future
 *  Pi core schema additions. */
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
	// Pi core owns scheduling; retained for lifecycle compatibility only.
}

export function requestPlanningCompaction(_ctx: ExtensionContext): void {
	// Proactive pi-plans compaction is intentionally disabled. Manual,
	// threshold, and overflow compactions are handled by session_before_compact.
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
	pi: ExtensionAPI,
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

export async function handlePlanningCompact(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionCompactEvent): Promise<void> {
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
			await pi.sendUserMessage?.(followUpPrompt);
		} else if ((event.reason === "threshold" || event.reason === "overflow") && shouldScheduleAutoContinue(continueAfterThresholdCompact, runtimePiVersion(ctx))) {
			state.resumeGuard = true;
			pi.sendMessage(
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


export function handlePlanningCompactFailed(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionCompactFailedEvent): void {
	if (getExecution()) return;
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = session.__planningCompaction;
	if (!state) return;
	const terminal = isTerminalCompactionFailure(event);
	if (terminal) {
		// Pi refused or aborted the compaction. Hold the cooldown and re-arm
		// only after real growth or high-watermark pressure so the loop stops.
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
	return messages.filter((message) => message.customType !== PLANNING_RESUME_CUSTOM_TYPE);
}

export async function stopExecution(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): Promise<void> {
	if (!execution) return;
	resetExecutionCompactionState(ctx);
	// Final synchronous write: drain any deferred flush and land the last snapshot.
	pendingExecutionFlush = false;
	persist(pi);
	execution = null;
	pi.appendEntry("pi-plans-exec-cleared", { reason });
	pi.sendMessage(
		{
			customType: "pi-plans-exec-stop",
			content: `**pi-plans: execution stopped** — ${reason}`,
			display: true,
		},
		{ triggerTurn: false },
	);
	const active = readActive(ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "stopped");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
}

/** Apply [DONE:VC-xxx] markers from an assistant message. Returns changed ids. */
export function applyDoneMarkers(text: string): string[] {
	if (!execution) return [];
	const changed: string[] = [];
	for (const id of scanDoneMarkers(text)) {
		const item = execution.items.find((candidate) => candidate.id === id && !candidate.done);
		if (item) {
			item.done = true;
			changed.push(id);
		}
	}
	return changed;
}

/**
 * Apply [I-xxx:implemented|validating] markers from an assistant message.
 * Unknown I-ids are silently ignored; later markers overwrite earlier ones.
 * Returns the ids whose state actually changed.
 */
export function applyImplMarkers(text: string): string[] {
	if (!execution?.implItems?.length) return [];
	const known = new Set(execution.implItems.map((impl) => impl.id));
	execution.implStatus ??= {};
	const changed: string[] = [];
	for (const marker of scanImplMarkers(text)) {
		if (!known.has(marker.id)) continue;
		const previous = execution.implStatus[marker.id];
		execution.implStatus[marker.id] = marker.state;
		if (previous !== marker.state) changed.push(marker.id);
	}
	return changed;
}

export function applyCurrentIMarker(text: string): boolean {
	if (!execution?.implItems?.length) return false;
	const markers = scanCurrentIMarkers(text);
	const resolved = resolveCurrentI(execution.implItems, markers, execution.currentI);
	if (!resolved || resolved === execution.currentI) return false;
	execution.currentI = resolved;
	return true;
}

export function isExecutionComplete(): boolean {
	return execution !== null && execution.items.length > 0 && execution.items.every((item) => item.done);
}

export async function completeExecution(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!execution) return;
	resetExecutionCompactionState(ctx);
	// Final synchronous write: drain any deferred flush and land the last snapshot.
	pendingExecutionFlush = false;
	persist(pi);

	const summary = execution.items.map((item) => `- ✅ \`${item.id}\` ${item.text.split(";")[0]}`).join("\n");
	const planPath = execution.planPath;
	execution = null;
	pi.appendEntry("pi-plans-exec-cleared", { reason: "complete" });
	// Post-execution goal-running continuation: in interactive sessions, attach
	// the continuation block and trigger a new turn so the agent immediately
	// enters the implementation-review loop. Headless sessions keep the silent
	// completion behavior. Both completeExecution call sites (turn_end and the
	// restoreFromSession recovery path) share this behavior.
	const interactive = ctx.hasUI === true;
	const content = interactive
		? `**Plan complete!** ✅ \`${planPath}\`\n\n${summary}\n\n${AMELIORATION_PROMPT_TEXT}`
		: `**Plan complete!** ✅ \`${planPath}\`\n\n${summary}`;
	pi.sendMessage(
		{
			customType: "pi-plans-complete",
			content,
			display: true,
		},
		{ triggerTurn: interactive },
	);
	if (interactive) {
		pi.appendEntry("pi-plans-ameliorate", { planPath, phase: "goal-started", rounds: null, currentRound: 0 });
	}
	const active = readActive(ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "done");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
}

/** Instructions appended to the post-execution completion message in
 * interactive sessions, telling the agent to enter the goal-running
 * implementation-review loop. */
export const AMELIORATION_PROMPT_TEXT = `---
Goal-running continuation: immediately ask the user now via ask_choice (autoComplete: false, in the session language) for the termination condition of the implementation-review loop: until no high-severity finding (hard cap 5 rounds, recommended) / 1 round / 2 rounds / 3 rounds. Then keep running the loop without asking whether to continue: each round calls refine (role: "reviewer", target: "implementation"), accepts findings on evidence, applies fixes, re-runs relevant tests, and repeats until the chosen termination condition or the 5-round cap.`;

/** Injection text for before_agent_start while executing. */
export function executionContextMessage(ctx: ExtensionContext): string | null {
	if (!execution) return null;
	const remaining = execution.items.filter((item) => !item.done);
	const list =
		remaining.map((item) => `- \`${item.id}\` ${item.text}`).join("\n") || "(none — report completion now)";
	// Live read: the injected guidance and the tool wrappers share the same
	// tri-state, so they can never contradict each other mid-run.
	const mode = resolveGraphMode(ctx?.cwd ?? process.cwd());
	const graphLine =
		mode === "config-unavailable"
			? `${graphBlockForExecutor(false)}\n[pi-plans: config unreadable this turn; graph features are off until .git/pi_plans/config.json is repaired]`
			: graphBlockForExecutor(mode === "enabled");
	const implementationItems = execution.implItems?.length
		? `\nImplementation items: ${execution.implItems.map((item) => item.id).join(", ")}${execution.currentI ? `\nCurrent implementation item: \`${execution.currentI}\`` : ""}\nWhen beginning an implementation item, emit its current anchor exactly once as \`[I-###:current]\`; then use \`[I-###:implemented]\` or \`[I-###:validating]\` for progress.`
		: "";
	return `[PI-PLANS EXECUTION — write access enabled]
Implement the accepted plan at ${execution.planPath} (${execution.items.length - remaining.length}/${execution.items.length} verifier items done).

Remaining verifier items:
${list}${implementationItems}

${graphLine}

Execution rules:
- Implement implementation items in dependency order; grow the change in layers — smallest end-to-end slice first, then stack each new capability on top of what already works.
- Report implementation-item progress with lightweight markers in your reply: write \`[I-001:implemented]\` when an item's code is done, \`[I-001:validating]\` when you start verifying it. The execution status bar tracks these states.
- For subprocess-backed verification, when a step starts a subprocess and needs its result before verifying, use literal \`waiting for\` with backoff \`5s -> 10s -> 20s -> 40s -> 80s\`, then keep polling at 80s; restart at 5s for each new subprocess.
- Simplest implementation that fully meets the item: no speculative abstractions, configuration, or indirection; keep components modular with clearly separated concerns.
- Architectural decisions are for the long term: no stopgaps. Do not add backward-compatibility layers, fallbacks, or migrations — remove the obsolete paths this change obsoletes.
- Prefer established, well-maintained libraries when they reduce complexity or improve reliability; before writing your own implementation or adding a package, check the project's existing dependencies (docs and types) — never reimplement common functionality without a clear reason.
- MINIMUM tests: trivial one-liners get no test; non-trivial logic gets exactly one minimal check; reuse the repo's test runner when one exists; when unsure, skip and emit \`[test skipped: <name>, add when <trigger>]\`.
- After verifying an item's pass condition with its stated evidence, include \`[DONE:VC-xxx]\` in your reply.
- When every item is done, report a completion summary.`;
}

interface SessionEntry {
	type: string;
	customType?: string;
	data?: ExecState;
	message?: { role: string; content: Array<{ type: string; text?: string }> };
}

/**
 * Rebuild execution state from the session on start/resume. Finds the last
 * pi-plans-exec snapshot, then re-scans assistant messages after it for
 * [DONE:VC-xxx] markers so progress survives restarts.
 */
export async function restoreFromSession(pi: ExtensionAPI, ctx: ExtensionContext, entries: SessionEntry[]): Promise<void> {
	pendingExecutionFlush = false; // no flush debt survives a restart
	resetExecutionCompactionState(ctx);
	let snapshotIndex = -1;
	let snapshot: ExecState | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "pi-plans-exec" && entry.data) {
			snapshot = entry.data;
			snapshotIndex = i;
			break;
		}
		if (entry.type === "custom" && entry.customType === "pi-plans-exec-cleared") {
			// Execution was explicitly stopped or completed after the last snapshot.
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
	// Ignore stale plans whose file vanished.
	if (!fs.existsSync(snapshot.planPath)) {
		execution = null;
		updateStatusWidget(ctx);
		return;
	}
	execution = {
		planPath: snapshot.planPath,
		items: snapshot.items.map((item) => ({ ...item })),
		startedAt: snapshot.startedAt,
		usage: snapshot.usage ?? { inToks: 0, outToks: 0 },
		implItems: snapshot.implItems ?? [],
		implStatus: { ...(snapshot.implStatus ?? {}) },
		currentI: snapshot.currentI ?? inferCurrentI(snapshot.implItems, snapshot.items, snapshot.implStatus),
	};
	for (let i = snapshotIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "pi-plans-exec-cleared") {
			execution = null;
			break;
		}
		const message = entry.message;
		if (message && message.role === "assistant") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			applyDoneMarkers(text);
			applyImplMarkers(text);
			applyCurrentIMarker(text);
		}
	}
	if (execution) {
		persist(pi); // refresh snapshot so the next resume has less to rescan
		if (isExecutionComplete()) {
			// Completed during the rescan: restore the planning model on the way out.
			await completeExecution(pi, ctx);
		}
	}
	updateStatusWidget(ctx);
}
