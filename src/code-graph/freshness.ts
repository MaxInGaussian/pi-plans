/**
 * Read-time freshness validation and self-healing (plan R-001, F-001/F-006/F-009).
 *
 * The DB-first design has two intentional states where disk hash != DB hash:
 *  - pending_kind = 'update': the DB holds staged, not-yet-applied edits and is
 *    AHEAD of the disk by design. Reads serve the staged text with a marker —
 *    never fall back, never rebuild (a rebuild would destroy the staged edit).
 *  - pending_kind IS NULL with a hash mismatch: genuinely stale index. Reads
 *    fall back to the disk buffer, mark it, and synchronously rebuild that
 *    one file so the next read is fresh.
 *
 * The stat fast path (last_size/last_mtime, schema v3) avoids a full-content
 * hash per read; when the slow path already read the disk buffer it is served
 * directly instead of re-serving DB text.
 */

import * as fs from "node:fs";
import { hashText } from "./parser.ts";
import type { Store } from "./store.ts";
import type { WorktreePaths } from "./paths.ts";
import type { Language, ParserBackend } from "./types.ts";
import { runIndex } from "./indexer.ts";
import { loadGraphRuntime } from "./runtime.ts";
import { makeBackend } from "./parsers/javascript.ts";
import { PythonBackend } from "./parsers/python.ts";

export interface FreshnessFileInfo {
	absolutePath: string;
	relativePath: string;
	fileDir: string;
	fileName: string;
	language: Language;
}

export type SnapshotOrigin = "db-fresh" | "db-pending" | "disk-fallback" | "db-orphan";

export interface ValidatedSnapshot {
	text: string;
	marker: string | null;
	origin: SnapshotOrigin;
}

/** Runtime pieces needed to (re)index — mirrors RuntimeCacheEntry without the
 *  tool-layer types so this module stays importable from src/. */
export interface FreshnessRuntime {
	store: Store;
	paths: WorktreePaths;
	parsers: Record<Language, ParserBackend>;
}

/** Single-flight guard: a file is rebuilt by at most one caller at a time. */
const inFlight = new Set<string>();

/** Normalize a relative path to the DB key form: root files live in "." so
 *  "a.ts" must become "./a.ts" for the indexer's path filter to match
 *  (mirrors toDbKey in commands.ts). */
function toDbKey(relativePath: string): string {
	return relativePath.includes("/") ? relativePath : `./${relativePath}`;
}

/** Shared incremental reindex entry point (plan R-006): reused by the
 *  read-time self-heal, the apply trigger, and the watch mode. */
export async function reindexRelativePaths(
	runtime: FreshnessRuntime,
	relativePaths: string[],
): Promise<{ reindexed: number; purged: number }> {
	if (relativePaths.length === 0) return { reindexed: 0, purged: 0 };
	const report = await runIndex({
		store: runtime.store,
		worktreeRoot: runtime.paths.worktreeRoot,
		parsers: runtime.parsers,
		paths: relativePaths.map(toDbKey),
	});
	return { reindexed: report.reindexedPaths.length, purged: report.purgedPaths.length };
}

