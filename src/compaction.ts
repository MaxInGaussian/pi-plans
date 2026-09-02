/**
 * Pure, bounded history policy helpers used by the planning and execution
 * compaction hooks. SessionManager remains the owner of persistence.
 */

export interface CompactionContentPart {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface CompactionMessage {
	role?: string;
	content?: string | CompactionContentPart[];
	toolCallId?: string;
	toolName?: string;
	details?: Record<string, unknown>;
	isError?: boolean;
}

export interface CompactionEntryLike {
	id?: string;
	type?: string;
	customType?: string;
	message?: CompactionMessage;
	data?: Record<string, unknown>;
	details?: Record<string, unknown>;
	/** Compaction entries carry their kept boundary at the top level (Pi schema). */
	firstKeptEntryId?: string;
	/** Test fixtures and callers may provide a native estimate. */
	tokens?: number;
}

export interface ReadRecord {
	path: string;
	lineStart: number | "unknown";
	lineEnd: number | "unknown";
	range: string;
	summary: string;
	key: string;
	formatted: string;
}

export interface ImplementationSlice {
	id: string | null;
	entries: CompactionEntryLike[];
	current: boolean;
}

export interface CompactionMetrics {
	contextWindow: number | null;
	tokensBefore: number;
	currentITokens: number;
	summaryTokens: number;
	keptSuffixTokens: number;
	estimatedAfterTokens: number | null;
	targetRatio: number;
	currentI: string | null;
	firstKeptEntryId: string | null;
	targetMet: boolean;
	hardFloorReason: string | null;
}

export interface ICompactionPlan {
	currentI: string | null;
	currentITokens: number;
	currentStartIndex: number;
	firstKeptEntryIndex: number | null;
	firstKeptEntryId: string | null;
	summaryEntries: CompactionEntryLike[];
	keptEntries: CompactionEntryLike[];
	slices: ImplementationSlice[];
	readRecords: ReadRecord[];
	metrics: CompactionMetrics;
}

const CURRENT_I_RE = /\[(I-\d+):current\]/g;
const TOOL_RESULT_ROLES = new Set(["toolResult", "tool_result"]);
const INTERNAL_CUSTOM_TYPES = new Set([
	"pi-plans-exec",
	"pi-plans-exec-cleared",
	"pi-plans-exec-start",
	"pi-plans-exec-context",
	"pi-plans-exec-resume",
	"pi-plans-run-start",
	"pi-plans-plan-written",
	"pi-plans-plan-resume",
]);

function contentParts(message: CompactionMessage | undefined): CompactionContentPart[] {
	if (!message) return [];
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content ?? [];
}

export function compactText(text: string, limit = 180): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length < limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function messageText(message: CompactionMessage | undefined): string {
	return contentParts(message)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

export function scanCurrentIMarkers(text: string): string[] {
	return [...text.matchAll(CURRENT_I_RE)].map((match) => match[1]);
}

export function entryCurrentIMarkers(entry: CompactionEntryLike): string[] {
	return scanCurrentIMarkers(messageText(entry.message));
}

export function isToolResultEntry(entry: CompactionEntryLike): boolean {
	return TOOL_RESULT_ROLES.has(entry.message?.role ?? "") || entry.type === "tool_result";
}

function toolCallIds(entry: CompactionEntryLike): string[] {
	if (entry.message?.role !== "assistant") return [];
	return contentParts(entry.message)
		.filter((part) => part.type === "toolCall" && typeof part.id === "string")
		.map((part) => part.id as string);
}

function toolResultId(entry: CompactionEntryLike): string | undefined {
	return entry.message?.toolCallId;
}

function isInternalEntry(entry: CompactionEntryLike): boolean {
	return entry.type === "custom" && INTERNAL_CUSTOM_TYPES.has(entry.customType ?? "");
}

export function estimateEntryTokens(entry: CompactionEntryLike): number {
	if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens)) return Math.max(0, entry.tokens);
	if (isInternalEntry(entry)) return 0;
	const message = entry.message;
	if (!message) return 0;
	let text = messageText(message);
	if (message.role === "assistant") {
		for (const part of contentParts(message)) {
			if (part.type === "toolCall") {
				text += ` ${part.name ?? "tool"} ${safeJson(part.arguments)}`;
			}
		}
	}
	if (message.role === "toolResult") {
		text += ` ${message.toolName ?? "tool"} ${safeJson(message.details)}`;
	}
	return Math.max(1, Math.ceil(text.length / 4));
}

