import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createEditTool,
	createReadTool,
	createWriteTool,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import { isIndexablePath } from "../src/code-graph/discovery.ts";
import { resolveGraphMode, type GraphMode } from "../src/code-graph/mode.ts";
import { normalizeRelative, PathError } from "../src/code-graph/paths.ts";
import { updateFile } from "../src/code-graph/mutations.ts";
import type { Language } from "../src/code-graph/types.ts";
import { ensureRuntime, type CodeGraphContext, type RuntimeCacheEntry } from "./code-graph.ts";

interface GraphPathInfo {
	absolutePath: string;
	relativePath: string;
	fileDir: string;
	fileName: string;
	language: Language;
}

interface GraphSnapshot {
	info: GraphPathInfo;
	text: string;
}

interface FunctionRow {
	function_name: string;
	is_primary: number;
	provenance_start_line: number | null;
	provenance_end_line: number | null;
	provenance_start_byte: number | null;
	provenance_end_byte: number | null;
	summary_description: string | null;
}

type GraphToolSet = ReturnType<typeof createGraphAwareFileTools>;

/** Files smaller than this are returned in full by default (digest not worth it). */
const FULL_FILE_MAX_LINES = 200;
/** Hard cap for digest output, header/footer lines included. */
const DIGEST_MAX_LINES = 50;
/** Native-equivalent full-read truncation hints are provided by truncateHead. */

const toolCache = new Map<string, GraphToolSet>();

function getBaseTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
	};
}

const GraphReadParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	full: Type.Optional(
		Type.Boolean({
			description:
				"Return the whole file (through the same safety truncation as native read) instead of the default function digest",
		}),
	),
});

function languageForFileName(fileName: string): Language | null {
	switch (path.extname(fileName).toLowerCase()) {
		case ".js":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".ts":
			return "typescript";
		case ".tsx":
			return "tsx";
		case ".py":
			return "python";
		default:
			return null;
	}
}

function resolveGraphPath(cwd: string, worktreeRoot: string, target: string): GraphPathInfo | null {
	const absolutePath = path.resolve(cwd, target);
	const relativePath = path.relative(worktreeRoot, absolutePath).split(path.sep).join("/");
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
	if (!isIndexablePath(relativePath)) return null;
	try {
		const { fileDir, fileName } = normalizeRelative(worktreeRoot, absolutePath);
		const language = languageForFileName(fileName);
		if (!language) return null;
		return { absolutePath, relativePath, fileDir, fileName, language };
	} catch (error) {
		if (error instanceof PathError) return null;
		throw error;
	}
}

function sliceByLines(text: string, offset?: number, limit?: number): string {
	const lines = text.split("\n");
	const start = offset ? Math.max(0, offset - 1) : 0;
	const end = limit !== undefined ? start + Math.max(0, limit) : lines.length;
	return lines.slice(start, end).join("\n");
}

function countLines(text: string): number {
	return text.split("\n").length;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find((entry) => entry.type === "text" && typeof entry.text === "string");
	return part?.text ?? "";
}

function loadGraphSnapshot(entry: RuntimeCacheEntry, info: GraphPathInfo): GraphSnapshot | null {
	const row = entry.store.read(() =>
		entry.store.db
			.prepare(`SELECT source_text, pending_kind FROM files WHERE file_dir = ? AND file_name = ?`)
			.get(info.fileDir, info.fileName),
	) as { source_text: string; pending_kind: string | null } | undefined;
	if (!row || row.pending_kind === "delete") return null;
	return {
		info,
		text: row.source_text,
	};
}

function loadFunctionRows(entry: RuntimeCacheEntry, info: GraphPathInfo): FunctionRow[] {
	return entry.store.read(() =>
		entry.store.db
			.prepare(
				`SELECT function_name, is_primary, provenance_start_line, provenance_end_line,
					provenance_start_byte, provenance_end_byte, summary_description
				 FROM functions WHERE file_dir = ? AND file_name = ?`,
			)
			.all(info.fileDir, info.fileName),
	) as FunctionRow[];
}

/** Provenance offsets are byte offsets: decode via Buffer, never string.slice. */
function describeSlice(text: string, startByte: number | null, endByte: number | null): string {
	if (startByte === null || endByte === null || endByte <= startByte) return "";
	try {
		const buf = Buffer.from(text, "utf8");
		const slice = buf.subarray(startByte, Math.min(endByte, buf.length)).toString("utf8");
		return slice.split("\n")[0]?.trim() ?? "";
	} catch {
		return "";
	}
}

