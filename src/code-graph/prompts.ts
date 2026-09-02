/**
 * Graph prompt blocks injected into planner/refiner/executor contexts,
 * conditional on config.graph_enabled. Kept short (<200 chars per role).
 */

export function graphBlockForRefiner(enabled: boolean): string {
	return enabled
		? "Code graph: prefer the code_graph tool (screening, get-function, manifest) for code context instead of raw file reads."
		: "Code graph disabled: use Read/grep/ls for code context.";
}

export function graphBlockForExecutor(enabled: boolean): string {
	return enabled
		? "Code graph loop: read code via code_graph; edit code via code_graph mutations (update-function/update-file/delete-file), then run /apply-graph, verify with /graph-drift, and call plans action final-commit. /update-graph is only for human-made source edits."
		: "Code graph disabled: edit source files directly with edit/write.";
}
