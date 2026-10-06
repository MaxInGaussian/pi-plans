/**
 * Compaction lifecycle primitives: the pre-plan compaction request/draft and
 * the "a compaction displaced a live turn" observation used by the manual
 * compaction resume path.
 *
 * Design facts (verified against pi 1.0.2; see the run's PROBLEM_ANALYSIS.md
 * and PLAN_v2.md):
 *
 * - `AgentSession.compact()` starts with `await this.abort()` ("Aborts the
 *   current agent operation first. Manual compaction never retries or
 *   continues the interrupted agent turn.") and only creates
 *   `_compactionAbortController` AFTER that abort resolves
 *   (`agent-session.js:2132-2135`). During the settle the abort causes, no
 *   extension-visible surface can attribute the abort to a compaction, so a
 *   manual compaction always leaves an aborted assistant message behind and
 *   needs an explicit resume.
 * - `turn_end` / `agent_before_settle` handler results are `BoundaryResult`s
 *   whose `entries` accept a `compaction` draft; the host applies it with
 *   `appendCompaction(summary, firstKeptEntryId, <host-computed tokensBefore>,
 *   details, fromExtension = true, usage)` and refreshes the finalized context
 *   (`agent-session.js:566-591`, `:623-628`), so the next provider request
 *   already sees the compacted context. The pre-plan compaction runs this way:
 *   **no abort at all**.
 * - `ctx.isIdle()` is false inside `agent_before_settle` (`isIdle =
 *   !_isAgentRunActive && !isCompacting`, and the run flag is cleared only
 *   when settling is emitted), and calling `ctx.compact()` inside that
 *   boundary sets `_abortDuringBeforeSettle`, which vetoes the boundary's
 *   continuations. Both are why the pre-plan compaction does not go through
 *   `ctx.compact()` anymore.
 *
 * This module is deliberately free of `exec.ts` imports: it owns the
 * session-scoped state, the timing constants, the abort predicate, and the
 * pure draft builder. Event wiring lives in `index.ts`; the phase context and
 * settings come from `exec.ts` (`activeVccSettings` / `planningVccContext`).
 */

import {
	buildPiPlansVccCompaction,
	messageText,
	PLANNING_PREPLAN_COMPACT_HINT,
	type CompactionEntryLike,
	type PiPlansVccPhaseContext,
	type PiPlansVccSettings,
	type VccCompactionStats,
} from "./compaction.ts";

/** A pre-plan request that never reached a `turn_end` carrying its `plans`
 *  result is dropped after this long; the compaction is an optimization and
 *  must never fire against a session that has moved on. */
export const PREPLAN_COMPACT_STALE_MS = 30 * 60 * 1000;

/** How long an observed abort stays attributable to a compaction. The host
 *  aborts the live turn immediately before it prepares a manual compaction, so
 *  the compaction's terminal event follows within seconds; anything older is
 *  treated as an unrelated interruption (for example the user's own Esc). */
export const DISPLACED_ABORT_TTL_MS = 2 * 60 * 1000;

/** Abort-shaped error text. Kept in sync with the pi-plans planning/execution
 *  compaction failure classifier, which uses the same list. */
const ABORT_MESSAGE_PATTERNS = [
	"this operation was aborted",
	"aborted",
	"stream ended before a terminal response event",
	"turn prefix summarization failed",
	"auto-compaction failed",
	"context overflow recovery failed",
];

/** Session-scoped pre-plan request. */
export interface PrePlanCompactionRequest {
	/** The planning run that asked for the compaction. */
	runId: string;
	/** Epoch ms of the request (`plans start-run`). */
	requestedAt: number;
	/** Set synchronously when a boundary consumed the request, so a single
	 *  request can never produce two drafts. */
	inFlight: boolean;
}

/** Session-scoped abort observation. */
export interface DisplacedAbortObservation {
	at: number;
}

interface SessionCarrier {
	__piPlansPrePlanCompact?: PrePlanCompactionRequest | null;
	__piPlansDisplacedAbort?: DisplacedAbortObservation | null;
}

function carrier(ctx: unknown): SessionCarrier {
	return (ctx as { sessionManager?: unknown }).sessionManager as SessionCarrier;
}

// ---------------------------------------------------------------------------
// Pre-plan request
// ---------------------------------------------------------------------------

/** Marks the session so the next `turn_end` carrying the `plans` tool result
 *  compacts once with the VCC planning path. Called from `plans start-run`
 *  behind the `prePlanCompact` setting and the "no execution active" guard. */
export function markPrePlanCompactPending(ctx: unknown, runId: string, now: number = Date.now()): void {
	const session = carrier(ctx);
	if (!session) return;
	session.__piPlansPrePlanCompact = { runId, requestedAt: now, inFlight: false };
}

export function pendingPrePlanCompaction(ctx: unknown): PrePlanCompactionRequest | null {
	return carrier(ctx)?.__piPlansPrePlanCompact ?? null;
}

export function clearPrePlanCompaction(ctx: unknown): void {
	const session = carrier(ctx);
	if (session) session.__piPlansPrePlanCompact = null;
}

export function isPrePlanCompactionStale(request: PrePlanCompactionRequest, now: number = Date.now()): boolean {
	return now - request.requestedAt > PREPLAN_COMPACT_STALE_MS;
}

