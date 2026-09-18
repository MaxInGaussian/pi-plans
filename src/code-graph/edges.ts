/**
 * Cross-file call/import edge extraction (plan I-002, R-003).
 *
 * Replaces the v1 regex resolver that marked every call site unresolved.
 * Pipeline per index run:
 *  1. buildModuleGraph — scan every indexed file's text (DB snapshots +
 *     in-batch overrides) for exported symbols and import declarations.
 *  2. extractEdges — per function body, resolve each call expression against
 *     (a) same-file functions → resolved/EXTRACTED, (b) imported symbols with
 *     a resolved module → resolved/INFERRED, (c) unique project-wide exported
 *     member name → resolved/INFERRED, (d) ambiguous imports → ambiguous,
 *     (e) everything else → dangling unresolved edge. Calls whose head is an
 *     import from an unresolved module (node_modules, node builtins) are
 *     dropped outright — they are noise, not signal (F-005).
 *
 * Import edges: kind="import", EXTRACTED when the module path resolves
 * directly, INFERRED when resolved via barrel probing (index.ts etc.).
 */

import type { SourceLocation, Language } from "./types.ts";
import type { DiscoveredFile } from "./discovery.ts";
import type { CallSite } from "./resolver.ts";
import type { FunctionRecord } from "./types.ts";
import type { Store } from "./store.ts";

export interface ModuleKey {
	fileDir: string;
	fileName: string;
	language: Language;
}

export interface ImportedSymbol {
	/** Local alias used at the call site (default/namespace/named alias). */
	local: string;
	/** Exported name this binding refers to; null for namespace imports. */
	imported: string | null;
	/** Raw module specifier as written ('./x', './x/y', 'x.y'). */
	source: string;
	kind: "import" | "require";
	/** Byte offset of the import statement (for provenance). */
	byte: number;
}

export interface ModuleInfo {
	key: ModuleKey;
	exports: Map<string, "function" | "other">;
	hasDefault: boolean;
	imports: ImportedSymbol[];
	/** Raw `export { x } from '...'` specifiers (pre-resolution). */
	reExports: Map<string, string>;
	/** Raw `export * from '...'` specifiers (pre-resolution). */
	starExports: string[];
	/** Resolved passthrough: symbol -> DEFINING module rel path. Call edges
	 *  must target the defining module, never the barrel (impl-review F-B). */
	reExportTargets: Map<string, string>;
}

export type ModuleGraph = Map<string, ModuleInfo>;

const JS_CALL_KEYWORDS = new Set([
	"if", "for", "while", "switch", "catch", "return", "function", "typeof", "instanceof",
	"delete", "void", "in", "of", "do", "else", "try", "finally", "throw", "new", "await", "yield",
	"case", "break", "continue", "const", "let", "var", "class", "extends", "import", "export",
]);

const JS_GLOBALS = new Set([
	"console", "Object", "Array", "JSON", "Math", "Promise", "Map", "Set", "WeakMap", "WeakSet",
	"Symbol", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "EvalError",
	"Buffer", "process", "setTimeout", "setInterval", "setImmediate", "clearTimeout",
	"clearInterval", "clearImmediate", "fetch", "isNaN", "isFinite", "parseInt", "parseFloat",
	"String", "Number", "Boolean", "BigInt", "Intl", "encodeURI", "decodeURI", "encodeURIComponent",
	"decodeURIComponent", "structuredClone", "queueMicrotask", "assert", "test", "describe", "it",
	"ArrayBuffer", "Uint8Array", "TextEncoder", "TextDecoder", "URL", "performance", "globalThis",
	"Reflect", "Proxy", "WeakRef", "FinalizationRegistry", "crypto", "URLSearchParams",
]);

