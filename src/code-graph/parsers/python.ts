/**
 * Python backend. Recognizes `def`, `async def`, and `lambda` expressions,
 * class methods, and decorators as parent-relative nested entries.
 */

import type { ParserBackend, ParsedFile } from "../parser.ts";
import type { FunctionRecord, ParseDiagnostic, RenderUnit } from "../types.ts";
import { hashText, makeLocation } from "../parser.ts";

interface PythonNode {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	namedChildren: PythonNode[];
	children: PythonNode[];
	text?: string;
	parent?: PythonNode;
	isMissing?: boolean;
	hasError?: boolean;
}

interface ParserLike {
	parse(input: string | Buffer): { rootNode: PythonNode };
	setLanguage(language: unknown): void;
}

export class PythonBackend implements ParserBackend {
	readonly language = "python" as const;
	private readonly ParserCtor: new () => ParserLike;
	private readonly grammar: unknown;

	constructor(ParserCtor: new () => unknown, grammar: unknown) {
		this.ParserCtor = ParserCtor as never;
		this.grammar = grammar;
	}

	parse(source: Buffer | string): ParsedFile {
		const text = typeof source === "string" ? source : source.toString("utf8");
		const buf = Buffer.from(text, "utf8");
		const parser = new this.ParserCtor();
		parser.setLanguage(this.grammar);
		const tree = parser.parse(text);
		const diagnostics: ParseDiagnostic[] = [];
		const collectDiag = (node: PythonNode) => {
			if (node.hasError || node.isMissing) {
				diagnostics.push({
					message: node.isMissing ? `missing ${node.type}` : "syntax error",
					severity: node.isMissing ? "missing" : "error",
					startByte: node.startIndex,
					endByte: node.endIndex,
				});
			}
			for (const child of node.namedChildren ?? []) collectDiag(child);
		};
		collectDiag(tree.rootNode);
		const functions: FunctionRecord[] = [];
		const renderUnits: RenderUnit[] = [
			{ kind: "raw", startByte: 0, endByte: buf.length, moveSupported: false },
		];
		const anonymousOrdinals = new Map<string, number>();
		const visit = (node: PythonNode, parentName: string | null) => {
			if (node.type === "decorated_definition") {
				for (const child of node.namedChildren ?? []) visit(child, parentName);
				return;
			}
			if (node.type === "function_definition" || node.type === "lambda") {
				const nameNode = (node.namedChildren ?? []).find(
					(c) => c.type === "identifier" || c.type === "name",
				);
				let id = nameNode?.text;
				if (!id) {
					const scope = parentName ?? findClass(node) ?? "<module>";
					const key = `${scope}\0${node.type}`;
					const ordinal = (anonymousOrdinals.get(key) ?? 0) + 1;
					anonymousOrdinals.set(key, ordinal);
					id = `<anonymous:${node.type}#${ordinal}>`;
				}
				const qualified = parentName ? `${parentName}.${id}` : id;
				const callableText = text.slice(node.startIndex, node.endIndex);
				const container = findClass(node);
				functions.push({
					fileDir: "",
					fileName: "",
					functionName: qualified,
					language: "python",
					kind: node.type === "lambda" ? "lambda" : "declaration",
					fullCode: callableText,
					fullCodeHash: hashText(callableText),
					renderCode: callableText,
					renderCodeHash: hashText(callableText),
					parent: parentName ?? undefined,
					container,
					moveSupported: node.type !== "lambda" && !!nameNode,
					isPrimary: true,
					provenance: locator(node),
					summary: null,
					version: 1,
				});
				renderUnits.push({
					kind: node.type === "lambda" ? "lambda" : "function",
					startByte: node.startIndex,
					endByte: node.endIndex,
					label: qualified,
					moveSupported: node.type !== "lambda",
					children: [],
				});
				return;
			}
			if (node.type === "class_definition") {
				const classNameNode = (node.namedChildren ?? []).find(
					(c) => c.type === "identifier" || c.type === "name",
				);
				const className = classNameNode?.text ?? "<anonymous>";
				const children: RenderUnit[] = [];
				for (const child of node.namedChildren ?? []) {
					if (child.type === "block") {
						for (const inner of child.namedChildren ?? []) visit(inner, className);
					}
				}
				renderUnits.push({
					kind: "raw",
					startByte: node.startIndex,
					endByte: node.endIndex,
					label: className,
					moveSupported: false,
					children,
				});
				return;
			}
			for (const child of node.namedChildren ?? []) visit(child, parentName);
		};
		visit(tree.rootNode, null);
		return { language: "python", renderUnits, functions, diagnostics };
	}
}

function findClass(node: PythonNode): string | undefined {
	let p: PythonNode | undefined = node.parent;
	while (p) {
		if (p.type === "class_definition") {
			const nameNode = (p.namedChildren ?? []).find((c) => c.type === "identifier" || c.type === "name");
			return nameNode?.text ?? "<anonymous>";
		}
		p = p.parent;
	}
	return undefined;
}

function locator(node: PythonNode) {
	return makeLocation(
		node.startIndex,
		node.endIndex,
		node.startPosition.row + 1,
		node.startPosition.column,
		node.endPosition.row + 1,
		node.endPosition.column,
	);
}
