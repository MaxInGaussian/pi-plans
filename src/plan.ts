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
