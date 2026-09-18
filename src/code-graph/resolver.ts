/**
 * Conservative static call resolution. Captures call expressions of the form
 * `name(...)` and `obj.method(...)` inside the same file; cross-file
 * resolution is limited to relative imports and explicit module exports.
 */


export interface CallSite {
	fromFunction: string;
	calleeText: string;
	kind: "call" | "definition" | "import";
	resolution: "resolved" | "ambiguous" | "unresolved";
	/** Provenance (plan R-003): EXTRACTED = intra-file/direct binding or an
	 *  explicit import statement; INFERRED = target bound via cross-file
	 *  symbol resolution (default-export mapping, barrel re-export, ...). */
	confidence?: "EXTRACTED" | "INFERRED";
	target?: { fileDir: string; fileName: string; functionName: string };
	reason?: string;
	provenance: SourceLocation;
}
