/**
 * Slash-command handlers for /init-graph, /update-graph, and /apply-graph.
 * They defer loading the runtime and SQLite until invoked so other pi-plans tools stay usable
 * even when the graph feature is unavailable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadGraphRuntime,
	describeRuntimeIssues,
	type RuntimeStatus,
} from "./runtime.ts";
import { resolveCanonicalWorktree } from "./paths.ts";
import { Store } from "./store.ts";
import { runIndex } from "./indexer.ts";
import { makeBackend } from "./parsers/javascript.ts";
import { PythonBackend } from "./parsers/python.ts";
import type { ParserBackend } from "./parser.ts";
import type { Language } from "./types.ts";
import { materialize } from "./materialize.ts";
import { generateSummaries, type CompletionHandle, type SummaryReport } from "./summary.ts";
import { readActive, getRun, setRunStatus } from "../state.ts";

interface CommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify: (message: string, kind?: "info" | "warning" | "error") => void;
		confirm: (title: string, body: string) => Promise<boolean>;
	};
	modelRegistry?: {
		find?: (provider: string, id: string) => unknown;
		complete?: (
			model: unknown,
			context: { messages: Array<{ role: "user"; content: string }> },
			options: Record<string, unknown>,
		) => Promise<{ content: Array<{ type: "text"; text: string }>; stopReason?: string }>;
		hasConfiguredAuth?: (model: unknown) => boolean;
	};
	model?: unknown;
	thinkingLevel?: string;
}

async function buildParsers(runtime: Awaited<ReturnType<typeof loadGraphRuntime>>["runtime"]): Promise<Record<Language, ParserBackend>> {
	const ParserCtor = runtime.parser.Parser as unknown as new () => {
		parse(input: string | Buffer): unknown;
		setLanguage(language: unknown): void;
	};
	return {
		javascript: makeBackend("javascript", ParserCtor, runtime.parser.javascript),
		typescript: makeBackend("typescript", ParserCtor, runtime.parser.typescript),
		tsx: makeBackend("tsx", ParserCtor, runtime.parser.tsx),
		python: new PythonBackend(ParserCtor, runtime.parser.python),
	};
}

interface Bootstrap {
	store: Store;
	paths: ReturnType<typeof resolveCanonicalWorktree>;
	parsers: Record<Language, ParserBackend>;
	runtimeStatus: RuntimeStatus;
}

async function bootstrap(ctx: CommandContext, opts: { reindex?: boolean }): Promise<Bootstrap | null> {
	const paths = resolveCanonicalWorktree(ctx.cwd);
	const { runtime, status } = await loadGraphRuntime();
	if (status.issues.length > 0 && !status.sqliteAvailable && !status.parserAvailable) {
		ctx.ui.notify(`code-graph unavailable: ${describeRuntimeIssues(status).join("; ")}`, "error");
		return null;
	}
	const store = new Store(
		{ dbPath: paths.codeGraphDb, worktreeRoot: paths.worktreeRoot, gitCommonDir: paths.gitCommonDir },
		runtime.sqlite,
	);
	try {
		store.checkWorktree(paths.worktreeRoot, paths.gitCommonDir);
	} catch (error) {
		store.close();
		ctx.ui.notify(`code-graph: ${(error as Error).message}`, "error");
		return null;
	}
	const parsers = await buildParsers(runtime);
	void opts;
	return { store, paths, parsers, runtimeStatus: status };
}

function denyActivePlanning(ctx: CommandContext): boolean {
	const active = readActive(ctx.cwd);
	if (!active) return false;
	const run = getRun(ctx.cwd, active.run_id);
	if (!run) return false;
	return run.status === "planning" || run.status === "accepted";
}

export async function initGraphCommand(args: string, ctx: CommandContext): Promise<void> {
	const flags = parseCommandArgs(args).flags;
	const preflightPaths = resolveCanonicalWorktree(ctx.cwd);
	const preferRebuild = flags.has("reindex") || !ctx.hasUI;
	if (fs.existsSync(preflightPaths.codeGraphDb) && !preferRebuild) {
		const rebuild = await ctx.ui.confirm(
			"code-graph DB already exists",
			`${preflightPaths.codeGraphDb}\n\nRebuild the graph with the current /init-graph flow, or sync changed paths via /update-graph?\n\nYes = rebuild the full graph\nNo = sync changed paths only`,
		);
		if (!rebuild) {
			const bootstrapResult = await bootstrap(ctx, {});
			if (!bootstrapResult) return;
			const { store, paths, parsers } = bootstrapResult;
			try {
				await runChangedPathSync(args, ctx, store, paths, parsers);
			} catch (error) {
				ctx.ui.notify(`code-graph update failed: ${(error as Error).message}`, "error");
			} finally {
				store.close();
			}
			return;
		}
	}
	const bootstrapResult = await bootstrap(ctx, { reindex: flags.has("reindex") });
	if (!bootstrapResult) return;
	const { store, paths, parsers, runtimeStatus } = bootstrapResult;
	try {
		// Pre-index chore commit: snapshot any uncommitted work so the DB indexes
		// a recoverable state (--no-commit skips this).
		let choreCommit = "";
		if (!flags.has("no-commit")) {
			choreCommit = gitAddAllAndCommit(paths.worktreeRoot, "chore(code-graph): pre-init snapshot");
			if (choreCommit) ctx.ui.notify(`code-graph pre-init commit: ${choreCommit.slice(0, 12)}`, "info");
		}
		const report = await runIndex({
			store,
			worktreeRoot: paths.worktreeRoot,
			parsers,
			reindex: flags.has("reindex"),
		});
		ctx.ui.notify(
			`code-graph indexed ${report.functionsIndexed} function(s) in ${report.filesScanned} file(s) — ${report.edgesResolved} resolved, ${report.edgesUnresolved} unresolved`,
			"info",
		);
		if (!flags.has("no-summary") && ctx.hasUI && ctx.modelRegistry?.complete && ctx.model) {
			const handle: CompletionHandle = {
				complete: async (request) =>
					await ctx.modelRegistry!.complete!(ctx.model, { messages: request.messages }, {}),
				model: () => ctx.model as { id?: string; provider?: string; api?: string; reasoning?: boolean } | undefined,
				thinkingLevel: () => ctx.thinkingLevel,
				hasUI: ctx.hasUI,
				confirm: ctx.ui.confirm,
				notify: ctx.ui.notify,
			};
			try {
				const summary: SummaryReport = await generateSummaries({ store, ctx: handle, skipConsent: flags.has("consent") });
				ctx.ui.notify(
					`code-graph summaries: ${summary.ok} ok, ${summary.failed} failed, ${summary.declined} declined`,
					summary.failed > 0 ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(`code-graph summary failed: ${(error as Error).message}`, "warning");
			}
		}
		ctx.ui.notify(
			`code-graph db: ${paths.codeGraphDb} (Node ${runtimeStatus.nodeVersion}${runtimeStatus.hasExperimentalSqliteFlag ? " +sqlite-flag" : ""})`,
			"info",
		);
		// Post-index snapshot: anchor drift checks to this commit + status.
		const head = gitHead(paths.worktreeRoot) || choreCommit;
		const uncommitted = gitStatusPorcelain(paths.worktreeRoot).map((entry) => entry.path);
		store.upsertSnapshot(head, uncommitted);
		ctx.ui.notify(`code-graph snapshot: ${head.slice(0, 12) || "(no commits)"} · ${uncommitted.length} uncommitted path(s)`, "info");
	} catch (error) {
		ctx.ui.notify(`code-graph index failed: ${(error as Error).message}`, "error");
	} finally {
		store.close();
	}
}

export async function applyGraphCommand(args: string, ctx: CommandContext): Promise<void> {
	if (denyActivePlanning(ctx)) {
		ctx.ui.notify("code-graph apply refused: a planning run is currently planning or accepted.", "error");
		return;
	}
	const flags = parseCommandArgs(args).flags;
	const bootstrapResult = await bootstrap(ctx, {});
	if (!bootstrapResult) return;
	const { store, paths } = bootstrapResult;
	try {
		const report = materialize({ store, worktreeRoot: paths.worktreeRoot, force: flags.has("force") });
		const stale = report.files.filter((file) => file.status === "stale").length;
		const errors = report.files.filter((file) => file.status === "error").length;
		const ok = report.files.filter((file) => file.status === "ok").length;
		const deleted = report.files.filter((file) => file.status === "deleted").length;
		const skipped = report.files.filter((file) => file.status === "skipped-missing").length;
		ctx.ui.notify(
			`code-graph apply: ${ok} ok, ${deleted} deleted, ${stale} stale, ${skipped} skipped-missing, ${errors} error`,
			errors > 0 ? "error" : "info",
		);
		const active = readActive(ctx.cwd);
		if (active) setRunStatus(ctx.cwd, active.run_id, "executing");
	} catch (error) {
		ctx.ui.notify(`code-graph apply failed: ${(error as Error).message}`, "error");
	} finally {
		store.close();
	}
}

export async function graphStatusCommand(_args: string, ctx: CommandContext): Promise<void> {
	const bootstrapResult = await bootstrap(ctx, {});
	if (!bootstrapResult) return;
	const { store, paths } = bootstrapResult;
	try {
		const files = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM files").get()) as { c: number };
		const functions = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM functions").get()) as { c: number };
		const edges = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM call_edges").get()) as { c: number };
		ctx.ui.notify(
			`code-graph: ${functions.c} functions, ${files.c} files, ${edges.c} edges — ${paths.codeGraphDb}`,
			"info",
		);
	} finally {
		store.close();
	}
}

// ---------------------------------------------------------------------------
// /update-graph, /graph-drift, /enable-graph, /disable-graph
// ---------------------------------------------------------------------------

import { gitAddAllAndCommit, gitDiffNameOnly, gitHead, gitStatusPorcelain, parseCommandArgs } from "./git.ts";
import { isIndexablePath } from "./discovery.ts";
import { hashText } from "./parser.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, resolveStateRootOrNull, setGraphEnabled } from "../state.ts";

export interface DriftResult {
	ok: boolean;
	/** Invariant (a): per-file hash drift, unless pending_kind is set. */
	hashDrift: Array<{ path: string; kind: "hash-mismatch" | "pending-update" | "pending-delete" }>;
	/** Invariant (b): indexable uncommitted paths missing from the DB. */
	unindexed: string[];
	/** Invariant (c), informational: snapshot vs current git state. */
	snapshot: { stale: boolean; headCommit: string; snapshotHead: string; uncommittedAtSnapshot: string[] };
	pending: Array<{ path: string; kind: string }>;
	recommendation: string;
}