const PY_BUILTINS = new Set([
	"print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple", "open",
	"isinstance", "issubclass", "super", "enumerate", "zip", "map", "filter", "sorted", "reversed",
	"min", "max", "sum", "abs", "any", "all", "repr", "format", "type", "hash", "id", "iter",
	"next", "callable", "getattr", "setattr", "hasattr", "delattr", "vars", "dir", "globals",
	"locals", "eval", "exec", "compile", "input", "Exception", "BaseException", "ValueError",
	"TypeError", "KeyError", "IndexError", "AttributeError", "RuntimeError", "StopIteration",
	"KeyboardInterrupt", "staticmethod", "classmethod", "property", "NotImplementedError",
	"MemoryError", "OSError", "IOError", "FileNotFoundError", "ZeroDivisionError", "bool", "bytes",
	"bytearray", "frozenset", "complex", "object", "slice", "self", "cls",
]);

const JS_SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
const JS_INDEX_BASENAMES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

function extractJsExports(text: string): {
	exports: Map<string, "function" | "other">;
	hasDefault: boolean;
	/** Re-export passthrough (impl-review F-B): symbol -> source module. */
	reExports: Map<string, string>;
	starExports: string[];
} {
	const exports = new Map<string, "function" | "other">();
	const reExports = new Map<string, string>();
	const starExports: string[] = [];
	let hasDefault = false;
	for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
		exports.set(m[2]!, m[1] === "function" ? "function" : "other");
	}
	for (const m of text.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
		starExports.push(m[1]!);
	}
	for (const m of text.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
		const fromSource = m[2];
		for (const part of m[1]!.split(",")) {
			const seg = part.trim();
			if (!seg) continue;
			const name = seg.includes(" as ") ? seg.split(/\s+as\s+/).pop()!.trim() : seg;
			if (!name || name.startsWith("*")) continue;
			if (fromSource) reExports.set(name, fromSource);
			else exports.set(name, "other");
		}
	}
	for (const m of text.matchAll(/export\s+default\s+(?!function|class)([A-Za-z_$][\w$]*)?/g)) {
		hasDefault = true;
		if (m[1]) exports.set(m[1], "other");
	}
	if (/export\s+default\s+(?:async\s+)?function/.test(text) || /export\s+default\s+class/.test(text)) hasDefault = true;
	return { exports, hasDefault, reExports, starExports };
}

function extractPyExports(text: string): Map<string, "function" | "other"> {
	const exports = new Map<string, "function" | "other">();
	for (const m of text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) exports.set(m[1]!, "function");
	for (const m of text.matchAll(/^class\s+([A-Za-z_]\w*)/gm)) exports.set(m[1]!, "other");
	return exports;
}

function extractJsImports(text: string): ImportedSymbol[] {
	const out: ImportedSymbol[] = [];
	for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
		const clause = m[1]!;
		const source = m[2]!;
		const byte = m.index ?? 0;
		const def = clause.match(/^([A-Za-z_$][\w$]*)/);
		if (def) out.push({ local: def[1]!, imported: "__default__", source, kind: "import", byte });
		const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
		if (ns) out.push({ local: ns[1]!, imported: null, source, kind: "import", byte });
		const named = clause.match(/\{([^}]*)\}/);
		if (named) {
			for (const part of named[1]!.split(",")) {
				const seg = part.trim();
				if (!seg) continue;
				const [raw, alias] = seg.split(/\s+as\s+/).map((x) => x.trim());
				if (raw === "type") continue;
				if (raw) out.push({ local: alias ?? raw, imported: raw, source, kind: "import", byte });
			}
		}
	}
	// Destructured require (named bindings) vs plain require (default):
	// `const { a, b: c } = require('./x')` binds named exports; only the
	// brace-less form binds the module default (impl-review F-B).
	for (const m of text.matchAll(/(?:const|let|var)\s+\{([^=}]*?)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		const clause = m[1]!;
		const source = m[2]!;
		const byte = m.index ?? 0;
		for (const part of clause.split(",")) {
			const seg = part.trim();
			if (!seg) continue;
			const prop = seg.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
			if (prop) out.push({ local: prop[2]!, imported: prop[1]!, source, kind: "require", byte });
			else if (/^[A-Za-z_$][\w$]*$/.test(seg)) out.push({ local: seg, imported: seg, source, kind: "require", byte });
		}
	}
	for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		out.push({ local: m[1]!, imported: "__default__", source: m[2]!, kind: "require", byte: m.index ?? 0 });
	}
	return out;
}

