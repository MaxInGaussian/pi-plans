/** Plan artifact parsing: verifier checklist extraction and [DONE:VC-xxx] markers. */

import * as fs from "node:fs";

export interface CheckItem {
	id: string;
	text: string;
	done: boolean;
}

/** Parse the `## Verifier Checklist` section of a PLAN_vN.md into items. */
export function parseChecklist(planText: string): CheckItem[] {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+Verifier Checklist\s*$/.test(line.trim()));
	if (headerIndex < 0) return [];
	const items: CheckItem[] = [];
	const seen = new Set<string>();
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line.trim())) break; // next section ends the checklist
		const match = line.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/);
		if (!match) continue;
		const idMatch = match[2].match(/`(VC-\d+)`/) ?? match[2].match(/\b(VC-\d+)\b/);
		if (!idMatch) continue;
		const id = idMatch[1];
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ id, text: match[2].trim(), done: match[1].toLowerCase() === "x" });
	}
	return items;
}

/** Extract every [DONE:VC-xxx] marker from an assistant message. */
export function scanDoneMarkers(text: string): string[] {
	return [...text.matchAll(/\[DONE:(VC-\d+)\]/g)].map((match) => match[1]);
}

export interface CurrentIMarker {
	id: string;
}

/** Extract current implementation-item anchors from an assistant message. */
export function scanCurrentIMarkers(text: string): CurrentIMarker[] {
	return [...text.matchAll(/\[(I-\d+):current\]/g)].map((match) => ({ id: match[1] }));
}

export const scanCurrentMarkers = scanCurrentIMarkers;

/** Resolve the last known current-I marker, ignoring unknown ids. */
export function resolveCurrentI(
	implItems: ImplItem[],
	markers: CurrentIMarker[] | string[],
	fallback?: string,
): string | undefined {
	const known = new Set(implItems.map((item) => item.id));
	let current: string | undefined;
	for (const marker of markers) {
		const id = typeof marker === "string" ? marker : marker.id;
		if (known.has(id)) current = id;
	}
	return current ?? fallback;
}

/** Deterministic frontier used by snapshots written before currentI existed. */
export function inferCurrentI(
	implItems: ImplItem[] | undefined,
	items: CheckItem[],
	implStatus: Record<string, ImplMarkerState> | undefined,
): string | undefined {
	if (!implItems?.length) return undefined;
	const statuses = resolveImplStatuses(implItems, items, implStatus);
	return implItems.find((item) => statuses[item.id] !== "vc-passed")?.id ?? implItems.at(-1)?.id;
}

export type ImplMarkerState = "implemented" | "validating";

export interface ImplMarker {
	id: string;
	state: ImplMarkerState;
}

/** Extract every [I-xxx:implemented|validating] marker from an assistant message. */
export function scanImplMarkers(text: string): ImplMarker[] {
	return [...text.matchAll(/\[(I-\d+):(implemented|validating)\]/g)].map((match) => ({
		id: match[1],
		state: match[2] as ImplMarkerState,
	}));
}

export interface ImplItem {
	id: string;
	text: string;
}

/**
 * Parse the `## Implementation Items` section of a PLAN_vN.md. Strict grammar:
 * top-level `- `I-001`: text` single lines only; multi-line bodies and nested
 * sub-bullets are ignored (text stops at end of the first line).
 */
export function parseImplItems(planText: string): ImplItem[] {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+Implementation Items\s*$/.test(line.trim()));
	if (headerIndex < 0) return [];
	const items: ImplItem[] = [];
	const seen = new Set<string>();
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line.trim())) break; // next section ends the items
		const match = line.match(/^\s*-\s+`(I-\d+)`\s*:\s+(.*)$/);
		if (!match) continue;
		const id = match[1];
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ id, text: match[2].trim() });
	}
	return items;
}

/**
 * One-sentence description: cut at the first sentence boundary (。/.) or
 * semicolon (；/;), then cap at 80 characters with an ellipsis.
 */
export function shortImplDescription(text: string): string {
	const clipped = text.split(/[。；;]/)[0] ?? text;
	const sentence = clipped.split(/(?<=[.])\s/)[0] ?? clipped;
	const trimmed = sentence.trim();
	if (trimmed.length <= 80) return trimmed;
	return `${trimmed.slice(0, 79)}…`;
}

/**
 * Extract the covered I-ids from a VC checklist line's coverage clause
 * ("`VC-001` covers `I-002` and `I-003`; pass condition: ..." → ["I-002",
 * "I-003"]). Only references before the first ";" count.
 */
export function extractCoverage(vcText: string): string[] {
	const clause = vcText.split(";")[0] ?? "";
	return [...clause.matchAll(/\bI-\d+\b/g)].map((match) => match[0]);
}

export type ImplDisplayState = "pending" | "implementing" | "implemented" | "validating" | "vc-passed";

/**
 * Resolve the display state for every I-item. Precedence: vc-passed (all
 * covering VCs done, final) > explicit marker (validating / implemented) >
 * derivation (some covering VC done → validating; first I with no covering
 * VC done → implementing; rest → pending).
 */
export function resolveImplStatuses(
	implItems: ImplItem[],
	items: CheckItem[],
	implStatus: Record<string, ImplMarkerState> | undefined,
): Record<string, ImplDisplayState> {
	const result: Record<string, ImplDisplayState> = {};
	let frontierAssigned = false;
	for (const impl of implItems) {
		const coverage = items.filter((item) => extractCoverage(item.text).includes(impl.id));
		if (coverage.length > 0 && coverage.every((item) => item.done)) {
			result[impl.id] = "vc-passed";
			continue;
		}
		const marker = implStatus?.[impl.id];
		if (marker === "validating" || marker === "implemented") {
			result[impl.id] = marker;
			continue;
		}
		if (coverage.some((item) => item.done)) {
			result[impl.id] = "validating";
			continue;
		}
		if (!frontierAssigned) {
			result[impl.id] = "implementing";
			frontierAssigned = true;
			continue;
		}
		result[impl.id] = "pending";
	}
	return result;
}

export interface PlanVersionFile {
	path: string;
	version: number;
}

/** Find the highest PLAN_vN.md in an artifact directory. */
export function latestPlanVersion(artifactDir: string): PlanVersionFile | null {
	if (!fs.existsSync(artifactDir)) return null;
	let best: PlanVersionFile | null = null;
	for (const name of fs.readdirSync(artifactDir)) {
		const match = name.match(/^PLAN_v(\d+)\.(md|markdown)$/i);
		if (!match) continue;
		const version = Number(match[1]);
		if (best === null || version > best.version) {
			best = { path: `${artifactDir}/${name}`, version };
		}
	}
	return best;
}

/** Path for the next plan revision (PLAN_vN+1.md) in an artifact directory. */
export function nextPlanVersionPath(artifactDir: string): PlanVersionFile {
	const latest = latestPlanVersion(artifactDir);
	const version = (latest?.version ?? 0) + 1;
	return { path: `${artifactDir}/PLAN_v${version}.md`, version };
}
