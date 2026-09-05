import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Store } from "../src/code-graph/store.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { setGraphEnabled } from "../src/state.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";
import { createGraphAwareFileTools } from "../tools/graph-aware-file-tools.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function git(cwd: string, args: string[]): void {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
}

function initRepo(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-graph-tools-"));
	git(root, ["init", "--initial-branch=main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "test"]);
	fs.writeFileSync(path.join(root, "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "init"]);
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

function makeCtx(workdir: string) {
	return {
		cwd: workdir,
		ui: {
			notify: () => {},
		},
	} as any;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((part) => part.type === "text" && typeof part.text === "string")?.text ?? "";
}

test("index.ts wires graph-aware read/write/edit overrides", () => {
	const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
	assert.match(source, /import \{ registerGraphAwareFileTools \} from "\.\/tools\/graph-aware-file-tools\.ts";/);
	assert.match(source, /registerGraphAwareFileTools\(pi\);/);
});

test("graph-aware read/write/edit stage indexed code in the DB instead of on disk", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	setGraphEnabled(root, true);
	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => {
		try {
			store.close();
		} finally {
			cleanup();
		}
	});
	await runIndex({ store, worktreeRoot: root, parsers });

	const tools = createGraphAwareFileTools(root);
	const ctx = makeCtx(root);
	const filePath = path.join(root, "math.ts");
	const originalDisk = fs.readFileSync(filePath, "utf8");

	const initialRead = await tools.read.execute("read-1", { path: "math.ts" }, undefined, undefined, ctx);
	assert.match(firstText(initialRead), /return a \+ b;/);

	const stagedWrite = "export function add(a: number, b: number): number { return a + b + 100; }\n";
	await tools.write.execute("write-1", { path: "math.ts", content: stagedWrite }, undefined, undefined, ctx);
	assert.equal(fs.readFileSync(filePath, "utf8"), originalDisk, "graph-aware write must not touch the worktree yet");

	const stagedRead = await tools.read.execute("read-2", { path: "math.ts" }, undefined, undefined, ctx);
	assert.match(firstText(stagedRead), /return a \+ b \+ 100;/);

	const editResult = await tools.edit.execute(
		"edit-1",
		{
			path: "math.ts",
			edits: [{ oldText: "return a + b + 100;", newText: "return a + b + 200;" }],
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(editResult), /staged in code graph/);
	assert.equal(fs.readFileSync(filePath, "utf8"), originalDisk, "graph-aware edit must stay DB-first until /apply-graph");

	const editedRead = await tools.read.execute("read-3", { path: "math.ts" }, undefined, undefined, ctx);
	assert.match(firstText(editedRead), /return a \+ b \+ 200;/);
});

function makeRepoWith(files: Record<string, string>): { root: string } {
	const root0 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-graph-read-"));
	git(root0, ["init", "--initial-branch=main"]);
	git(root0, ["config", "user.email", "test@example.com"]);
	git(root0, ["config", "user.name", "test"]);
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(root0, name), content);
	}
	git(root0, ["add", "-A"]);
	git(root0, ["commit", "-m", "init"]);
	fs.mkdirSync(path.join(root0, ".git", "pi_plans"), { recursive: true });
	return { root: fs.realpathSync(root0) };
}

function bigSource(functionCount: number): string {
	const parts: string[] = [];
	for (let i = 0; i < functionCount; i++) {
		parts.push(`export function fn${i}(x: number): number {`);
		parts.push(`\treturn ${i} + x;`);
		parts.push(`}`);
		parts.push("");
	}
	return parts.join("\n");
}

test("graph read defaults to a capped function digest; full/offset/beyond-EOF follow native semantics", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	setGraphEnabled(root, true);
	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => {
		try {
			store.close();
		} finally {
			cleanup();
		}
	});
	fs.writeFileSync(path.join(root, "big.ts"), bigSource(120));
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "big"]);
	await runIndex({ store, worktreeRoot: root, parsers });

	const tools = createGraphAwareFileTools(root);
	const ctx = makeCtx(root);

	const digest = firstText(await tools.read.execute("d1", { path: "big.ts" }, undefined, undefined, ctx));
	const digestLines = digest.split("\n");
	assert.ok(digestLines.length <= 50, `digest must be capped, got ${digestLines.length}`);
	assert.match(digestLines[0] ?? "", /big\.ts · typescript · 120 functions/);
	assert.match(digest, /fn0 \(1-3\) function fn0\(x: number\): number \{/);
	assert.match(digest, /\u2026\+\d+ more \(code_graph screening \/ get-function\)/);
	assert.match(digest, /Use full:true for the whole file/);
	assert.doesNotMatch(digest, /return 0 \+ x;/);

	const whole = firstText(await tools.read.execute("d2", { path: "big.ts", full: true }, undefined, undefined, ctx));
	assert.match(whole, /return 119 \+ x;/);
	assert.ok(whole.split("\n").length > 400);

	const slice = firstText(await tools.read.execute("d3", { path: "big.ts", full: true, offset: 477, limit: 3 }, undefined, undefined, ctx));
	assert.match(slice, /export function fn119\(x: number\): number \{/);

	await assert.rejects(
		tools.read.execute("d4", { path: "big.ts", offset: 481 }, undefined, undefined, ctx),
		/beyond end of file/,
	);

	fs.writeFileSync(path.join(root, "consts.ts"), Array.from({ length: 250 }, (_, i) => `export const c${i} = ${i};`).join("\n") + "\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "consts"]);
	await runIndex({ store, worktreeRoot: root, parsers });
	const constsRead = firstText(await tools.read.execute("d5", { path: "consts.ts" }, undefined, undefined, ctx));
	assert.match(constsRead, /c249 = 249/);
});

test("graph read folds synthetic anonymous functions and keeps named non-primary rows", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	setGraphEnabled(root, true);
	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => {
		try {
			store.close();
		} finally {
			cleanup();
		}
	});
	fs.writeFileSync(path.join(root, "big.ts"), bigSource(120));
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "big"]);
	await runIndex({ store, worktreeRoot: root, parsers });
	store.tx(() => {
		for (let i = 0; i < 5; i++) {
			store.db
				.prepare(
					`INSERT INTO functions (file_dir, file_name, function_name, language, kind, full_code, full_code_hash, render_code, render_code_hash,
					 move_supported, is_primary, provenance_start_byte, provenance_end_byte, provenance_start_line, provenance_start_col,
					 provenance_end_line, provenance_end_col, version)
					 VALUES ('.', 'big.ts', ?, 'typescript', 'arrow', '', 'h', '', 'h', 1, 0, 0, 4, 1, 1, 1, 1, 1)`,
				)
				.run(`outer.<anonymous:arrow_function#${i}>`);
		}
	});

	const tools = createGraphAwareFileTools(root);
	const ctx = makeCtx(root);
	const digest = firstText(await tools.read.execute("a1", { path: "big.ts" }, undefined, undefined, ctx));
	assert.match(digest.split("\n")[0] ?? "", /120 functions \(\+5 anonymous\)/);
	assert.match(digest, /…\+\d+ more/);
});

