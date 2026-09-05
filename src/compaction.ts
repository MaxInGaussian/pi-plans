/**
 * Deterministic VCC-style compaction helpers for planning and execution.
 * SessionManager remains the owner of session persistence; this module only
 * builds summaries, cut points, stats, and repo-private VCC settings.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export type CompactionReason = "manual" | "threshold" | "overflow";
export type PiPlansCompactionPhase = "planning" | "execution";

export interface PiPlansVccSettings {
	overrideDefaultCompaction: boolean;
	smartKeepTail: boolean;
	continueAfterThresholdCompact: boolean;
	debug: boolean;
}

export const DEFAULT_VCC_SETTINGS: PiPlansVccSettings = {
	overrideDefaultCompaction: true,
	smartKeepTail: true,
	continueAfterThresholdCompact: true,
	debug: false,
};

export const VCC_SETTINGS_FILENAME = "pi-vcc-config.json";
export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;
export const OVERSIZED_TAIL_FACTOR = 2.5;
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_CHARS_PER_TOKEN = 2;
export const MAX_CHARS_PER_TOKEN = 6;
export const PI_SELF_RESUME_VERSION: readonly [number, number, number] = [0, 84, 4];
export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

const INTERNAL_COMPACT_INSTRUCTIONS = new Set([
	"pi-plans execution auto compact",
	"pi-plans planning auto compact",
]);

export function vccSettingsPath(stateRoot: string): string {
	return path.join(stateRoot, VCC_SETTINGS_FILENAME);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function atomicWriteJson(filePath: string, data: unknown): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	renameSync(tmp, filePath);
}

/**
 * Repo-private pi-vcc config scaffold.
 * Missing file -> create defaults; valid file -> fill missing keys; invalid
 * JSON -> no-op so a user file is never clobbered.
 */
export function scaffoldVccSettings(stateRoot: string): void {
	const filePath = vccSettingsPath(stateRoot);
	try {
		mkdirSync(path.dirname(filePath), { recursive: true });
		if (!existsSync(filePath)) {
			atomicWriteJson(filePath, DEFAULT_VCC_SETTINGS);
			return;
		}
		const parsed = readJsonObject(filePath);
		if (!parsed) return;
		let changed = false;
		const next = { ...parsed };
		for (const [key, value] of Object.entries(DEFAULT_VCC_SETTINGS)) {
			if (!(key in next)) {
				next[key] = value;
				changed = true;
			}
		}
		if (changed) atomicWriteJson(filePath, next);
	} catch {
		// Settings are best-effort; compaction can still use defaults.
	}
}

export function loadVccSettings(stateRoot: string): PiPlansVccSettings {
	const parsed = readJsonObject(vccSettingsPath(stateRoot));
	if (!parsed) return { ...DEFAULT_VCC_SETTINGS };
	return {
		overrideDefaultCompaction: typeof parsed.overrideDefaultCompaction === "boolean" ? parsed.overrideDefaultCompaction : DEFAULT_VCC_SETTINGS.overrideDefaultCompaction,
		smartKeepTail: typeof parsed.smartKeepTail === "boolean" ? parsed.smartKeepTail : DEFAULT_VCC_SETTINGS.smartKeepTail,
		continueAfterThresholdCompact: typeof parsed.continueAfterThresholdCompact === "boolean" ? parsed.continueAfterThresholdCompact : DEFAULT_VCC_SETTINGS.continueAfterThresholdCompact,
		debug: typeof parsed.debug === "boolean" ? parsed.debug : DEFAULT_VCC_SETTINGS.debug,
	};
}

export interface CompactionContentPart {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown> | string;
	input?: Record<string, unknown> | string;
	content?: unknown;
	mimeType?: string;
}

export interface CompactionMessage {
	role?: string;
	content?: string | CompactionContentPart[];
	toolCallId?: string;
	toolName?: string;
	details?: Record<string, unknown>;
	isError?: boolean;
	[key: string]: unknown;
}

export interface CompactionEntryLike {
	id?: string;
	type?: string;
	customType?: string;
	message?: CompactionMessage;
	content?: string | CompactionContentPart[];
	data?: Record<string, unknown>;
	details?: Record<string, unknown>;
	firstKeptEntryId?: string;
	tokens?: number;
	timestamp?: number | string;
	[key: string]: unknown;
}

export interface FileOpsLike {
	read?: string[];
	written?: string[];
	edited?: string[];
	readFiles?: string[];
	modifiedFiles?: string[];
	createdFiles?: string[];
}

export interface PiPlansVccPhaseContext {
	phase: PiPlansCompactionPhase;
	runId?: string | null;
	artifactDir?: string | null;
	planPath?: string | null;
	currentI?: string | null;
	remainingVerifierIds?: string[];
	implementationIds?: string[];
}

export interface PiPlansCompactionDetails {
	compactor: "pi-vcc";
	version: number;
	sections: string[];
	sourceMessageCount: number;
	previousSummaryUsed: boolean;
	reason?: CompactionReason;
	willRetry?: boolean;
	phase: PiPlansCompactionPhase;
	stats: VccCompactionStats;
}

export interface VccCompactionStats {
	summarized: number;
	kept: number;
	keptUserTurns: number;
	totalUserTurns: number;
	requestedKeepUserTurns: number;
	keepUserTurnsExplicit: boolean;
	keepFallbackToCompactAll: boolean;
	budgetCut?: BudgetCutKind;
	keptTokensEst: number;
	estimatedSummaryTokens: number;
	estimatedTokensAfter: number;
	smartKeepAdjusted?: boolean;
	smartFromKeep?: number;
	reason?: CompactionReason;
	willRetry?: boolean;
}

export type BudgetCutKind = "no_anchor" | "oversized_tail";

interface EntryWithMessage {
	entry: CompactionEntryLike;
	message: CompactionMessage;
}

export type OwnCutCancelReason = "no_live_messages" | "too_few_live_messages";

export type OwnCutResult =
	| {
		ok: true;
		messages: CompactionMessage[];
		firstKeptEntryId: string;
		compactAll: boolean;
		keptUserTurns: number;
		totalUserTurns: number;
		requestedKeepUserTurns: number;
		keepFallbackToCompactAll: boolean;
		budgetCut?: BudgetCutKind;
	}
	| { ok: false; reason: OwnCutCancelReason };