function safeJson(value: unknown): string {
	try {
		return value === undefined ? "" : JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

/**
 * Conservative mirror of Pi's `prepareCompaction` eligibility: is there
 * anything outside the keep-recent window that Pi could actually summarize?
 * Pi refuses manual compaction ("Nothing to compact (session too small)" /
 * "Already compacted") when the answer is no, so the auto-trigger must not
 * fire in that regime. Uncertainty (missing entry ids, unreadable branch)
 * resolves to `true` — the caller prefers one Pi rejection, which the
 * terminal-failure backoff absorbs, over permanently blocked compaction.
 */
export function hasCompactableContent(
	entries: CompactionEntryLike[],
	keepRecentTokens = 20_000,
): boolean {
	if (!Array.isArray(entries) || entries.length === 0) return false;
	if (entries[entries.length - 1]?.type === "compaction") return false;
	let prevCompactionIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.type === "compaction") {
			prevCompactionIndex = index;
			break;
		}
	}
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prev = entries[prevCompactionIndex];
		const known = prev?.firstKeptEntryId
			?? (typeof prev?.details?.firstKeptEntryId === "string" ? prev.details.firstKeptEntryId : undefined);
		const firstKeptIndex = known
			? entries.findIndex((entry) => entry.id === known)
			: -1;
		boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : prevCompactionIndex + 1;
	}
	// Walk backwards from the newest entry, reserving the keep-recent budget,
	// exactly like Pi's findCutPoint accumulation.
	let reserved = 0;
	let cutIndex = boundaryStart;
	for (let index = entries.length - 1; index >= boundaryStart; index--) {
		reserved += estimateEntryTokens(entries[index] ?? { type: "raw" });
		cutIndex = index;
		if (reserved >= keepRecentTokens) break;
	}
	// Anything summarizable between the previous boundary and the cut point?
	for (let index = boundaryStart; index < cutIndex; index++) {
		const entry = entries[index];
		if (entry?.message && !isInternalEntry(entry)) return true;
	}
	return false;
}

function entryHasToolCall(entry: CompactionEntryLike, id: string): boolean {
	return toolCallIds(entry).includes(id);
}

/**
 * Return the first entry to keep for a requested boundary. Tool results always
 * move the boundary back to their matching assistant call, preserving the
 * call/result pair as one indivisible context unit.
 */
export function legalFirstKeptEntryIndex(entries: CompactionEntryLike[], requestedIndex: number): number | null {
	if (!entries.length) return null;
	let index = Math.max(0, Math.min(entries.length - 1, Math.floor(requestedIndex)));
	if (!isToolResultEntry(entries[index])) return index;
	const resultId = toolResultId(entries[index]);
	if (resultId) {
		for (let i = index - 1; i >= 0; i--) {
			if (entryHasToolCall(entries[i], resultId)) return i;
		}
	}
	while (index > 0 && isToolResultEntry(entries[index])) index -= 1;
	return isToolResultEntry(entries[index]) ? null : index;
}

export function legalFirstKeptEntryId(entries: CompactionEntryLike[], requestedIndex: number, fallback: string): string {
	const index = legalFirstKeptEntryIndex(entries, requestedIndex);
	return index !== null && entries[index]?.id ? entries[index].id as string : fallback;
}

function markerStarts(entries: CompactionEntryLike[], knownIds?: Set<string>): Array<{ index: number; id: string }> {
	const starts: Array<{ index: number; id: string }> = [];
	for (let index = 0; index < entries.length; index++) {
		for (const id of entryCurrentIMarkers(entries[index])) {
			if (knownIds && !knownIds.has(id)) continue;
			starts.push({ index, id });
		}
	}
	return starts;
}

export function compactionCurrentI(entry: CompactionEntryLike): string | undefined {
	if (entry.type !== "compaction") return undefined;
	const raw = entry.details ?? entry.data;
	if (!raw || typeof raw !== "object") return undefined;
	const currentI = (raw as { currentI?: unknown }).currentI;
	return typeof currentI === "string" && currentI ? currentI : undefined;
}