test("graph read marks unexpected fallbacks and stays silent for flag-off", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	setGraphEnabled(root, true);
	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => {
		try {
			store.close();
		} finally {
			cleanup();
		}
	});
	await runIndex({ store, worktreeRoot: root, parsers });
	// Close before the foreign-DB swap below: an open connection keeps wal/shm
	// siblings alive and SQLite recovery would resurrect the old rows.
	store.close();
	fs.writeFileSync(path.join(root, "late.ts"), "export function late(): number { return 42; }\n");

	const tools = createGraphAwareFileTools(root);
	const ctx = makeCtx(root);

	const notIndexed = firstText(await tools.read.execute("f1", { path: "late.ts" }, undefined, undefined, ctx));
	assert.match(notIndexed, /^\[graph-read fallback: not indexed → native\]/);
	assert.match(notIndexed, /return 42;/);

	const normal = firstText(await tools.read.execute("f2", { path: "math.ts" }, undefined, undefined, ctx));
	assert.doesNotMatch(normal, /^\[graph-read fallback/);
	assert.match(normal, /return a \+ b;/);

	setGraphEnabled(root, false);
	const off = firstText(await tools.read.execute("f3", { path: "math.ts" }, undefined, undefined, ctx));
	assert.doesNotMatch(off, /^\[graph-read fallback/);
	assert.match(off, /return a \+ b;/);

	fs.writeFileSync(path.join(root, ".git", "pi_plans", "config.json"), "{broken");
	const broken = firstText(await tools.read.execute("f4", { path: "math.ts" }, undefined, undefined, ctx));
	assert.match(broken, /^\[graph-read fallback: config read failed → native\]/);

	// runtime unavailable: DB whose stored worktree is another directory.
	// ensureRuntime caches by db path within a process, so probe in a child
	// process with fresh module state: checkWorktree must reject the foreign DB.
	fs.writeFileSync(path.join(root, ".git", "pi_plans", "config.json"), JSON.stringify({ schema: 1, graph_enabled: true }));
	const otherRoot0 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-graph-other-"));
	git(otherRoot0, ["init", "--initial-branch=main"]);
	const otherRoot = fs.realpathSync(otherRoot0);
	const foreignStore = new Store(
		{ dbPath: path.join(otherRoot, "foreign.db"), worktreeRoot: otherRoot, gitCommonDir: path.join(otherRoot, ".git") },
		runtime.runtime.sqlite,
	);
	foreignStore.close();
	fs.copyFileSync(path.join(otherRoot, "foreign.db"), path.join(root, ".git", "pi_plans", "code_graph.db"));
	fs.writeFileSync(path.join(root, "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
	const probeScript = [
		"const fs = await import('node:fs');",
		"const { pathToFileURL } = await import('node:url');",
		`const mod = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, "tools", "graph-aware-file-tools.ts"))}));`,
		`const tools = mod.createGraphAwareFileTools(${JSON.stringify(root)});`,
		"const ctx = { cwd: process.cwd(), ui: { notify: () => {} } };",
		"const r = await tools.read.execute('probe', { path: 'math.ts' }, undefined, undefined, ctx);",
		"const text = r.content.find((c) => c.type === 'text').text;",
		"console.log(JSON.stringify(text));",
	].join("\n");
	const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probeScript], {
		cwd: root,
		encoding: "utf8",
		timeout: 60000,
	});
	let probeText = "";
	try {
		probeText = JSON.parse(probe.stdout.trim().split("\n").filter((l) => l.startsWith("\"") || l.startsWith("["))[0] ?? "\"\"");
	} catch {
		probeText = probe.stderr;
	}
	assert.match(probeText, /^\[graph-read fallback: runtime unavailable → native\]/);

	fs.rmSync(otherRoot0, { recursive: true, force: true });
});

