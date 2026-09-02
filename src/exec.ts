/**
 * Plan-execution loop: the tracked execution mode for accepted plans.
 *
 * When the user approves the execution handoff, the extension switches into
 * execution mode: every agent turn is injected with the remaining verifier
 * checklist, assistant messages are scanned for [DONE:VC-xxx] markers, and
 * progress is reported through the bottom status bar until every item passes.
 */

import { randomUUID } from "node:crypto";
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
import { AUTOCOMPLETE_ENTRY } from "./autocomplete.ts";
import {
	compactText as boundedCompactionText,
	compactionCurrentI,
	currentIExceedsTrigger,
	entryCurrentIMarkers,
	hasCompactableContent,
	extractReadRecords,
	formatReadRecord,
	mergeCompactionDetails,
	planIAwareCompaction,
	type CompactionDetailsLike,
	type CompactionEntryLike,
} from "./compaction.ts";
import { getRun, loadConfig, readActive, resolveStateRootOrNull, setRunStatus, utcNow } from "./state.ts";
import { graphBlockForExecutor } from "./code-graph/prompts.ts";
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
	graphEnabled?: boolean;
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

const EXECUTION_COMPACTION_TRIGGER_PERCENT = 20;
const EXECUTION_COMPACTION_REARM_PERCENT = 80;
const EXECUTION_COMPACTION_REARM_HIGH_PERCENT = 95;
/** Terminal "nothing to compact" backoff: re-arm only after the session has
 * grown past Pi's default keep-recent window (20k) or usage is nearly full. */
const TERMINAL_BACKOFF_GROWTH_TOKENS = 20_000;
const TERMINAL_BACKOFF_HIGH_PERCENT = 85;
const EXECUTION_COMPACTION_RESUME_MESSAGE = "Continue execution.";