export type VccCompactionBuildResult =
	| {
		kind: "compaction";
		compaction: {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			estimatedTokensAfter?: number;
			details: PiPlansCompactionDetails;
		};
		stats: VccCompactionStats;
		followUpPrompt: string | null;
		settings: PiPlansVccSettings;
	}
	| { kind: "cancel"; message: string; reason: OwnCutCancelReason }
	| { kind: "fallback"; reason: string };

function contentParts(message: CompactionMessage | undefined): CompactionContentPart[] {
	if (!message) return [];
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return Array.isArray(message.content) ? message.content : [];
}

export function compactText(text: string, limit = 180): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}...`;
}

export function messageText(message: CompactionMessage | undefined): string {
	return contentParts(message)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

const CURRENT_I_RE = /\[(I-\d+):current\]/g;

export function scanCurrentIMarkers(text: string): string[] {
	return [...text.matchAll(CURRENT_I_RE)].map((match) => match[1]);
}

export function entryCurrentIMarkers(entry: CompactionEntryLike): string[] {
	return scanCurrentIMarkers(messageText(entry.message));
}

export function compactionCurrentI(entry: CompactionEntryLike): string | undefined {
	if (entry.type !== "compaction") return undefined;
	const raw = entry.details ?? entry.data;
	if (!raw || typeof raw !== "object") return undefined;
	const details = raw as { currentI?: unknown; stats?: { currentI?: unknown }; metrics?: { currentI?: unknown } };
	const currentI = details.currentI ?? details.stats?.currentI ?? details.metrics?.currentI;
	return typeof currentI === "string" && currentI ? currentI : undefined;
}

export function estimateMessageContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum: number, part: CompactionContentPart) => {
		if (!part || typeof part !== "object") return sum;
		switch (part.type) {
			case "text":
				return sum + (typeof part.text === "string" ? part.text.length : 0);
			case "thinking":
				return sum + (typeof part.thinking === "string" ? part.thinking.length : 0);
			case "toolCall": {
				const args = part.arguments ?? part.input;
				return sum + (part.name?.length ?? 0) + safeStringify(args).length;
			}
			case "toolResult":
				return sum + safeStringify(part.content).length;
			case "image":
				return sum + 4_800;
			default:
				return sum + (typeof part.text === "string" ? part.text.length : 0);
		}
	}, 0);
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value ?? "") ?? "";
	} catch {
		return "";
	}
}

export function estimateTokensFromChars(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
	return Math.ceil(Math.max(0, chars) / charsPerToken);
}

export function estimateMessageContentTokens(content: unknown, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
	return estimateTokensFromChars(estimateMessageContentChars(content), charsPerToken);
}

export function estimateEntryTokens(entry: CompactionEntryLike, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
	if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens)) return Math.max(0, entry.tokens);
	return Math.max(1, estimateMessageContentTokens(entry.message?.content, charsPerToken));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function calibrateCharsPerToken(sourceChars: number, sourceTokens: number | undefined): number {
	if (!sourceTokens || sourceTokens <= 0 || sourceChars <= 0) return DEFAULT_CHARS_PER_TOKEN;
	const raw = sourceChars / sourceTokens;
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHARS_PER_TOKEN;
	return clamp(raw, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN);
}

function toLiveMessage(entry: CompactionEntryLike): CompactionMessage | null {
	if (entry.type === "message" && entry.message) return entry.message;
	if (entry.type === "custom_message") {
		return { role: "custom", customType: entry.customType, content: entry.content, display: entry.display };
	}
	if (entry.type === "branch_summary") {
		return { role: "branchSummary", summary: entry.summary, content: undefined };
	}
	return null;
}

function previousFirstKeptId(entry: CompactionEntryLike): string | undefined {
	if (typeof entry.firstKeptEntryId === "string") return entry.firstKeptEntryId;
	const raw = entry.details ?? entry.data;
	if (!raw || typeof raw !== "object") return undefined;
	const details = raw as { firstKeptEntryId?: unknown; metrics?: { firstKeptEntryId?: unknown } };
	const id = details.firstKeptEntryId ?? details.metrics?.firstKeptEntryId;
	return typeof id === "string" ? id : undefined;
}

export function collectLiveMessages(branchEntries: CompactionEntryLike[]): EntryWithMessage[] {
	let lastCompactionIdx = -1;
	let lastKeptId: string | undefined;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		if (branchEntries[i].type === "compaction") {
			lastCompactionIdx = i;
			lastKeptId = previousFirstKeptId(branchEntries[i]);
			break;
		}
	}
	const hasPriorCompaction = lastCompactionIdx >= 0;
	const hasValidKeptId = !!lastKeptId && branchEntries.some((entry) => entry.id === lastKeptId);
	const orphanRecovery = hasPriorCompaction && !hasValidKeptId;
	const live: EntryWithMessage[] = [];
	if (orphanRecovery) {
		for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
			const message = toLiveMessage(branchEntries[i]);
			if (message) live.push({ entry: branchEntries[i], message });
		}
		return live;
	}
	let foundKept = !lastKeptId;
	for (const entry of branchEntries) {
		if (!foundKept && entry.id === lastKeptId) foundKept = true;
		if (!foundKept || entry.type === "compaction") continue;
		const message = toLiveMessage(entry);
		if (message) live.push({ entry, message });
	}
	return live;
}

function normalizeKeepUserTurns(keepUserTurns: number): number {
	if (!Number.isFinite(keepUserTurns)) return 0;
	return Math.max(0, Math.floor(keepUserTurns));
}

export function buildOwnCut(branchEntries: CompactionEntryLike[], keepUserTurns = 1): OwnCutResult {
	const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
	const liveMessages = collectLiveMessages(branchEntries);
	if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
	if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };
	const userIndices = liveMessages.reduce<number[]>((acc, item, index) => {
		if (item.message.role === "user") acc.push(index);
		return acc;
	}, []);
	const compactAll = (keepFallbackToCompactAll: boolean): OwnCutResult => ({
		ok: true,
		messages: liveMessages.map((item) => item.message),
		firstKeptEntryId: "",
		compactAll: true,
		keptUserTurns: 0,
		totalUserTurns: userIndices.length,
		requestedKeepUserTurns: normalizedKeepUserTurns,
		keepFallbackToCompactAll,
	});
	if (normalizedKeepUserTurns <= 0) return compactAll(false);
	const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
	const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;
	if (cutIdx <= 0) return compactAll(true);
	return {
		ok: true,
		messages: liveMessages.slice(0, cutIdx).map((item) => item.message),
		firstKeptEntryId: liveMessages[cutIdx].entry.id ?? "",
		compactAll: false,
		keptUserTurns: userIndices.length - targetUserIdx,
		totalUserTurns: userIndices.length,
		requestedKeepUserTurns: normalizedKeepUserTurns,
		keepFallbackToCompactAll: false,
	};
}

function isToolResultRole(role?: string): boolean {
	return role === "toolResult" || role === "tool_result";
}

export function findBudgetCutIndex(live: EntryWithMessage[], maxTokens: number, charsPerToken?: number): number {
	let acc = 0;
	let crossed = -1;
	for (let i = live.length - 1; i >= 0; i--) {
		acc += estimateMessageContentTokens(live[i].message.content, charsPerToken);
		if (acc >= maxTokens) {
			crossed = i;
			break;
		}
	}
	if (crossed < 0) return -1;
	for (let j = Math.max(crossed, 1); j < live.length; j++) {
		if (!isToolResultRole(live[j].message.role)) return j;
	}
	return -1;
}

export function applyTailBudget(
	branchEntries: CompactionEntryLike[],
	cut: OwnCutResult,
	opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number } = {},
): OwnCutResult {
	if (!cut.ok) return cut;
	const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
	const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
	const live = collectLiveMessages(branchEntries);
	const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
		ok: true,
		messages: live.slice(0, idx).map((item) => item.message),
		firstKeptEntryId: live[idx].entry.id ?? "",
		compactAll: false,
		keptUserTurns: live.slice(idx).filter((item) => item.message.role === "user").length,
		totalUserTurns: live.filter((item) => item.message.role === "user").length,
		requestedKeepUserTurns: cut.requestedKeepUserTurns,
		keepFallbackToCompactAll: false,
		budgetCut,
	});
	if (cut.compactAll) {
		if (!cut.keepFallbackToCompactAll) return cut;
		const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
		return idx < 0 ? cut : budgetResult(idx, "no_anchor");
	}
	const tailStart = cut.messages.length;
	let tailTokens = 0;
	for (let i = tailStart; i < live.length; i++) {
		tailTokens += estimateMessageContentTokens(live[i].message.content, opts.charsPerToken);
	}
	if (tailTokens <= maxTokens * factor) return cut;
	const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
	if (idx <= tailStart) return cut;
	return budgetResult(idx, "oversized_tail");
}

function tailTokensForKeep(branchEntries: CompactionEntryLike[], keepUserTurns: number, charsPerToken?: number): number | null {
	const cut = buildOwnCut(branchEntries, keepUserTurns);
	if (!cut.ok || cut.compactAll) return null;
	const idx = branchEntries.findIndex((entry) => entry.id === cut.firstKeptEntryId);
	if (idx < 0) return null;
	const chars = branchEntries.slice(idx)
		.map((entry) => toLiveMessage(entry))
		.filter((message): message is CompactionMessage => !!message)
		.reduce((sum, message) => sum + estimateMessageContentChars(message.content), 0);
	return estimateTokensFromChars(chars, charsPerToken);
}

export function resolveSmartKeepUserTurns(opts: {
	branchEntries: CompactionEntryLike[];
	requestedKeepUserTurns: number | null;
	explicit: boolean;
	smartKeepTail: boolean;
	minTokens?: number;
	maxTokens?: number;
	charsPerToken?: number;
}): { keepUserTurns: number; smartAdjusted: boolean; fromKeep: number } {
	const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
	const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
	const baseKeep = opts.requestedKeepUserTurns ?? 1;
	if (opts.explicit || !opts.smartKeepTail) return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
	const baseTokens = tailTokensForKeep(opts.branchEntries, baseKeep, opts.charsPerToken);
	if (baseTokens == null || baseTokens > minTokens) return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
	const baseCut = buildOwnCut(opts.branchEntries, baseKeep);
	const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;
	let selected = baseKeep;
	for (let keep = baseKeep + 1; keep <= totalUserTurns; keep++) {
		const tokens = tailTokensForKeep(opts.branchEntries, keep, opts.charsPerToken);
		if (tokens == null || tokens > maxTokens) break;
		selected = keep;
	}
	return { keepUserTurns: selected, smartAdjusted: selected !== baseKeep, fromKeep: baseKeep };
}

const KEEP_TOKEN_RE = /^keep:(\d+)$/;

function parseKeepUserTurns(raw: string): number {
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function parseKeepAndPrompt(args?: string): { followUpPrompt: string; keepUserTurns: number | null; keepUserTurnsExplicit: boolean } {
	const trimmed = args?.trim() ?? "";
	if (!trimmed) return { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false };
	const startMatch = trimmed.match(/^keep:(\d+)(?:\s+|$)([\s\S]*)$/);
	if (startMatch) {
		return { followUpPrompt: startMatch[2].trim(), keepUserTurns: parseKeepUserTurns(startMatch[1]), keepUserTurnsExplicit: true };
	}
	const parts = trimmed.split(/\s+/);
	const endMatch = parts.at(-1)?.match(KEEP_TOKEN_RE);
	if (endMatch) {
		return {
			followUpPrompt: trimmed.slice(0, trimmed.length - parts[parts.length - 1].length).trim(),
			keepUserTurns: parseKeepUserTurns(endMatch[1]),
			keepUserTurnsExplicit: true,
		};
	}
	return { followUpPrompt: trimmed, keepUserTurns: null, keepUserTurnsExplicit: false };
}

export function parseCompactionInstructions(customInstructions?: string): {
	isPiVcc: boolean;
	isInternalPiPlans: boolean;
	keepUserTurns: number;
	keepUserTurnsExplicit: boolean;
	followUpPrompt: string | null;
} {
	const trimmed = customInstructions?.trim();
	if (trimmed && INTERNAL_COMPACT_INSTRUCTIONS.has(trimmed)) {
		return { isPiVcc: false, isInternalPiPlans: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
	}
	if (trimmed === PI_VCC_COMPACT_INSTRUCTION) {
		return { isPiVcc: true, isInternalPiPlans: false, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
	}
	const keepPrefix = `${PI_VCC_COMPACT_INSTRUCTION} `;
	if (trimmed?.startsWith(keepPrefix)) {
		const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
		return {
			isPiVcc: true,
			isInternalPiPlans: false,
			keepUserTurns: parsed.keepUserTurns ?? 1,
			keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
			followUpPrompt: null,
		};
	}
	const parsed = parseKeepAndPrompt(customInstructions);
	return {
		isPiVcc: false,
		isInternalPiPlans: false,
		keepUserTurns: parsed.keepUserTurns ?? 1,
		keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
		followUpPrompt: parsed.followUpPrompt || null,
	};
}

type NormalizedBlock =
	| { kind: "user"; text: string; sourceIndex?: number }
	| { kind: "assistant"; text: string; sourceIndex?: number }
	| { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
	| { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
	| { kind: "bash"; command: string; output: string; exitCode?: number; sourceIndex?: number };

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function sanitize(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: CompactionContentPart) => part.type === "text")
		.map((part: CompactionContentPart) => part.text ?? "")
		.join("\n");
}

function normalizeOne(message: CompactionMessage, index: number): NormalizedBlock[] {
	if (message.role === "user") {
		const blocks: NormalizedBlock[] = [];
		const text = sanitize(textOf(message.content));
		if (text) blocks.push({ kind: "user", text, sourceIndex: index });
		for (const part of contentParts(message)) {
			if (part.type === "image") blocks.push({ kind: "user", text: `[image: ${part.mimeType ?? "unknown"}]`, sourceIndex: index });
		}
		return blocks.length ? blocks : [{ kind: "user", text: "", sourceIndex: index }];
	}
	if (message.role === "bashExecution") {
		return [{ kind: "bash", command: String(message.command ?? ""), output: String(message.output ?? ""), exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined, sourceIndex: index }];
	}
	if (isToolResultRole(message.role)) {
		return [{ kind: "tool_result", name: String(message.toolName ?? "tool"), text: sanitize(textOf(message.content)), sourceIndex: index }];
	}
	if (message.role === "assistant") {
		if (!message.content) return [];
		if (typeof message.content === "string") return [{ kind: "assistant", text: sanitize(message.content), sourceIndex: index }];
		const blocks: NormalizedBlock[] = [];
		for (const part of message.content) {
			if (part.type === "text") blocks.push({ kind: "assistant", text: sanitize(part.text ?? ""), sourceIndex: index });
			else if (part.type === "toolCall") {
				const args = typeof part.arguments === "object" && part.arguments !== null ? part.arguments : {};
				blocks.push({ kind: "tool_call", name: part.name ?? "tool", args: args as Record<string, unknown>, sourceIndex: index });
			}
		}
		return blocks;
	}
	return [];
}

function normalize(messages: CompactionMessage[]): NormalizedBlock[] {
	return messages.flatMap((message, index) => normalizeOne(message, index));
}

function nonEmptyLines(text: string): string[] {
	return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function clip(text: string, max = 200): string {
	if (text.length <= max) return text;
	const cut = text.lastIndexOf(" ", max);
	const end = cut > max * 0.6 ? cut : max;
	return text.slice(0, end).trimEnd();
}

function clipSentence(text: string, max = 200): string {
	if (text.length <= max) return text;
	const window = text.slice(0, max);
	const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
	if (matches.length) {
		const end = (matches.at(-1)?.index ?? 0) + 1;
		if (end >= max * 0.5) return text.slice(0, end);
	}
	return clip(text, max);
}

const TASK_RE = /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up|plan|execute)\b/i;
const SCOPE_CHANGE_RE = /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|y|n|k)\s*[.!?]*$/i;
const NON_GOAL_RE = /^\s*[\[│├└─╭╰]|```|^\s*(function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])/;

