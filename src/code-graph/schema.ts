/**
 * Schema definition and migrations for the code-graph SQLite database. The
 * database is intentionally normalized — JSON views are derived from the
 * edge tables at query time and never stored alongside them.
 */

export const CURRENT_SCHEMA_VERSION = 2;

export const SCHEMA_STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS graph_meta (
		schema_version INTEGER PRIMARY KEY,
		worktree_root TEXT NOT NULL,
		git_common_dir TEXT NOT NULL,
		parser_versions TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS files (
		file_dir TEXT NOT NULL,
		file_name TEXT NOT NULL,
		language TEXT NOT NULL,
		source_hash TEXT NOT NULL,
		source_text TEXT NOT NULL,
		pending_kind TEXT,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (file_dir, file_name)
	)`,
	`CREATE TABLE IF NOT EXISTS file_entries (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_dir TEXT NOT NULL,
		file_name TEXT NOT NULL,
		ordinal INTEGER NOT NULL,
		kind TEXT NOT NULL,
		function_name TEXT,
		start_byte INTEGER NOT NULL,
		end_byte INTEGER NOT NULL,
		text TEXT NOT NULL,
		UNIQUE (file_dir, file_name, ordinal)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_file_entries_file ON file_entries (file_dir, file_name, ordinal)`,
	`CREATE TABLE IF NOT EXISTS functions (
		file_dir TEXT NOT NULL,
		file_name TEXT NOT NULL,
		function_name TEXT NOT NULL,
		language TEXT NOT NULL,
		kind TEXT NOT NULL,
		full_code TEXT NOT NULL,
		full_code_hash TEXT NOT NULL,
		render_code TEXT NOT NULL,
		render_code_hash TEXT NOT NULL,
		parent TEXT,
		container TEXT,
		move_supported INTEGER NOT NULL,
		is_primary INTEGER NOT NULL,
		overload_signatures TEXT,
		provenance_start_byte INTEGER NOT NULL,
		provenance_end_byte INTEGER NOT NULL,
		provenance_start_line INTEGER NOT NULL,
		provenance_start_col INTEGER NOT NULL,
		provenance_end_line INTEGER NOT NULL,
		provenance_end_col INTEGER NOT NULL,
		summary_description TEXT,
		summary_inputs TEXT,
		summary_outputs TEXT,
		summary_status TEXT,
		summary_model TEXT,
		summary_schema_version INTEGER,
		summary_effective_effort TEXT,
		summary_error TEXT,
		summary_updated_at TEXT,
		version INTEGER NOT NULL DEFAULT 1,
		PRIMARY KEY (file_dir, file_name, function_name)
	)`,
	`CREATE TABLE IF NOT EXISTS call_edges (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_file_dir TEXT NOT NULL,
		from_file_name TEXT NOT NULL,
		from_function TEXT NOT NULL,
		to_file_dir TEXT,
		to_file_name TEXT,
		to_function TEXT,
		to_callee_text TEXT NOT NULL,
		kind TEXT NOT NULL,
		resolution TEXT NOT NULL,
		reason TEXT,
		provenance_start_byte INTEGER NOT NULL,
		provenance_end_byte INTEGER NOT NULL,
		provenance_start_line INTEGER NOT NULL,
		provenance_start_col INTEGER NOT NULL,
		provenance_end_line INTEGER NOT NULL,
		provenance_end_col INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_call_edges_from ON call_edges (from_file_dir, from_file_name, from_function)`,
	`CREATE INDEX IF NOT EXISTS idx_call_edges_to ON call_edges (to_file_dir, to_file_name, to_function)`,
	`CREATE TABLE IF NOT EXISTS change_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		detail TEXT NOT NULL,
		recorded_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS reindex_conflicts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_dir TEXT NOT NULL,
		file_name TEXT NOT NULL,
		kind TEXT NOT NULL,
		detail TEXT NOT NULL,
		recorded_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS code_graph_snapshot (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		head_commit TEXT NOT NULL,
		uncommitted_paths TEXT NOT NULL,
		recorded_at TEXT NOT NULL
	)`,
];

export const FUNCTION_RECORDS_VIEW = `
CREATE VIEW IF NOT EXISTS function_records AS
SELECT
	f.file_dir AS file_dir,
	f.file_name AS file_name,
	f.function_name AS function_name,
	f.language AS language,
	f.kind AS kind,
	f.parent AS parent,
	f.container AS container,
	f.move_supported AS move_supported,
	f.is_primary AS is_primary,
	f.provenance_start_byte AS provenance_start_byte,
	f.provenance_end_byte AS provenance_end_byte,
	(SELECT json_group_array(json_object('file_dir', e.from_file_dir, 'file_name', e.from_file_name, 'function_name', e.from_function))
		FROM call_edges e WHERE e.to_file_dir = f.file_dir AND e.to_file_name = f.file_name AND e.to_function = f.function_name AND e.resolution = 'resolved') AS in_links_json,
	(SELECT json_group_array(json_object('file_dir', e.to_file_dir, 'file_name', e.to_file_name, 'function_name', e.to_function))
		FROM call_edges e WHERE e.from_file_dir = f.file_dir AND e.from_file_name = f.file_name AND e.from_function = f.function_name AND e.resolution = 'resolved') AS out_links_json
FROM functions f
`;
