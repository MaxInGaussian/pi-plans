/**
 * Staged indexing pipeline: discovery → parse → resolve calls → write records
 * inside a single SQLite write transaction. Each stage produces immutable
 * snapshots so a parser crash cannot leave the DB in an inconsistent state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { discoverFiles, type DiscoveredFile } from "./discovery.ts";
import { Store } from "./store.ts";
import type { ParserBackend } from "./parser.ts";
import { hashText } from "./parser.ts";
import type { Language } from "./types.ts";
import { resolveCalls, type CallSite } from "./resolver.ts";
import { assertUniqueFunctionKeys, normalizeFunctionIdentities } from "./identity.ts";

export interface IndexerOptions {
	store: Store;
	worktreeRoot: string;
	parsers: Record<Language, ParserBackend>;
	reindex?: boolean;
	/** When provided, only index these POSIX "dir/name" paths; paths that no
	 *  longer exist on disk are purged from the DB (deletions and rename-old). */
	paths?: string[];
}

export interface IndexReport {
	filesScanned: number;
	functionsIndexed: number;
	edgesResolved: number;
	edgesUnresolved: number;
	conflicts: number;
	durationMs: number;
	reindexedPaths: string[];
	purgedPaths: string[];
}

export async function runIndex(opts: IndexerOptions): Promise<IndexReport> {
	const started = Date.now();
	const files = discoverFiles({ worktreeRoot: opts.worktreeRoot });
	const pathFilter = opts.paths ? new Set(opts.paths) : null;
	if (pathFilter) {
		for (const requested of pathFilter) {
			if (!files.some((file) => `${file.fileDir}/${file.fileName}` === requested)) {
				// Requested path no longer exists on disk (deletion or rename-old):
				// purge its DB rows inside the same transaction below.
				files.push({
					absolutePath: path.join(opts.worktreeRoot, requested),
					fileDir: requested.slice(0, requested.lastIndexOf("/")) || ".",
					fileName: requested.slice(requested.lastIndexOf("/") + 1),
					language: "javascript",
				}) as DiscoveredFile;
			}
		}
	}
	const staged: Array<{
		file: DiscoveredFile;
		parsed: ReturnType<ParserBackend["parse"]>;
		calls: CallSite[];
		sourceText: string;
		sourceHash: string;
		exists: boolean;
	}> = [];
	let preflightConflict = 0;
	const existingByFile = new Map<string, { sourceHash: string }>();
	for (const row of opts.store
		.read(() => opts.store.db.prepare("SELECT file_dir, file_name, source_hash FROM files").all()) as Array<{
		file_dir: string;
		file_name: string;
		source_hash: string;
	}>) {
		existingByFile.set(`${row.file_dir}/${row.file_name}`, { sourceHash: row.source_hash });
	}
	for (const file of files) {
		const relativeKey = `${file.fileDir}/${file.fileName}`;
		if (pathFilter && !pathFilter.has(relativeKey)) continue;
		let sourceText: string;
		let exists = true;
		try {
			sourceText = fs.readFileSync(file.absolutePath, "utf8");
		} catch {
			if (pathFilter) {
				// Path was requested but is gone from disk: stage a purge.
				staged.push({ file, parsed: { functions: [], renderUnits: [] } as ReturnType<ParserBackend["parse"]>, calls: [], sourceText: "", sourceHash: "", exists: false });
			}
			continue;
		}
		const sourceHash = hashText(sourceText);
		const backend = opts.parsers[file.language];
		if (!backend) continue;
		let parsed = backend.parse(sourceText);
		parsed = normalizeFunctionIdentities(parsed);
		parsed.functions.forEach((fn) => {
			fn.fileDir = file.fileDir;
			fn.fileName = file.fileName;
		});
		assertUniqueFunctionKeys(parsed.functions, file.fileDir, file.fileName);
		const calls: CallSite[] = [];
		for (const fn of parsed.functions) {
			const fromText = fn.fullCode;
			resolveCalls(fn.functionName, fromText, file, calls);
		}
		staged.push({ file, parsed, calls, sourceText, sourceHash, exists: true });
	}
	const now = new Date().toISOString();
	const report: IndexReport = {
		filesScanned: staged.filter((entry) => entry.exists).length,
		functionsIndexed: 0,
		edgesResolved: 0,
		edgesUnresolved: 0,
		conflicts: 0,
		durationMs: 0,
		reindexedPaths: [],
		purgedPaths: [],
	};
	try {
		opts.store.tx(() => {
			for (const { file, parsed, calls, sourceText, sourceHash, exists } of staged) {
				if (!exists) {
					opts.store
						.prepare("delete_functions_purge", `DELETE FROM functions WHERE file_dir = ? AND file_name = ?`)
						.run(file.fileDir, file.fileName);
					opts.store
						.prepare("delete_entries_purge", `DELETE FROM file_entries WHERE file_dir = ? AND file_name = ?`)
						.run(file.fileDir, file.fileName);
					opts.store
						.prepare("delete_edges_purge", `DELETE FROM call_edges WHERE from_file_dir = ? AND from_file_name = ?`)
						.run(file.fileDir, file.fileName);
					opts.store
						.prepare("delete_file_purge", `DELETE FROM files WHERE file_dir = ? AND file_name = ?`)
						.run(file.fileDir, file.fileName);
					report.purgedPaths.push(`${file.fileDir}/${file.fileName}`);
					continue;
			}
				report.reindexedPaths.push(`${file.fileDir}/${file.fileName}`);
				const stmt = opts.store.prepare(
					"insert_file",
					`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(file_dir, file_name) DO UPDATE SET
						language = excluded.language,
						source_hash = excluded.source_hash,
						source_text = excluded.source_text,
						updated_at = excluded.updated_at`,
				);
				stmt.run(file.fileDir, file.fileName, file.language, sourceHash, sourceText, now);
				const oldHash = existingByFile.get(`${file.fileDir}/${file.fileName}`)?.sourceHash;
				if (opts.reindex && oldHash && oldHash !== sourceHash) {
					opts.store
						.prepare(
							"insert_conflict",
							`INSERT INTO reindex_conflicts (file_dir, file_name, kind, detail, recorded_at)
							 VALUES (?, ?, ?, ?, ?)`,
						)
						.run(file.fileDir, file.fileName, "external-change", `was ${oldHash}, now ${sourceHash}`, now);
					report.conflicts++;
				}
				opts.store
					.prepare("delete_functions", `DELETE FROM functions WHERE file_dir = ? AND file_name = ?`)
					.run(file.fileDir, file.fileName);
				opts.store
					.prepare("delete_entries", `DELETE FROM file_entries WHERE file_dir = ? AND file_name = ?`)
					.run(file.fileDir, file.fileName);
				opts.store
					.prepare("delete_edges", `DELETE FROM call_edges WHERE from_file_dir = ? AND from_file_name = ?`)
					.run(file.fileDir, file.fileName);
				const insertFn = opts.store.prepare(
					"insert_function",
					`INSERT INTO functions (
						file_dir, file_name, function_name, language, kind,
						full_code, full_code_hash, render_code, render_code_hash,
						parent, container, move_supported, is_primary, overload_signatures,
						provenance_start_byte, provenance_end_byte,
						provenance_start_line, provenance_start_col,
						provenance_end_line, provenance_end_col,
						summary_description, summary_inputs, summary_outputs,
						summary_status, summary_model, summary_schema_version,
						summary_effective_effort, summary_error, summary_updated_at,
						version
					) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				);
				for (const fn of parsed.functions) {
					const summary = fn.summary;
					insertFn.run(
						fn.fileDir,
						fn.fileName,
						fn.functionName,
						fn.language,
						fn.kind,
						fn.fullCode,
						fn.fullCodeHash,
						fn.renderCode,
						fn.renderCodeHash,
						fn.parent ?? null,
						fn.container ?? null,
						fn.moveSupported ? 1 : 0,
						fn.isPrimary ? 1 : 0,
						fn.overloadSignatures ? JSON.stringify(fn.overloadSignatures) : null,
						fn.provenance.startByte,
						fn.provenance.endByte,
						fn.provenance.startLine,
						fn.provenance.startColumn,
						fn.provenance.endLine,
						fn.provenance.endColumn,
						summary?.description ?? null,
						summary ? JSON.stringify(summary.inputs) : null,
						summary ? JSON.stringify(summary.outputs) : null,
						summary?.status ?? null,
						summary?.model ?? null,
						summary?.schemaVersion ?? null,
						summary?.effectiveEffort ?? null,
						summary?.errorMessage ?? null,
						summary?.updatedAt ?? null,
						fn.version,
					);
					report.functionsIndexed++;
				}
				let ordinal = 0;
				const insertEntry = opts.store.prepare(
					"insert_entry",
					`INSERT INTO file_entries (file_dir, file_name, ordinal, kind, function_name, start_byte, end_byte, text)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				);
				for (const unit of parsed.renderUnits) {
					insertEntry.run(
						file.fileDir,
						file.fileName,
						ordinal,
						unit.kind,
						unit.label ?? null,
						unit.startByte,
						unit.endByte,
						unit.text ?? "",
					);
					ordinal++;
				}
				const insertEdge = opts.store.prepare(
					"insert_edge",
					`INSERT INTO call_edges (
						from_file_dir, from_file_name, from_function,
						to_file_dir, to_file_name, to_function,
						to_callee_text, kind, resolution, reason,
						provenance_start_byte, provenance_end_byte,
						provenance_start_line, provenance_start_col,
						provenance_end_line, provenance_end_col
					) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				);
				for (const call of calls) {
					insertEdge.run(
						file.fileDir,
						file.fileName,
						call.fromFunction,
						call.target?.fileDir ?? null,
						call.target?.fileName ?? null,
						call.target?.functionName ?? null,
						call.calleeText,
						call.kind,
						call.resolution,
						call.reason ?? null,
						call.provenance.startByte,
						call.provenance.endByte,
						call.provenance.startLine,
						call.provenance.startColumn,
						call.provenance.endLine,
						call.provenance.endColumn,
					);
					if (call.resolution === "resolved") report.edgesResolved++;
					else report.edgesUnresolved++;
				}
			}
		});
	} catch (error) {
		if (!opts.reindex && staged.length === 0) {
			preflightConflict++;
		}
		throw error;
	}
	report.durationMs = Date.now() - started;
	report.conflicts += preflightConflict;
	return report;
}
