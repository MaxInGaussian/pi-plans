/**
 * Shared tree-sitter JSON helpers. Each language backend wraps a parser
 * instance and converts the tree into our normalized function / render units.
 */

import type {
	FunctionRecord,
	ParseDiagnostic,
	RenderUnit,
} from "../types.ts";
import { hashText, makeLocation, type ParserBackend, type ParsedFile } from "../parser.ts";

interface RawNode {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	namedChildren: RawNode[];
	children: RawNode[];
	text?: string;
	parent?: RawNode;
	isMissing?: boolean;
	hasError?: boolean;
}

type Tree = {
	rootNode: RawNode;
};

type Language = unknown;

interface ParserLike {
	parse(input: string | Buffer): Tree;
	setLanguage(language: Language): void;
}

export interface TreeSitterBackendOptions {
	ParserCtor: new () => ParserLike;
	language: unknown;
	languageId: FunctionRecord["kind"] extends string ? FunctionRecord["language"] : never;
}

const KINDS: Record<string, FunctionRecord["kind"]> = {
	function_declaration: "declaration",
	function: "declaration",
	method_definition: "method",
	generator_function_declaration: "generator",
	arrow_function: "arrow",
	function_expression: "expression",
	lambda: "lambda",
	async_function: "async",
};

function detectKind(node: RawNode): FunctionRecord["kind"] {
	if (node.type === "method_definition") {
		const accessor = (node.children ?? []).find((child) => child.type === "get" || child.type === "set");
		if (accessor) return "accessor";
	}
	if (KINDS[node.type]) return KINDS[node.type];
	if (node.type === "method_definition") return "method";
	return "declaration";
}

function collectDiagnostics(node: RawNode, acc: ParseDiagnostic[]): void {
	if (node.hasError || node.isMissing) {
		acc.push({
			message: node.isMissing ? `missing ${node.type}` : "syntax error",
			severity: node.isMissing ? "missing" : "error",
			startByte: node.startIndex,
			endByte: node.endIndex,
		});
	}
	for (const child of node.children ?? []) collectDiagnostics(child, acc);
}

function classContainer(node: RawNode): string | undefined {
	if (!node.parent) return undefined;
	let p: RawNode | undefined = node.parent;
	while (p) {
		if (p.type === "class_declaration" || p.type === "class_definition" || p.type === "class" || p.type === "interface_declaration") {
			return nameOfClass(p) ?? "<anonymous>";
		}
		p = p.parent;
	}
	return undefined;
}

function nameOfClass(node: RawNode): string | undefined {
	const child = (node.children ?? []).find(
		(c) => c.type === "identifier" || c.type === "name" || c.type === "type_identifier",
	);
	return child?.text;
}

function functionName(node: RawNode): string | null {
	const child = (node.children ?? []).find(
		(c) => c.type === "identifier" || c.type === "name" || c.type === "property_identifier",
	);
	return child?.text ?? null;
}

function qualifiedName(node: RawNode, parentName: string | null, anonymousOrdinals?: Map<string, number>): string {
	const named = functionName(node);
	let id = named;
	if (!id) {
		const scope = parentName ?? classContainer(node) ?? "<module>";
		const key = `${scope}\0${node.type}`;
		const ordinal = (anonymousOrdinals?.get(key) ?? 0) + 1;
		anonymousOrdinals?.set(key, ordinal);
		id = `<anonymous:${node.type}#${ordinal}>`;
	}
	if (parentName) return `${parentName}.${id}`;
	const container = classContainer(node);
	return container ? `${container}.${id}` : id;
}

function isOverloadSignatureNode(node: RawNode): boolean {
	return (
		node.type === "function_signature" ||
		node.type === "method_signature" ||
		node.type === "abstract_method_signature" ||
		node.type === "declare_function"
	);
}

function collectOverloadSignatures(node: RawNode, text: string, out: Map<string, string[]>): void {
	if (isOverloadSignatureNode(node)) {
		const name = functionName(node);
		if (name) {
			const base = qualifiedName(node, null);
			const signatures = out.get(base) ?? [];
			signatures.push(text.slice(node.startIndex, node.endIndex));
			out.set(base, signatures);
		}
	}
	for (const child of node.children ?? []) collectOverloadSignatures(child, text, out);
}

function locator(node: RawNode) {
	return makeLocation(
		node.startIndex,
		node.endIndex,
		node.startPosition.row + 1,
		node.startPosition.column,
		node.endPosition.row + 1,
		node.endPosition.column,
	);
}

export abstract class TreeSitterBackend implements ParserBackend {
	abstract readonly language: FunctionRecord["language"];
	protected readonly ParserCtor: new () => ParserLike;
	protected readonly grammar: unknown;

	constructor(opts: TreeSitterBackendOptions) {
		this.ParserCtor = opts.ParserCtor;
		this.grammar = opts.language;
	}

