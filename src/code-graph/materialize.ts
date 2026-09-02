/**
 * DB-to-source materialization. Rebuilds the file from ordered manifest
 * entries plus the raw chunk text saved alongside the parse. Files whose
 * `pending_kind` is set (DB-first mutations) are applied with convergence
 * semantics: 'update' writes/creates the file; 'delete' removes the disk file
 * and purges its DB rows. Pending-NULL files keep the stale-hash guard and
 * are never resurrected when missing on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Store } from "./store.ts";
import type { FileRecord } from "./types.ts";

export interface MaterializeOptions {
	store: Store;
	worktreeRoot: string;
	force?: boolean;
}

export interface MaterializeReport {
	files: Array<{
		fileDir: string;
		fileName: string;
		absolutePath: string;
		status: "ok" | "stale" | "error" | "deleted" | "skipped-missing";
		reason?: string;
	}>;
}

interface ManifestEntry {
	ordinal: number;
	kind: string;
	function_name: string | null;
	start_byte: number;
	end_byte: number;
	text: string;
}

function loadManifest(store: Store, fileDir: string, fileName: string): ManifestEntry[] {
	return store
		.read(() =>
			store.db
				.prepare(
					`SELECT ordinal, kind, function_name, start_byte, end_byte, text
					 FROM file_entries WHERE file_dir = ? AND file_name = ?
					 ORDER BY ordinal ASC`,
				)
				.all(fileDir, fileName),
		) as ManifestEntry[];
}

export function reassembleFileText(sourceText: string, entries: ManifestEntry[]): string {
	if (entries.length === 0) return sourceText;
	let cursor = 0;
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.start_byte > cursor) {
			parts.push(sourceText.slice(cursor, entry.start_byte));
		}
		parts.push(entry.text);
		cursor = entry.end_byte;
	}
	if (cursor < sourceText.length) {
		parts.push(sourceText.slice(cursor));
	}
	return parts.join("");
}

function reassemble(file: FileRecord, entries: ManifestEntry[]): string {
	return reassembleFileText(file.sourceText, entries);
}

function loadSourceText(store: Store, fileDir: string, fileName: string): { text: string; hash: string } | null {
	const row = store
		.read(() =>
			store.db
				.prepare(
					`SELECT source_text, source_hash FROM files WHERE file_dir = ? AND file_name = ?`,
				)
				.get(fileDir, fileName),
		) as { source_text: string; source_hash: string } | undefined;
	return row ? { text: row.source_text, hash: row.source_hash } : null;
}

function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function materializeFile(
	store: Store,
	worktreeRoot: string,
	fileDir: string,
	fileName: string,
	opts: { force?: boolean } = {},
): { status: "ok" | "stale" | "error" | "deleted" | "skipped-missing"; reason?: string; written?: string } {
	const file = loadSourceText(store, fileDir, fileName);
	if (!file) return { status: "error", reason: "file not indexed" };
	const absolute = path.join(worktreeRoot, fileDir === "." ? fileName : path.join(fileDir, fileName));
	const pendingKind = store.read(() =>
		store.db.prepare(`SELECT pending_kind FROM files WHERE file_dir = ? AND file_name = ?`).get(fileDir, fileName),
	) as { pending_kind: string | null } | undefined;
	const pending = pendingKind?.pending_kind ?? null;

	if (pending === "delete") {
		try {
			if (fs.existsSync(absolute)) fs.rmSync(absolute);
		} catch (error) {
			return { status: "error", reason: (error as Error).message };
		}
		store.tx(() => {
			store.db.prepare(`DELETE FROM file_entries WHERE file_dir = ? AND file_name = ?`).run(fileDir, fileName);
			store.db.prepare(`DELETE FROM call_edges WHERE from_file_dir = ? AND from_file_name = ?`).run(fileDir, fileName);
			store.db.prepare(`DELETE FROM functions WHERE file_dir = ? AND file_name = ?`).run(fileDir, fileName);
			store.db.prepare(`DELETE FROM files WHERE file_dir = ? AND file_name = ?`).run(fileDir, fileName);
		});
		return { status: "deleted", written: absolute };
	}

	const manifest = loadManifest(store, fileDir, fileName);
	const output = reassemble(
		{ fileDir, fileName, language: "javascript", sourceHash: file.hash, sourceText: file.text, entries: [], updatedAt: "" },
		manifest,
	);
	let currentText: string | null = null;
	try {
		currentText = fs.readFileSync(absolute, "utf8");
	} catch {
		currentText = null;
	}
	if (pending === "update") {
		// DB-first convergence: files.source_text IS the canonical new content
		// (mutations maintain it; the loop-end reindex rebuilds the manifest).
		// Write (or create) regardless of the on-disk hash.
		const write = writeAtomically(absolute, file.text);
		if (write.error) return { status: "error", reason: write.error };
		store.tx(() => {
			store.db
				.prepare(`UPDATE files SET pending_kind = NULL, updated_at = ? WHERE file_dir = ? AND file_name = ?`)
				.run(new Date().toISOString(), fileDir, fileName);
		});
		return { status: "ok", written: absolute };
	}
	if (currentText === null) {
		// Pending-NULL and missing on disk: never resurrect deletions.
		return { status: "skipped-missing", reason: "file missing on disk and not pending; skipped (not resurrected)" };
	}
	const currentHash = hashText(currentText);
	if (currentHash !== file.hash && !opts.force) {
		return { status: "stale", reason: `current hash ${currentHash} != indexed hash ${file.hash}` };
	}
	const write = writeAtomically(absolute, output);
	if (write.error) return { status: "error", reason: write.error };
	return { status: "ok", written: absolute };
}

function writeAtomically(absolute: string, output: string): { error?: string } {
	try {
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		const tmp = path.join(os.tmpdir(), `code-graph-apply-${process.pid}-${Date.now()}-${path.basename(absolute)}`);
		fs.writeFileSync(tmp, output);
		try {
			fs.renameSync(tmp, absolute);
		} catch (error) {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
			return { error: (error as Error).message };
		}
		return {};
	} catch (error) {
		return { error: (error as Error).message };
	}
}

export function materialize(opts: MaterializeOptions): MaterializeReport {
	const rows = opts.store
		.read(() =>
			opts.store.db
				.prepare(
					`SELECT file_dir, file_name FROM files ORDER BY file_dir, file_name`,
				)
				.all(),
		) as Array<{ file_dir: string; file_name: string }>;
	const files: MaterializeReport["files"] = [];
	for (const row of rows) {
		const result = materializeFile(opts.store, opts.worktreeRoot, row.file_dir, row.file_name, {
			force: opts.force === true,
		});
		files.push({
			fileDir: row.file_dir,
			fileName: row.file_name,
			absolutePath: path.join(opts.worktreeRoot, row.file_dir === "." ? row.file_name : path.join(row.file_dir, row.file_name)),
			status: result.status,
			reason: result.reason,
		});
	}
	return { files };
}

export interface ApplyResult {
	ok: boolean;
	report: MaterializeReport;
}

export function applyGraph(opts: MaterializeOptions & { allowStale?: boolean }): ApplyResult {
	const report = materialize({ ...opts, force: opts.force === true || opts.allowStale === true });
	const ok = report.files.every((file) => file.status !== "error");
	return { ok, report };
}
