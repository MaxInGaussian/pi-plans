/**
 * Light-weight pre-write syntax validation hook. Parses the produced source
 * text with the appropriate grammar and refuses to commit if the grammar
 * reports errors or missing nodes.
 */

import type { ParserBackend } from "./parser.ts";
import type { Language } from "./types.ts";

export interface ValidateSourceOptions {
	parsers: Record<Language, ParserBackend>;
}

export interface SyntaxValidation {
	ok: boolean;
	errors: Array<{ message: string; severity: string }>;
}

export function validateSyntax(
	sourceText: string,
	language: Language,
	opts: ValidateSourceOptions,
): SyntaxValidation {
	const backend = opts.parsers[language];
	if (!backend) {
		return { ok: false, errors: [{ message: `unsupported language: ${language}`, severity: "error" }] };
	}
	const parsed = backend.parse(sourceText);
	const errors = parsed.diagnostics.filter((diag) => diag.severity === "error" || diag.severity === "missing");
	return { ok: errors.length === 0, errors };
}
