/**
 * Graph prompt blocks injected into planner/refiner/executor contexts,
 * conditional on the graph mode. Enabled blocks are hard rules, not hints:
 * indexed code files must be read at function level; `full` is the only
 * whole-file exit.
 */

export function graphBlockForRefiner(enabled: boolean): string {
	return enabled
		? "Code graph: read-time validation is active — stale files automatically fall back to fresh disk reads (marked, never rebuilt in read-only sessions); files with staged edits serve the staged DB text (marked). Indexed code files MUST be read via the function digest or code_graph (screening, get-function, query, path, explain, impact) — no whole-file reads; full:true only as a last resort."
		: "Code graph disabled: use Read/grep/ls for code context.";
}

export function graphBlockForExecutor(enabled: boolean): string {
	return enabled
		? "Code graph loop: indexed code files read as a function digest by default (digests carry →calls/←called-by/§community) — never whole-file; drill in via code_graph get-function, full:true is the only whole-file exit. Stale reads self-heal (disk fallback + auto-reindex). Answer structural questions with code_graph query/path/explain/impact before grepping. Edit via graph-aware edit (DB-first; derived rows parse-merge immediately), then code_graph apply (auto-reindexes the materialized set; result includes the post-apply drift summary) → plans final-commit."
		: "Code graph disabled: edit source files directly with edit/write.";
}
