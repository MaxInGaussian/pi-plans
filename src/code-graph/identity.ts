/** Deterministic function identity normalization for a parsed file. */

import type { ParsedFile } from "./parser.ts";
import type { FunctionRecord, RenderUnit } from "./types.ts";

function spanKey(startByte: number, endByte: number): string {
	return `${startByte}:${endByte}`;
}

function finalNames(functions: FunctionRecord[]): Map<string, string> {
	const counts = new Map<string, number>();
	const names = new Map<string, string>();
	for (const fn of functions) {
		const ordinal = (counts.get(fn.functionName) ?? 0) + 1;
		counts.set(fn.functionName, ordinal);
		const name = ordinal === 1 ? fn.functionName : `${fn.functionName}#${ordinal}`;
		names.set(spanKey(fn.provenance.startByte, fn.provenance.endByte), name);
	}
	return names;
}

function renameUnits(units: RenderUnit[], names: Map<string, string>): RenderUnit[] {
	return units.map((unit) => ({
		...unit,
		label: names.get(spanKey(unit.startByte, unit.endByte)) ?? unit.label,
		children: unit.children ? renameUnits(unit.children, names) : unit.children,
	}));
}

/**
 * Normalize parser output before calls are resolved or rows are written. The
 * parser order is structural and deterministic; provenance is only used to
 * associate an existing render unit with its function record.
 */
export function normalizeFunctionIdentities(parsed: ParsedFile): ParsedFile {
	const names = finalNames(parsed.functions);
	const functions = parsed.functions.map((fn) => ({
		...fn,
		functionName: names.get(spanKey(fn.provenance.startByte, fn.provenance.endByte)) ?? fn.functionName,
	}));
	return {
		...parsed,
		functions,
		renderUnits: renameUnits(parsed.renderUnits, names),
	};
}

export function assertUniqueFunctionKeys(functions: FunctionRecord[], fileDir: string, fileName: string): void {
	const seen = new Set<string>();
	for (const fn of functions) {
		const key = `${fileDir}\0${fileName}\0${fn.functionName}`;
		if (seen.has(key)) {
			throw new Error(
				`duplicate normalized function identity for ${fileDir}/${fileName}/${fn.functionName} at ${fn.provenance.startByte}`,
			);
		}
		seen.add(key);
	}
}