	protected withParser<T>(fn: (parser: ParserLike) => T): T {
		const parser = new this.ParserCtor();
		parser.setLanguage(this.grammar);
		return fn(parser);
	}

	parse(source: Buffer | string): ParsedFile {
		const text = typeof source === "string" ? source : source.toString("utf8");
		const buf = Buffer.from(text, "utf8");
		return this.withParser((parser) => {
			const tree = parser.parse(text);
			const diagnostics: ParseDiagnostic[] = [];
			collectDiagnostics(tree.rootNode, diagnostics);
			const overloads = new Map<string, string[]>();
			collectOverloadSignatures(tree.rootNode, text, overloads);
			const functions: FunctionRecord[] = [];
			const renderUnits: RenderUnit[] = [
				{
					kind: "raw",
					startByte: 0,
					endByte: buf.length,
					moveSupported: false,
				},
			];
			const anonymousOrdinals = new Map<string, number>();
			this.collect(tree.rootNode, text, buf, functions, renderUnits, null, anonymousOrdinals);
			for (const fn of functions) {
				const signatures = overloads.get(fn.functionName);
				if (signatures?.length) fn.overloadSignatures = signatures;
			}
			return {
				language: this.language,
				renderUnits,
				functions,
				diagnostics,
			};
		});
	}

	private collect(
		node: RawNode,
		text: string,
		_buf: Buffer,
		functions: FunctionRecord[],
		renderUnits: RenderUnit[],
		parentName: string | null,
		anonymousOrdinals: Map<string, number>,
	): void {
		for (const child of node.children ?? []) {
			this.visitNode(child, text, functions, renderUnits, parentName, anonymousOrdinals);
		}
	}

	protected visitNode(
		node: RawNode,
		text: string,
		functions: FunctionRecord[],
		renderUnits: RenderUnit[],
		parentName: string | null,
		anonymousOrdinals: Map<string, number>,
	): void {
		if (this.isCallable(node.type)) {
			const name = functionName(node);
			const qualified = qualifiedName(node, parentName, anonymousOrdinals);
			const callableText = text.slice(node.startIndex, node.endIndex);
			const container = classContainer(node);
			functions.push({
				fileDir: "",
				fileName: "",
				functionName: qualified,
				language: this.language,
				kind: detectKind(node),
				fullCode: callableText,
				fullCodeHash: hashText(callableText),
				renderCode: callableText,
				renderCodeHash: hashText(callableText),
				parent: parentName ?? undefined,
				container,
				moveSupported: !!(name && container !== undefined ? true : false),
				isPrimary: true,
				overloadSignatures: undefined,
				provenance: locator(node),
				summary: null,
				version: 1,
			});
			renderUnits.push({
				kind: node.type === "method_definition" ? "method" : node.type === "arrow_function" ? "arrow" : "function",
				startByte: node.startIndex,
				endByte: node.endIndex,
				label: qualified,
				moveSupported: !!name,
				children: this.collectNested(node, text, functions, renderUnits, qualified, anonymousOrdinals),
			});
			return;
		}
		this.collect(node, text, Buffer.from(text, "utf8"), functions, renderUnits, parentName, anonymousOrdinals);
	}

	protected collectNested(
		node: RawNode,
		text: string,
		functions: FunctionRecord[],
		renderUnits: RenderUnit[],
		parentName: string,
		anonymousOrdinals: Map<string, number>,
	): RenderUnit[] {
		const nested: RenderUnit[] = [];
		for (const child of node.children ?? []) {
			if (this.isCallable(child.type)) {
				const name = functionName(child);
				const qualified = qualifiedName(child, parentName, anonymousOrdinals);
				const callableText = text.slice(child.startIndex, child.endIndex);
				const container = classContainer(child);
				functions.push({
					fileDir: "",
					fileName: "",
					functionName: qualified,
					language: this.language,
					kind: detectKind(child),
					fullCode: callableText,
					fullCodeHash: hashText(callableText),
					renderCode: callableText,
					renderCodeHash: hashText(callableText),
					parent: parentName,
					container,
					moveSupported: !!name,
					isPrimary: true,
					provenance: locator(child),
					summary: null,
					version: 1,
				});
				nested.push({
					kind: child.type === "method_definition" ? "method" : child.type === "arrow_function" ? "arrow" : "function",
					startByte: child.startIndex,
					endByte: child.endIndex,
					label: qualified,
					moveSupported: !!name,
				});
			} else if (child.children) {
				for (const sub of child.children ?? []) this.visitNode(sub, text, functions, renderUnits, parentName, anonymousOrdinals);
			}
		}
		return nested;
	}

	protected isCallable(type: string): boolean {
		return (
			type === "function_declaration" ||
			type === "method_definition" ||
			type === "generator_function_declaration" ||
			type === "arrow_function" ||
			type === "function_expression" ||
			type === "lambda"
		);
	}
}