/** Atomically claims the pending request for one boundary: marks it in flight
 *  and returns it, or clears it and returns null when it must not run (already
 *  claimed, stale, an execution took over, or the active planning run moved on).
 *  The caller builds the draft from the returned request. */
export function takePrePlanCompactionRequest(
	ctx: unknown,
	guards: { now?: number; hasExecution?: boolean; activeRunId?: string | null } = {},
): PrePlanCompactionRequest | null {
	const now = guards.now ?? Date.now();
	const request = pendingPrePlanCompaction(ctx);
	if (!request) return null;
	const drop = (): null => {
		clearPrePlanCompaction(ctx);
		return null;
	};
	if (request.inFlight) return drop();
	if (isPrePlanCompactionStale(request, now)) return drop();
	if (guards.hasExecution) return drop();
	if (guards.activeRunId !== undefined && guards.activeRunId !== request.runId) return drop();
	request.inFlight = true;
	return request;
}

// ---------------------------------------------------------------------------
// Displaced-turn observation
// ---------------------------------------------------------------------------

export function isAbortErrorMessage(message: unknown): boolean {
	if (typeof message !== "string") return false;
	const lowered = message.toLowerCase();
	return ABORT_MESSAGE_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/** True when an assistant message is the host's abort record: the turn that
 *  was in flight when something aborted the run. */
export function hasAbortSignature(message: unknown): boolean {
	const candidate = message as { role?: string; stopReason?: string; errorMessage?: string } | null;
	if (!candidate || typeof candidate !== "object") return false;
	if (candidate.role !== "assistant") return false;
	if (candidate.stopReason !== "error") return false;
	return isAbortErrorMessage(candidate.errorMessage ?? "");
}

/** Records that a turn was aborted. Returns true when the message carried an
 *  abort signature (and was therefore recorded). */
export function noteAssistantMessage(ctx: unknown, message: unknown, now: number = Date.now()): boolean {
	if (!hasAbortSignature(message)) return false;
	const session = carrier(ctx);
	if (session) session.__piPlansDisplacedAbort = { at: now };
	return true;
}

export function clearDisplacedAbort(ctx: unknown): void {
	const session = carrier(ctx);
	if (session) session.__piPlansDisplacedAbort = null;
}

/** Whether a fresh abort observation is available. Non-consuming: the caller
 *  decides when the attribution window ends. */
export function pendingDisplacedAbort(ctx: unknown, now: number = Date.now()): boolean {
	const observed = carrier(ctx)?.__piPlansDisplacedAbort;
	if (!observed) return false;
	return now - observed.at <= DISPLACED_ABORT_TTL_MS;
}

/** Consumes the observation, returning whether a compaction displaced a live
 *  turn. Called at every compaction end so a stale attribution can never leak
 *  into a later compaction. */
export function consumeDisplacedAbort(ctx: unknown, now: number = Date.now()): boolean {
	const displaced = pendingDisplacedAbort(ctx, now);
	clearDisplacedAbort(ctx);
	return displaced;
}

// ---------------------------------------------------------------------------
// Draft builder
// ---------------------------------------------------------------------------

/** Structural shape of the host's `CompactionEntryDraft`; kept local so this
 *  module stays free of host type imports. */
export interface CompactionBoundaryDraft {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string | null;
	details?: unknown;
}

export interface PrePlanCompactionDraft {
	entries: CompactionBoundaryDraft[];
	stats: VccCompactionStats;
}

/** Most recent VCC/pi compaction summary on the branch, used as the iterative
 *  context for the next summary (same role as `preparation.previousSummary` on
 *  the `session_before_compact` path). */
export function latestCompactionSummary(branchEntries: CompactionEntryLike[]): string | null {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry?.type !== "compaction") continue;
		// The host writes the summary as a top-level string (`CompactionEntry.summary`).
		if (typeof entry.summary === "string" && entry.summary.length > 0) return entry.summary;
		if (typeof entry.content === "string" && entry.content.length > 0) return entry.content;
		// Fixture/legacy shapes carry the text in the message instead.
		const text = messageText(entry.message);
		if (text.length > 0) return text;
	}
	return null;
}

/**
 * Builds the boundary draft for one pre-plan compaction, or null when the VCC
 * cut cannot run (too-small session, no live messages, override disabled).
 *
 * `preparation` only carries `previousSummary`: the host computes the
 * authoritative `tokensBefore` for boundary drafts itself, and `fileOps` (used
 * for the read/modified file lists) comes from pi-plans' own entry scan on
 * this path — the one behavioural difference from the
 * `session_before_compact` path, which receives a host-built preparation.
 */
export function buildPrePlanCompactionDraft(options: {
	branchEntries: CompactionEntryLike[];
	settings: PiPlansVccSettings;
	phaseContext: PiPlansVccPhaseContext;
}): PrePlanCompactionDraft | null {
	const { branchEntries, settings, phaseContext } = options;
	const built = buildPiPlansVccCompaction({
		branchEntries,
		preparation: { previousSummary: latestCompactionSummary(branchEntries) },
		customInstructions: PLANNING_PREPLAN_COMPACT_HINT,
		reason: "manual",
		willRetry: false,
		settings,
		phaseContext,
	});
	if (built.kind !== "compaction") return null;
	return {
		entries: [
			{
				type: "compaction",
				summary: built.compaction.summary,
				firstKeptEntryId: built.compaction.firstKeptEntryId,
				details: built.compaction.details,
			},
		],
		stats: built.stats,
	};
}
