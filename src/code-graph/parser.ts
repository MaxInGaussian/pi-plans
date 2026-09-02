/**
 * Parser backend interface. Each backend returns a list of render units plus a
 * list of (callable) function records. Callable spans do not overlap with
 * each other; overlapping spans are flattened through the parent linkage.
 */

import type {
	FunctionRecord,
	Language,
	ParseDiagnostic,
	RenderUnit,
	SourceLocation,
} from "./types.ts";

export interface ParsedFile {
	language: Language;
	renderUnits: RenderUnit[];
	functions: FunctionRecord[];
	diagnostics: ParseDiagnostic[];
}

export interface ParserBackend {
	readonly language: Language;
	parse(source: Buffer | string): ParsedFile;
}

export interface ParserContext {
	ParserCtor: new () => unknown;
	grammar: unknown;
}

export function makeLocation(
	startByte: number,
	endByte: number,
	startLine: number,
	startColumn: number,
	endLine: number,
	endColumn: number,
): SourceLocation {
	return { startByte, endByte, startLine, startColumn, endLine, endColumn };
}

export function hashText(text: string): string {
	// Simple non-cryptographic hash, fast and stable for fingerprinting.
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}