function truncatedDetails(
	truncation: ReturnType<typeof truncateHead>,
	totalLines: number,
): Record<string, unknown> {
	// Counts only — never the content copy; the text already lives in `content`.
	return {
		truncated: truncation.truncated === true,
		truncatedBy: truncation.truncatedBy ?? null,
		totalLines,
		outputLines: truncation.outputLines,
		outputBytes: truncation.outputBytes,
		maxLines: truncation.maxLines,
		maxBytes: truncation.maxBytes,
	};
}

function fullTextResult(text: string, offset?: number, limit?: number) {
	const totalLines = countLines(text);
	if (offset !== undefined && offset > totalLines) {
		// Align with native read: an offset past EOF is a caller error.
		throw new Error(`offset ${offset} beyond end of file (${totalLines} lines)`);
	}
	const selected = sliceByLines(text, offset, limit);
	const truncation = truncateHead(selected, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return {
		content: [{ type: "text", text: truncation.content }],
		details: truncatedDetails(truncation, totalLines),
	};
}

/**
 * Compact function digest: one line per named function, synthetic anonymous
 * entries folded into a single count, capped at DIGEST_MAX_LINES with a tail
 * pointer to the low-token graph tools.
 */
function buildDigest(info: GraphPathInfo, text: string, rows: FunctionRow[]) {
	const totalLines = countLines(text);
	const named: FunctionRow[] = [];
	let anonymous = 0;
	for (const row of rows) {
		if (row.function_name.includes("<anonymous")) {
			anonymous++;
			continue;
		}
		named.push(row);
	}
	named.sort((a, b) => {
		const primary = (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0);
		if (primary !== 0) return primary;
		return (a.provenance_start_line ?? 0) - (b.provenance_start_line ?? 0);
	});

	const lines: string[] = [
		`${info.relativePath} · ${info.language} · ${named.length} functions${anonymous ? ` (+${anonymous} anonymous)` : ""}`,
	];
	const bodyBudget = DIGEST_MAX_LINES - 2; // header + footer
	for (const row of named) {
		if (lines.length >= bodyBudget - 1) break; // reserve one line for the "+M more" tail
		const description = (row.summary_description ?? "").trim() || describeSlice(text, row.provenance_start_byte, row.provenance_end_byte);
		const range =
			row.provenance_start_line && row.provenance_end_line ? ` (${row.provenance_start_line}-${row.provenance_end_line})` : "";
		lines.push(`${row.function_name}${range}${description ? ` ${description}` : ""}`);
	}
	const hidden = named.length - (lines.length - 1);
	if (hidden > 0) {
		lines.push(`…+${hidden} more (code_graph screening / get-function)`);
	}
	lines.push(`Use full:true for the whole file (${totalLines} lines, safety-truncated), or code_graph get-function for one function body.`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { functions: named.length, anonymous, shown: Math.max(0, lines.length - 2), hidden: Math.max(0, hidden), totalLines },
	};
}

function createGraphReadTool(cwd: string) {
	const base = getBaseTools(cwd).read;
	return {
		...base,
		parameters: GraphReadParams,
		async execute(
			toolCallId: string,
			params: { path: string; offset?: number; limit?: number; full?: boolean },
			signal: AbortSignal | undefined,
			onUpdate: any,
			ctx: CodeGraphContext,
		) {
			const native = async (marker: string | null) => {
				const result = await getBaseTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
				if (!marker) return result;
				return {
					...result,
					content: [{ type: "text", text: `[graph-read fallback: ${marker} → native]\n${textContent(result)}` }],
				};
			};
			const mode: GraphMode = resolveGraphMode(ctx.cwd);
			if (mode === "off") return native(null);
			if (mode === "config-unavailable") return native("config read failed");
			const ensured = await ensureRuntime(ctx.cwd, ctx);
			if (!ensured) return native("runtime unavailable");
			const info = resolveGraphPath(ctx.cwd, ensured.entry.paths.worktreeRoot, params.path);
			if (!info) return native(null); // not an indexable source file: native by design
			const snapshot = loadGraphSnapshot(ensured.entry, info);
			if (!snapshot) return native("not indexed");
			const wantsFull = params.full === true || params.offset !== undefined || params.limit !== undefined;
			if (wantsFull) return fullTextResult(snapshot.text, params.offset, params.limit);
			const rows = loadFunctionRows(ensured.entry, info);
			if (countLines(snapshot.text) < FULL_FILE_MAX_LINES || rows.length === 0) {
				return fullTextResult(snapshot.text, params.offset, params.limit);
			}
			return buildDigest(info, snapshot.text, rows);
		},
	};
}

function createGraphWriteTool(cwd: string) {
	const base = getBaseTools(cwd).write;
	return {
		...base,
		async execute(toolCallId: string, params: { path: string; content: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: CodeGraphContext) {
			const stage = async (marker: string | null) => {
				const result = await getBaseTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
				if (!marker) return result;
				return {
					...result,
					content: [{ type: "text", text: `[graph-write fallback: ${marker} → native]\n${textContent(result)}` }],
				};
			};
			const mode: GraphMode = resolveGraphMode(ctx.cwd);
			if (mode === "off") return stage(null);
			if (mode === "config-unavailable") return stage("config read failed");
			const ensured = await ensureRuntime(ctx.cwd, ctx);
			if (!ensured) return stage("runtime unavailable");
			const info = resolveGraphPath(ctx.cwd, ensured.entry.paths.worktreeRoot, params.path);
			if (!info) return stage(null);
			const mutation = updateFile(ensured.entry.store, {
				fileDir: info.fileDir,
				fileName: info.fileName,
				text: params.content,
				language: info.language,
			});
			if (!mutation.ok) {
				throw new Error(`code graph write failed: ${mutation.reason ?? "unknown error"}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `code graph: staged ${mutation.created ? "new" : "updated"} file ${info.relativePath}; run /apply-graph to materialize`,
					},
				],
				details: {},
			};
		},
	};
}

function createGraphEditTool(cwd: string) {
	const base = getBaseTools(cwd).edit;
	return {
		...base,
		async execute(toolCallId: string, params: { path: string; edits: Array<{ oldText: string; newText: string }> }, signal: AbortSignal | undefined, onUpdate: any, ctx: CodeGraphContext) {
			const stage = async (marker: string | null) => {
				const result = await getBaseTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
				if (!marker) return result;
				return {
					...result,
					content: [{ type: "text", text: `[graph-edit fallback: ${marker} → native]\n${textContent(result)}` }],
				};
			};
			const mode: GraphMode = resolveGraphMode(ctx.cwd);
			if (mode === "off") return stage(null);
			if (mode === "config-unavailable") return stage("config read failed");
			const ensured = await ensureRuntime(ctx.cwd, ctx);
			if (!ensured) return stage("runtime unavailable");
			const info = resolveGraphPath(ctx.cwd, ensured.entry.paths.worktreeRoot, params.path);
			if (!info) return stage(null);
			const snapshot = loadGraphSnapshot(ensured.entry, info);
			if (!snapshot) {
				throw new Error(`code graph: ${info.relativePath} is not indexed; run /update-graph or /init-graph first`);
			}
			let stagedText: string | null = null;
			const graphEdit = createEditTool(ctx.cwd, {
				operations: {
					access: async () => {},
					readFile: async () => Buffer.from(snapshot.text, "utf8"),
					writeFile: async (_absolutePath: string, content: string) => {
						stagedText = content;
					},
				},
			});
			const result = await graphEdit.execute(toolCallId, params, signal, onUpdate);
			if (stagedText === null) {
				throw new Error(`code graph edit failed: no staged content captured for ${info.relativePath}`);
			}
			const mutation = updateFile(ensured.entry.store, {
				fileDir: info.fileDir,
				fileName: info.fileName,
				text: stagedText,
				language: info.language,
			});
			if (!mutation.ok) {
				throw new Error(`code graph edit failed: ${mutation.reason ?? "unknown error"}`);
			}
			return {
				...result,
				content: [
					{
						type: "text",
						text: `${textContent(result)} (staged in code graph; run /apply-graph to materialize)`,
					},
				],
			};
		},
	};
}

export function createGraphAwareFileTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = {
			read: createGraphReadTool(cwd),
			write: createGraphWriteTool(cwd),
			edit: createGraphEditTool(cwd),
		};
		toolCache.set(cwd, tools);
	}
	return tools;
}

export function registerGraphAwareFileTools(pi: ExtensionAPI, cwd = process.cwd()): void {
	const tools = createGraphAwareFileTools(cwd);
	pi.registerTool(tools.read);
	pi.registerTool(tools.write);
	pi.registerTool(tools.edit);
}
