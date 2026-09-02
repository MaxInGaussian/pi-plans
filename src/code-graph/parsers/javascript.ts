/**
 * JavaScript / ECMAScript backend. Implements JS function declaration,
 * expression, arrow, method, generator and async functions.
 */

import { TreeSitterBackend } from "./tree-sitter.ts";
import type { FunctionRecord, Language } from "../types.ts";

export interface JavaScriptGrammar {
	default?: unknown;
	[key: string]: unknown;
}

export class JavaScriptBackend extends TreeSitterBackend {
	readonly language: Language = "javascript";
}

export class TypeScriptBackend extends TreeSitterBackend {
	readonly language: Language = "typescript";
}

export class TsxBackend extends TreeSitterBackend {
	readonly language: Language = "tsx";
}

export function makeBackend(
	language: "javascript" | "typescript" | "tsx",
	ParserCtor: new () => unknown,
	grammar: unknown,
): TreeSitterBackend {
	const opts = { ParserCtor: ParserCtor as never, language: grammar };
	if (language === "javascript") return new JavaScriptBackend(opts);
	if (language === "typescript") return new TypeScriptBackend(opts);
	return new TsxBackend(opts);
}
