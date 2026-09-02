/**
 * LLM screening pipeline for code-graph. Records explicit consent and
 * gracefully degrades to pending/declined summaries when the host has no UI
 * or no model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hashText } from "./parser.ts";
import { Store } from "./store.ts";
import type { FunctionRecord, SummaryRecord } from "./types.ts";

export interface CompletionRequest {
	messages: Array<{ role: "user"; content: string }>;
}

export interface CompletionHandle {
	complete: (request: CompletionRequest) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		stopReason?: string;
	}>;
	model?: () => { provider?: string; id?: string; api?: string; reasoning?: boolean };
	thinkingLevel?: () => string | undefined;
	hasUI?: boolean;
	confirm?: (title: string, body: string) => Promise<boolean>;
	notify?: (message: string, kind?: "info" | "warning" | "error") => void;
}

export interface SummaryOptions {
	store: Store;
	ctx: CompletionHandle;
	batchTokens?: number;
	skipConsent?: boolean;
}

export interface SummaryReport {
	processed: number;
	ok: number;
	failed: number;
	declined: number;
	batches: number;
}

const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		description: { type: "string", maxLength: 280 },
		inputs: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 8 },
		outputs: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 8 },
	},
	required: ["description", "inputs", "outputs"],
	additionalProperties: false,
} as const;

/** Conservative default prompt budget per completion call. Provider token
 * counts vary; character-based estimates here intentionally bias low so the
 * system cannot exceed typical context windows even with prompt overhead. */
const DEFAULT_BATCH_TOKENS = 8_000;
/** Characters-per-token ratio used for the conservative estimate. */
const CHARS_PER_TOKEN = 4;
/** Per-entry overhead added to the estimate (path, name, separator). */
const PER_ENTRY_OVERHEAD_TOKENS = 32;
/** Maximum allowed characters for a persisted `summary_error` value. */
const SUMMARY_ERROR_MAX_LENGTH = 240;

const SYSTEM_PROMPT = `You summarize code functions in structured JSON. Each input block starts with a "ref:" line. For each input return exactly one JSON object matching {ref: string, description: string, inputs: string[], outputs: string[]} where ref is the exact ref line value copied verbatim, description <= 280 chars, and arrays of short strings (<= 80 chars, <= 8 entries). Do not include any explanation or additional fields. Output one JSON object per input.`;

/** Opaque alignment key echoed back by the model. Built in ONE place so
 * prompt, alignment, and DB writes can never disagree. */
export function buildRef(fileDir: string, fileName: string, functionName: string): string {
	return `${fileDir}/${fileName}::${functionName}`;
}

export interface PendingSummary {
	fileDir: string;
	fileName: string;
	functionName: string;
	fullCodeHash: string;
	language: string;
	fullCode: string;
}

export function pendingFunctions(store: Store): PendingSummary[] {
	const rows = store
		.read(() =>
			store.db
				.prepare(
					`SELECT file_dir, file_name, function_name, full_code_hash, language, full_code
					 FROM functions
					 WHERE summary_status IS NULL OR summary_status = 'pending' OR summary_status = 'failed'`,
				)
				.all(),
		) as Array<{ file_dir: string; file_name: string; function_name: string; full_code_hash: string; language: string; full_code: string }>;
	return rows.map((row) => ({
		fileDir: row.file_dir,
		fileName: row.file_name,
		functionName: row.function_name,
		fullCodeHash: row.full_code_hash,
		language: row.language,
		fullCode: row.full_code,
	}));
}

function cacheKey(input: PendingSummary): string {
	return `${input.language}:${input.fullCodeHash}`;
}

interface CacheEntry {
	summary: SummaryRecord;
}

const cache = new Map<string, CacheEntry>();

