/**
 * Agent-facing graph tool. Eagerly avoids importing node:sqlite or the
 * parsers at module load; both are loaded on first action call.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	loadGraphRuntime,
	describeRuntimeIssues,
	type RuntimeStatus,
} from "../src/code-graph/runtime.ts";
import { resolveCanonicalWorktree } from "../src/code-graph/paths.ts";
import type { WorktreePaths } from "../src/code-graph/paths.ts";
import { Store } from "../src/code-graph/store.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import { hashText } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";
import { screeningQuery } from "../src/code-graph/screening.ts";
import { deleteFile, listPending, updateFile, updateFunction } from "../src/code-graph/mutations.ts";

const CodeGraphParams = Type.Object({
	action: StringEnum(
		[
			"status",
			"screening",
			"get-function",
			"update-function",
			"update-file",
			"delete-file",
			"list-pending",
			"reindex",
			"manifest",
		] as const,
		{ description: "Code graph action to perform" },
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace directory" })),
	language: Type.Optional(StringEnum(["javascript", "typescript", "tsx", "python"] as const)),
	functionName: Type.Optional(Type.String()),
	fileDir: Type.Optional(Type.String({ description: "File directory (POSIX, '.' for root)" })),
	fileName: Type.Optional(Type.String({ description: "File name without directory" })),
	fullCode: Type.Optional(Type.String({ description: "New function body text for update-function" })),
	text: Type.Optional(Type.String({ description: "New whole-file text for update-file" })),
	limit: Type.Optional(Type.Number()),
	force: Type.Optional(Type.Boolean()),
});

export type CodeGraphContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

export interface RuntimeCacheEntry {
	runtime: Awaited<ReturnType<typeof loadGraphRuntime>>["runtime"];
	parsers: Record<Language, ParserBackend>;
	paths: WorktreePaths;
	store: Store;
}

let runtimeCache: RuntimeCacheEntry | null = null;

export async function ensureRuntime(workdir: string, ctx: CodeGraphContext): Promise<{ entry: RuntimeCacheEntry; status: RuntimeStatus } | null> {
	const { runtime, status } = await loadGraphRuntime();
	if (status.issues.length > 0 && !status.sqliteAvailable && !status.parserAvailable) {
		ctx.ui?.notify?.(`code-graph unavailable: ${describeRuntimeIssues(status).join("; ")}`, "warning");
		return null;
	}
	const paths = resolveCanonicalWorktree(workdir);
	if (!runtimeCache || runtimeCache.paths.codeGraphDb !== paths.codeGraphDb) {
		if (runtimeCache) {
			runtimeCache.store.close();
			runtimeCache = null;
		}
		const store = new Store({ dbPath: paths.codeGraphDb, worktreeRoot: paths.worktreeRoot, gitCommonDir: paths.gitCommonDir }, runtime.sqlite);
		try {
			store.checkWorktree(paths.worktreeRoot, paths.gitCommonDir);
		} catch (error) {
			store.close();
			ctx.ui?.notify?.(`code-graph: ${(error as Error).message}`, "error");
			return null;
		}
		const ParserCtor = runtime.parser.Parser as unknown as new () => { parse(input: string | Buffer): unknown; setLanguage(language: unknown): void };
		const parsers: Record<Language, ParserBackend> = {
			javascript: makeBackend("javascript", ParserCtor, runtime.parser.javascript),
			typescript: makeBackend("typescript", ParserCtor, runtime.parser.typescript),
			tsx: makeBackend("tsx", ParserCtor, runtime.parser.tsx),
			python: new PythonBackend(ParserCtor, runtime.parser.python),
		};
		runtimeCache = { runtime, parsers, paths, store };
	}
	return { entry: runtimeCache, status };
}

export function registerCodeGraphTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "code_graph",
		label: "Code Graph",
		description:
			"Read-only code-graph actions: status, screening (no full_code), function read, reindex guard, manifest summary. No agent mutation API in v1.",
		promptSnippet: "Read-only code graph queries",
		parameters: CodeGraphParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workdir = params.workdir ?? ctx.cwd;
			const ensured = await ensureRuntime(workdir, ctx);
			if (!ensured) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "runtime unavailable" }) }],
					details: {},
				};
			}
			const { entry } = ensured;
			switch (params.action) {
				case "status":
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									ok: true,
									dbPath: entry.paths.codeGraphDb,
									worktreeRoot: entry.paths.worktreeRoot,
									files: entry.store.read(() => entry.store.db.prepare("SELECT COUNT(*) AS c FROM files").get()) as { c: number } | undefined,
									functions: entry.store.read(() => entry.store.db.prepare("SELECT COUNT(*) AS c FROM functions").get()) as { c: number } | undefined,
								}),
							},
						],
						details: {},
					};
				case "screening": {
					const items = screeningQuery({
						store: entry.store,
						language: params.language,
						functionNameLike: params.functionName,
						limit: params.limit ?? 100,
					});
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: true, items }) }],
						details: {},
					};
				}
				case "get-function": {
					if (!params.functionName) {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "functionName required" }) }],
							details: {},
						};
					}
					const row = entry.store.read(() =>
						entry.store.db
							.prepare(
								`SELECT file_dir, file_name, function_name, full_code, render_code,
									full_code_hash, render_code_hash, version, kind
								 FROM functions
								 WHERE function_name = ? LIMIT 1`,
							)
							.get(params.functionName),
					) as
						| {
								file_dir: string;
								file_name: string;
								function_name: string;
								full_code: string;
								render_code: string;
								full_code_hash: string;
								render_code_hash: string;
								version: number;
								kind: string;
						  }
						| undefined;
					if (!row) {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "not found" }) }],
							details: {},
						};
					}
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: true, function: row }) }],
						details: {},
					};
				}
case "update-function": {
					if (!params.fileDir || !params.fileName || !params.functionName || typeof params.fullCode !== "string") {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "fileDir, fileName, functionName, and fullCode are required" }) }],
							details: {},
						};
					}
					const result = updateFunction(entry.store, {
						fileDir: params.fileDir,
						fileName: params.fileName,
						functionName: params.functionName,
						fullCode: params.fullCode,
					});
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
				}
				case "update-file": {
					if (!params.fileDir || !params.fileName || typeof params.text !== "string") {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "fileDir, fileName, and text are required" }) }],
							details: {},
						};
					}
					const result = updateFile(entry.store, {
						fileDir: params.fileDir,
						fileName: params.fileName,
						text: params.text,
						...(params.language ? { language: params.language } : {}),
					});
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
				}
				case "delete-file": {
					if (!params.fileDir || !params.fileName) {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "fileDir and fileName are required" }) }],
							details: {},
						};
					}
					const result = deleteFile(entry.store, { fileDir: params.fileDir, fileName: params.fileName });
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
				}
				case "list-pending": {
					return { content: [{ type: "text", text: JSON.stringify({ ok: true, pending: listPending(entry.store) }) }], details: {} };
				}
				
				case "reindex":
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									ok: false,
									reason: "reindex must run via the /init-graph slash command (D-013)",
								}),
							},
						],
						details: {},
					};
				case "manifest": {
					const rows = entry.store.read(() =>
						entry.store.db
							.prepare(
								`SELECT file_dir, file_name, COUNT(*) AS c FROM file_entries GROUP BY file_dir, file_name ORDER BY file_dir, file_name`,
							)
							.all(),
					) as Array<{ file_dir: string; file_name: string; c: number }>;
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: true, manifest: rows }) }],
						details: {},
					};
				}
			}
		},
	});
}