function latestCompactionCurrentIStart(entries: CompactionEntryLike[], currentI: string | undefined): number | undefined {
	if (!currentI) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (compactionCurrentI(entries[index]) === currentI) return index + 1;
	}
	return undefined;
}

export function sliceHistoryByImplementation(
	entries: CompactionEntryLike[],
	currentI?: string | null,
	knownIds?: Iterable<string>,
): { slices: ImplementationSlice[]; currentStartIndex: number; currentI: string | null } {
	const known = knownIds ? new Set(knownIds) : undefined;
	const starts = markerStarts(entries, known);
	const effectiveCurrent = currentI && (!known || known.has(currentI))
		? currentI
		: starts.at(-1)?.id ?? null;
	const markerStart = starts.findLast((start) => start.id === effectiveCurrent)?.index;
	const compactionStart = latestCompactionCurrentIStart(entries, effectiveCurrent);
	const currentStart = Math.max(markerStart ?? 0, compactionStart ?? 0);
	const slices: ImplementationSlice[] = [];
	if (starts.length && starts[0].index > 0) {
		slices.push({ id: null, entries: entries.slice(0, starts[0].index), current: false });
	}
	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		const end = starts[i + 1]?.index ?? entries.length;
		const prior = slices.find((slice) => slice.id === start.id && !slice.current);
		if (prior) prior.entries.push(...entries.slice(start.index, end));
		else slices.push({ id: start.id, entries: entries.slice(start.index, end), current: start.id === effectiveCurrent && i === starts.findLastIndex((candidate) => candidate.id === effectiveCurrent) });
	}
	if (!starts.length && entries.length) {
		if (currentStart > 0 && currentStart < entries.length) {
			slices.push({ id: null, entries: entries.slice(0, currentStart), current: false });
			slices.push({ id: effectiveCurrent, entries: entries.slice(currentStart), current: true });
		} else {
			slices.push({ id: null, entries: [...entries], current: true });
		}
	}
	if (effectiveCurrent && currentStart > 0) {
		for (const slice of slices) {
			if (slice.id === effectiveCurrent) slice.current = false;
		}
		const hasExactCurrentSlice = slices.some((slice) => slice.id === effectiveCurrent && slice.entries[0] === entries[currentStart]);
		if (!hasExactCurrentSlice && currentStart < entries.length) {
			slices.push({ id: effectiveCurrent, entries: entries.slice(currentStart), current: true });
		} else {
			const exact = slices.find((slice) => slice.id === effectiveCurrent && slice.entries[0] === entries[currentStart]);
			if (exact) exact.current = true;
		}
	}
	return { slices, currentStartIndex: currentStart, currentI: effectiveCurrent };
}

function lineRangeFrom(value: Record<string, unknown> | undefined, resultText: string): [number | "unknown", number | "unknown"] {
	const start = numberValue(value?.lineStart ?? value?.startLine ?? value?.line_start);
	const end = numberValue(value?.lineEnd ?? value?.endLine ?? value?.line_end);
	if (start !== undefined && end !== undefined) return [start, end];
	const offset = numberValue(value?.offset);
	const limit = numberValue(value?.limit);
	if (limit !== undefined && limit > 0) {
		const first = offset !== undefined && offset > 0 ? offset : 1;
		return [first, first + limit - 1];
	}
	const match = resultText.match(/\b(?:lines?|line)\s*(\d+)\s*[-–]\s*(\d+)\b/i);
	if (match) return [Number(match[1]), Number(match[2])];
	return ["unknown", "unknown"];
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
	if (typeof value === "string" && /^\d+$/.test(value)) return Math.max(1, Number(value));
	return undefined;
}

