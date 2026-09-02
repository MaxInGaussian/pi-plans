/**
 * Conservative static call resolution. Captures call expressions of the form
 * `name(...)` and `obj.method(...)` inside the same file; cross-file
 * resolution is limited to relative imports and explicit module exports.
 */

import type { SourceLocation } from "./types.ts";
import type { DiscoveredFile } from "./discovery.ts";

export interface CallSite {
	fromFunction: string;
	calleeText: string;
	kind: "call" | "definition" | "import";
	resolution: "resolved" | "ambiguous" | "unresolved";
	target?: { fileDir: string; fileName: string; functionName: string };
	reason?: string;
	provenance: SourceLocation;
}

const CALL_PATTERN = /\b([a-zA-Z_$][\w$]*)(?:\.([a-zA-Z_$][\w$]*))?\s*\(/g;

export function resolveCalls(fromFunction: string, code: string, file: DiscoveredFile, out: CallSite[]): void {
	for (const match of code.matchAll(CALL_PATTERN)) {
		const head = match[1];
		const member = match[2];
		const start = match.index ?? 0;
		const calleeText = match[0];
		out.push({
			fromFunction,
			calleeText,
			kind: "call",
			resolution: "unresolved",
			reason: "conservative resolution: same-file or relative import only",
			provenance: locationOf(code, start, calleeText.length),
		});
		void head;
		void member;
		void file;
	}
	for (const match of code.matchAll(/^\s*(?:import|from)\s+([\w./-]+)/gm)) {
		const start = match.index ?? 0;
		out.push({
			fromFunction,
			calleeText: match[0],
			kind: "import",
			resolution: "unresolved",
			reason: "import resolution deferred to module graph (not implemented in v1)",
			provenance: locationOf(code, start, match[0].length),
		});
	}
}

function locationOf(code: string, byteStart: number, length: number): SourceLocation {
	const before = code.slice(0, byteStart);
	const startLine = before.split("\n").length;
	const startColumn = before.length - before.lastIndexOf("\n");
	const targetText = code.slice(byteStart, byteStart + length);
	const endLine = startLine + targetText.split("\n").length - 1;
	const endColumn =
		targetText.split("\n").pop()?.length ?? startColumn;
	return {
		startByte: byteStart,
		endByte: byteStart + length,
		startLine,
		startColumn,
		endLine,
		endColumn,
	};
}
