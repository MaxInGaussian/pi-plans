/**
 * Shared graph-enabled tri-state resolution. Both the graph-aware file-tool
 * wrappers (tools/) and the execution prompt injection (src/exec.ts) must read
 * the SAME state through this helper, so the injected guidance and the actual
 * tool behavior can never diverge.
 *
 * Three states, deliberately not a boolean:
 *   - "enabled"             — graph_enabled === true: wrappers and graph reads active.
 *   - "off"                 — flag explicitly false/absent: native tools, no markers
 *                             (the injected prompt already announces the disabled state).
 *   - "config-unavailable"  — state root missing config or config.json unreadable:
 *                             treated as an unexpected fallback and surfaced with a
 *                             marker line (never silently collapsed into "off").
 */

import { loadConfig, resolveStateRootOrNull } from "../state.ts";

export type GraphMode = "enabled" | "off" | "config-unavailable";

export function resolveGraphMode(workdir: string): GraphMode {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (!stateRoot) return "off";
	try {
		return loadConfig(stateRoot).graph_enabled === true ? "enabled" : "off";
	} catch {
		return "config-unavailable";
	}
}
