/** End-to-end indexer rollback: an injected failure during write must leave no
 * half-written rows for the file being indexed. */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/code-graph/store.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";

function git(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (args[0] === "rev-parse") return (result.stdout ?? "").trim();
	assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function initRepo(): { worktreeRoot: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-rollback-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	const subdir = path.join(dir, "pkg");
	fs.mkdirSync(subdir, { recursive: true });
	fs.writeFileSync(path.join(subdir, "math.js"), "function add(a, b) { return a + b; }\n");
	git(subdir, ["add", "-A"]);
	git(subdir, ["commit", "-m", "init"]);
	return {
		worktreeRoot: subdir,
		cleanup: () => {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

test("indexer rolls back the whole file batch when an emit step throws", async (t) => {
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

	const original = store.prepare.bind(store);
	const prepare = (key: string, sql: string) => {
		if (key === "insert_edge") throw new Error("injected emit failure");
		return original(key, sql);
	};
	(store as unknown as { prepare: typeof prepare }).prepare = prepare;

	await assert.rejects(() => runIndex({ store, worktreeRoot, parsers }), /injected emit failure/);

	const fileRows = store.read(() =>
		store.db.prepare("SELECT file_dir, file_name FROM files WHERE file_dir = '.' AND file_name = 'math.js'").all(),
	) as Array<{ file_dir: string; file_name: string }>;
	const functionRows = store.read(() =>
		store.db.prepare("SELECT function_name FROM functions WHERE file_dir = '.' AND file_name = 'math.js'").all(),
	) as Array<{ function_name: string }>;
	const entryRows = store.read(() =>
		store.db.prepare("SELECT function_name FROM file_entries WHERE file_dir = '.' AND file_name = 'math.js'").all(),
	) as Array<{ function_name: string }>;
	const edgeRows = store.read(() =>
		store.db.prepare("SELECT from_function FROM call_edges WHERE from_file_dir = '.' AND from_file_name = 'math.js'").all(),
	) as Array<{ from_function: string }>;
	assert.equal(fileRows.length, 0);
	assert.equal(functionRows.length, 0);
	assert.equal(entryRows.length, 0);
	assert.equal(edgeRows.length, 0);
});