function resultText(entry: CompactionEntryLike): string {
	const message = entry.message;
	if (!message) return "";
	return contentParts(message)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function readCall(entry: CompactionEntryLike): { id: string; path: string; args: Record<string, unknown> } | null {
	if (entry.message?.role !== "assistant") return null;
	for (const part of contentParts(entry.message)) {
		if (part.type !== "toolCall" || part.name !== "read" || !part.id) continue;
		return { id: part.id, path: String(part.arguments?.path ?? "unknown"), args: part.arguments ?? {} };
	}
	return null;
}

function boundedReadSummary(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "no textual extraction";
	const limit = 160;
	const clipped = normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
	return `${clipped} [bounded]`;
}

export function formatReadRecord(record: Pick<ReadRecord, "path" | "range" | "summary">): string {
	return `Read: ${record.path} line ${record.range} Extracted information summary: ${record.summary}`;
}

export function extractReadRecords(entries: CompactionEntryLike[]): ReadRecord[] {
	const records: ReadRecord[] = [];
	for (let callIndex = 0; callIndex < entries.length; callIndex++) {
		const call = readCall(entries[callIndex]);
		if (!call) continue;
		let resultIndex = -1;
		for (let i = callIndex + 1; i < entries.length; i++) {
			if (isToolResultEntry(entries[i]) && toolResultId(entries[i]) === call.id) {
				resultIndex = i;
				break;
			}
		}
		if (resultIndex < 0) continue;
		const result = entries[resultIndex];
		const text = resultText(result);
		const [lineStart, lineEnd] = lineRangeFrom(call.args, text);
		const range = lineStart === "unknown" || lineEnd === "unknown" ? "unknown" : `${lineStart}-${lineEnd}`;
		const summary = boundedReadSummary(text);
		const key = `${call.path}|${range}`;
		const record = { path: call.path, lineStart, lineEnd, range, summary, key, formatted: "" };
		record.formatted = formatReadRecord(record);
		records.push(record);
	}
	return records;
}

export function mergeReadRecords(...recordLists: ReadRecord[][]): ReadRecord[] {
	const merged = new Map<string, ReadRecord>();
	for (const records of recordLists) {
		for (const record of records) merged.set(record.key || `${record.path}|${record.range}`, { ...record, formatted: formatReadRecord(record) });
	}
	return [...merged.values()];
}

export interface CompactionDetailsLike {
	kind?: string;
	version?: number;
	currentI?: string | null;
	iSections?: Array<{ id: string | null; entryIds?: string[] }>;
	readRecords?: ReadRecord[];
	metrics?: Partial<CompactionMetrics>;
	[key: string]: unknown;
}

export function mergeCompactionDetails(
	previous: CompactionDetailsLike | undefined,
	current: CompactionDetailsLike,
): CompactionDetailsLike {
	const previousRecords = previous?.readRecords ?? [];
	const currentRecords = current.readRecords ?? [];
	return {
		...(previous ?? {}),
		...current,
		version: current.version ?? previous?.version ?? 1,
		readRecords: mergeReadRecords(previousRecords, currentRecords),
		metrics: { ...(previous?.metrics ?? {}), ...(current.metrics ?? {}) },
	};
}

function tokenIndexForRatio(entries: CompactionEntryLike[], start: number, end: number, ratio: number): number {
	const total = entries.slice(start, end).reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
	const goal = total * ratio;
	let seen = 0;
	for (let index = start; index < end; index++) {
		seen += estimateEntryTokens(entries[index]);
		if (seen >= goal) return index + 1;
	}
	return end;
}

function latestTurnStart(entries: CompactionEntryLike[], start: number): number {
	for (let index = entries.length - 1; index >= start; index--) {
		if (entries[index].message?.role === "user") return index;
	}
	return start;
}

function summaryEstimate(entries: CompactionEntryLike[]): number {
	const source = entries.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
	return source === 0 ? 0 : Math.max(16, Math.ceil(source * 0.12));
}

export function planIAwareCompaction(options: {
	entries: CompactionEntryLike[];
	currentI?: string | null;
	knownIIds?: Iterable<string>;
	contextWindow?: number | null;
	tokensBefore?: number;
	fallbackFirstKeptEntryId?: string;
	/** When Pi is splitting a turn, never discard more than its prepared boundary. */
	maxFirstKeptEntryIndex?: number;
}): ICompactionPlan {
	const entries = options.entries;
	const tokensBefore = Math.max(0, options.tokensBefore ?? entries.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0));
	const contextWindow = typeof options.contextWindow === "number" && options.contextWindow > 0 ? options.contextWindow : null;
	const sliced = sliceHistoryByImplementation(entries, options.currentI, options.knownIIds);
	const currentStartIndex = sliced.currentStartIndex;
	const currentEntries = entries.slice(currentStartIndex);
	const currentITokens = currentEntries.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
	const targetRatio = 0.1;
	const targetTokens = contextWindow === null ? null : contextWindow * targetRatio;
	const protectedStart = latestTurnStart(entries, currentStartIndex);
	const boundaryLimit = Math.max(0, Math.min(entries.length - 1, Math.floor(options.maxFirstKeptEntryIndex ?? entries.length - 1)));
	const initialRequested = currentEntries.length
		? tokenIndexForRatio(entries, currentStartIndex, entries.length, 0.8)
		: currentStartIndex;
	const initial = legalFirstKeptEntryIndex(entries, Math.min(initialRequested, Math.max(currentStartIndex, protectedStart), boundaryLimit));
	const candidateIndexes: number[] = [];
	if (initial !== null && initial > 0 && initial <= boundaryLimit) candidateIndexes.push(initial);
	if (protectedStart > 0) {
		const protectedIndex = legalFirstKeptEntryIndex(entries, protectedStart);
		if (protectedIndex !== null && protectedIndex > 0 && protectedIndex <= boundaryLimit) candidateIndexes.push(protectedIndex);
	}
	if (!candidateIndexes.length && currentStartIndex > 0) {
		const currentIndex = legalFirstKeptEntryIndex(entries, currentStartIndex);
		if (currentIndex !== null && currentIndex > 0 && currentIndex <= boundaryLimit) candidateIndexes.push(currentIndex);
	}
	const firstCandidate = candidateIndexes[0];
	const candidates = [...new Set([
		...(firstCandidate === undefined ? [] : [firstCandidate]),
		...candidateIndexes.slice(firstCandidate === undefined ? 0 : 1).sort((a, b) => a - b),
	])];
	let chosen: number | null = null;
	let chosenAfter: number | null = null;
	let chosenSummaryTokens = 0;
	let chosenKeptTokens = 0;
	for (const candidate of candidates) {
		const summaryTokens = summaryEstimate(entries.slice(0, candidate));
		const keptTokens = entries.slice(candidate).reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
		const outsideTokens = Math.max(0, tokensBefore - entries.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0));
		const after = outsideTokens + summaryTokens + keptTokens;
		if (chosen === null || (targetTokens !== null && after < targetTokens && (chosenAfter === null || after < chosenAfter))) {
			chosen = candidate;
			chosenAfter = after;
			chosenSummaryTokens = summaryTokens;
			chosenKeptTokens = keptTokens;
		}
		if (targetTokens !== null && after < targetTokens) break;
	}
	const firstKeptEntryIndex = chosen;
	const firstKeptEntryId = chosen !== null && entries[chosen]?.id
		? entries[chosen].id as string
		: options.fallbackFirstKeptEntryId ?? null;
	const summaryEntries = chosen === null ? [] : entries.slice(0, chosen);
	const keptEntries = chosen === null ? entries : entries.slice(chosen);
	const estimatedAfterTokens = chosenAfter;
	const targetMet = targetTokens !== null && estimatedAfterTokens !== null && estimatedAfterTokens < targetTokens;
	const hardFloorReason = chosen === null
		? "no legal eligible prefix"
		: targetTokens === null
			? "context window unavailable"
			: targetMet
				? null
				: "protected suffix, summary, or system context exceeds the 10% target";
	const metrics: CompactionMetrics = {
		contextWindow,
		tokensBefore,
		currentITokens,
		summaryTokens: chosenSummaryTokens,
		keptSuffixTokens: chosenKeptTokens,
		estimatedAfterTokens,
		targetRatio,
		currentI: sliced.currentI,
		firstKeptEntryId,
		targetMet,
		hardFloorReason,
	};
	const slices = sliced.slices.map((slice) => ({ ...slice, entries: [...slice.entries] }));
	return {
		currentI: sliced.currentI,
		currentITokens,
		currentStartIndex,
		firstKeptEntryIndex,
		firstKeptEntryId,
		summaryEntries,
		keptEntries,
		slices,
		readRecords: extractReadRecords(summaryEntries),
		metrics,
	};
}

export function currentIExceedsTrigger(currentITokens: number, contextWindow: number | null | undefined): boolean {
	return typeof contextWindow === "number" && contextWindow > 0 && currentITokens > contextWindow * 0.2;
}