/** Normalize a porcelain/git path ("src/a.ts", "a.ts") to the DB key form ("./a.ts"). */
export function toDbKey(porcelainPath: string): string {
	return porcelainPath.includes("/") ? porcelainPath : `./${porcelainPath}`;
}

export function computeDrift(store: Store, worktreeRoot: string): DriftResult {
	const entries = gitStatusPorcelain(worktreeRoot);
	const renameOrigPaths = new Set(
		entries.filter((entry) => entry.origPath !== null).map((entry) => toDbKey(entry.origPath!)),
	);
	const porcelainPaths = entries.filter((entry) => !entry.status.includes("D")).map((entry) => toDbKey(entry.path));
	const indexableChanged = [...new Set([...porcelainPaths, ...renameOrigPaths])].filter(isIndexablePath);

	const filesRows = store.read(() =>
		store.db.prepare(`SELECT file_dir, file_name, source_hash, pending_kind FROM files`).all(),
	) as Array<{ file_dir: string; file_name: string; source_hash: string; pending_kind: string | null }>;
	const byPath = new Map(filesRows.map((row) => [`${row.file_dir}/${row.file_name}`, row]));

	const hashDrift: DriftResult["hashDrift"] = [];
	const pending: DriftResult["pending"] = [];
	const unindexed: string[] = [];
	for (const row of filesRows) {
		const rel = `${row.file_dir}/${row.file_name}`;
		if (row.pending_kind === "update") {
			pending.push({ path: rel, kind: "update" });
			hashDrift.push({ path: rel, kind: "pending-update" });
			continue;
		}
		if (row.pending_kind === "delete") {
			pending.push({ path: rel, kind: "delete" });
			hashDrift.push({ path: rel, kind: "pending-delete" });
			continue;
		}
		const absolute = path.join(worktreeRoot, row.file_dir === "." ? row.file_name : path.join(row.file_dir, row.file_name));
		let onDisk: string | null = null;
		try {
			onDisk = fs.readFileSync(absolute, "utf8");
		} catch {
			onDisk = null;
		}
		if (onDisk === null) {
			// Deleted on disk but not marked pending: untracked deletion.
			hashDrift.push({ path: rel, kind: "hash-mismatch" });
			continue;
		}
		if (hashText(onDisk) !== row.source_hash) {
			hashDrift.push({ path: rel, kind: "hash-mismatch" });
		}
	}
	for (const changed of indexableChanged) {
		if (renameOrigPaths.has(changed)) continue; // rename-old: purge is the fix, not reindex
		if (!byPath.has(changed)) unindexed.push(changed);
	}

	const snapshot = store.readLatestSnapshot();
	const head = gitHead(worktreeRoot);
	const snapshotInfo = {
		stale: snapshot !== null && snapshot.headCommit !== head,
		headCommit: head,
		snapshotHead: snapshot?.headCommit ?? "(none)",
		uncommittedAtSnapshot: snapshot?.uncommittedPaths ?? [],
	};

	const needsUpdate = hashDrift.some((item) => item.kind === "hash-mismatch") || unindexed.length > 0;
	const needsApply = pending.length > 0;
	const recommendation = needsUpdate
		? "run /update-graph to reindex changed paths"
		: needsApply
			? "run /apply-graph to materialize pending DB edits"
			: "in sync";
	return {
		ok: hashDrift.every((item) => item.kind !== "hash-mismatch") && unindexed.length === 0,
		hashDrift,
		unindexed,
		snapshot: snapshotInfo,
		pending,
		recommendation,
	};
}