interface ExecutionCompactionState {
	inFlight: boolean;
	resumeGuard: boolean;
	cooldownActive: boolean;
	lastAttemptReason: string | null;
	lastSuccessfulUsagePercent: number | null;
	lastSuccessfulAt: string | null;
	rearmPending: boolean;
	/** Terminal "nothing to compact" backoff: tokens observed when Pi refused. */
	terminalBackoffTokens: number | null;
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

function refreshExecutionCompactionCooldown(ctx: ExtensionContext): void {
	const state = executionCompactionState(ctx);
	if (!state) return;
	const percent = ctx.getContextUsage()?.percent ?? null;
	if (percent !== null && percent < EXECUTION_COMPACTION_REARM_PERCENT && state.cooldownActive) {
		state.cooldownActive = false;
		state.rearmPending = true;
	}
}

function executionCurrentIUsage(ctx: ExtensionContext): { tokens: number; contextWindow: number; eligible?: boolean } | null {
	const usage = ctx.getContextUsage();
	if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return null;
	const manager = ctx.sessionManager as unknown as { getBranch?: () => CompactionEntryLike[] };
	if (execution?.implItems?.length && typeof manager.getBranch === "function") {
		try {
			const entries = manager.getBranch();
			if (entries.length) {
				const plan = planIAwareCompaction({
					entries,
					currentI: execution.currentI,
					knownIIds: execution.implItems.map((item) => item.id),
					contextWindow: usage.contextWindow,
					tokensBefore: usage.tokens ?? undefined,
				});
				if (plan.currentI || execution.currentI) {
					return {
						tokens: plan.currentITokens,
						contextWindow: usage.contextWindow,
						eligible: plan.firstKeptEntryIndex !== null && plan.firstKeptEntryIndex > 0,
					};
				}
			}
		} catch {
			// A read-only session projection is optional in test and startup contexts.
		}
	}
	if (typeof usage.tokens !== "number") return null;
	return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}
export function shouldTriggerExecutionCompaction(ctx: ExtensionContext): boolean {
	const currentUsage = executionCurrentIUsage(ctx);
	if (!currentUsage || currentUsage.eligible === false || !currentIExceedsTrigger(currentUsage.tokens, currentUsage.contextWindow)) return false;
	if (!branchIsCompactable(ctx)) return false;
	const percent = (currentUsage.tokens / currentUsage.contextWindow) * 100;
	const state = executionCompactionState(ctx);
	if (!state) return true;
	if (state.inFlight || state.resumeGuard || state.cooldownActive) return false;
	if (terminalBackoffBlocks(state, currentUsage.tokens, currentUsage.contextWindow)) return false;
	if (state.rearmPending) {
		if (percent < EXECUTION_COMPACTION_REARM_HIGH_PERCENT) return false;
		state.rearmPending = false;
	}
	return true;
}

function requestExecutionCompaction(ctx: ExtensionContext): void {
	const state = ensureExecutionCompactionState(ctx);
	if (state.inFlight || state.resumeGuard) return;
	if (compactionInFlight(ctx, "execution")) return; // Pi core already running one; skip this turn
	if (agentIsBusy(ctx)) return; // never abort an in-flight turn; retry on the next turn_end
	const usage = ctx.getContextUsage();
	if (terminalBackoffBlocks(state, usage?.tokens, usage?.contextWindow)) return;
	state.inFlight = true;
	state.lastAttemptReason = "threshold";
	try {
		ctx.compact({ customInstructions: "pi-plans execution auto compact" });
	} catch (error) {
		state.inFlight = false;
		ctx.ui.notify(`pi-plans: could not request execution compaction (${String(error)}).`, "warning");
	}
}

export function handleExecutionTurnCompaction(ctx: ExtensionContext): void {
	refreshExecutionCompactionCooldown(ctx);
	if (consumeExecutionCompactionResumeGuard(ctx)) return;
	if (shouldTriggerExecutionCompaction(ctx)) {
		requestExecutionCompaction(ctx);
	}
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

export function executionProgress(): { done: number; total: number } | null {
	if (!execution) return null;
	return computeExecutionProgress(execution);
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
	let graphEnabled: boolean | undefined;
	const stateRoot = resolveStateRootOrNull(ctx.cwd);
	if (stateRoot) {
		try {
			graphEnabled = loadConfig(stateRoot).graph_enabled === true;
		} catch {
			graphEnabled = undefined;
		}
	}
	execution = { planPath, items, startedAt: utcNow(), usage: { inToks: 0, outToks: 0 }, implItems: implItems ?? [], implStatus: {}, graphEnabled };
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

type CompactBranchEntry = SessionBeforeCompactEvent["branchEntries"][number];
type CompactMessage = { role?: string; content?: Array<{ type: string; text?: string }> };

function compactText(text: string, limit = 180): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function messageText(message: CompactMessage | undefined): string {
	if (!message) return "";
	return (message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function messageRoleLabel(role?: string): string {
	switch (role) {
		case "assistant": return "Assistant";
		case "user": return "User";
		case "toolResult": return "Tool";
		case "custom": return "Custom";
		default: return role ? role : "Message";
	}
}

function isInternalExecutionCustomType(customType?: string): boolean {
	return customType === "pi-plans-exec"
		|| customType === "pi-plans-exec-cleared"
		|| customType === "pi-plans-exec-start"
		|| customType === "pi-plans-exec-context"
		|| customType === EXECUTION_RESUME_CUSTOM_TYPE;
}

function isSummarizableEntry(entry: CompactBranchEntry): boolean {
	return entry.type === "message" && !!entry.message;
}

function renderMessageLine(entry: CompactBranchEntry): string {
	if (!isSummarizableEntry(entry)) return "";
	const text = messageText(entry.message);
	if (!text) return "";
	return `- [${messageRoleLabel(entry.message?.role)}] ${compactText(text)}`;
}

function findExecutionCompactionCutEntryId(branchEntries: CompactBranchEntry[], fallback: string): string {
	const completionIds = new Set(execution?.items.filter((item) => item.done).map((item) => item.id) ?? []);
	let lastCompletionIndex = -1;
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i];
		if (!isSummarizableEntry(entry)) continue;
		const markers = scanDoneMarkers(messageText(entry.message));
		if (markers.some((marker) => completionIds.has(marker))) {
			lastCompletionIndex = i;
		}
	}
	if (lastCompletionIndex >= 0) {
		const next = branchEntries.slice(lastCompletionIndex + 1).find((entry) => entry.id && !isInternalExecutionCustomType(entry.customType));
		if (next?.id) return next.id;
	}
	const startIndex = branchEntries.findIndex((entry) => entry.type === "custom" && entry.customType === "pi-plans-exec-start");
	if (startIndex >= 0) {
		const next = branchEntries.slice(startIndex + 1).find((entry) => entry.id && !isInternalExecutionCustomType(entry.customType));
		if (next?.id) return next.id;
	}
	return fallback;
}

function buildFinishedItemSections(summaryEntries: CompactBranchEntry[]): string[] {
	if (!execution) return [];
	const completedItems = execution.items.filter((item) => item.done);
	const sections: string[] = [];
	let completedIndex = 0;
	let currentLines: string[] = [];
	for (const entry of summaryEntries) {
		if (!isSummarizableEntry(entry)) continue;
		const line = renderMessageLine(entry);
		if (line) currentLines.push(line);
		for (const marker of scanDoneMarkers(messageText(entry.message))) {
			const itemIndex = completedItems.findIndex((item, index) => index >= completedIndex && item.id === marker);
			if (itemIndex < 0) continue;
			const item = completedItems[itemIndex];
			sections.push(`### \`${item.id}\` ${item.text.split(";")[0]}
${currentLines.length ? currentLines.join("\n") : "- (no transcript captured)"}`);
			currentLines = [];
			completedIndex = itemIndex + 1;
		}
	}
	return sections;
}

function splitTurnBoundaryIndex(event: SessionBeforeCompactEvent): number | undefined {
	if (!event.preparation.isSplitTurn) return undefined;
	const index = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
	return index >= 0 ? index : undefined;
}

function buildExecutionIPlan(event: SessionBeforeCompactEvent, ctx?: ExtensionContext): ReturnType<typeof planIAwareCompaction> {
	if (!execution) throw new Error("execution state is unavailable");
	const usage = eventPreparationUsage(event, ctx);
	return planIAwareCompaction({
		entries: event.branchEntries as unknown as CompactionEntryLike[],
		currentI: execution.currentI,
		knownIIds: execution.implItems?.map((item) => item.id),
		contextWindow: usage.contextWindow,
		tokensBefore: event.preparation.tokensBefore,
		fallbackFirstKeptEntryId: event.preparation.firstKeptEntryId,
		maxFirstKeptEntryIndex: splitTurnBoundaryIndex(event),
	});
}

function eventPreparationUsage(event: SessionBeforeCompactEvent, ctx?: ExtensionContext): { contextWindow: number | null } {
	const fromContext = ctx?.getContextUsage()?.contextWindow;
	const contextWindow = (event as SessionBeforeCompactEvent & { contextWindow?: number }).contextWindow ?? fromContext;
	return { contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null };
}

function previousCompactionDetails(entries: CompactionEntryLike[]): CompactionDetailsLike | undefined {
	let merged: CompactionDetailsLike | undefined;
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		const raw = entry.details ?? entry.data;
		if (!raw || typeof raw !== "object") continue;
		const details = raw as CompactionDetailsLike;
		if (!details.readRecords && !details.metrics && !details.iSections) continue;
		merged = mergeCompactionDetails(merged, details);
	}
	return merged;
}

function buildImplementationSections(plan: ReturnType<typeof planIAwareCompaction>): string[] {
	const sections: string[] = [];
	for (const slice of plan.slices) {
		if (slice.id === null) continue;
		const lines = slice.entries
			.filter((entry) => plan.summaryEntries.includes(entry))
			.map((entry) => renderMessageLine(entry as CompactBranchEntry))
			.filter(Boolean);
		if (lines.length) {
			sections.push(`### ${slice.current ? "Current I" : "Implementation I"} \`${slice.id}\`\n${lines.join("\\n")}`);
		}
	}
	return sections;
}

function executionSummaryParts(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	firstKeptEntryId: string,
	boundaryIndex: number,
	plan: ReturnType<typeof planIAwareCompaction> | null,
): { parts: string[]; details: CompactionDetailsLike } {
	if (!execution) return { parts: [], details: {} };
	const active = readActive(ctx.cwd);
	const run = active ? getRun(ctx.cwd, active.run_id) : null;
	const branchEntries = event.branchEntries as unknown as CompactionEntryLike[];
	const summaryEntries = boundaryIndex >= 0
		? (branchEntries.slice(0, boundaryIndex) as CompactBranchEntry[])
		: (branchEntries as CompactBranchEntry[]);
	const sections = buildFinishedItemSections(summaryEntries);
	const readRecords = plan?.readRecords ?? extractReadRecords(summaryEntries as unknown as CompactionEntryLike[]);
	const priorDetails = previousCompactionDetails(branchEntries);
	const metrics = plan?.metrics ?? {
		contextWindow: ctx.getContextUsage()?.contextWindow ?? null,
		tokensBefore: event.preparation.tokensBefore,
		currentITokens: 0,
		summaryTokens: 0,
		keptSuffixTokens: 0,
		estimatedAfterTokens: null,
		targetRatio: 0.1,
		currentI: execution.currentI ?? null,
		firstKeptEntryId,
		targetMet: false,
		hardFloorReason: "I-aware budget unavailable for this legacy execution snapshot",
	};
	const details = mergeCompactionDetails(priorDetails, {
		kind: "pi-plans-execution-compaction",
		version: 1,
		currentI: execution.currentI ?? plan?.currentI ?? null,
		iSections: plan?.slices.map((slice) => ({ id: slice.id, entryIds: slice.entries.map((entry) => entry.id).filter((id): id is string => !!id) })) ?? [],
		readRecords,
		metrics: { ...metrics, firstKeptEntryId },
		reason: event.reason,
		willRetry: event.willRetry,
		finishedItems: execution.items.filter((item) => item.done).map((item) => item.id),
	});
	const parts: string[] = [];
	if (event.customInstructions?.trim()) {
		parts.push(`## Compact Instructions\n${compactText(event.customInstructions, 1000)}`);
	}
	parts.push(`## Plan Before This Run\n- Request: ${compactText(run?.request_text ?? execution.planPath, 280)}\n- Plan file: \`${execution.planPath}\``);
	if (event.preparation.previousSummary?.trim()) {
		parts.push(`## Previous Compact Summary\n${event.preparation.previousSummary.trim()}`);
	}
	parts.push(`## Implementation Items\n${plan?.slices.length ? (buildImplementationSections(plan).join("\\n\\n") || "- (no I transcript captured)") : "- Legacy snapshot: current I is inferred from the execution frontier."}`);
	parts.push(`## Finished VC Items\n${sections.length ? sections.join("\\n\\n") : "- (none yet)"}`);
	parts.push(`## Current I\n- \`${execution.currentI ?? plan?.currentI ?? "unknown"}\`\n- Recent legal suffix begins at \`${firstKeptEntryId}\`.`);
	parts.push(`## Read Records\n${readRecords.length ? readRecords.map((record) => formatReadRecord(record)).join("\\n") : "- (none)"}`);
	parts.push(`## Compaction Boundary\n- firstKeptEntryId: \`${firstKeptEntryId}\`\n- currentI: \`${execution.currentI ?? plan?.currentI ?? "unknown"}\`\n- tokensBefore: ${metrics.tokensBefore}\n- estimatedAfterTokens: ${metrics.estimatedAfterTokens ?? "unknown"}\n- targetRatio: ${metrics.targetRatio}\n- targetMet: ${metrics.targetMet}\n- hardFloorReason: ${metrics.hardFloorReason ?? "none"}`);
	parts.push(`## Current Work\n- Raw tail preserved from \`${firstKeptEntryId}\` onward.${event.preparation.isSplitTurn ? "\\n- Split-turn prefix remains in the kept tail." : ""}`);
	return { parts, details };
}

export function buildExecutionCompactionResult(event: SessionBeforeCompactEvent, ctx: ExtensionContext): CompactionResult | null {
	if (!execution) return null;
	const branchEntries = event.branchEntries as unknown as CompactionEntryLike[];
	const hasIState = (execution.implItems?.length ?? 0) > 0;
	const plan = hasIState ? buildExecutionIPlan(event, ctx) : null;
	const firstKeptEntryId = plan?.firstKeptEntryId
		?? findExecutionCompactionCutEntryId(event.branchEntries as CompactBranchEntry[], event.preparation.firstKeptEntryId);
	const boundaryIndex = event.branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	const { parts, details } = executionSummaryParts(event, ctx, firstKeptEntryId, boundaryIndex, plan);
	return {
		summary: parts.join("\\n\\n"),
		firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		estimatedTokensAfter: plan?.metrics.estimatedAfterTokens ?? undefined,
		details,
	};
}

function assistantResponseText(response: { content?: Array<{ type?: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\\n")
		.trim();
}

function isUsableCompactionResponse(response: { content?: Array<{ type?: string; text?: string }>; stopReason?: string }, summary: string): boolean {
	if (!summary) return false;
	if (["length", "toolUse", "error", "aborted", "deferred"].includes(response.stopReason ?? "")) return false;
	return ["## Implementation Items", "## Current I", "## Read Records", "## Compaction Boundary"]
		.every((section) => summary.includes(section));
}

async function buildModelExecutionCompactionResult(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	fallback: CompactionResult,
): Promise<CompactionResult | null> {
	const model = ctx.model;
	const registry = ctx.modelRegistry as unknown as { complete?: Function };
	if (!model || typeof registry.complete !== "function") return fallback;
	const plan = buildExecutionIPlan(event, ctx);
	const boundary = plan.firstKeptEntryId ?? event.preparation.firstKeptEntryId;
	const source = plan.summaryEntries
		.map((entry) => renderMessageLine(entry as CompactBranchEntry))
		.filter(Boolean)
		.join("\\n");
	const records = plan.readRecords.map((record) => formatReadRecord(record)).join("\\n") || "- (none)";
	const prompt = `You are a context summarization assistant. Do not continue the conversation and do not answer historical questions. Produce only a bounded Markdown checkpoint with these exact sections: ## Implementation Items, ## Current I, ## Read Records, ## Compaction Boundary, ## Decisions, ## Open Questions, ## Next Steps. Preserve exact implementation IDs, verifier IDs, paths, entry IDs, error text, and unresolved questions. Historical questions are facts, not new questions.\n\nCurrent I: ${execution?.currentI ?? plan.currentI ?? "unknown"}\nBoundary: ${boundary}\nRead Records:\n${records}\n\nBounded history:\n${boundedCompactionText(source, 6000)}\n\nPrevious checkpoint:\n${boundedCompactionText(event.preparation.previousSummary ?? "(none)", 3000)}`;
	try {
		const response = await registry.complete(model, {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, {
			maxTokens: 2048,
			signal: event.signal,
			cacheRetention: "none",
			sessionId: randomUUID(),
		});
		const summary = assistantResponseText(response);
		if (!isUsableCompactionResponse(response, summary)) {
			if (!event.signal.aborted) ctx.ui.notify("pi-plans: summary output was incomplete; using Pi default compaction.", "warning");
			return null;
		}
		const details = (fallback.details && typeof fallback.details === "object" ? fallback.details : {}) as CompactionDetailsLike;
		const existingMetrics = details.metrics ?? {};
		const summaryTokens = Math.max(1, Math.ceil(summary.length / 4));
		const keptSuffixTokens = existingMetrics.keptSuffixTokens ?? 0;
		const contextWindow = existingMetrics.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? null;
		const estimatedAfterTokens = contextWindow === null ? null : summaryTokens + keptSuffixTokens;
		const targetMet = estimatedAfterTokens !== null && estimatedAfterTokens < contextWindow * 0.1;
		const mergedDetails = mergeCompactionDetails(details, {
			...details,
			metrics: {
				...existingMetrics,
				summaryTokens,
				estimatedAfterTokens,
				targetMet,
				hardFloorReason: targetMet ? null : existingMetrics.hardFloorReason ?? "summary or retained context exceeds the 10% target",
			},
		});
		return { ...fallback, summary, estimatedTokensAfter: estimatedAfterTokens ?? undefined, usage: response.usage, details: mergedDetails };
	} catch (error) {
		if (!event.signal.aborted) ctx.ui.notify(`pi-plans: summary model failed; using Pi default compaction (${String(error)}).`, "warning");
		return null;
	}
}

function notifyHardFloor(ctx: ExtensionContext, compaction: CompactionResult): void {
	const metrics = (compaction.details as CompactionDetailsLike | undefined)?.metrics;
	if (!metrics || metrics.targetMet !== false) return;
	ctx.ui.notify(
		`pi-plans: compaction target <10% is unreachable; retaining the legal floor (${metrics.hardFloorReason ?? "unknown reason"}).`,
		"warning",
	);
}

export function handleExecutionBeforeCompact(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
): SessionBeforeCompactResult | Promise<SessionBeforeCompactResult | undefined> | undefined {
	if (!execution) return undefined;
	let fallback: CompactionResult | null;
	try {
		fallback = buildExecutionCompactionResult(event, ctx);
	} catch (error) {
		const state = executionCompactionState(ctx);
		if (state) state.inFlight = false;
		ctx.ui.notify(`pi-plans: compaction preparation failed; using Pi default compaction (${String(error)}).`, "warning");
		return undefined;
	}
	if (!fallback) return undefined;
	notifyHardFloor(ctx, fallback);
	const registry = ctx.modelRegistry as unknown as { complete?: Function };
	if (!ctx.model || typeof registry.complete !== "function") {
		requestExecutionFlush(pi, ctx);
		return { compaction: fallback };
	}
	return buildModelExecutionCompactionResult(event, ctx, fallback).then((compaction) => {
		if (!compaction) return undefined;
		requestExecutionFlush(pi, ctx);
		return { compaction };
	});
}

export function handleExecutionCompact(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionCompactEvent): void {
	if (!execution) return;
	const state = ensureExecutionCompactionState(ctx);
	state.inFlight = false;
	state.lastAttemptReason = event.reason;
	state.cooldownActive = true;
	state.rearmPending = false;
	state.terminalBackoffTokens = null;
	state.lastSuccessfulAt = utcNow();
	state.lastSuccessfulUsagePercent = ctx.getContextUsage()?.percent ?? state.lastSuccessfulUsagePercent;
	if (!event.willRetry) {
		state.resumeGuard = true;
		pi.sendMessage(
			{
				customType: EXECUTION_RESUME_CUSTOM_TYPE,
				content: EXECUTION_COMPACTION_RESUME_MESSAGE,
				display: false,
			},
			{ triggerTurn: true },
		);
	} else {
		state.resumeGuard = false;
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
// Planning-phase auto compaction: same trigger rules and resume pattern as
// the execution side, but with a different cut-point algorithm and summary
// shape. The two state machines are kept independent (different memory slot
// and snapshot key) so execution never bleeds into planning.
// ---------------------------------------------------------------------------

export const PLANNING_RUN_START_CUSTOM_TYPE = "pi-plans-run-start";
export const PLANNING_PLAN_WRITTEN_CUSTOM_TYPE = "pi-plans-plan-written";
const PLANNING_QA_SECTION_HEADER = "## Q&A During Planning";
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
}

/** Shared helpers for both compaction phases. */
function agentIsBusy(ctx: ExtensionContext): boolean {
	const host = ctx as unknown as { isIdle?: () => boolean; hasPendingMessages?: () => boolean };
	try {
		if (typeof host.hasPendingMessages === "function" && host.hasPendingMessages()) return true;
		if (typeof host.isIdle === "function" && !host.isIdle()) return true;
	} catch {
		// Host projection unavailable: treat as idle to preserve prior behavior.
	}
	return false;
}

function sessionBranchEntries(ctx: ExtensionContext): CompactionEntryLike[] | null {
	const manager = ctx.sessionManager as unknown as { getBranch?: () => unknown };
	if (typeof manager.getBranch !== "function") return null;
	try {
		const entries = manager.getBranch() as CompactionEntryLike[];
		return Array.isArray(entries) ? entries : null;
	} catch {
		return null;
	}
}

function branchIsCompactable(ctx: ExtensionContext): boolean {
	const entries = sessionBranchEntries(ctx);
	if (!entries) return true; // conservative: let Pi decide, backoff absorbs a rejection
	return hasCompactableContent(entries);
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

/** True while the terminal "nothing to compact" backoff is still active.
 * Releases (and clears) the anchor once the session grew past Pi's keep-recent
 * window or usage reached the high watermark. Shared by the shouldTrigger
 * gate and the request functions so a direct request cannot bypass it. */
function terminalBackoffBlocks(
	state: { terminalBackoffTokens: number | null },
	tokens?: number,
	contextWindow?: number,
): boolean {
	if (state.terminalBackoffTokens === null) return false;
	const grown = typeof tokens === "number" ? tokens - state.terminalBackoffTokens : Number.NEGATIVE_INFINITY;
	const percent = typeof tokens === "number" && typeof contextWindow === "number" && contextWindow > 0
		? (tokens / contextWindow) * 100
		: 0;
	if (grown >= TERMINAL_BACKOFF_GROWTH_TOKENS || percent >= TERMINAL_BACKOFF_HIGH_PERCENT) {
		state.terminalBackoffTokens = null;
		return false;
	}
	return true;
}

/** Session-scoped phase-local "compaction in flight" guard.
 *  - Set on `session_before_compact` for the phase attributed by the custom
 *    instructions hint; auto-compaction (no hint) marks both phases defensively.
 *  - Cleared on `session_compact` and `session_compact_failed`.
 *  - Read by `requestPlanningCompaction` / `requestExecutionCompaction` to skip
 *    a manual compact while Pi core is already running one. */
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

interface PlanningBranchEntry {
	id?: string;
	type?: string;
	customType?: string;
	data?: { planPath?: string; runId?: string; artifactDir?: string };
	message?: { role?: string; content?: Array<{ type: string; text?: string }> };
}

function isPlanningInternalCustomType(customType?: string): boolean {
	return (
		customType === "pi-plans-exec"
		|| customType === "pi-plans-exec-cleared"
		|| customType === "pi-plans-exec-start"
		|| customType === "pi-plans-exec-context"
		|| customType === EXECUTION_RESUME_CUSTOM_TYPE
		|| customType === PLANNING_RUN_START_CUSTOM_TYPE
		|| customType === PLANNING_PLAN_WRITTEN_CUSTOM_TYPE
		|| customType === PLANNING_RESUME_CUSTOM_TYPE
		|| customType === AUTOCOMPLETE_ENTRY
	);
}

function summarizePlanningEntryText(entry: PlanningBranchEntry): string {
	return (entry.message?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function summarizePlanningEntryLine(entry: PlanningBranchEntry): string | null {
	return summarizePlanningMessageLine(entry);
}

function summarizePlanningMessageLine(entry: PlanningBranchEntry): string | null {
	if (!entry.message) return null;
	const text = (entry.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
	if (!text) return null;
	const role = entry.message.role ?? "message";
	const normalized = text.replace(/\s+/g, " ").trim();
	const limit = 180;
	const clipped = normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
	return `- [${role}] ${clipped}`;
}

function findPlanningCutEntryId(
	branchEntries: PlanningBranchEntry[],
	fallback: string,
): { id: string; qaWindowEntries: PlanningBranchEntry[]; hasMarker: boolean } {
	const planWrittenIndexes: number[] = [];
	const runStartIndexes: number[] = [];
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i];
		if (entry.type === "custom" && entry.customType === PLANNING_PLAN_WRITTEN_CUSTOM_TYPE) {
			planWrittenIndexes.push(i);
		} else if (entry.type === "custom" && entry.customType === PLANNING_RUN_START_CUSTOM_TYPE) {
			runStartIndexes.push(i);
		}
	}
	const planIndex = planWrittenIndexes[planWrittenIndexes.length - 1] ?? -1;
	const startIndex = runStartIndexes[runStartIndexes.length - 1] ?? -1;
	const anchorIndex = planIndex >= 0 ? planIndex : startIndex;
	if (anchorIndex < 0) {
		return { id: fallback, qaWindowEntries: [], hasMarker: false };
	}
	const next = branchEntries
		.slice(anchorIndex + 1)
		.find((entry) => entry.id && !isPlanningInternalCustomType(entry.customType));
	if (!next?.id) {
		return { id: fallback, qaWindowEntries: [], hasMarker: true };
	}
	const qaWindowEntries = branchEntries
		.slice(startIndex >= 0 ? startIndex + 1 : 0, anchorIndex)
		.filter((entry) => entry.type === "message" && entry.message);
	return { id: next.id, qaWindowEntries, hasMarker: true };
}

function buildPlanningQASection(qaWindowEntries: PlanningBranchEntry[]): string | null {
	if (!qaWindowEntries.length) return null;
	const lines: string[] = [];
	for (const entry of qaWindowEntries) {
		const line = summarizePlanningMessageLine(entry);
		if (line) lines.push(line);
	}
	if (!lines.length) return null;
	return `${PLANNING_QA_SECTION_HEADER}
${lines.join("\n")}`;
}

function resolvePlanningCompactionContext(workdir: string): { runId: string; artifactDir: string } | null {
	const active = readActive(workdir);
	if (!active) return null;
	const run = getRun(workdir, active.run_id);
	if (!run || run.status !== "planning") return null;
	return { runId: run.run_id, artifactDir: run.artifact_dir };
}

function planningCurrentIUsage(ctx: ExtensionContext): { tokens: number; contextWindow: number; eligible?: boolean } | null {
	const usage = ctx.getContextUsage();
	if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return null;
	const manager = ctx.sessionManager as unknown as { getBranch?: () => CompactionEntryLike[] };
	if (typeof manager.getBranch === "function") {
		try {
			const entries = manager.getBranch();
			const currentI = entries.flatMap((entry) => entryCurrentIMarkers(entry)).at(-1)
				?? entries.map((entry) => compactionCurrentI(entry)).filter((id): id is string => !!id).at(-1);
			if (currentI) {
				const plan = planIAwareCompaction({
					entries,
					currentI,
					contextWindow: usage.contextWindow,
					tokensBefore: usage.tokens ?? undefined,
				});
				return {
					tokens: plan.currentITokens,
					contextWindow: usage.contextWindow,
					eligible: plan.firstKeptEntryIndex !== null && plan.firstKeptEntryIndex > 0,
				};
			}
		} catch {
			// Session projection is unavailable during startup in some hosts.
		}
	}
	if (typeof usage.tokens !== "number") return null;
	return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}
export function shouldTriggerPlanningCompaction(ctx: ExtensionContext): boolean {
	if (getExecution()) return false;
	const ctxWorkdir = ctx.cwd;
	if (!resolvePlanningCompactionContext(ctxWorkdir)) return false;
	const currentUsage = planningCurrentIUsage(ctx);
	if (!currentUsage || currentUsage.eligible === false || !currentIExceedsTrigger(currentUsage.tokens, currentUsage.contextWindow)) return false;
	if (!branchIsCompactable(ctx)) return false;
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = session.__planningCompaction;
	if (!state) return true;
	if (state.inFlight || state.resumeGuard || state.cooldownActive) return false;
	if (terminalBackoffBlocks(state, currentUsage.tokens, currentUsage.contextWindow)) return false;
	return true;
}

export function consumePlanningCompactionResumeGuard(ctx: ExtensionContext): boolean {
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	if (!session.__planningCompaction?.resumeGuard) return false;
	session.__planningCompaction.resumeGuard = false;
	return true;
}

export function refreshPlanningCompactionCooldown(ctx: ExtensionContext): void {
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = session.__planningCompaction;
	if (!state) return;
	const percent = ctx.getContextUsage()?.percent ?? null;
	if (percent !== null && percent < 85 && state.cooldownActive) {
		state.cooldownActive = false;
	}
}

export function requestPlanningCompaction(ctx: ExtensionContext): void {
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = (session.__planningCompaction ??= {
		inFlight: false,
		resumeGuard: false,
		cooldownActive: false,
		lastAttemptReason: null,
		lastSuccessfulUsagePercent: null,
		lastSuccessfulAt: null,
		terminalBackoffTokens: null,
	} satisfies PlanningCompactionState);
	if (state.inFlight || state.resumeGuard) return;
	if (compactionInFlight(ctx, "planning")) return; // Pi core already running one; skip this turn
	if (agentIsBusy(ctx)) return; // never abort an in-flight turn; retry on the next turn_end
	const usage = ctx.getContextUsage();
	if (terminalBackoffBlocks(state, usage?.tokens, usage?.contextWindow)) return;
	state.inFlight = true;
	state.lastAttemptReason = "threshold";
	try {
		ctx.compact({ customInstructions: "pi-plans planning auto compact" });
	} catch (error) {
		state.inFlight = false;
		ctx.ui.notify(`pi-plans: could not request planning compaction (${String(error)}).`, "warning");
	}
}

export function buildPlanningCompactionResult(event: SessionBeforeCompactEvent, ctx: ExtensionContext): CompactionResult | null {
	const ctxWorkdir = ctx.cwd;
	const planningCtx = resolvePlanningCompactionContext(ctxWorkdir);
	if (!planningCtx) return null;
	const branchEntries = event.branchEntries as unknown as PlanningBranchEntry[];
	const legacyCut = findPlanningCutEntryId(branchEntries, event.preparation.firstKeptEntryId);
	const markerIds = branchEntries.flatMap((entry) => scanCurrentIMarkers(summarizePlanningEntryText(entry)));
	const currentI = markerIds.at(-1)?.id
		?? branchEntries.map((entry) => compactionCurrentI(entry)).filter((id): id is string => !!id).at(-1)
		?? null;
	const iPlan = currentI
		? planIAwareCompaction({
			entries: branchEntries as unknown as CompactionEntryLike[],
			currentI,
			contextWindow: eventPreparationUsage(event, ctx).contextWindow,
			tokensBefore: event.preparation.tokensBefore,
			fallbackFirstKeptEntryId: event.preparation.firstKeptEntryId,
			maxFirstKeptEntryIndex: splitTurnBoundaryIndex(event),
		})
		: null;
	const firstKeptEntryId = iPlan?.firstKeptEntryId ?? legacyCut.id;
	const qaSection = legacyCut.hasMarker ? buildPlanningQASection(legacyCut.qaWindowEntries) : null;
	const boundaryIndex = event.branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	const summaryEntries = boundaryIndex >= 0 ? branchEntries.slice(0, boundaryIndex) : branchEntries;
	const readRecords = iPlan?.readRecords ?? extractReadRecords(summaryEntries as unknown as CompactionEntryLike[]);
	const parts: string[] = [];
	if (event.customInstructions?.trim()) {
		parts.push(`## Compact Instructions
${compactText(event.customInstructions, 1000)}`);
	}
	if (qaSection) {
		parts.push(qaSection);
	}
	const previousSummary = event.preparation.previousSummary?.trim();
	parts.push(`## Goal
${compactText(planningCtx.runId, 80)} — keep current planning progress.`);
	parts.push(`## Constraints & Preferences
- Stay in the active planning run (\`${planningCtx.runId}\`).
- Plan files live under \`${planningCtx.artifactDir}\`.`);
	parts.push(`## Progress
### Done
- Pre-plan history compressed below.

### In Progress
- Current planning question or open decision.

### Blocked
- ${legacyCut.hasMarker ? "None" : "Planning cut-point marker missing; falling back to default."}`);
	if (iPlan) {
		const iSections = iPlan.slices
			.map((slice) => {
				const lines = slice.entries.filter((entry) => iPlan.summaryEntries.includes(entry)).map((entry) => summarizePlanningEntryLine(entry)).filter(Boolean);
				return slice.id && lines.length ? `### ${slice.current ? "Current I" : "Implementation I"} \`${slice.id}\`\n${lines.join("\\n")}` : "";
			})
			.filter(Boolean);
		parts.push(`## Current I\n- \`${currentI}\`\n${iSections.join("\\n\\n") || "- Current I transcript is in the retained suffix."}`);
		parts.push(`## Read Records\n${readRecords.length ? readRecords.map((record) => formatReadRecord(record)).join("\\n") : "- (none)"}`);
		parts.push(`## Compaction Boundary\n- firstKeptEntryId: \`${firstKeptEntryId}\`\n- currentI: \`${currentI}\`\n- targetMet: ${iPlan.metrics.targetMet}\n- hardFloorReason: ${iPlan.metrics.hardFloorReason ?? "none"}`);
	}
	if (previousSummary) {
		parts.push(`## Previous Compact Summary\n${previousSummary}`);
	}
	parts.push(`## Next Steps
- Resume the active planning turn from the raw tail.`);
	const priorDetails = previousCompactionDetails(branchEntries as unknown as CompactionEntryLike[]);
	const details = mergeCompactionDetails(priorDetails, {
		kind: "pi-plans-planning-compaction",
		version: 1,
		currentI,
		iSections: iPlan?.slices.map((slice) => ({ id: slice.id, entryIds: slice.entries.map((entry) => entry.id).filter((id): id is string => !!id) })),
		readRecords,
		metrics: iPlan?.metrics,
		reason: event.reason,
		hasMarker: legacyCut.hasMarker,
	});
	return {
		summary: parts.join("\n\n"),
		firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		estimatedTokensAfter: iPlan?.metrics.estimatedAfterTokens ?? undefined,
		details,
	};
}

export function handlePlanningBeforeCompact(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
): SessionBeforeCompactResult | undefined {
	if (getExecution()) return undefined;
	if (!resolvePlanningCompactionContext(ctx.cwd)) return undefined;
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = (session.__planningCompaction ??= {
		inFlight: false,
		resumeGuard: false,
		cooldownActive: false,
		lastAttemptReason: null,
		lastSuccessfulUsagePercent: null,
		lastSuccessfulAt: null,
		terminalBackoffTokens: null,
	} satisfies PlanningCompactionState);
	const percent = ctx.getContextUsage()?.percent ?? null;
	if (event.reason === "threshold" && (percent === null || percent < 100)) {
		state.inFlight = false;
		state.lastAttemptReason = event.reason;
		return { cancel: true };
	}
	state.inFlight = true;
	state.lastAttemptReason = event.reason;
	if (percent !== null && percent < 85) {
		state.cooldownActive = false;
	}
	let compaction: CompactionResult | null;
	try {
		compaction = buildPlanningCompactionResult(event, ctx);
	} catch (error) {
		state.inFlight = false;
		ctx.ui.notify(`pi-plans: planning compaction preparation failed; using Pi default compaction (${String(error)}).`, "warning");
		return undefined;
	}
	if (!compaction) {
		state.inFlight = false;
		return undefined;
	}
	notifyHardFloor(ctx, compaction);
	return { compaction };
}

export function handlePlanningCompact(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionCompactEvent): void {
	if (getExecution()) return;
	const session = ctx.sessionManager as unknown as { __planningCompaction?: PlanningCompactionState };
	const state = session.__planningCompaction;
	if (!state) return;
	state.inFlight = false;
	state.lastAttemptReason = event.reason;
	state.terminalBackoffTokens = null;
	state.cooldownActive = true;
	state.lastSuccessfulAt = utcNow();
	state.lastSuccessfulUsagePercent = ctx.getContextUsage()?.percent ?? state.lastSuccessfulUsagePercent;
	if (!event.willRetry) {
		state.resumeGuard = true;
		pi.sendMessage(
			{
				customType: PLANNING_RESUME_CUSTOM_TYPE,
				content: "Continue planning.",
				display: false,
			},
			{ triggerTurn: true },
		);
	} else {
		state.resumeGuard = false;
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
	// Post-execution amelioration prompt: in interactive sessions, attach the
	// amelioration instruction block and trigger a new turn so the agent can
	// ask the user via ask_choice. Headless sessions keep the silent-completion
	// behavior. Both completeExecution call sites (turn_end and the
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
		pi.appendEntry("pi-plans-ameliorate", { planPath, phase: "prompted", rounds: null, currentRound: 0 });
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
 * interactive sessions, asking the agent to invite the user into a Reviewer /
 * Criticizer / Auto-refine loop run on the implementation result. */
export const AMELIORATION_PROMPT_TEXT = `---
Post-execution amelioration: ask the user now via ask_choice (autoComplete: false, trailing: "auto-refine-loop", in the session language): "Run a post-execution amelioration round on the implementation?" Options (recommended first): 1. Run one Reviewer round (target: "implementation") and fix high/medium findings, re-running relevant tests 2. Run one Criticizer round (target: "implementation") and answer its questions with the user first 3. Finish here. If the user picks Auto-refine loop, ask the follow-up via ask_choice (autoComplete: false): termination = until no high-severity finding (hard cap 5 rounds, recommended) / 1 round / 2 rounds / 3 rounds. Then loop: each round calls refine (role: "reviewer", target: "implementation"), accepts findings on evidence, applies fixes, re-runs relevant tests, and records progress, until the termination condition or the 5-round cap.`;

/** Injection text for before_agent_start while executing. */
export function executionContextMessage(): string | null {
	if (!execution) return null;
	const remaining = execution.items.filter((item) => !item.done);
	const list =
		remaining.map((item) => `- \`${item.id}\` ${item.text}`).join("\n") || "(none — report completion now)";
	const graphLine = graphBlockForExecutor(execution.graphEnabled === true);
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