function extractGoals(blocks: NormalizedBlock[]): string[] {
	const goals: string[] = [];
	let latestScopeChange: string[] | null = null;
	for (const block of blocks) {
		if (block.kind !== "user") continue;
		const lines = nonEmptyLines(block.text)
			.map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
			.filter((line) => line.length > 5 && line.length <= 200 && !NOISE_SHORT_RE.test(line) && !NON_GOAL_RE.test(line));
		if (!lines.length) continue;
		if (!goals.length) {
			goals.push(...lines.slice(0, 6));
			continue;
		}
		const leading = block.text.slice(0, 200);
		if (SCOPE_CHANGE_RE.test(leading) || (TASK_RE.test(leading) && lines[0].length > 15)) {
			latestScopeChange = lines.slice(0, 2).map((line) => clip(line, 200));
		}
	}
	if (latestScopeChange?.length) goals.push("[Scope change]", ...latestScopeChange);
	return goals.slice(0, 8);
}

const PREF_PATTERNS = [
	/\bprefer(?:s|red|ring)?\s+\w/i,
	/\bdon'?t want\b/i,
	/\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
	/\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
	/\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
	/\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
];

function extractPreferences(blocks: NormalizedBlock[], goals: string[]): string[] {
	const seen = new Set(goals.map((goal) => goal.trim().toLowerCase()));
	const prefs: string[] = [];
	for (const block of blocks) {
		if (block.kind !== "user") continue;
		for (const line of nonEmptyLines(block.text)) {
			if (line.length < 5 || line.length > 200 || line.endsWith("?")) continue;
			if (!PREF_PATTERNS.some((pattern) => pattern.test(line))) continue;
			const clipped = clip(line, 200);
			const key = clipped.trim().toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			prefs.push(clipped);
			break;
		}
	}
	return prefs.slice(0, 10);
}