function extractPyImports(text: string): ImportedSymbol[] {
	const out: ImportedSymbol[] = [];
	for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/gm)) {
		const source = m[1]!;
		const byte = m.index ?? 0;
		const clause = m[2]!.trim();
		if (clause === "*") {
			out.push({ local: source.split(".").pop()!, imported: null, source, kind: "import", byte });
			continue;
		}
		const paren = clause.match(/^\((.*)\)$/);
		for (const part of (paren ? paren[1]! : clause).split(",")) {
			const seg = part.trim();
			if (!seg) continue;
			const [raw, alias] = seg.split(/\s+as\s+/).map((x) => x.trim());
			if (raw) out.push({ local: alias ?? raw, imported: raw, source, kind: "import", byte });
		}
	}
	for (const m of text.matchAll(/^\s*import\s+([\w.,\s]+)$/gm)) {
		const byte = m.index ?? 0;
		for (const part of m[1]!.split(",")) {
			const mod = part.trim();
			if (!mod) continue;
			// `import x.y` binds the HEAD module (x) in Python semantics, not
			// the tail — `x.f()` must resolve while `y.f()` stays unbound.
			out.push({ local: mod.split(".")[0]!, imported: null, source: mod.split(".")[0]!, kind: "import", byte });
		}
	}
	return out;
}

function moduleInfoFor(key: ModuleKey, text: string): ModuleInfo {
	const isPython = key.language === "python";
	const js = extractJsExports(text);
	const exports = isPython ? extractPyExports(text) : js.exports;
	const hasDefault = isPython ? false : js.hasDefault;
	const imports = isPython ? extractPyImports(text) : extractJsImports(text);
	const reExports = isPython ? new Map<string, string>() : js.reExports;
	const starExports = isPython ? [] : js.starExports;
	return { key, exports, hasDefault, imports, reExports, starExports, reExportTargets: new Map() };
}

/** Build (or extend) the module graph from DB snapshots, with in-batch text
 *  overrides taking precedence (fresh texts not yet committed). */