test("full read triggers the native-equivalent safety valve and marks truncation in details", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	setGraphEnabled(root, true);
	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => {
		try {
			store.close();
		} finally {
			cleanup();
		}
	});
	fs.writeFileSync(path.join(root, "huge.ts"), bigSource(700)); // 2800 lines > DEFAULT_MAX_LINES
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "huge"]);
	await runIndex({ store, worktreeRoot: root, parsers });

	const tools = createGraphAwareFileTools(root);
	const ctx = makeCtx(root);
	const result = await tools.read.execute("t1", { path: "huge.ts", full: true }, undefined, undefined, ctx);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.truncatedBy, "lines");
	assert.ok(result.details.outputLines <= 2000);
	assert.ok(result.details.totalLines >= 2800);
});

test("digest descriptions decode multibyte slices and degrade across all three levels", async (t) => {
	const loaded = await loadParsers();
	if (!loaded) return;
	const { runtime, parsers } = loaded;
	const { root, cleanup } = initRepo();
	setGraphEnabled(root, true);
	const store = openStore(root, runtime.runtime.sqlite);
	t.after(() => {
		try {
			store.close();
		} finally {
			cleanup();
		}
	});
	fs.writeFileSync(
		path.join(root, "mixed.ts"),
		[
			"// 中文注释：多字节字符用于锁定字节偏移切片的正确性。",
			"export function 求和(a: number, b: number): number {",
			"\treturn a + b;",
			"}",
			"",
			"export function noProvenance() {",
			"\treturn 1;",
			"}",
			"",
			...Array.from({ length: 200 }, (_, i) => `export const pad${i} = ${i};`), // push past the 200-line full-text threshold
		].join("\n") + "\n",
	);
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "mixed"]);
	await runIndex({ store, worktreeRoot: root, parsers });
	// Level 1: summary_description set → used verbatim.
	store.tx(() => {
		store.db
			.prepare(`UPDATE functions SET summary_description = ? WHERE function_name = ?`)
			.run("求和函数：返回两数之和", "求和");
		store.db
			.prepare(`UPDATE functions SET provenance_start_byte = provenance_end_byte WHERE function_name = ?`)
			.run("noProvenance");
	});

	const tools = createGraphAwareFileTools(root);
	const ctx = makeCtx(root);
	const digest = firstText(await tools.read.execute("m1", { path: "mixed.ts" }, undefined, undefined, ctx));
	// Level 1: summary_description wins over the byte slice.
	assert.match(digest, /求和 .*求和函数：返回两数之和/);
	// Level 3: NULL provenance bytes → name + line range, empty description.
	assert.match(digest, /noProvenance \(6-8\)\n/);
	// Level 2 sanity: no mojibake from byte-offset slicing on CJK sources.
	assert.doesNotMatch(digest, /\uFFFD/);
});