const BLOCKER_RE = /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

function extractOutstandingContext(blocks: NormalizedBlock[]): string[] {
	const items: string[] = [];
	for (const block of blocks.slice(-20)) {
		if (block.kind !== "assistant" && block.kind !== "user") continue;
		for (const line of nonEmptyLines(block.text)) {
			if (!BLOCKER_RE.test(line) || line.length < 15) continue;
			const clipped = block.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
			if (!items.includes(clipped)) items.push(clipped);
			break;
		}
	}
	return items.slice(0, 5);
}

const PATH_KEYS = ["path", "file", "filePath", "file_path", "filename", "url"];

function extractPath(args: Record<string, unknown>): string | null {
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function formatFileActivity(blocks: NormalizedBlock[], fileOps?: FileOpsLike): string[] {
	const read = new Set(fileOps?.readFiles ?? fileOps?.read ?? []);
	const modified = new Set(fileOps?.modifiedFiles ?? [...(fileOps?.written ?? []), ...(fileOps?.edited ?? [])]);
	const created = new Set(fileOps?.createdFiles ?? []);
	for (const block of blocks) {
		if (block.kind !== "tool_call") continue;
		const name = block.name.toLowerCase();
		const file = extractPath(block.args);
		if (!file) continue;
		if (["read", "read_file", "view"].includes(name)) read.add(file);
		if (["edit", "write", "edit_file", "write_file", "multiedit", "quick_edit", "target_edit", "apply_patch"].includes(name)) modified.add(file);
		if (["write", "write_file"].includes(name)) created.add(file);
	}
	for (const file of modified) created.delete(file);
	const cap = (set: Set<string>, limit: number) => {
		const values = [...set].filter(Boolean);
		return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
	};
	const lines: string[] = [];
	if (modified.size) lines.push(`Modified: ${cap(modified, 10)}`);
	if (created.size) lines.push(`Created: ${cap(created, 10)}`);
	if (read.size) lines.push(`Read: ${cap(read, 10)}`);
	return lines;
}

const COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/;
const HASH_RE = /\b([0-9a-f]{7,12})\b/;

function extractCommits(blocks: NormalizedBlock[]): string[] {
	const commits: string[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (block.kind !== "tool_call" || block.name !== "bash") continue;
		const command = typeof block.args.command === "string" ? block.args.command : "";
		if (!/\bgit\s+commit\b/.test(command)) continue;
		const match = command.match(COMMIT_MSG_RE);
		const message = (match?.[1] ?? match?.[2] ?? "").replace(/\\"/g, '"').replace(/\\'/g, "'").trim().split(/\\n|\n/)[0];
		if (!message) continue;
		let hash = "";
		for (let j = index + 1; j < Math.min(blocks.length, index + 3); j++) {
			if (blocks[j].kind !== "tool_result") continue;
			hash = blocks[j].text.match(/\[\S+\s+([0-9a-f]{7,12})\]/)?.[1] ?? blocks[j].text.match(HASH_RE)?.[1] ?? "";
			if (hash) break;
		}
		const line = hash ? `${hash}: ${message}` : message;
		if (!commits.includes(line)) commits.push(line);
	}
	return commits.slice(-8);
}

function compressBash(raw: string): string {
	const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
	const meaningful = lines
		.filter((line) => !/^(?:set\s+[-+]|cd\s+\S+$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#)/.test(line))
		.map((line) => line.replace(/^cd\s+\S+\s*&&\s*/, "").trim())
		.filter(Boolean);
	const command = (meaningful.length ? meaningful : lines).join("; ");
	return command.length > 240 ? `${command.slice(0, 237)}...` : command;
}

function toolOneLiner(name: string, args: Record<string, unknown>): string {
	const file = extractPath(args);
	if (file) return `* ${name} "${file}"`;
	if (/^bash$/i.test(name)) return `* ${name} "${compressBash(String(args.command ?? args.description ?? ""))}"`;
	if (typeof args.query === "string") return `* ${name} "${clip(args.query, 60)}"`;
	return `* ${name}`;
}

function briefBlockText(block: NormalizedBlock): string {
	switch (block.kind) {
		case "user":
			return `[user]\n${clip(block.text.replace(/\s+/g, " ").trim(), 256)}${block.sourceIndex != null ? ` (#${block.sourceIndex})` : ""}`;
		case "assistant":
			return `[assistant]\n${clip(block.text.replace(/^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i, "").trim(), 600)}${block.sourceIndex != null ? ` (#${block.sourceIndex})` : ""}`;
		case "tool_call":
			return `[assistant]\n${toolOneLiner(block.name, block.args)}${block.sourceIndex != null ? ` (#${block.sourceIndex})` : ""}`;
		case "bash":
			return `[user]\n$ ${compressBash(block.command)}${block.sourceIndex != null ? ` (#${block.sourceIndex})` : ""}`;
		case "tool_result":
			return "";
	}
}

const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show)$/i;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn|node|pytest|cargo|go|mvn|gradle)\b[^\n]*(?:test|spec|check|lint|build|tsc)/i;

function scoreBlock(block: NormalizedBlock, index: number, total: number, fileOps?: FileOpsLike): number {
	let score = total <= 1 ? 0 : Math.round((index / (total - 1)) * 12);
	if (block.kind === "user") score += 18;
	if (block.kind === "assistant") score += 10;
	if (block.kind === "tool_call") {
		if (EDIT_TOOL_RE.test(block.name)) score += 34;
		else if (/^bash$/i.test(block.name) && TEST_COMMAND_RE.test(String(block.args.command ?? ""))) score += 26;
		else if (READ_TOOL_RE.test(block.name)) score += 6;
		else score += 12;
		const file = extractPath(block.args);
		if (file && [...(fileOps?.written ?? []), ...(fileOps?.edited ?? []), ...(fileOps?.modifiedFiles ?? [])].includes(file)) score += 18;
		if (file && [...(fileOps?.read ?? []), ...(fileOps?.readFiles ?? [])].includes(file)) score += 6;
	}
	if (block.kind === "bash") {
		score += 8;
		if (block.exitCode != null && block.exitCode !== 0) score += 24;
		if (TEST_COMMAND_RE.test(block.command)) score += 22;
	}
	return score;
}

function selectRankedBriefBlocks(blocks: NormalizedBlock[], fileOps?: FileOpsLike, maxChars = 4_400, maxCharsCeiling = 8_000, charsPerBlock = 60): NormalizedBlock[] {
	const effectiveMaxChars = Math.round(Math.min(maxCharsCeiling, Math.max(maxChars, charsPerBlock * blocks.length)));
	const selected = new Set<number>();
	let usedChars = 0;
	const addIfFits = (index: number): void => {
		if (selected.has(index) || blocks[index].kind === "tool_result") return;
		const rendered = briefBlockText(blocks[index]);
		if (!rendered || usedChars + rendered.length > effectiveMaxChars) return;
		selected.add(index);
		usedChars += rendered.length + 1;
	};
	for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - 16); i--) addIfFits(i);
	const ranked = blocks.map((block, index) => ({ index, score: scoreBlock(block, index, blocks.length, fileOps) }))
		.sort((a, b) => b.score - a.score || b.index - a.index);
	for (const item of ranked) {
		if (selected.size >= 80) break;
		addIfFits(item.index);
	}
	return [...selected].sort((a, b) => a - b).map((index) => blocks[index]);
}

function stringifyBrief(blocks: NormalizedBlock[]): string {
	const lines: string[] = [];
	let lastHeader = "";
	for (const block of blocks) {
		const rendered = briefBlockText(block);
		if (!rendered) continue;
		const [header, ...body] = rendered.split("\n");
		if (header !== lastHeader) {
			if (lines.length && !(header === "[assistant]" && lastHeader === "[assistant]" && body.every((line) => line.startsWith("* ")))) lines.push("");
			lines.push(header);
			lastHeader = header;
		}
		lines.push(...body);
	}
	return lines.join("\n");
}

function capBrief(text: string, maxLines = 120): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const kept = lines.slice(-maxLines);
	const firstHeader = kept.findIndex((line) => /^\[.+\]/.test(line));
	const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
	return `...(${lines.length - clean.length} earlier lines omitted)\n\n${clean.join("\n")}`;
}

const HEADER_NAMES = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"] as const;
const SUMMARY_SEPARATOR = "\n\n---\n\n";

function section(title: typeof HEADER_NAMES[number], items: string[]): string {
	const body = items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
	return `[${title}]\n${body}`;
}

function sectionOf(text: string, header: string): string {
	const tag = `[${header}]`;
	const start = text.indexOf(tag);
	if (start < 0) return "";
	const after = text.slice(start);
	const nextSection = HEADER_NAMES
		.filter((candidate) => candidate !== header)
		.map((candidate) => after.indexOf(`[${candidate}]`))
		.filter((index) => index > 0);
	const nextSep = after.indexOf(SUMMARY_SEPARATOR);
	const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
	const end = candidates[0];
	return (end ? after.slice(0, end) : after).trim();
}

function briefOf(text: string): string {
	const idx = text.indexOf(SUMMARY_SEPARATOR);
	return idx < 0 ? "" : text.slice(idx + SUMMARY_SEPARATOR.length).trim();
}

function sectionLines(sectionText: string): string[] {
	return sectionText.split("\n").slice(1).map((line) => line.trim()).filter((line) => line && line !== "- (none)");
}

function mergeFileLines(prev: string[], fresh: string[]): string[] {
	const categories = ["Modified", "Created", "Read"];
	const merged: Record<string, Set<string>> = { Modified: new Set(), Created: new Set(), Read: new Set() };
	for (const line of [...prev, ...fresh]) {
		for (const category of categories) {
			const prefix = `- ${category}: `;
			if (!line.startsWith(prefix)) continue;
			const rest = line.slice(prefix.length).replace(/\s*\(\+\d+ more\)\s*$/, "");
			for (const item of rest.split(",")) {
				const value = item.trim();
				if (value) merged[category].add(value);
			}
		}
	}
	for (const item of merged.Modified) merged.Created.delete(item);
	const cap = (set: Set<string>, limit: number) => {
		const values = [...set];
		return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
	};
	const lines: string[] = [];
	if (merged.Modified.size) lines.push(`- Modified: ${cap(merged.Modified, 10)}`);
	if (merged.Created.size) lines.push(`- Created: ${cap(merged.Created, 10)}`);
	if (merged.Read.size) lines.push(`- Read: ${cap(merged.Read, 10)}`);
	return lines;
}

function mergeSections(previousSummary: string | undefined, freshSections: Record<typeof HEADER_NAMES[number], string[]>): Record<typeof HEADER_NAMES[number], string[]> {
	const merged = { ...freshSections };
	if (!previousSummary) return merged;
	for (const header of HEADER_NAMES) {
		const prevLines = sectionLines(sectionOf(previousSummary, header));
		if (!prevLines.length) continue;
		const freshLines = freshSections[header].map((line) => `- ${line}`);
		const combined = header === "Files And Changes"
			? mergeFileLines(prevLines, freshLines)
			: [...new Set([...prevLines, ...freshLines])].slice(header === "User Preferences" ? -15 : -8);
		merged[header] = combined.map((line) => line.replace(/^-\s+/, ""));
	}
	return merged;
}

function wrapLongLines(text: string, maxChars = 120): string {
	const wrapped: string[] = [];
	for (const line of text.split("\n")) {
		let remaining = line;
		const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
		const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
		let prefix = "";
		while (prefix.length + remaining.length > maxChars) {
			const available = Math.max(20, maxChars - prefix.length);
			let splitAt = remaining.lastIndexOf(" ", available);
			if (splitAt < Math.floor(available * 0.5)) splitAt = available;
			wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
			remaining = remaining.slice(splitAt).trimStart();
			prefix = continuationIndent;
		}
		wrapped.push(prefix + remaining);
	}
	return wrapped.join("\n");
}

function phaseContextLines(context?: PiPlansVccPhaseContext): Partial<Record<typeof HEADER_NAMES[number], string[]>> {
	if (!context) return {};
	const sessionGoal: string[] = [];
	const outstandingContext: string[] = [];
	if (context.phase === "execution") {
		sessionGoal.push(context.planPath ? `Execute accepted plan ${context.planPath}` : "Execute the accepted pi-plans plan");
		if (context.currentI) outstandingContext.push(`Current implementation item: ${context.currentI}`);
		if (context.remainingVerifierIds?.length) outstandingContext.push(`Remaining verifier items: ${context.remainingVerifierIds.slice(0, 12).join(", ")}`);
		if (context.implementationIds?.length) outstandingContext.push(`Implementation items: ${context.implementationIds.slice(0, 16).join(", ")}`);
	} else {
		sessionGoal.push(context.runId ? `Continue active planning run ${context.runId}` : "Continue active pi-plans planning");
		if (context.planPath) outstandingContext.push(`Latest plan path from session: ${context.planPath}`);
		if (context.artifactDir) outstandingContext.push(`Planning artifact directory from session: ${context.artifactDir}`);
		if (context.currentI) outstandingContext.push(`Current implementation marker observed during planning: ${context.currentI}`);
	}
	return { "Session Goal": sessionGoal, "Outstanding Context": outstandingContext };
}

function legacyPreviousSummaryLine(previousSummary?: string | null): string | null {
	if (!previousSummary?.trim()) return null;
	if (HEADER_NAMES.some((header) => previousSummary.includes(`[${header}]`))) return null;
	const stripped = previousSummary.replace(/#+\s*/g, "").replace(/\s+/g, " ").trim();
	return stripped ? `Previous compact summary: ${compactText(stripped, 260)}` : null;
}

function objectLike(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function legacyReadRecordLine(value: unknown): string | null {
	const record = objectLike(value);
	if (!record) return null;
	if (typeof record.formatted === "string" && record.formatted.trim()) return compactText(record.formatted, 260);
	if (typeof record.path !== "string" || !record.path.trim()) return null;
	let range = typeof record.range === "string" && record.range.trim() ? record.range.trim() : "unknown";
	const start = record.lineStart;
	const end = record.lineEnd;
	if (range === "unknown" && (typeof start === "number" || start === "unknown") && (typeof end === "number" || end === "unknown")) {
		range = start === "unknown" || end === "unknown" ? "unknown" : `${start}-${end}`;
	}
	const summary = typeof record.summary === "string" && record.summary.trim()
		? compactText(record.summary, 160)
		: "legacy read record";
	return `Read: ${record.path.trim()} line ${range} Extracted information summary: ${summary}`;
}

function legacyCompactionContext(branchEntries: CompactionEntryLike[]): { filesAndChanges: string[]; outstandingContext: string[] } {
	const filesAndChanges: string[] = [];
	const outstandingContext: string[] = [];
	for (const entry of branchEntries) {
		if (entry.type !== "compaction") continue;
		const details = objectLike(entry.details ?? entry.data);
		if (!details) continue;
		const readRecords = Array.isArray(details.readRecords) ? details.readRecords : [];
		for (const record of readRecords) {
			const line = legacyReadRecordLine(record);
			if (line && !filesAndChanges.includes(line)) filesAndChanges.push(line);
		}
		const metrics = objectLike(details.metrics);
		const hardFloorReason = metrics?.hardFloorReason;
		if (typeof hardFloorReason === "string" && hardFloorReason.trim()) {
			const line = `Previous compaction hard floor: ${compactText(hardFloorReason, 180)}`;
			if (!outstandingContext.includes(line)) outstandingContext.push(line);
		}
	}
	return {
		filesAndChanges: filesAndChanges.slice(-10),
		outstandingContext: outstandingContext.slice(-5),
	};
}

export function compilePiPlansVccSummary(input: {
	messages: CompactionMessage[];
	previousSummary?: string | null;
	fileOps?: FileOpsLike;
	phaseContext?: PiPlansVccPhaseContext;
	legacyFilesAndChanges?: string[];
	legacyOutstandingContext?: string[];
	charsPerToken?: number;
}): { summary: string; sections: string[]; sourceMessageCount: number } {
	const blocks = normalize(input.messages).filter((block) => block.kind !== "user" || block.text.trim());
	const goals = extractGoals(blocks);
	const prefs = extractPreferences(blocks, goals);
	const phase = phaseContextLines(input.phaseContext);
	const outstanding = [...(input.legacyOutstandingContext ?? []), ...extractOutstandingContext(blocks)];
	const legacy = legacyPreviousSummaryLine(input.previousSummary);
	if (legacy) outstanding.unshift(legacy);
	const briefBlocks = selectRankedBriefBlocks(
		blocks,
		input.fileOps,
		Math.round(1_100 * (input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN)),
		Math.round(2_000 * (input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN)),
		Math.round(15 * (input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN)),
	);
	const freshSections: Record<typeof HEADER_NAMES[number], string[]> = {
		"Session Goal": [...(phase["Session Goal"] ?? []), ...goals],
		"Files And Changes": [...formatFileActivity(blocks, input.fileOps), ...(input.legacyFilesAndChanges ?? [])],
		"Commits": extractCommits(blocks),
		"Outstanding Context": [...(phase["Outstanding Context"] ?? []), ...outstanding],
		"User Preferences": prefs,
	};
	const mergedSections = mergeSections(input.previousSummary ?? undefined, freshSections);
	const freshBrief = stringifyBrief(briefBlocks);
	const previousBrief = input.previousSummary ? briefOf(input.previousSummary) : "";
	const brief = capBrief(previousBrief ? `${previousBrief}\n\n${freshBrief}` : freshBrief);
	const headers = HEADER_NAMES.map((header) => section(header, mergedSections[header])).join("\n\n");
	const summary = wrapLongLines(brief ? `${headers}${SUMMARY_SEPARATOR}${brief}` : headers);
	return { summary, sections: [...HEADER_NAMES], sourceMessageCount: input.messages.length };
}

function fileOpsFromPreparation(fileOps?: FileOpsLike): FileOpsLike {
	return {
		readFiles: fileOps?.readFiles ?? fileOps?.read ?? [],
		modifiedFiles: fileOps?.modifiedFiles ?? [...(fileOps?.written ?? []), ...(fileOps?.edited ?? [])],
		createdFiles: fileOps?.createdFiles ?? [],
	};
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
	no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
	too_few_live_messages: "pi-vcc: Too few messages to compact",
};

function writeDebug(settings: PiPlansVccSettings, data: Record<string, unknown>): void {
	if (!settings.debug) return;
	try {
		writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2));
	} catch {
		// Debug snapshots are best-effort.
	}
}

export function buildPiPlansVccCompaction(options: {
	branchEntries: CompactionEntryLike[];
	preparation: { firstKeptEntryId?: string; tokensBefore?: number; previousSummary?: string | null; fileOps?: FileOpsLike };
	customInstructions?: string;
	reason?: CompactionReason;
	willRetry?: boolean;
	settings: PiPlansVccSettings;
	phaseContext: PiPlansVccPhaseContext;
}): VccCompactionBuildResult {
	const { branchEntries, preparation, settings, phaseContext } = options;
	const parsed = parseCompactionInstructions(options.customInstructions);
	if (!parsed.isPiVcc && !parsed.isInternalPiPlans && !settings.overrideDefaultCompaction) {
		return { kind: "fallback", reason: "override-disabled" };
	}
	const calibrationCut = buildOwnCut(branchEntries, 0);
	const calibrationMessageChars = calibrationCut.ok
		? calibrationCut.messages.reduce((sum, message) => sum + estimateMessageContentChars(message.content), 0)
		: 0;
	const charsPerToken = calibrateCharsPerToken(
		calibrationMessageChars + (preparation.previousSummary?.length ?? 0),
		preparation.tokensBefore,
	);
	const smartKeep = resolveSmartKeepUserTurns({
		branchEntries,
		requestedKeepUserTurns: parsed.keepUserTurnsExplicit ? parsed.keepUserTurns : null,
		explicit: parsed.keepUserTurnsExplicit,
		smartKeepTail: settings.smartKeepTail,
		charsPerToken,
	});
	let cut = buildOwnCut(branchEntries, smartKeep.keepUserTurns);
	if (cut.ok && !parsed.keepUserTurnsExplicit) {
		cut = applyTailBudget(branchEntries, cut, { charsPerToken });
	}
	if (!cut.ok) {
		const fallbackToCore = !parsed.isPiVcc && !parsed.isInternalPiPlans && (options.reason === "overflow" || options.willRetry === true);
		writeDebug(settings, {
			cancelled: !fallbackToCore,
			fallbackToCore,
			reason: cut.reason,
			compaction: { reason: options.reason, willRetry: options.willRetry },
			phase: phaseContext.phase,
			branchEntryCount: branchEntries.length,
		});
		return fallbackToCore ? { kind: "fallback", reason: cut.reason } : { kind: "cancel", message: REASON_MESSAGES[cut.reason], reason: cut.reason };
	}
	const fileOps = fileOpsFromPreparation(preparation.fileOps);
	const legacyContext = legacyCompactionContext(branchEntries);
	const compiled = compilePiPlansVccSummary({
		messages: cut.messages,
		previousSummary: preparation.previousSummary,
		fileOps,
		phaseContext,
		legacyFilesAndChanges: legacyContext.filesAndChanges,
		legacyOutstandingContext: legacyContext.outstandingContext,
		charsPerToken,
	});
	const live = collectLiveMessages(branchEntries);
	const cutIndex = cut.firstKeptEntryId ? live.findIndex((item) => item.entry.id === cut.firstKeptEntryId) : -1;
	const keptLive = cutIndex >= 0 ? live.slice(cutIndex) : [];
	const keptTokensEst = keptLive.reduce((sum, item) => sum + estimateMessageContentTokens(item.message.content, charsPerToken), 0);
	const estimatedSummaryTokens = estimateTokensFromChars(compiled.summary.length, charsPerToken);
	const stats: VccCompactionStats = {
		summarized: cut.messages.length,
		kept: keptLive.length,
		keptUserTurns: cut.keptUserTurns,
		totalUserTurns: cut.totalUserTurns,
		requestedKeepUserTurns: cut.requestedKeepUserTurns,
		keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
		keepFallbackToCompactAll: cut.keepFallbackToCompactAll,
		budgetCut: cut.budgetCut,
		keptTokensEst,
		estimatedSummaryTokens,
		estimatedTokensAfter: keptTokensEst + estimatedSummaryTokens,
		smartKeepAdjusted: smartKeep.smartAdjusted,
		smartFromKeep: smartKeep.fromKeep,
		reason: options.reason,
		willRetry: options.willRetry,
	};
	const details: PiPlansCompactionDetails = {
		compactor: "pi-vcc",
		version: 1,
		sections: compiled.sections,
		sourceMessageCount: compiled.sourceMessageCount,
		previousSummaryUsed: Boolean(preparation.previousSummary),
		reason: options.reason,
		willRetry: options.willRetry,
		phase: phaseContext.phase,
		stats,
	};
	writeDebug(settings, {
		usedOwnCut: true,
		phase: phaseContext.phase,
		budgetCut: cut.budgetCut,
		compaction: { reason: options.reason, willRetry: options.willRetry },
		messagesToSummarize: cut.messages.length,
		firstKeptEntryId: cut.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		charsPerToken,
		sections: compiled.sections,
	});
	return {
		kind: "compaction",
		compaction: {
			summary: compiled.summary,
			firstKeptEntryId: cut.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore ?? 0,
			estimatedTokensAfter: stats.estimatedTokensAfter,
			details,
		},
		stats,
		followUpPrompt: parsed.followUpPrompt,
		settings,
	};
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.max(0, Math.round(tokens)));
}

export function formatVccCompactionStats(stats: VccCompactionStats): string {
	if (stats.budgetCut) {
		const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
		return `pi-vcc: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.`;
	}
	const notes = [`summarized ${stats.summarized}`];
	if (stats.smartKeepAdjusted) notes.push(`smart-keep ${stats.smartFromKeep ?? 1}->${stats.requestedKeepUserTurns}`);
	return `pi-vcc: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
}

function parseVersionCore(version: unknown): [number, number, number] | null {
	if (typeof version !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function shouldScheduleAutoContinue(settingEnabled: boolean, piVersion: unknown): boolean {
	if (!settingEnabled) return false;
	const running = parseVersionCore(piVersion);
	if (!running) return false;
	for (let i = 0; i < 3; i++) {
		if (running[i] !== PI_SELF_RESUME_VERSION[i]) return running[i] < PI_SELF_RESUME_VERSION[i];
	}
	return false;
}