export function buildModuleGraph(
	store: Store,
	overrides: Map<string, { text: string; key: ModuleKey }>,
): ModuleGraph {
	const graph: ModuleGraph = new Map();
	const rows = store.read(() =>
		store.db.prepare(`SELECT file_dir, file_name, language, source_text, pending_kind FROM files`).all(),
	) as Array<{ file_dir: string; file_name: string; language: Language; source_text: string; pending_kind: string | null }>;
	for (const row of rows) {
		const rel = row.file_dir === "." ? row.file_name : `${row.file_dir}/${row.file_name}`;
		const key: ModuleKey = { fileDir: row.file_dir, fileName: row.file_name, language: row.language };
		const override = overrides.get(rel);
		if (override) {
			graph.set(rel, moduleInfoFor(override.key, override.text));
			continue;
		}
		// Pending-deleted files are gone; pending-updated files serve their
		// staged DB text (DB-first convergence).
		if (row.pending_kind === "delete") continue;
		graph.set(rel, moduleInfoFor(key, row.source_text));
	}
	for (const [rel, entry] of overrides) {
		if (!graph.has(rel)) graph.set(rel, moduleInfoFor(entry.key, entry.text));
	}
	// Re-export passthrough (impl-review F-B): resolve `export { x } from
	// './y'` and `export * from './y'` to the DEFINING module and record
	// symbol -> defining rel path in reExportTargets. The barrel's own
	// exports map stays untouched, so call edges target real function nodes
	// in the defining file — never phantom barrel nodes. Chained barrels are
	// followed transitively through the target's own reExportTargets.
	const relOf = (info: ModuleInfo, spec: string): string | null => {
		const target = resolveModulePath(spec, info.key, graph);
		return target ? target.relPath : null;
	};
	for (let hop = 0; hop < 4; hop++) {
		let expanded = false;
		for (const info of graph.values()) {
			if (info.reExports.size === 0 && info.starExports.length === 0) continue;
			for (const [symbol, spec] of [...info.reExports]) {
				const rel = relOf(info, spec);
				const targetInfo = rel ? graph.get(rel) : null;
				if (!targetInfo) {
					info.reExports.delete(symbol); // external source: no phantom
					expanded = true;
					continue;
				}
				if (targetInfo.exports.has(symbol) || targetInfo.reExportTargets.has(symbol)) {
					info.reExportTargets.set(symbol, targetInfo.exports.has(symbol) ? rel! : targetInfo.reExportTargets.get(symbol)!);
					info.reExports.delete(symbol);
					expanded = true;
				}
			}
			for (const spec of [...info.starExports]) {
				const rel = relOf(info, spec);
				const targetInfo = rel ? graph.get(rel) : null;
				if (!targetInfo) continue;
				for (const name of targetInfo.exports.keys()) {
					if (!info.exports.has(name) && !info.reExportTargets.has(name)) {
						info.reExportTargets.set(name, rel!);
						expanded = true;
					}
				}
				for (const [name, defining] of targetInfo.reExportTargets) {
					if (!info.exports.has(name) && !info.reExportTargets.has(name)) {
						info.reExportTargets.set(name, defining);
						expanded = true;
					}
				}
				info.starExports = info.starExports.filter((x) => x !== spec);
			}
		}
		if (!expanded) break;
	}
	return graph;
}

// ---------------------------------------------------------------------------
// Module path resolution
// ---------------------------------------------------------------------------

export interface ResolvedModule {
	key: ModuleKey;
	relPath: string;
	confidence: "EXTRACTED" | "INFERRED";
}

/** Resolve an import specifier to an indexed module. Relative JS specifiers
 *  probe extensions then index barrels (barrel hit = INFERRED); Python dotted
 *  modules map to directory/file paths. Returns null for externals. */
