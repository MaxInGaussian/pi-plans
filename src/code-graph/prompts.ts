/**
 * Graph prompt blocks injected into planner/refiner/executor contexts,
 * conditional on the graph mode. Enabled blocks are hard rules, not hints:
 * indexed code files must be read at function level; `full` is the only
 * whole-file exit.
 */

export function graphBlockForRefiner(enabled: boolean): string {
	return enabled
		? "Code graph: indexed code files MUST be read via the function digest or code_graph (screening, get-function) — no whole-file reads; full:true only as a last resort. Graph-aware read/edit are active."
		: "Code graph disabled: use Read/grep/ls for code context.";
}

export function graphBlockForExecutor(enabled: boolean): string {
	return enabled
		? "Code graph loop: indexed code files read as a function digest by default — never whole-file; drill in via offset/limit or code_graph get-function, full:true is the only whole-file exit. Edit via graph-aware edit (DB-first), then /apply-graph → /graph-drift → plans final-commit."
		: "Code graph disabled: edit source files directly with edit/write.";
}