function boundedLength(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function boundedErrorMessage(message: string): string {
	const trimmed = message.replace(/[\r\n\t]+/g, " ").trim();
	return boundedLength(trimmed, SUMMARY_ERROR_MAX_LENGTH);
}

function estimateEntryTokens(entry: PendingSummary): number {
	const header = `${entry.fileDir}/${entry.fileName}::${entry.functionName}\n`;
	const chars = header.length + entry.fullCode.length;
	return Math.ceil(chars / CHARS_PER_TOKEN) + PER_ENTRY_OVERHEAD_TOKENS;
}

/** Greedy, deterministic batch builder. Each batch keeps a running token
 * estimate; an entry that does not fit becomes the start of the next batch.
 * A single oversized entry still forms its own batch (no batching progress
 * must silently drop or split an entry). */
export function buildBatches(pending: PendingSummary[], batchTokens: number): PendingSummary[][] {
	const limit = Math.max(1, batchTokens | 0);
	const batches: PendingSummary[][] = [];
	let current: PendingSummary[] = [];
	let currentTokens = 0;
	for (const entry of pending) {
		const entryTokens = estimateEntryTokens(entry);
		if (current.length === 0) {
			current = [entry];
			currentTokens = entryTokens;
			continue;
		}
		if (currentTokens + entryTokens <= limit) {
			current.push(entry);
			currentTokens += entryTokens;
		} else {
			batches.push(current);
			current = [entry];
			currentTokens = entryTokens;
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function validate(record: unknown): SummaryRecord | null {
	if (!record || typeof record !== "object") return null;
	const obj = record as Record<string, unknown>;
	if (typeof obj.description !== "string") return null;
	if (!Array.isArray(obj.inputs) || !Array.isArray(obj.outputs)) return null;
	if (!obj.inputs.every((s) => typeof s === "string")) return null;
	if (!obj.outputs.every((s) => typeof s === "string")) return null;
	const description = boundedLength(obj.description, 280);
	const inputs = (obj.inputs as string[]).slice(0, 8).map((s) => boundedLength(s, 80));
	const outputs = (obj.outputs as string[]).slice(0, 8).map((s) => boundedLength(s, 80));
	return {
		description,
		inputs,
		outputs,
		status: "ok",
		schemaVersion: 1,
	};
}

/** Quote-aware balanced-brace scanner: extracts top-level {...} object
 *  substrings from raw model output, tolerating pretty-printed objects that
 *  span lines, multiple objects on one line, and garbage between objects.
 *  A truncated final object is dropped (never mis-parsed). Strings and
 *  escapes are skipped so braces inside literals cannot split an object. */
export function parseSummaryObjects(raw: string): unknown[] {
	const objects: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			if (depth > 0) {
				depth--;
				if (depth === 0 && start >= 0) {
						try {
							objects.push(JSON.parse(raw.slice(start, i + 1)));
						} catch {
							/* malformed object: skip */
						}
						start = -1;
					}
				}
			}
	}
	return objects;
}

export interface AlignOutcome {
	/** Per-input-function resolution, aligned with `updates` order. */
	aligned: Array<{ entry: PendingSummary; record: unknown } | { entry: PendingSummary; record: null }>;
	/** true when order fallback was used (zero ref-carrying records, count equal). */
	orderFallback: boolean;
}

/** Align parsed records back to batch functions by their echoed `ref`.
 *  Duplicates: first wins. Unknown refs are dropped (uncounted). When NO
 *  record carries a usable ref AND counts match exactly, fall back to order
 *  alignment (the pre-ref contract) so legacy responses keep working. */
export function alignByRef(updates: PendingSummary[], records: unknown[]): AlignOutcome {
	const byRef = new Map<string, unknown>();
	let refRecords = 0;
	for (const record of records) {
		const ref = record && typeof record === "object" && typeof (record as Record<string, unknown>).ref === "string"
			? (record as Record<string, unknown>).ref
			: null;
		if (ref === null) continue;
		refRecords++;
		if (!byRef.has(ref)) byRef.set(ref, record);
	}
	const orderFallback = refRecords === 0 && records.length === updates.length;
	const aligned: AlignOutcome["aligned"] = updates.map((entry, index) => {
		if (orderFallback) return { entry, record: records[index] ?? null };
		return { entry, record: byRef.get(buildRef(entry.fileDir, entry.fileName, entry.functionName)) ?? null };
	});
	return { aligned, orderFallback };
}

function effectiveEffort(ctx: CompletionHandle): string | undefined {
	const model = ctx.model?.();
	if (!model) return undefined;
	const api = model.api ?? "";
	if (api.includes("openai-completions") || api.includes("openai-responses") || api.includes("anthropic")) {
		return "low";
	}
	return undefined;
}

async function userConsent(opts: SummaryOptions, pending: PendingSummary[]): Promise<boolean> {
	if (opts.skipConsent) return true;
	if (!opts.ctx.hasUI) return false;
	if (!opts.ctx.confirm) return false;
	const model = opts.ctx.model?.();
	const body = [
		`Functions awaiting summary: ${pending.length}`,
		`Model: ${model ? `${model.provider ?? "?"}/${model.id ?? "?"}` : "unknown"}`,
		`Thinking level: ${opts.ctx.thinkingLevel?.() ?? "default"}`,
		`Reasoning capability: ${model?.reasoning ? "yes" : "no"}`,
		`Send source code for each function to the current model?`,
	].join("\n");
	return await opts.ctx.confirm("Generate code summaries with LLM?", body);
}

export async function generateSummaries(opts: SummaryOptions): Promise<SummaryReport> {
	const pending = pendingFunctions(opts.store);
	if (pending.length === 0) {
		return { processed: 0, ok: 0, failed: 0, declined: 0, batches: 0 };
	}
	const consent = await userConsent(opts, pending);
	if (!consent) {
		markDeclined(opts.store, pending);
		return { processed: pending.length, ok: 0, failed: 0, declined: pending.length, batches: 0 };
	}
	const effort = effectiveEffort(opts.ctx);
	const batchTokens = opts.batchTokens ?? DEFAULT_BATCH_TOKENS;
	const batches = buildBatches(pending, batchTokens);
	const report: SummaryReport = {
		processed: 0,
		ok: 0,
		failed: 0,
		declined: 0,
		batches: batches.length,
	};
	for (let index = 0; index < batches.length; index++) {
		const updates = batches[index];
		opts.ctx.notify?.(
			`code-graph summary batch ${index + 1}/${batches.length} (${updates.length} function(s))`,
			"info",
		);
		const prompts = updates
			.map((entry) => `ref: ${buildRef(entry.fileDir, entry.fileName, entry.functionName)}\n${entry.fullCode}`)
			.join("\n---\n");
		try {
			const response = await opts.ctx.complete({
				messages: [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${prompts}` }],
			});
			const texts = response.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const records = parseSummaryObjects(texts);
			const { aligned, orderFallback } = alignByRef(updates, records);
			if (orderFallback) {
				opts.ctx.notify?.("code-graph summary: no refs echoed; aligned by order (legacy response shape)", "info");
			}
			const applied = applyAligned(opts.store, aligned, effort);
			report.processed += applied.processed;
			report.ok += applied.ok;
			report.failed += applied.failed;
		} catch (error) {
			const message = boundedErrorMessage((error as Error).message || "completion failed");
			markFailed(opts.store, updates, message);
			report.processed += updates.length;
			report.failed += updates.length;
		}
	}
	return report;
}

function markDeclined(store: Store, pending: PendingSummary[]): void {
	const stmt = store.prepare(
		"update_declined",
		`UPDATE functions SET summary_status = 'declined', summary_updated_at = ?,
			summary_description = NULL, summary_inputs = NULL, summary_outputs = NULL
		 WHERE file_dir = ? AND file_name = ? AND function_name = ?`,
	);
	store.tx(() => {
		const now = new Date().toISOString();
		for (const entry of pending) {
			stmt.run(now, entry.fileDir, entry.fileName, entry.functionName);
		}
	});
}

function markFailed(store: Store, pending: PendingSummary[], message: string): void {
	const stmt = store.prepare(
		"update_failed",
		`UPDATE functions SET summary_status = 'failed', summary_error = ?, summary_updated_at = ?
		 WHERE file_dir = ? AND file_name = ? AND function_name = ?`,
	);
	const text = boundedErrorMessage(message);
	store.tx(() => {
		const now = new Date().toISOString();
		for (const entry of pending) {
			stmt.run(text, now, entry.fileDir, entry.fileName, entry.functionName);
		}
	});
}

function applyAligned(
	store: Store,
	aligned: AlignOutcome["aligned"],
	effort: string | undefined,
): { processed: number; ok: number; failed: number } {
	const stmt = store.prepare(
		"update_summary",
		`UPDATE functions SET
			summary_description = ?,
			summary_inputs = ?,
			summary_outputs = ?,
			summary_status = ?,
			summary_model = ?,
			summary_schema_version = ?,
			summary_effective_effort = ?,
			summary_error = NULL,
			summary_updated_at = ?
		 WHERE file_dir = ? AND file_name = ? AND function_name = ?`,
	);
	const failStmt = store.prepare(
		"update_failed_single",
		`UPDATE functions SET summary_status = 'failed', summary_error = ?, summary_updated_at = ?
		 WHERE file_dir = ? AND file_name = ? AND function_name = ?`,
	);
	let ok = 0;
	let failed = 0;
	store.tx(() => {
		const now = new Date().toISOString();
		for (const slot of aligned) {
			const validated = slot.record === null ? null : validate(slot.record);
			if (!validated) {
				const ref = buildRef(slot.entry.fileDir, slot.entry.fileName, slot.entry.functionName);
				const reason = slot.record === null
					? `no aligned summary record for ${ref} (missing/unknown ref or unparseable object)`
					: `invalid summary fields for ${ref}`;
				failStmt.run(boundedErrorMessage(reason), now, slot.entry.fileDir, slot.entry.fileName, slot.entry.functionName);
				failed++;
				continue;
			}
			stmt.run(
				validated.description,
				JSON.stringify(validated.inputs),
				JSON.stringify(validated.outputs),
				"ok",
				"(current-model)",
				1,
				effort ?? null,
				now,
				slot.entry.fileDir,
				slot.entry.fileName,
				slot.entry.functionName,
			);
			cache.set(cacheKey(slot.entry), { summary: validated });
			ok++;
		}
	});
	return { processed: aligned.length, ok, failed };
}

export function clearSummaryCache(): void {
	cache.clear();
}

export function summaryCacheStats(): { size: number } {
	return { size: cache.size };
}

export { SUMMARY_SCHEMA };

// Minimal smoke: ensures the schema object remains usable as a JSON Schema
// description for tests and documentation.
if (process.env.PI_PLANS_GRAPH_DUMP_SCHEMA === "1") {
	const dumpPath = path.join(fs.realpathSync("."), "code-graph-summary.schema.json");
	fs.writeFileSync(dumpPath, JSON.stringify(SUMMARY_SCHEMA, null, 2));
}
