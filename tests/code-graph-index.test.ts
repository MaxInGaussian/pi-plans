/**
 * End-to-end index integration test: write a small fixture into a git
 * worktree, run the indexer, and verify function rows and edges.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/code-graph/store.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { screeningQuery } from "../src/code-graph/screening.ts";
import { hashText } from "../src/code-graph/parser.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";

function git(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	return (result.stdout ?? "").trim();
}

function initRepo(): { worktreeRoot: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-index-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	const subdir = path.join(dir, "pkg");
	fs.mkdirSync(subdir, { recursive: true });
	fs.writeFileSync(path.join(subdir, "math.js"), `function add(a, b) { return a + b; }\nfunction mul(a, b) { return a * b; }\nfunction same() { return 1; }\nfunction same() { return 2; }\n`);
	fs.writeFileSync(path.join(subdir, "note.py"), `def hello(name):\n    return f"hi {name}"\n`);
	fs.writeFileSync(path.join(subdir, "api.ts"), `function overloaded(value: string): string;\nfunction overloaded(value: number): number;\nfunction overloaded(value: string | number): string | number { return value; }\n\nclass Accessors {\n\tget value(): string { return "value"; }\n\tset value(next: string) { void next; }\n}\n`);
	git(subdir, ["add", "-A"]);
	git(subdir, ["commit", "-m", "init"]);
	return {
		worktreeRoot: subdir,
		cleanup: () => {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

test("runIndex indexes files, writes rows, and screening excludes full_code", async (t) => {
	const { worktreeRoot, cleanup } = initRepo();
	t.after(cleanup);
	const runtime = await loadGraphRuntime();
	if (!runtime.status.parserAvailable || !runtime.status.sqliteAvailable) return;
	const ParserCtor = runtime.runtime.parser.Parser as unknown as new () => {
		parse(input: string | Buffer): unknown;
		setLanguage(language: unknown): void;
	};
	const parsers: Record<Language, ParserBackend> = {
		javascript: makeBackend("javascript", ParserCtor, runtime.runtime.parser.javascript),
		typescript: makeBackend("typescript", ParserCtor, runtime.runtime.parser.typescript),
		tsx: makeBackend("tsx", ParserCtor, runtime.runtime.parser.tsx),
		python: new PythonBackend(ParserCtor, runtime.runtime.parser.python),
	};
	const sqlite = await import("node:sqlite");
	const commonDir = git(worktreeRoot, ["rev-parse", "--git-common-dir"]);
	const dbDir = path.join(path.resolve(worktreeRoot, commonDir), "pi_plans");
	fs.mkdirSync(dbDir, { recursive: true });
	const dbPath = path.join(dbDir, "code_graph.db");
	try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
	const store = new Store(
		{ dbPath, worktreeRoot, gitCommonDir: path.resolve(worktreeRoot, commonDir) },
		sqlite,
	);
	t.after(() => {
		store.close();
		try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
	});
	const report = await runIndex({ store, worktreeRoot, parsers });
	assert.equal(report.filesScanned >= 2, true, `expected >=2 files, got ${report.filesScanned}`);
	assert.equal(report.functionsIndexed >= 3, true, `expected >=3 functions, got ${report.functionsIndexed}`);
	const screening = screeningQuery({ store, functionNameLike: "add", limit: 50 });
	assert.equal(screening.length, 1);
	assert.equal(screening[0].fullCode, undefined);
	assert.equal(screening[0].functionName, "add");
	const same = screeningQuery({ store, functionNameLike: "same", limit: 50 });
	assert.deepEqual(same.map((item) => item.functionName), ["same", "same#2"]);
	const manifestNames = store.read(() =>
		store.db.prepare("SELECT function_name FROM file_entries WHERE file_dir = '.' AND file_name = 'math.js' AND function_name IS NOT NULL ORDER BY ordinal").all(),
	) as Array<{ function_name: string }>;
	assert.deepEqual(manifestNames.map((row) => row.function_name), ["add", "mul", "same", "same#2"]);
	const overload = store.read(() =>
		store.db.prepare("SELECT function_name, overload_signatures FROM functions WHERE file_name = 'api.ts' AND function_name = 'overloaded'").all(),
	) as Array<{ function_name: string; overload_signatures: string | null }>;
	assert.equal(overload.length, 1);
	assert.equal(overload[0].function_name, "overloaded");
	assert.deepEqual(JSON.parse(overload[0].overload_signatures ?? "[]"), [
		"function overloaded(value: string): string;",
		"function overloaded(value: number): number;",
	]);
	const accessorRows = store.read(() =>
		store.db.prepare("SELECT function_name, kind FROM functions WHERE file_name = 'api.ts' AND kind = 'accessor' ORDER BY provenance_start_byte").all(),
	) as Array<{ function_name: string; kind: string }>;
	assert.deepEqual(accessorRows.map((row) => [row.function_name, row.kind]), [
		["Accessors.value", "accessor"],
		["Accessors.value#2", "accessor"],
	]);
	const initialSource = fs.readFileSync(path.join(worktreeRoot, "math.js"), "utf8");
	const initialFile = store.read(() =>
		store.db.prepare("SELECT source_hash FROM files WHERE file_dir = '.' AND file_name = 'math.js'").get(),
	) as { source_hash: string };
	assert.equal(initialFile.source_hash, hashText(initialSource));

	const mul = screeningQuery({ store, functionNameLike: "mul", limit: 50 });
	assert.equal(mul.length, 1);
	assert.equal(mul[0].functionName, "mul");

	fs.writeFileSync(path.join(worktreeRoot, "math.js"), `function add(a, b) { return a + b; }\nfunction mul(a, b) { return a * b; }\nfunction same() { return 3; }\nfunction later() { return same(); }\n`);
	const reindexReport = await runIndex({ store, worktreeRoot, parsers, reindex: true });
	assert.equal(reindexReport.conflicts >= 1, true);
	const updatedSource = fs.readFileSync(path.join(worktreeRoot, "math.js"), "utf8");
	const updatedFile = store.read(() =>
		store.db.prepare("SELECT source_hash FROM files WHERE file_dir = '.' AND file_name = 'math.js'").get(),
	) as { source_hash: string };
	assert.equal(updatedFile.source_hash, hashText(updatedSource));
	const names = store.read(() =>
		store.db.prepare("SELECT function_name FROM functions WHERE file_dir = '.' AND file_name = 'math.js' ORDER BY provenance_start_byte").all(),
	) as Array<{ function_name: string }>;
	const edgeRows = store.read(() =>
		store.db.prepare("SELECT from_function FROM call_edges WHERE from_file_dir = '.' AND from_file_name = 'math.js' ORDER BY from_function").all(),
	) as Array<{ from_function: string }>;
	assert.ok(edgeRows.some((row) => row.from_function === "later"));
	assert.deepEqual(names.map((row) => row.function_name), ["add", "mul", "same", "later"]);
	const remainingManifest = store.read(() =>
		store.db.prepare("SELECT function_name FROM file_entries WHERE file_dir = '.' AND file_name = 'math.js' AND function_name IS NOT NULL ORDER BY ordinal").all(),
	) as Array<{ function_name: string }>;
	assert.deepEqual(remainingManifest.map((row) => row.function_name), ["add", "mul", "same", "later"]);
});

test("runIndex with opts.paths indexes only hit paths and purges missing ones", async (t) => {
	const { worktreeRoot, cleanup } = initRepo();
	t.after(cleanup);
	const runtime = await loadGraphRuntime();
	if (!runtime.status.parserAvailable || !runtime.status.sqliteAvailable) return;
	const ParserCtor = runtime.runtime.parser.Parser as unknown as new () => {
		parse(input: string | Buffer): unknown;
		setLanguage(language: unknown): void;
	};
	const parsers: Record<Language, ParserBackend> = {
		javascript: makeBackend("javascript", ParserCtor, runtime.runtime.parser.javascript),
		typescript: makeBackend("typescript", ParserCtor, runtime.runtime.parser.typescript),
		tsx: makeBackend("tsx", ParserCtor, runtime.runtime.parser.tsx),
		python: new PythonBackend(ParserCtor, runtime.runtime.parser.python),
	};
	const stateRoot = path.join(worktreeRoot, ".git", "pi_plans");
	fs.mkdirSync(stateRoot, { recursive: true });
	const store = new Store({ dbPath: path.join(stateRoot, "code_graph.db"), worktreeRoot, gitCommonDir: path.join(worktreeRoot, ".git") }, runtime.runtime.sqlite);
	t.after(() => store.close());
	await runIndex({ store, worktreeRoot, parsers });

	// Modify one file, delete another.
	fs.writeFileSync(path.join(worktreeRoot, "math.js"), "function add(a, b) { return a + b + 1; }\n");
	fs.rmSync(path.join(worktreeRoot, "note.py"));

	const report = await runIndex({ store, worktreeRoot, parsers, paths: ["./math.js", "./note.py"] });
	assert.deepEqual(report.reindexedPaths.sort(), ["./math.js"]);
	assert.deepEqual(report.purgedPaths.sort(), ["./note.py"]);
	const noteRows = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM files WHERE file_name = 'note.py'").get()) as { c: number };
	assert.equal(noteRows.c, 0, "deleted file rows must be purged");
	const noteFunctions = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM functions WHERE file_name = 'note.py'").get()) as { c: number };
	assert.equal(noteFunctions.c, 0);
	const apiRows = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM files WHERE file_name = 'api.ts'").get()) as { c: number };
	assert.equal(apiRows.c, 1, "untouched files must remain indexed");
	const mathHash = store.read(() => store.db.prepare("SELECT source_hash FROM files WHERE file_name = 'math.js'").get()) as { source_hash: string };
	assert.equal(mathHash.source_hash, hashText("function add(a, b) { return a + b + 1; }\n"));
});
