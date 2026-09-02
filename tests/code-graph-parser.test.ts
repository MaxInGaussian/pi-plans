/**
 * Verifies the parser backends produce stable identities for the JS/TS/Python
 * fixtures. Skipped when the runtime cannot provide node:sqlite or
 * tree-sitter.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { normalizeFunctionIdentities } from "../src/code-graph/identity.ts";
import type { ParserBackend } from "../../src/code-graph/parser.ts";
import type { Language } from "../../src/code-graph/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures", "code-graph");

async function backends(): Promise<Record<Language, ParserBackend> | null> {
	try {
		const { runtime, status } = await loadGraphRuntime();
		if (!status.parserAvailable) return null;
		const ParserCtor = runtime.parser.Parser as unknown as new () => {
			parse(input: string | Buffer): unknown;
			setLanguage(language: unknown): void;
		};
		return {
			javascript: makeBackend("javascript", ParserCtor, runtime.parser.javascript),
			typescript: makeBackend("typescript", ParserCtor, runtime.parser.typescript),
			tsx: makeBackend("tsx", ParserCtor, runtime.parser.tsx),
			python: new PythonBackend(ParserCtor, runtime.parser.python),
		};
	} catch {
		return null;
	}
}

test("parsers yield function records without overlapping provenance", async () => {
	const bs = await backends();
	if (!bs) return; // skip when tree-sitter unavailable
	const jsSource = fs.readFileSync(path.join(fixturesDir, "sample.js"), "utf8");
	const pySource = fs.readFileSync(path.join(fixturesDir, "sample.py"), "utf8");
	const js = bs.javascript.parse(jsSource);
	const py = bs.python.parse(pySource);
	assert.ok(js.functions.length > 0);
	assert.ok(py.functions.length > 0);
	const jsNames = js.functions.map((f) => f.functionName);
	const pyNames = py.functions.map((f) => f.functionName);
	assert.ok(jsNames.includes("alpha"));
	assert.ok(pyNames.includes("alpha"));
	const lambda = py.functions.find((f) => f.kind === "lambda");
	assert.ok(lambda, "expected a lambda record in python fixture");
	// Every function has a non-empty hash and provenance.
	for (const fn of [...js.functions, ...py.functions]) {
		assert.equal(typeof fn.fullCodeHash, "string");
		assert.ok(fn.fullCodeHash.length > 0);
		assert.ok(fn.provenance.startByte < fn.provenance.endByte);
	}
});

test("parser metadata and identity normalization handle overloads and accessors", async () => {
	const bs = await backends();
	if (!bs) return;
	const js = bs.javascript.parse(fs.readFileSync(path.join(fixturesDir, "sample.js"), "utf8"));
	const normalized = normalizeFunctionIdentities(js);
	const accessorNames = normalized.functions
		.filter((fn) => fn.kind === "accessor")
		.map((fn) => fn.functionName);
	assert.deepEqual(accessorNames, ["Container.foo", "Container.foo#2"]);
	assert.ok(normalized.functions.some((fn) => fn.functionName === "Container.delta"));

	const ts = bs.typescript.parse(fs.readFileSync(path.join(fixturesDir, "sample.ts"), "utf8"));
	const overloaded = ts.functions.filter((fn) => fn.functionName === "overloaded");
	assert.equal(overloaded.length, 1, "overload signatures must not create separate function rows");
	assert.deepEqual(overloaded[0].overloadSignatures, [
		"function overloaded(value: string): string;",
		"function overloaded(value: number): number;",
	]);
	const tsAccessors = ts.functions.filter((fn) => fn.kind === "accessor");
	assert.deepEqual(tsAccessors.map((fn) => fn.functionName), ["Accessors.value", "Accessors.value"]);
});
