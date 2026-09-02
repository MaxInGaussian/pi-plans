/**
 * Public type definitions shared across the code-graph module. Kept small and
 * dependency-free so all sibling modules can import them safely.
 */

export type Language = "javascript" | "typescript" | "tsx" | "python";

export interface SourceLocation {
	startByte: number;
	endByte: number;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface ParseDiagnostic {
	message: string;
	severity: "error" | "warning" | "missing";
	startByte?: number;
	endByte?: number;
}

export type RenderUnitKind =
	| "raw"
	| "function"
	| "method"
	| "arrow"
	| "lambda"
	| "expression"
	| "decorator"
	| "docstring"
	| "unsupported";

export interface RenderUnit {
	kind: RenderUnitKind;
	/** Byte offsets into the source snapshot (UTF-8 bytes). */
	startByte: number;
	endByte: number;
	/** Optional identifier for chunks (function name, expression handle, etc.). */
	label?: string;
	/** Nested children rendered by the same backend. */
	children?: RenderUnit[];
	/** Whether this unit may be safely moved between manifest entries. */
	moveSupported: boolean;
}

export interface FunctionRecord {
	fileDir: string;
	fileName: string;
	functionName: string;
	language: Language;
	kind: "declaration" | "expression" | "arrow" | "method" | "async" | "generator" | "lambda" | "accessor" | "unsupported";
	/** UTF-8 text of the callable body (best-effort, may equal render code). */
	fullCode: string;
	fullCodeHash: string;
	/** Text used by the materializer to reconstruct the file (render unit). */
	renderCode: string;
	renderCodeHash: string;
	/** Optional human-readable parent identifier (class name, container). */
	parent?: string;
	/** Optional container group (class body, module). */
	container?: string;
	/** Whether the function entry may be moved between manifest positions. */
	moveSupported: boolean;
	/** Whether this record is a primary function (true) or merged overload signature (false). */
	isPrimary: boolean;
	/** Optional list of overload signatures merged into this entry (TypeScript). */
	overloadSignatures?: string[];
	/** UTF-8 byte span of the callable (provenance). */
	provenance: SourceLocation;
	summary: SummaryRecord | null;
	version: number;
}

export interface SummaryRecord {
	description: string;
	inputs: string[];
	outputs: string[];
	status: "ok" | "pending" | "declined" | "failed";
	model?: string;
	schemaVersion: number;
	effectiveEffort?: string;
	errorMessage?: string;
	updatedAt?: string;
}

export interface FileEntry {
	id: number;
	kind: "raw" | "function" | "decorator" | "docstring" | "trailing";
	/** Order within the file manifest. */
	ordinal: number;
	/** Optional reference to a function row (`(file_dir,file_name,function_name)`). */
	functionName?: string;
	/** Byte offsets into the file source snapshot. */
	startByte: number;
	endByte: number;
	text: string;
}

export interface FileRecord {
	fileDir: string;
	fileName: string;
	language: Language;
	sourceHash: string;
	sourceText: string;
	entries: FileEntry[];
	updatedAt: string;
}

export type EdgeKind = "call" | "definition" | "import";
export type EdgeResolution = "resolved" | "ambiguous" | "unresolved";

export interface CallEdge {
	id: number;
	fromFileDir: string;
	fromFileName: string;
	fromFunction: string;
	toFileDir?: string;
	toFileName?: string;
	toFunction?: string;
	toCalleeText: string;
	kind: EdgeKind;
	resolution: EdgeResolution;
	reason?: string;
	provenance: SourceLocation;
}

export interface GraphMeta {
	schemaVersion: number;
	worktreeRoot: string;
	gitCommonDir: string;
	parserVersions: Record<string, string>;
	updatedAt: string;
}

export interface CodeGraphSnapshot {
	id: number;
	headCommit: string;
	uncommittedPaths: string[];
	recordedAt: string;
}

export interface GraphContext {
	worktreeRoot: string;
	gitCommonDir: string;
	dbPath: string;
}

export interface FunctionScreening {
	fileDir: string;
	fileName: string;
	functionName: string;
	language: Language;
	kind: FunctionRecord["kind"];
	description: string | null;
	inputs: string[] | null;
	outputs: string[] | null;
	version: number;
	summaryStatus: SummaryRecord["status"] | null;
	inLinks: Array<{ fileDir: string; fileName: string; functionName: string }>;
	outLinks: Array<{ fileDir: string; fileName: string; functionName: string }>;
}
