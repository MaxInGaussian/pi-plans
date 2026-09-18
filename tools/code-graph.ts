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
import * as path from "node:path";
import { checkFreshness, loadValidatedSnapshot, type FreshnessFileInfo } from "../src/code-graph/freshness.ts";
import {
	loadGraphIndex,
	queryGraph,
	shortestPath,
	explainNode,
	impactOf,
	resolveNodeSelector,
	DEFAULT_BUDGET_TOKENS,
} from "../src/code-graph/traverse.ts";
import type { WorktreePaths } from "../src/code-graph/paths.ts";
import { Store } from "../src/code-graph/store.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import { hashText } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";
import { screeningQuery } from "../src/code-graph/screening.ts";
import { deleteFile, listPending, updateFile, updateFunction } from "../src/code-graph/mutations.ts";
import { applyGraphCore } from "../src/code-graph/commands.ts";
import { boundRunId } from "../src/run-context.ts";
import { normalizeWorkdir } from "../src/state.ts";

const CodeGraphParams = Type.Object({
	action: StringEnum(
		[
			"status",
			"screening",
			"get-function",
			"query",
			"path",
			"explain",
			"impact",
			"update-function",
			"update-file",
			"delete-file",
			"list-pending",
			"reindex",
			"manifest",
			"apply",
		] as const,
		{ description: "Code graph action to perform" },
	),
	query: Type.Optional(Type.String({ description: "query action: space-separated keywords matched against function names" })),
	pathFrom: Type.Optional(Type.String({ description: "path action: start node (function name or 'dir/file::name' selector)" })),
	pathTo: Type.Optional(Type.String({ description: "path action: end node (exactly two nodes total)" })),
	explainName: Type.Optional(Type.String({ description: "explain action: node to describe" })),
	impactName: Type.Optional(Type.String({ description: "impact action: node whose reverse call closure is computed" })),
	mode: Type.Optional(StringEnum(["bfs", "dfs"] as const, { description: "query traversal mode (default bfs)" })),
	budgetTokens: Type.Optional(Type.Number({ description: "query/impact output budget in ~tokens (chars/4, default 1500)" })),
	includeUnresolved: Type.Optional(Type.Boolean({ description: "also traverse edges whose target row is present but unresolved/ambiguous (target-less dangling edges never enter traversal)" })),
	workdir: Type.Optional(Type.String({ description: "Target workspace directory" })),
	language: Type.Optional(StringEnum(["javascript", "typescript", "tsx", "python"] as const)),
	functionName: Type.Optional(Type.String()),
	fileDir: Type.Optional(Type.String({ description: "File directory (POSIX, '.' for root)" })),
	fileName: Type.Optional(Type.String({ description: "File name without directory" })),
	fullCode: Type.Optional(Type.String({ description: "New function body text for update-function" })),
	text: Type.Optional(Type.String({ description: "New whole-file text for update-file" })),
	limit: Type.Optional(Type.Number()),
});

export type CodeGraphContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

export interface RuntimeCacheEntry {
	runtime: Awaited<ReturnType<typeof loadGraphRuntime>>["runtime"];
	parsers: Record<Language, ParserBackend>;
	paths: WorktreePaths;
	store: Store;
}

let runtimeCache: RuntimeCacheEntry | null = null;