async function runChangedPathSync(
	args: string,
	ctx: CommandContext,
	store: Store,
	paths: Bootstrap["paths"],
	parsers: Record<Language, ParserBackend>,
): Promise<void> {
	const { flags, values } = parseCommandArgs(args);
	const entries = gitStatusPorcelain(paths.worktreeRoot);
	const renameOrigPaths = new Set(
		entries.filter((entry) => entry.origPath !== null).map((entry) => toDbKey(entry.origPath!)),
	);
	const porcelainPaths = entries.map((entry) => toDbKey(entry.path));
	// --base <commit>: union porcelain with diff-vs-base so pinned-base
	// changes (possibly already committed) are included.
	const basePath = values.get("base");
	const basePaths = basePath
		? gitDiffNameOnly(paths.worktreeRoot, basePath).map(toDbKey)
		: [];
	const candidates = [...new Set([...porcelainPaths, ...renameOrigPaths, ...basePaths])].filter(isIndexablePath);
	if (candidates.length === 0) {
		ctx.ui.notify("code-graph update: no changed indexable paths — nothing to do", "info");
		return;
	}
	if (flags.has("dry-run")) {
		ctx.ui.notify(`code-graph update (dry-run): would reindex ${candidates.length} path(s):\n${candidates.join("\n")}`, "info");
		return;
	}
	const report = await runIndex({ store, worktreeRoot: paths.worktreeRoot, parsers, paths: candidates });
	ctx.ui.notify(
		`code-graph update: ${report.reindexedPaths.length} reindexed, ${report.purgedPaths.length} purged, ${report.functionsIndexed} function(s)`,
		"info",
	);
}

