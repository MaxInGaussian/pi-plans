import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { Store } from "../src/code-graph/store.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { gitHead } from "../src/code-graph/git.ts";
import { initGraphCommand } from "../src/code-graph/commands.ts";
import { hashText } from "../src/code-graph/parser.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";

function git(cwd: string, args: string[]): void {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
}

function initRepo(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-init-graph-"));
	git(root, ["init", "--initial-branch=main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "test"]);
	fs.writeFileSync(path.join(root, "math.js"), "function add(a, b) { return a + b; }\n");
	fs.writeFileSync(path.join(root, "helper.ts"), "export function twice(n: number): number { return n * 2; }\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "init"]);
	fs.mkdirSync(path.join(root, ".git", "pi_plans"), { recursive: true });
	const canonicalRoot = fs.realpathSync(root);
	return {
		root: canonicalRoot,
		cleanup: () => {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}

async function loadParsers() {
	const runtime = await loadGraphRuntime();
	if (!runtime.status.parserAvailable || !runtime.status.sqliteAvailable) return null;
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
	return { runtime, parsers };
}

function openStore(root: string, sqlite: typeof import("node:sqlite")): Store {
	const canonicalRoot = fs.realpathSync(root);
	const dbPath = path.join(canonicalRoot, ".git", "pi_plans", "code_graph.db");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	return new Store({ dbPath, worktreeRoot: canonicalRoot, gitCommonDir: path.join(canonicalRoot, ".git") }, sqlite);
}

function makeCtx(root: string, confirmResult: boolean, hasUI = true) {
	const confirmations: Array<{ title: string; body: string }> = [];
	const notifications: Array<{ message: string; kind?: string }> = [];
	return {
		cwd: root,
		hasUI,
		ui: {
			notify: (message: string, kind?: "info" | "warning" | "error") => {
				notifications.push({ message, kind });
			},
			confirm: async (title: string, body: string) => {
				confirmations.push({ title, body });
				return confirmResult;
			},
		},
		confirmations,
		notifications,
	};
}

test("initGraphCommand keeps the fresh-init path prompt-free", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	t.after(cleanup);
	const ctx = makeCtx(root, false);
	await initGraphCommand("", ctx as never);
	assert.equal(ctx.confirmations.length, 0, "fresh init must not prompt");

	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => store.close());
	const fileCount = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM files").get()) as { c: number };
	assert.ok(fileCount.c > 0, "fresh init should populate files");
	const functionsCount = store.read(() => store.db.prepare("SELECT COUNT(*) AS c FROM functions").get()) as { c: number };
	assert.ok(functionsCount.c > 0, "fresh init should populate functions");
	void parsers;
});

test("initGraphCommand routes an existing DB to changed-path sync and ignores rebuild-only flags", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	t.after(cleanup);
	const sqlite = runtime.runtime.sqlite;
	const seedStore = openStore(root, sqlite);
	t.after(() => seedStore.close());
	await runIndex({ store: seedStore, worktreeRoot: root, parsers });
	seedStore.upsertSnapshot(gitHead(root), []);
	seedStore.close();

	const updatedSource = "function add(a, b) { return a + b + 100; }\n";
	fs.writeFileSync(path.join(root, "math.js"), updatedSource);
	const headBefore = gitHead(root);
	const ctx = makeCtx(root, false);
	await initGraphCommand("--no-summary --no-commit", ctx as never);

	assert.equal(ctx.confirmations.length, 1, "existing DB should prompt once");
	assert.match(ctx.confirmations[0]!.body, /\/update-graph/);
	assert.equal(gitHead(root), headBefore, "incremental branch must not create the pre-init commit");

	const checkStore = openStore(root, sqlite);
	t.after(() => checkStore.close());
	const row = checkStore.read(() =>
		checkStore.db.prepare("SELECT source_hash FROM files WHERE file_dir = '.' AND file_name = 'math.js'").get(),
	) as { source_hash: string } | undefined;
	assert.ok(row, "math.js should remain indexed");
	assert.equal(row!.source_hash, hashText(updatedSource));
	const conflicts = checkStore.read(() => checkStore.db.prepare("SELECT COUNT(*) AS c FROM reindex_conflicts").get()) as { c: number };
	assert.equal(conflicts.c, 0, "incremental sync should ignore rebuild-only reindex conflicts");
	void runtime;
});

test("initGraphCommand rebuild branch skips prompt when --reindex is explicit", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	t.after(cleanup);
	const sqlite = runtime.runtime.sqlite;
	const seedStore = openStore(root, sqlite);
	t.after(() => seedStore.close());
	await runIndex({ store: seedStore, worktreeRoot: root, parsers });
	seedStore.upsertSnapshot(gitHead(root), []);
	seedStore.close();

	const changedSource = "function add(a, b) { return a + b + 200; }\n";
	fs.writeFileSync(path.join(root, "math.js"), changedSource);
	const headBefore = gitHead(root);
	const ctx = makeCtx(root, true);
	await initGraphCommand("--reindex --no-commit", ctx as never);

	assert.equal(ctx.confirmations.length, 0, "existing DB with --reindex should skip the prompt");
	assert.equal(gitHead(root), headBefore, "--no-commit must still suppress the pre-init commit on rebuild");

	const checkStore = openStore(root, sqlite);
	t.after(() => checkStore.close());
	const row = checkStore.read(() =>
		checkStore.db.prepare("SELECT source_hash FROM files WHERE file_dir = '.' AND file_name = 'math.js'").get(),
	) as { source_hash: string } | undefined;
	assert.ok(row, "math.js should remain indexed");
	assert.equal(row!.source_hash, hashText(changedSource));
	const conflicts = checkStore.read(() => checkStore.db.prepare("SELECT COUNT(*) AS c FROM reindex_conflicts").get()) as { c: number };
	assert.ok(conflicts.c > 0, "--reindex must still record conflicts on the rebuild path");
	void runtime;
});

test("initGraphCommand rebuilds without prompting in headless mode", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	t.after(cleanup);
	const sqlite = runtime.runtime.sqlite;
	const seedStore = openStore(root, sqlite);
	t.after(() => seedStore.close());
	await runIndex({ store: seedStore, worktreeRoot: root, parsers });
	seedStore.upsertSnapshot(gitHead(root), []);
	seedStore.close();

	const updatedSource = "function add(a, b) { return a + b + 300; }\n";
	fs.writeFileSync(path.join(root, "math.js"), updatedSource);
	const headBefore = gitHead(root);
	const ctx = makeCtx(root, false, false);
	await initGraphCommand("", ctx as never);

	assert.equal(ctx.confirmations.length, 0, "headless runs must not prompt");
	assert.notEqual(gitHead(root), headBefore, "headless existing DB should rebuild and create the pre-init commit");

	const checkStore = openStore(root, sqlite);
	t.after(() => checkStore.close());
	const row = checkStore.read(() =>
		checkStore.db.prepare("SELECT source_hash FROM files WHERE file_dir = '.' AND file_name = 'math.js'").get(),
	) as { source_hash: string } | undefined;
	assert.ok(row, "math.js should remain indexed");
	assert.equal(row!.source_hash, hashText(updatedSource));
	const conflicts = checkStore.read(() => checkStore.db.prepare("SELECT COUNT(*) AS c FROM reindex_conflicts").get()) as { c: number };
	assert.equal(conflicts.c, 0, "headless rebuild without --reindex should keep the normal rebuild path");
	void runtime;
});