function fileInfoFor(worktreeRoot: string, fileDir: string, fileName: string, language: FreshnessFileInfo["language"]): FreshnessFileInfo {
	const relativePath = fileDir === "." ? fileName : `${fileDir}/${fileName}`;
	return {
		absolutePath: path.join(worktreeRoot, fileDir === "." ? "." : fileDir, fileName),
		relativePath,
		fileDir,
		fileName,
		language,
	};
}

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
			"Code-graph actions: read-only queries (status, screening without full_code, function read, graph query/path/explain/impact, manifest summary) plus `apply` — safe non-force materialization of DB-first staged edits into the worktree (same gate as /apply-graph: refused during active planning/accepted runs and for read-only refiner subagents via PI_PLANS_REFINER; returns per-file report with counts and a post-apply drift summary; never changes run status). reindex stays user-only (/init-graph).",
		promptSnippet: "Read-only code graph queries",
		parameters: CodeGraphParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workdir = params.workdir ?? ctx.cwd;
			if (params.action === "apply") {
				if (process.env.PI_PLANS_REFINER === "1") {
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "code-graph apply refused: read-only refiner subagents cannot materialize worktree edits (PI_PLANS_REFINER)" }) }],
						details: {},
					};
				}
				const resolvedWorkdir = normalizeWorkdir(workdir);
				const core = await applyGraphCore(resolvedWorkdir, {
					sessionRunId: boundRunId(ctx.sessionManager, resolvedWorkdir),
				});
				if (core.refused || core.failed || !core.report) {
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: false, reason: core.refused ?? core.failed ?? "unknown error" }) }],
						details: {},
					};
				}
				const counts: Record<string, number> = { ok: 0, deleted: 0, stale: 0, "skipped-missing": 0, error: 0 };
				for (const file of core.report.files) counts[file.status] = (counts[file.status] ?? 0) + 1;
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: true, report: { counts, files: core.report.files }, drift: core.drift ?? null }) }],
					details: {},
				};
			}
			const ensured = await ensureRuntime(workdir, ctx);
			if (!ensured) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "runtime unavailable" }) }],
					details: {},
				};
			}
			const { entry } = ensured;
			switch (params.action) {
				case "status": {
					// AC-003: edge count + confidence×resolution distribution on
					// the status surface itself (impl-review F-E).
					const edgeDist = entry.store.read(() =>
						entry.store.db
							.prepare(`SELECT kind, resolution, confidence, COUNT(*) AS n FROM call_edges GROUP BY kind, resolution, confidence`)
							.all(),
					);
					const edgeCount = entry.store.read(() => entry.store.db.prepare(`SELECT COUNT(*) AS c FROM call_edges`).get()) as { c: number };
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
									edges: edgeCount.c,
									edgeDistribution: edgeDist,
								}),
							},
						],
						details: {},
					};
				}
				case "screening": {
					const raw = screeningQuery({
						store: entry.store,
						language: params.language,
						functionNameLike: params.functionName,
						limit: params.limit ?? 100,
					});
					// Freshness verification is scoped to the returned rows only
					// (plan R-001/F-006): a stat probe, never a rebuild.
					const probed = new Map<string, ReturnType<typeof checkFreshness>>();
					for (const item of raw) {
						const key = `${item.fileDir}/${item.fileName}`;
						if (probed.has(key)) continue;
						const langRow = entry.store.read(() =>
							entry.store.db.prepare(`SELECT language FROM files WHERE file_dir = ? AND file_name = ?`).get(item.fileDir, item.fileName),
						) as { language: FreshnessFileInfo["language"] } | undefined;
						if (!langRow) {
							probed.set(key, "missing-db");
							continue;
						}
						probed.set(key, checkFreshness(entry.store, fileInfoFor(entry.paths.worktreeRoot, item.fileDir, item.fileName, langRow.language)));
					}
					const items = raw.map((item) => ({ ...item, freshness: probed.get(`${item.fileDir}/${item.fileName}`) ?? "missing-db" }));
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
					const fetchRow = () =>
						entry.store.read(() =>
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
					let row = fetchRow();
					if (!row) {
						return {
							content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "not found" }) }],
							details: {},
						};
					}
					// Read-time validation (plan R-001): a stale index may serve
					// an outdated function body — the exact trust bug this
					// upgrade fixes. Validate the owning file; when the self-heal
					// rebuilt it, re-read the row from the fresh index.
					const langRow = entry.store.read(() =>
						entry.store.db.prepare(`SELECT language FROM files WHERE file_dir = ? AND file_name = ?`).get(row!.file_dir, row!.file_name),
					) as { language: FreshnessFileInfo["language"] } | undefined;
					let marker: string | null = null;
					let origin = "db-fresh";
					if (langRow) {
						const info = fileInfoFor(entry.paths.worktreeRoot, row.file_dir, row.file_name, langRow.language);
						const snap = await loadValidatedSnapshot(entry, info, { selfHeal: process.env.PI_PLANS_REFINER !== "1" });
						if (snap) {
							marker = snap.marker;
							origin = snap.origin;
							if (snap.origin === "disk-fallback") row = fetchRow() ?? row;
						} else {
							marker = "[graph: stale — owning file no longer indexed]";
							origin = "orphan";
						}
					}
					return {
						content: [{ type: "text", text: marker ? `${marker}\n${JSON.stringify({ ok: true, function: row })}` : JSON.stringify({ ok: true, function: row, freshness: origin }) }],
						details: { freshness: origin },
					};
				}
