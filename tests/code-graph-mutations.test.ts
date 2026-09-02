/**
 * Tool-path mutation tests against src/code-graph/mutations.ts: real indexer
 * output (multi-function file with inter-function gaps), exact post-apply
 * bytes, zero-match refusal, and the full mutation→apply convergence.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/code-graph/store.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { materializeFile } from "../src/code-graph/materialize.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { updateFunction, updateFile, deleteFile, listPending } from "../src/code-graph/mutations.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";

function git(cwd: string, args: string[]): void {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

// Two functions with a comment gap between them — the offset-propagation case.
const SOURCE = "function first(a) { return a + 1; }\n// inter-function gap\nfunction second(b) { return b * 2; }\n";
const NEW_FIRST = "function first(a) { return a + 42; }";

function initRepo(): { root: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-mut-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	fs.writeFileSync(path.join(dir, "two.js"), SOURCE);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", "init"]);
	return {
		root: dir,
		cleanup: () => {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

test("updateFunction propagates offsets, rebuilds source exactly, and applies byte-for-byte", async (t) => {
	const runtime = await loadGraphRuntime();
	if (!runtime.status.parserAvailable || !runtime.status.sqliteAvailable) return;
	const { root, cleanup } = initRepo();
	t.after(cleanup);
	const stateRoot = path.join(root, ".git", "pi_plans");
	fs.mkdirSync(stateRoot, { recursive: true });
	const store = new Store({ dbPath: path.join(stateRoot, "g.db"), worktreeRoot: root, gitCommonDir: path.join(root, ".git") }, runtime.runtime.sqlite);
	t.after(() => store.close());
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
	await runIndex({ store, worktreeRoot: root, parsers });

	const result = updateFunction(store, { fileDir: ".", fileName: "two.js", functionName: "first", fullCode: NEW_FIRST });
	assert.equal(result.ok, true, result.reason ?? "");

	// Rebuilt source keeps the gap and the untouched second function intact.
	const rebuilt = store.read(() =>
		store.db.prepare(`SELECT source_text, pending_kind FROM files WHERE file_name = 'two.js'`).get(),
	) as { source_text: string; pending_kind: string };
	assert.equal(rebuilt.pending_kind, "update");
	const expected = NEW_FIRST + "\n// inter-function gap\nfunction second(b) { return b * 2; }\n";
	assert.equal(rebuilt.source_text, expected, "gap + later function preserved with shifted offsets");

	// Apply writes the exact bytes; pending cleared; second fn intact on disk.
	const applied = materializeFile(store, root, ".", "two.js");
	assert.equal(applied.status, "ok");
	assert.equal(fs.readFileSync(path.join(root, "two.js"), "utf8"), expected);

	// Zero-match refusal carries a repair path.
	const bad = updateFunction(store, { fileDir: ".", fileName: "two.js", functionName: "nonexistent", fullCode: "x" });
	assert.equal(bad.ok, false);
	assert.match(bad.reason ?? "", /not found|manifest entry|get-function/);
});

test("updateFile / deleteFile / listPending round-trip", async (t) => {
	const runtime = await loadGraphRuntime();
	if (!runtime.status.sqliteAvailable) return;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-mut2-"));
	t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
	const store = new Store({ dbPath: path.join(dir, "g.db"), worktreeRoot: dir, gitCommonDir: path.join(dir, ".git") }, runtime.runtime.sqlite);
	t.after(() => store.close());

	const created = updateFile(store, { fileDir: ".", fileName: "brand-new.ts", text: "export const x = 1;\n", language: "typescript" });
	assert.equal(created.ok, true);
	assert.equal(created.created, true);
	const applied = materializeFile(store, dir, ".", "brand-new.ts");
	assert.equal(applied.status, "ok", "new file created from DB");
	assert.equal(fs.readFileSync(path.join(dir, "brand-new.ts"), "utf8"), "export const x = 1;\n");

	const replaced = updateFile(store, { fileDir: ".", fileName: "brand-new.ts", text: "export const x = 2;\n" });
	assert.equal(replaced.ok, true);
	assert.equal(replaced.created, false);

	const marked = deleteFile(store, { fileDir: ".", fileName: "brand-new.ts" });
	assert.equal(marked.ok, true);
	assert.deepEqual(listPending(store), [{ path: "./brand-new.ts", kind: "delete" }]);
	const purged = materializeFile(store, dir, ".", "brand-new.ts");
	assert.equal(purged.status, "deleted");
	assert.equal(fs.existsSync(path.join(dir, "brand-new.ts")), false);
});