function statFile(absolutePath: string): { size: number; mtimeMs: number } | null {
	try {
		const st = fs.statSync(absolutePath);
		if (!st.isFile()) return null;
		return { size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}

/** Cheap freshness probe without any rebuild — for screening rows and other
 *  list-style results (plan R-001: only the returned rows are verified). */
export function checkFreshness(store: Store, info: FreshnessFileInfo): "fresh" | "stale" | "pending" | "missing-db" | "missing-disk" {
	const row = store.read(() =>
		store.db
			.prepare(`SELECT source_hash, pending_kind, last_size, last_mtime FROM files WHERE file_dir = ? AND file_name = ?`)
			.get(info.fileDir, info.fileName),
	) as { source_hash: string; pending_kind: string | null; last_size: number | null; last_mtime: number | null } | undefined;
	if (!row) return "missing-db";
	if (row.pending_kind === "update") return "pending";
	if (row.pending_kind === "delete") return "missing-db";
	const st = statFile(info.absolutePath);
	if (!st) return "missing-disk";
	if (row.last_size !== null && row.last_mtime !== null && row.last_size === st.size && Math.abs(row.last_mtime - st.mtimeMs) < 1) {
		return "fresh";
	}
	try {
		const diskText = fs.readFileSync(info.absolutePath, "utf8");
		return hashText(diskText) === row.source_hash ? "fresh" : "stale";
	} catch {
		return "missing-disk";
	}
}

/**
 * Load a file snapshot with read-time validation (plan R-001). Returns null
 * when the file is not indexed (caller falls back to the native tool).
 * `selfHeal: false` is the read-only branch used by refiner subagents.
 */
export async function loadValidatedSnapshot(
	runtime: FreshnessRuntime,
	info: FreshnessFileInfo,
	opts: { selfHeal: boolean },
): Promise<ValidatedSnapshot | null> {
	const row = runtime.store.read(() =>
		runtime.store.db
			.prepare(`SELECT source_text, source_hash, pending_kind, last_size, last_mtime FROM files WHERE file_dir = ? AND file_name = ?`)
			.get(info.fileDir, info.fileName),
	) as
		| { source_text: string; source_hash: string; pending_kind: string | null; last_size: number | null; last_mtime: number | null }
		| undefined;
	if (!row || row.pending_kind === "delete") return null;
	if (row.pending_kind === "update") {
		return {
			text: row.source_text,
			marker: "[graph: staged edit pending apply — run code_graph apply]",
			origin: "db-pending",
		};
	}
	const st = statFile(info.absolutePath);
	if (!st) {
		// Deleted on disk but still indexed: serve the last indexed text,
		// clearly marked. No rebuild target exists.
		return {
			text: row.source_text,
			marker: "[graph: stale — file missing on disk; showing last indexed text]",
			origin: "db-orphan",
		};
	}
	const statMatch =
		row.last_size !== null && row.last_mtime !== null && row.last_size === st.size && Math.abs(row.last_mtime - st.mtimeMs) < 1;
	if (!statMatch) {
		let diskText: string | null = null;
		try {
			diskText = fs.readFileSync(info.absolutePath, "utf8");
		} catch {
			diskText = null;
		}
		if (diskText !== null && hashText(diskText) !== row.source_hash) {
			// Genuinely stale: serve the disk buffer we already read, mark it,
			// and synchronously rebuild this one file so the next read is fresh.
			if (opts.selfHeal && !inFlight.has(info.relativePath)) {
				inFlight.add(info.relativePath);
				try {
					await reindexRelativePaths(runtime, [info.relativePath]);
				} catch {
					/* best-effort heal; next read retries */
				} finally {
					inFlight.delete(info.relativePath);
				}
			}
			return {
				text: diskText,
				marker: opts.selfHeal
					? "[graph: stale — fell back to disk read; reindexed]"
					: "[graph: stale — fell back to disk read (read-only session; run /update-graph to refresh)]",
				origin: "disk-fallback",
			};
		}
		// Content identical (touch/rename): refresh the fast-path columns and
		// serve whichever buffer we have. The column refresh is a tiny write —
		// skipped entirely for read-only callers.
		if (opts.selfHeal) {
			try {
				runtime.store.db
					.prepare(`UPDATE files SET last_size = ?, last_mtime = ? WHERE file_dir = ? AND file_name = ?`)
					.run(st.size, st.mtimeMs, info.fileDir, info.fileName);
			} catch {
				/* fast-path refresh is best-effort */
			}
		}
		if (diskText !== null) return { text: diskText, marker: null, origin: "db-fresh" };
	}
	return { text: row.source_text, marker: null, origin: "db-fresh" };
}

/** Build the four-language parser set from the live runtime (used by
 *  standalone triggers like final-commit that have no RuntimeCacheEntry). */
export async function buildParsersFromRuntime(
	runtime: Awaited<ReturnType<typeof loadGraphRuntime>>["runtime"],
): Promise<Record<Language, ParserBackend>> {
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