export async function updateGraphCommand(args: string, ctx: CommandContext): Promise<void> {
	const bootstrapResult = await bootstrap(ctx, {});
	if (!bootstrapResult) return;
	const { store, paths, parsers } = bootstrapResult;
	try {
		await runChangedPathSync(args, ctx, store, paths, parsers);
	} catch (error) {
		ctx.ui.notify(`code-graph update failed: ${(error as Error).message}`, "error");
	} finally {
		store.close();
	}
}

export async function graphDriftCommand(args: string, ctx: CommandContext): Promise<void> {
	const { flags } = parseCommandArgs(args);
	const bootstrapResult = await bootstrap(ctx, {});
	if (!bootstrapResult) return;
	const { store, paths } = bootstrapResult;
	try {
		const drift = computeDrift(store, paths.worktreeRoot);
		if (flags.has("json")) {
			const payload = flags.has("commit-aware")
				? { ...drift, gitStatus: gitStatusPorcelain(paths.worktreeRoot) }
				: drift;
			ctx.ui.notify(JSON.stringify(payload, null, 2), "info");
			return;
		}
		const lines: string[] = [];
		lines.push(`graph drift: ${drift.ok ? "OK" : "DIRTY"} — ${drift.recommendation}`);
		for (const item of drift.hashDrift) {
			if (item.kind === "hash-mismatch") lines.push(`  (a) hash mismatch: ${item.path}`);
			else if (item.kind === "pending-update") lines.push(`  (a) pending apply (update): ${item.path}`);
			else lines.push(`  (a) pending apply (delete): ${item.path}`);
		}
		for (const missing of drift.unindexed) lines.push(`  (b) uncommitted but unindexed: ${missing}`);
		if (drift.snapshot.stale) {
			lines.push(`  (c) snapshot stale: recorded ${drift.snapshot.snapshotHead.slice(0, 8)} vs HEAD ${drift.snapshot.headCommit.slice(0, 8)} (run /init-graph after committing to refresh)`);
		}
		if (flags.has("commit-aware")) {
			for (const entry of gitStatusPorcelain(paths.worktreeRoot)) {
				lines.push(`  (git) ${entry.status} ${entry.path}${entry.origPath ? ` (from ${entry.origPath})` : ""}`);
			}
		}
		ctx.ui.notify(lines.join("\n"), drift.ok ? "info" : "warning");
	} catch (error) {
		ctx.ui.notify(`graph drift failed: ${(error as Error).message}`, "error");
	} finally {
		store.close();
	}
}

export async function enableGraphCommand(_args: string, ctx: CommandContext): Promise<void> {
	setGraphEnabled(ctx.cwd, true);
	ctx.ui.notify("code-graph enabled: agents will use graph-aware read/write/edit on indexed source files. Run /init-graph to index.", "info");
}

export async function disableGraphCommand(_args: string, ctx: CommandContext): Promise<void> {
	const stateRoot = resolveStateRootOrNull(ctx.cwd);
	if (stateRoot && loadConfig(stateRoot).graph_enabled === true) {
		const bootstrapResult = await bootstrap(ctx, {});
		if (bootstrapResult) {
			const { store, paths } = bootstrapResult;
			try {
				const drift = computeDrift(store, paths.worktreeRoot);
				if (!drift.ok || drift.pending.length > 0) {
					ctx.ui.notify(
						`code-graph disable refused: worktree/DB is dirty (${drift.recommendation}). Fix drift first, then disable.`,
						"error",
					);
					return;
				}
			} finally {
				store.close();
			}
		}
	}
	setGraphEnabled(ctx.cwd, false);
	ctx.ui.notify("code-graph disabled: agents fall back to Read/grep/ls. Re-enable anytime with /enable-graph.", "info");
}