export function resolveModulePath(specifier: string, fromKey: ModuleKey, graph: ModuleGraph): ResolvedModule | null {
	if (fromKey.language === "python") {
		// `from . import x` / `from ..pkg import y`: resolve the current (or
		// parent) package's __init__ instead of bailing out.
		if (specifier === "." || specifier === "..") {
			const dirParts = fromKey.fileDir === "." ? [] : fromKey.fileDir.split("/");
			const targetDir = specifier === ".." ? dirParts.slice(0, -1) : dirParts;
			const rel = targetDir.length === 0 ? "__init__.py" : `${targetDir.join("/")}/__init__.py`;
			if (graph.has(rel)) return { key: graph.get(rel)!.key, relPath: rel, confidence: "EXTRACTED" };
			return null;
		}
		const parts = specifier.split(".").filter((p) => p.length > 0);
		if (parts.length === 0) return null;
		const candidates: Array<{ rel: string; barrel: boolean }> = [];
		const base = fromKey.fileDir === "." ? [] : fromKey.fileDir.split("/");
		for (const root of [base, []]) {
			let acc = [...root];
			for (let i = 0; i < parts.length; i++) {
				const isLast = i === parts.length - 1;
				if (isLast) {
					candidates.push({ rel: [...acc, `${parts[i]}.py`].join("/"), barrel: false });
					candidates.push({ rel: [...acc, parts[i]!, "__init__.py"].join("/"), barrel: true });
				} else {
					acc = [...acc, parts[i]!];
				}
			}
		}
		for (const cand of candidates) {
			if (graph.has(cand.rel)) {
				return { key: graph.get(cand.rel)!.key, relPath: cand.rel, confidence: cand.barrel ? "INFERRED" : "EXTRACTED" };
			}
		}
		return null;
	}
	// JS-family
	if (!specifier.startsWith(".")) return null; // package/builtin/alias — external
	const fromDirParts = fromKey.fileDir === "." ? [] : fromKey.fileDir.split("/");
	const resolveDir = (dir: string): string[] => {
		const parts = dir.split("/").filter((p) => p.length > 0);
		const stack = [...fromDirParts];
		for (const part of parts) {
			if (part === ".") continue;
			if (part === "..") stack.pop();
			else stack.push(part);
		}
		return stack;
	};
	const lastSlash = specifier.lastIndexOf("/");
	const base = lastSlash >= 0 ? specifier.slice(lastSlash + 1) : specifier;
	const dirParts = resolveDir(lastSlash >= 0 ? specifier.slice(0, lastSlash) || "." : ".");
	const tryRel = (parts: string[], name: string): string => (parts.length === 0 ? name : `${parts.join("/")}/${name}`);
	if (base) {
		for (const ext of JS_SOURCE_EXTENSIONS) {
			const rel = tryRel(dirParts, `${base}.${ext}`);
			if (graph.has(rel)) return { key: graph.get(rel)!.key, relPath: rel, confidence: "EXTRACTED" };
		}
		const rel = tryRel(dirParts, base);
		if (graph.has(rel)) return { key: graph.get(rel)!.key, relPath: rel, confidence: "EXTRACTED" };
		for (const idx of JS_INDEX_BASENAMES) {
			const rel = tryRel([...dirParts, base], idx);
			if (graph.has(rel)) return { key: graph.get(rel)!.key, relPath: rel, confidence: "INFERRED" };
		}
	} else {
		for (const idx of JS_INDEX_BASENAMES) {
			const rel = tryRel(dirParts, idx);
			if (graph.has(rel)) return { key: graph.get(rel)!.key, relPath: rel, confidence: "INFERRED" };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Call extraction + resolution
// ---------------------------------------------------------------------------

interface LineIndex {
	lineStarts: number[];
}

function buildLineIndex(text: string): LineIndex {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
	}
	return { lineStarts };
}

function locate(li: LineIndex, byte: number): { line: number; column: number } {
	let lo = 0;
	let hi = li.lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (li.lineStarts[mid]! <= byte) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo + 1, column: byte - li.lineStarts[lo]! + 1 };
}

function sourceLocation(li: LineIndex, startByte: number, length: number): SourceLocation {
	const start = locate(li, startByte);
	const end = locate(li, startByte + length);
	return {
		startByte,
		endByte: startByte + length,
		startLine: start.line,
		startColumn: start.column,
		endLine: end.line,
		endColumn: end.column,
	};
}

/** Unique project-wide exported symbol → module (for member-call fallback). */
function buildGlobalExportIndex(graph: ModuleGraph): Map<string, { relPath: string; count: number }> {
	const index = new Map<string, { relPath: string; count: number }>();
	for (const [rel, info] of graph) {
		for (const name of info.exports.keys()) {
			const entry = index.get(name);
			if (entry) entry.count++;
			else index.set(name, { relPath: rel, count: 1 });
		}
	}
	return index;
}

const DIRECT_CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const MEMBER_CALL_RE = /(?<!\w)([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Extract resolved/dangling call sites + import edges for one file.
 * `functions` are the freshly parsed FunctionRecords for this file.
 */
export function extractEdges(
	file: DiscoveredFile,
	text: string,
	functions: FunctionRecord[],
	graph: ModuleGraph,
): CallSite[] {
	const isPython = file.language === "python";
	const li = buildLineIndex(text);
	const out: CallSite[] = [];

	// Import bindings visible in this file, with resolved modules.
	type Binding = { imported: string | null; module: ResolvedModule | null };
	const bindings = new Map<string, Binding[]>();
	for (const imp of isPython ? extractPyImports(text) : extractJsImports(text)) {
		const module = resolveModulePath(imp.source, file, graph);
		const list = bindings.get(imp.local) ?? [];
		list.push({ imported: imp.imported, module });
		bindings.set(imp.local, list);
		if (module) {
			out.push({
				fromFunction: "<module>",
				calleeText: imp.source,
				kind: "import",
				resolution: "resolved",
				confidence: module.confidence,
				target: { fileDir: module.key.fileDir, fileName: module.key.fileName, functionName: "<module>" },
				reason: `import ${imp.source}`,
				provenance: sourceLocation(li, imp.byte, imp.source.length),
			});
		}
	}
	if (!isPython) {
		// Dynamic imports (impl-review F-B): emit an import edge instead of
		// dropping the specifier as keyword noise.
		for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			const spec = m[1]!;
			const at = m.index ?? 0;
			const module = resolveModulePath(spec, file, graph);
			out.push({
				fromFunction: "<module>",
				calleeText: `import(${spec})`,
				kind: "import",
				resolution: module ? "resolved" : "unresolved",
				confidence: module?.confidence ?? "EXTRACTED",
				target: module ? { fileDir: module.key.fileDir, fileName: module.key.fileName, functionName: "<module>" } : undefined,
				reason: module ? `dynamic import ${spec}` : `dynamic import (external) ${spec}`,
				provenance: sourceLocation(li, at, m[0].length),
			});
		}
	}

	const sameFile = new Set(functions.map((fn) => fn.functionName));
	const globalExports = buildGlobalExportIndex(graph);

	const resolveTarget = (
		head: string,
		member: string | null,
	): { target?: CallSite["target"]; resolution: CallSite["resolution"]; confidence: "EXTRACTED" | "INFERRED"; reason: string } => {
		if (!member && sameFile.has(head)) {
			return { target: { fileDir: file.fileDir, fileName: file.fileName, functionName: head }, resolution: "resolved", confidence: "EXTRACTED", reason: "same-file" };
		}
		if (member && sameFile.has(`${head}.${member}`)) {
			return { target: { fileDir: file.fileDir, fileName: file.fileName, functionName: `${head}.${member}` }, resolution: "resolved", confidence: "EXTRACTED", reason: "same-file qualified" };
		}
		// Import bindings are consulted BEFORE the same-file member heuristic
		// (impl-review F-B): a local `readFile` must not hijack `fs.readFile`.
		const lists = bindings.get(head);
		if (lists && lists.length > 0) {
			if (lists.length > 1) {
				return { resolution: "ambiguous", confidence: "EXTRACTED", reason: `${lists.length} bindings for ${head}` };
			}
			const binding = lists[0]!;
			if (!binding.module) {
				return { resolution: "unresolved", confidence: "EXTRACTED", reason: `external module ${head}` };
			}
			const info = graph.get(binding.module.relPath)!;
			const wanted = member ?? binding.imported;
			if (binding.imported === null) {
				if (member && info.exports.has(member)) {
					return { target: { fileDir: info.key.fileDir, fileName: info.key.fileName, functionName: member }, resolution: "resolved", confidence: "INFERRED", reason: `namespace ${head}.${member}` };
				}
				return { resolution: "unresolved", confidence: "EXTRACTED", reason: `namespace member ${head}.${member ?? ""}` };
			}
			if (wanted === "__default__") {
				if (member === null && info.hasDefault) {
					return { target: { fileDir: info.key.fileDir, fileName: info.key.fileName, functionName: "__default__" }, resolution: "resolved", confidence: "INFERRED", reason: "default import" };
				}
				if (member && info.exports.has(member)) {
					return { target: { fileDir: info.key.fileDir, fileName: info.key.fileName, functionName: member }, resolution: "resolved", confidence: "INFERRED", reason: `default import member ${member}` };
				}
				return { resolution: "unresolved", confidence: "EXTRACTED", reason: "default import member not exported" };
			}
			if (wanted && info.exports.has(wanted)) {
				return { target: { fileDir: info.key.fileDir, fileName: info.key.fileName, functionName: wanted }, resolution: "resolved", confidence: "INFERRED", reason: `imported ${wanted}` };
			}
			if (wanted) {
				// Re-export passthrough: target the DEFINING module.
				const definingRel = info.reExportTargets.get(wanted);
				if (definingRel) {
					const defining = graph.get(definingRel);
					if (defining) {
						return {
							target: { fileDir: defining.key.fileDir, fileName: defining.key.fileName, functionName: wanted },
							resolution: "resolved",
							confidence: "INFERRED",
							reason: `re-export via ${binding.module.relPath}`,
						};
					}
				}
			}
			return { resolution: "ambiguous", confidence: "EXTRACTED", reason: `${wanted} not exported by ${binding.module.relPath}` };
		}
		if (member && sameFile.has(member)) {
			// Same-name method heuristic: a guess, not a proven binding —
			// INFERRED, never EXTRACTED (impl-review F-B/F-D).
			return { target: { fileDir: file.fileDir, fileName: file.fileName, functionName: member }, resolution: "resolved", confidence: "INFERRED", reason: "same-file method (inferred)" };
		}
		if (member) {
			const hit = globalExports.get(member);
			if (hit && hit.count === 1) {
				const target = graph.get(hit.relPath)!.key;
				return { target: { fileDir: target.fileDir, fileName: target.fileName, functionName: member }, resolution: "resolved", confidence: "INFERRED", reason: "unique export" };
			}
			if (hit && hit.count > 1) {
				// Same-name exports across modules: ambiguous per plan R-003.
				return { resolution: "ambiguous", confidence: "EXTRACTED", reason: `${hit.count} modules export ${member}` };
			}
		}
		return { resolution: "unresolved", confidence: "EXTRACTED", reason: "unbound" };
	};

	const dropNoise = (head: string, member: string | null, reason: string): boolean => {
		// Calls bound to imports from unresolved modules (node_modules, node
		// builtins) are noise regardless of direct/member form (F-005).
		if (reason === `external module ${head}`) return true;
		if (isPython) {
			if (PY_BUILTINS.has(head)) return true;
			return !member && head.startsWith("__");
		}
		return JS_CALL_KEYWORDS.has(head) || JS_GLOBALS.has(head);
	};

	for (const fn of functions) {
		const full = fn.fullCode;
		// Skip the declaration signature so `function foo(` / `def foo(` and
		// method headers `render(width) {` are not recorded as self-calls.
		const scanFrom = isPython
			? (full.indexOf("\n") + 1 || full.length)
			: (() => {
					const brace = full.indexOf("{");
					return brace >= 0 ? brace + 1 : full.length;
				})();
		const body = full.slice(scanFrom);
		const base = fn.provenance.startByte + scanFrom;
		const seen = new Set<string>();
		for (const m of body.matchAll(MEMBER_CALL_RE)) {
			const head = m[1]!;
			const member = m[2]!;
			const at = base + (m.index ?? 0);
			const key = `${head}.${member}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const r = resolveTarget(head, member);
			if (dropNoise(head, member, r.reason)) continue;
			out.push({
				fromFunction: fn.functionName,
				calleeText: `${key}(`,
				kind: "call",
				resolution: r.resolution,
				confidence: r.confidence,
				target: r.target,
				reason: r.reason,
				provenance: sourceLocation(li, at, m[0].length),
			});
		}
		for (const m of body.matchAll(DIRECT_CALL_RE)) {
			const head = m[1]!;
			const at = base + (m.index ?? 0);
			if (seen.has(head)) continue;
			const isMemberAdjacent = body.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0) === ".";
			if (isMemberAdjacent) continue; // x.y( handled by the member pass
			seen.add(head);
			const r = resolveTarget(head, null);
			if (dropNoise(head, null, r.reason)) continue;
			out.push({
				fromFunction: fn.functionName,
				calleeText: `${head}(`,
				kind: "call",
				resolution: r.resolution,
				confidence: r.confidence,
				target: r.target,
				reason: r.reason,
				provenance: sourceLocation(li, at, m[0].length),
			});
		}
	}
	return out;
}