case "query": {
					if (!params.query) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "query required" }) }], details: {} };
					}
					const index = loadGraphIndex(entry.store, { includeUnresolved: params.includeUnresolved === true });
					const result = queryGraph(index, params.query.split(/\s+/).filter(Boolean), {
						mode: params.mode,
						budgetTokens: params.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
					});
					const nodeCount = index.nodes.size;
					const confidence = entry.store.read(() =>
						entry.store.db.prepare(`SELECT confidence, COUNT(*) AS n FROM call_edges WHERE resolution='resolved' GROUP BY confidence`).all(),
					);
					return {
						content: [
							{
								type: "text",
								text: [result.lines.join("\n"), "", `visited: ${result.visited} · edges: ${result.edges} · truncated: ${result.truncated}`].join("\n"),
							},
						],
						details: { seeds: result.seeds, visited: result.visited, edges: result.edges, truncated: result.truncated, nodes: nodeCount, confidence },
					};
				}
				case "path": {
					if (!params.pathFrom || !params.pathTo) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "pathFrom and pathTo required (exactly two nodes)" }) }], details: {} };
					}
					const index = loadGraphIndex(entry.store, { includeUnresolved: params.includeUnresolved === true });
					const from = resolveNodeSelector(index, params.pathFrom);
					const to = resolveNodeSelector(index, params.pathTo);
					if (!from || !to) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: `selector not found: ${!from ? params.pathFrom : params.pathTo}` }) }], details: {} };
					}
					const result = shortestPath(index, from, to);
					if (!result.found) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "no path between the two nodes" }) }], details: {} };
					}
					const lines = [from, ...result.hops.map((h) => `  → ${h.to} [${h.confidence}]`)];
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { hops: result.hops.length },
					};
				}
				case "explain": {
					if (!params.explainName) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "explainName required" }) }], details: {} };
					}
					const index = loadGraphIndex(entry.store, { includeUnresolved: params.includeUnresolved === true });
					const key = resolveNodeSelector(index, params.explainName);
					const result = key ? explainNode(index, key) : null;
					if (!result) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "not found" }) }], details: {} };
					}
					return {
						content: [
							{
								type: "text",
								text: [
									`${result.node.functionName} — ${result.node.fileDir}/${result.node.fileName}`,
									`community: ${result.community ?? "-"} · in-degree ${result.inDegree} · out-degree ${result.outDegree}`,
									`callees (${result.callees.length}):`,
									...result.callees.map((c) => `  → ${c.name} (${c.file}) [${c.confidence}]`),
									`callers (${result.callers.length}):`,
									...result.callers.map((c) => `  ← ${c.name} (${c.file}) [${c.confidence}]`),
								].join("\n"),
							},
						],
						details: { ...result },
					};
				}
				case "impact": {
					if (!params.impactName) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "impactName required" }) }], details: {} };
					}
					const index = loadGraphIndex(entry.store, { includeUnresolved: params.includeUnresolved === true });
					const key = resolveNodeSelector(index, params.impactName);
					const result = key ? impactOf(index, key, { budgetTokens: params.budgetTokens }) : null;
					if (!result) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "not found" }) }], details: {} };
					}
					return {
						content: [
							{
								type: "text",
								text: [
									`impact of ${result.root.functionName} (${result.root.fileDir}/${result.root.fileName})`,
									`affected functions: ${result.affected.length} · files: ${result.files.length} · truncated: ${result.truncated}`,
									...result.files.map((f) => `  file ${f}`),
									...result.affected.slice(0, 30).map((a) => `  ← ${a.name} (${a.file}) [${a.via}]`),
									result.affected.length > 30 ? `  … +${result.affected.length - 30} more (see details)` : "",
								].join("\n"),
							},
						],
						details: { affected: result.affected, files: result.files, truncated: result.truncated },
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
