/**
 * DB-first mutation core for the code_graph tool. Each mutation edits graph
 * rows, marks the file pending_materialization, and appends to change_log.
 * /apply-graph later converges the worktree to the DB state.
 */

import { Store } from "./store.ts";
import { hashText } from "./parser.ts";
import type { Language } from "./types.ts";

export interface MutationResult {
	ok: boolean;
	reason?: string;
	updated?: string;
	pending?: "update" | "delete";
	created?: boolean;
}

interface ManifestRow {
	ordinal: number;
	start_byte: number;
	end_byte: number;
	text: string;
	function_name: string | null;
}

function loadManifest(store: Store, fileDir: string, fileName: string): ManifestRow[] {
	return store.read(() =>
		store.db
			.prepare(
				`SELECT ordinal, start_byte, end_byte, text, function_name FROM file_entries
				 WHERE file_dir = ? AND file_name = ? ORDER BY ordinal ASC`,
			)
			.all(fileDir, fileName),
	) as ManifestRow[];
}

export function updateFunction(
	store: Store,
	opts: { fileDir: string; fileName: string; functionName: string; fullCode: string },
): MutationResult {
	const fnRow = store.read(() =>
		store.db
			.prepare(
				`SELECT provenance_start_byte, provenance_end_byte FROM functions
				 WHERE file_dir = ? AND file_name = ? AND function_name = ? LIMIT 1`,
			)
			.get(opts.fileDir, opts.fileName, opts.functionName),
	) as { provenance_start_byte: number; provenance_end_byte: number } | undefined;
	if (!fnRow) return { ok: false, reason: "function not found" };

	// Reads hoisted OUT of the tx: Store.read begins its own transaction.
	const manifest = loadManifest(store, opts.fileDir, opts.fileName);
	const fileRow = store.read(() =>
		store.db.prepare(`SELECT source_text FROM files WHERE file_dir = ? AND file_name = ?`).get(opts.fileDir, opts.fileName),
	) as { source_text: string } | undefined;
	const matched = manifest.filter((row) => row.function_name === opts.functionName);
	if (!fileRow || matched.length === 0) {
		return {
			ok: false,
			reason: !fileRow
				? "file row missing; run /update-graph first"
				: "no manifest entry matched the function name (qualified/overload names like name#2 may differ); re-check via code_graph get-function",
		};
	}

	const newHash = hashText(opts.fullCode);
	const first = matched[0]!;
	// Splice by the function's provenance byte range — the authoritative source
	// of the callable's extent. Manifest entry texts from the current parser are
	// empty, so reassembly-by-manifest cannot rebuild function bodies; the range
	// splice is deterministic and reindex-independent.
	const start = fnRow.provenance_start_byte;
	const end = fnRow.provenance_end_byte;
	const rebuilt = fileRow.source_text.slice(0, start) + opts.fullCode + fileRow.source_text.slice(end);
	const delta = opts.fullCode.length - (end - start);
	for (const row of manifest) {
		if (row.ordinal === first.ordinal) row.text = opts.fullCode;
		else if (row.start_byte >= end) {
			// Persist the shift so later reassembly aligns; the loop-end reindex
			// rebuilds entries authoritatively anyway.
			row.start_byte += delta;
			row.end_byte += delta;
		}
	}
	store.tx(() => {
		store.db
			.prepare(
				`UPDATE functions SET full_code = ?, full_code_hash = ?, render_code = ?, render_code_hash = ?
				 WHERE file_dir = ? AND file_name = ? AND function_name = ?`,
			)
			.run(opts.fullCode, newHash, opts.fullCode, newHash, opts.fileDir, opts.fileName, opts.functionName);
		for (const row of manifest) {
			store.db
				.prepare(`UPDATE file_entries SET text = ?, start_byte = ?, end_byte = ? WHERE file_dir = ? AND file_name = ? AND ordinal = ?`)
				.run(row.text, row.start_byte, row.ordinal === first.ordinal ? row.end_byte + delta : row.end_byte, opts.fileDir, opts.fileName, row.ordinal);
		}
		store.db
			.prepare(`UPDATE files SET source_text = ?, source_hash = ?, pending_kind = 'update', updated_at = ? WHERE file_dir = ? AND file_name = ?`)
			.run(rebuilt, hashText(rebuilt), new Date().toISOString(), opts.fileDir, opts.fileName);
		store.db
			.prepare(`INSERT INTO change_log (kind, detail, recorded_at) VALUES (?, ?, ?)`)
			.run("update-function", `${opts.fileDir}/${opts.fileName}:${opts.functionName}`, new Date().toISOString());
	});
	return { ok: true, updated: `${opts.fileDir}/${opts.fileName}:${opts.functionName}`, pending: "update" };
}

export function updateFile(
	store: Store,
	opts: { fileDir: string; fileName: string; text: string; language?: Language },
): MutationResult {
	const exists = store.read(() =>
		store.db.prepare(`SELECT 1 AS one FROM files WHERE file_dir = ? AND file_name = ?`).get(opts.fileDir, opts.fileName),
	);
	const now = new Date().toISOString();
	store.tx(() => {
		if (exists) {
			// Whole-file replace: entries would be stale; drop them so the
			// materializer falls back to source_text. The loop-end reindex rebuilds.
			store.db.prepare(`DELETE FROM file_entries WHERE file_dir = ? AND file_name = ?`).run(opts.fileDir, opts.fileName);
			store.db
				.prepare(`UPDATE files SET source_text = ?, source_hash = ?, pending_kind = 'update', updated_at = ? WHERE file_dir = ? AND file_name = ?`)
				.run(opts.text, hashText(opts.text), now, opts.fileDir, opts.fileName);
		} else {
			store.db
				.prepare(
					`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, pending_kind, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'update', ?)`,
				)
				.run(opts.fileDir, opts.fileName, opts.language ?? "javascript", hashText(opts.text), opts.text, now);
		}
		store.db
			.prepare(`INSERT INTO change_log (kind, detail, recorded_at) VALUES (?, ?, ?)`)
			.run("update-file", `${opts.fileDir}/${opts.fileName}`, now);
	});
	return { ok: true, updated: `${opts.fileDir}/${opts.fileName}`, pending: "update", created: !exists };
}

export function deleteFile(store: Store, opts: { fileDir: string; fileName: string }): MutationResult {
	const exists = store.read(() =>
		store.db.prepare(`SELECT 1 AS one FROM files WHERE file_dir = ? AND file_name = ?`).get(opts.fileDir, opts.fileName),
	);
	if (!exists) return { ok: false, reason: "file not indexed" };
	store.tx(() => {
		store.db.prepare(`UPDATE files SET pending_kind = 'delete' WHERE file_dir = ? AND file_name = ?`).run(opts.fileDir, opts.fileName);
		store.db
			.prepare(`INSERT INTO change_log (kind, detail, recorded_at) VALUES (?, ?, ?)`)
			.run("delete-file", `${opts.fileDir}/${opts.fileName}`, new Date().toISOString());
	});
	return { ok: true, updated: `${opts.fileDir}/${opts.fileName}`, pending: "delete" };
}

export function listPending(store: Store): Array<{ path: string; kind: string }> {
	const rows = store.read(() =>
		store.db
			.prepare(`SELECT file_dir, file_name, pending_kind FROM files WHERE pending_kind IS NOT NULL ORDER BY file_dir, file_name`)
			.all(),
	) as Array<{ file_dir: string; file_name: string; pending_kind: string }>;
	return rows.map((row) => ({ path: `${row.file_dir}/${row.file_name}`, kind: row.pending_kind }));
}
