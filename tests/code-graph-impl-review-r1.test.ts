/**
 * Implementation-review round 1 fixes (v0.5.0): pending-delete branch,
 * populated v2→v3 migration, re-export/export* passthrough, same-name
 * ambiguity, dynamic imports, require destructuring, hijack protection,
 * method-heuristic demotion, digest link shape.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/code-graph/store.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { loadValidatedSnapshot } from "../src/code-graph/freshness.ts";
import { deleteFile } from "../src/code-graph/mutations.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";

async function makeParsers() {
	const { runtime } = await loadGraphRuntime();
	const P = runtime.parser.Parser as never;
	return {
		parsers: {
			javascript: makeBackend("javascript", P, runtime.parser.javascript),
			typescript: makeBackend("typescript", P, runtime.parser.typescript),
			tsx: makeBackend("tsx", P, runtime.parser.tsx),
			python: new PythonBackend(P, runtime.parser.python),
		} as Parameters<typeof runIndex>[0]["parsers"],
		sqlite: runtime.sqlite,
	};
}

function tmpWorkdir(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-r1-"));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("impl-review r1 fixes", () => {
	test("pending delete reads as not-indexed via the real pending_delete branch", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { parsers, sqlite } = await makeParsers();
		fs.writeFileSync(path.join(root, "a.ts"), "export function alpha() { return 1; }\n");
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const del = deleteFile(store, { fileDir: ".", fileName: "a.ts" });
		assert.equal(del.ok, true);
		const info = { absolutePath: path.join(root, "a.ts"), relativePath: "a.ts", fileDir: ".", fileName: "a.ts", language: "typescript" as const };
		const rt = { store, paths: { worktreeRoot: root, codeGraphDb: path.join(root, "db.sqlite"), gitCommonDir: root }, parsers };
		const snap = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(snap, null, "pending delete must read as not-indexed");
		store.close();
		cleanup();
	});

	test("populated v2 database (with edge rows) migrates to v3 keeping its data", async () => {
		const { root, cleanup } = tmpWorkdir();
		const dbPath = path.join(root, "v2.db");
		const sqlite = await import("node:sqlite");
		const raw = new sqlite.DatabaseSync(dbPath, { open: true });
		raw.exec([
			"CREATE TABLE graph_meta (schema_version INTEGER PRIMARY KEY, worktree_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, parser_versions TEXT NOT NULL, updated_at TEXT NOT NULL);",
			"CREATE TABLE files (file_dir TEXT NOT NULL, file_name TEXT NOT NULL, language TEXT NOT NULL, source_hash TEXT NOT NULL, source_text TEXT NOT NULL, pending_kind TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (file_dir, file_name));",
			"CREATE TABLE functions (file_dir TEXT NOT NULL, file_name TEXT NOT NULL, function_name TEXT NOT NULL, language TEXT NOT NULL, kind TEXT NOT NULL, full_code TEXT NOT NULL, full_code_hash TEXT NOT NULL, render_code TEXT NOT NULL, render_code_hash TEXT NOT NULL, parent TEXT, container TEXT, move_supported INTEGER NOT NULL, is_primary INTEGER NOT NULL, provenance_start_byte INTEGER NOT NULL, provenance_end_byte INTEGER NOT NULL, provenance_start_line INTEGER NOT NULL, provenance_start_col INTEGER NOT NULL, provenance_end_line INTEGER NOT NULL, provenance_end_col INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (file_dir, file_name, function_name));",
			"CREATE TABLE call_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, from_file_dir TEXT NOT NULL, from_file_name TEXT NOT NULL, from_function TEXT NOT NULL, to_file_dir TEXT, to_file_name TEXT, to_function TEXT, to_callee_text TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL, reason TEXT, provenance_start_byte INTEGER NOT NULL, provenance_end_byte INTEGER NOT NULL, provenance_start_line INTEGER NOT NULL, provenance_start_col INTEGER NOT NULL, provenance_end_line INTEGER NOT NULL, provenance_end_col INTEGER NOT NULL);",
			"CREATE TABLE file_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, file_dir TEXT NOT NULL, file_name TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, function_name TEXT, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE (file_dir, file_name, ordinal));",
			"CREATE TABLE change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, detail TEXT NOT NULL, recorded_at TEXT NOT NULL);",
			"CREATE TABLE reindex_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, file_dir TEXT NOT NULL, file_name TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, recorded_at TEXT NOT NULL);",
			`INSERT INTO graph_meta VALUES (2, '${root}', '${root}', '{}', '2026-01-01T00:00:00Z');`,
			"INSERT INTO files VALUES ('.', 'a.ts', 'typescript', 'h1', 'export function alpha() { return 1; }', NULL, '2026-01-01T00:00:00Z');",
			"INSERT INTO call_edges (from_file_dir, from_file_name, from_function, to_callee_text, kind, resolution, provenance_start_byte, provenance_end_byte, provenance_start_line, provenance_start_col, provenance_end_line, provenance_end_col) VALUES ('.', 'a.ts', 'alpha', 'alpha(', 'call', 'unresolved', 0, 6, 1, 1, 1, 7);",
		].join("\n"));
		raw.close();
		const { runtime } = await loadGraphRuntime();
		const store = new Store({ dbPath, worktreeRoot: root, gitCommonDir: root }, runtime.sqlite);
		assert.equal(store.readMeta()?.schemaVersion, 3);
		const rows = store.read(() => store.db.prepare(`SELECT COUNT(*) AS c FROM call_edges`).get()) as { c: number };
		assert.equal(rows.c, 1, "populated edge rows must survive the v3 migration");
		const cols = store.db.prepare("PRAGMA table_info(call_edges)").all() as Array<{ name: string }>;
		assert.ok(cols.some((c) => c.name === "confidence"));
		const view = store.read(() => store.db.prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name='resolved_call_adjacency'`).get());
		assert.ok(view);
		store.close();
		cleanup();
	});

	test("re-export and export * passthrough target the defining module", async () => {
		const { root, cleanup } = tmpWorkdir();
		fs.writeFileSync(path.join(root, "util.ts"), "export function helper() { return 1; }\n");
		fs.writeFileSync(path.join(root, "star.ts"), "export function starFn() { return 2; }\n");
		fs.writeFileSync(path.join(root, "barrel.ts"), 'export { helper } from "./util.ts";\nexport * from "./star.ts";\n');
		fs.writeFileSync(path.join(root, "main.ts"), 'import { helper, starFn } from "./barrel.ts";\nexport function main() { helper(); starFn(); }\n');
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const helperEdge = store.read(() =>
			store.db.prepare(`SELECT to_file_name, resolution FROM call_edges WHERE from_function='main' AND to_callee_text='helper('`).get(),
		) as { to_file_name: string; resolution: string } | undefined;
		assert.ok(helperEdge, "barrel-imported call edge must exist");
		assert.equal(helperEdge.to_file_name, "util.ts", "must target the DEFINING module, not the barrel");
		assert.equal(helperEdge.resolution, "resolved");
		const starEdge = store.read(() =>
			store.db.prepare(`SELECT to_file_name FROM call_edges WHERE from_function='main' AND to_callee_text='starFn('`).get(),
		) as { to_file_name: string } | undefined;
		assert.equal(starEdge?.to_file_name, "star.ts", "export * passthrough must reach the defining module");
		store.close();
		cleanup();
	});

	test("same-name exports classify ambiguous; dynamic imports emit edges; require destructuring binds named", async () => {
		const { root, cleanup } = tmpWorkdir();
		fs.writeFileSync(path.join(root, "x.ts"), "export function dupName() { return 1; }\n");
		fs.writeFileSync(path.join(root, "y.ts"), "export function dupName() { return 2; }\n");
		fs.writeFileSync(path.join(root, "mod.ts"), "export function reqFn() { return 3; }\nexport default { reqFn };\n");
		fs.writeFileSync(path.join(root, "holder.ts"), "export const thing = { dupName: () => 3 };\n");
		fs.writeFileSync(
			path.join(root, "main.ts"),
			[
				'import { dupName } from "./x.ts";',
				'import { thing } from "./holder.ts";',
				'const { reqFn } = require("./mod.ts");',
				"export function main() {",
				"\tdupName();",
				"\tthing.dupName();",
				"\treqFn();",
				"\treturn import('./mod.ts');",
				"}",
			].join("\n"),
		);
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const amb = store.read(() =>
			store.db.prepare(`SELECT resolution FROM call_edges WHERE from_function='main' AND to_callee_text='thing.dupName('`).get(),
		) as { resolution: string } | undefined;
		assert.ok(amb, "member call edge must exist");
		assert.equal(amb.resolution, "ambiguous", "same-name exports must classify ambiguous, not unbound");
		const req = store.read(() =>
			store.db.prepare(`SELECT to_file_name, resolution FROM call_edges WHERE from_function='main' AND to_callee_text='reqFn('`).get(),
		) as { to_file_name: string; resolution: string } | undefined;
		assert.ok(req && req.resolution === "resolved", "require-destructure must bind the NAMED export");
		assert.equal(req?.to_file_name, "mod.ts");
		const dyn = store.read(() =>
			store.db.prepare(`SELECT kind, resolution FROM call_edges WHERE to_callee_text='import(./mod.ts)'`).get(),
		) as { kind: string; resolution: string } | undefined;
		assert.ok(dyn && dyn.kind === "import" && dyn.resolution === "resolved", "dynamic import must emit a resolved import edge");
		store.close();
		cleanup();
	});

	test("a local same-name function never hijacks an external member call; method heuristic is INFERRED", async () => {
		const { root, cleanup } = tmpWorkdir();
		fs.writeFileSync(
			path.join(root, "main.ts"),
			[
				'import * as fs from "node:fs";',
				"export function readFile() { return 1; }",
				"export function localUtil() { return readFile(); }",
				"export function extern() { return fs.readFileSync('x'); }",
				"export function caller() { return obj.readFile(); }",
			].join("\n") + "\n",
		);
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const hijack = store.read(() =>
			store.db.prepare(`SELECT resolution, to_file_name FROM call_edges WHERE from_function='extern' AND to_callee_text='fs.readFileSync('`).get(),
		);
		assert.equal(hijack, undefined, "external module member call must drop, not bind to the local readFile");
		const direct = store.read(() =>
			store.db.prepare(`SELECT resolution, confidence FROM call_edges WHERE from_function='localUtil' AND to_callee_text='readFile('`).get(),
		) as { resolution: string; confidence: string } | undefined;
		assert.ok(direct && direct.resolution === "resolved" && direct.confidence === "EXTRACTED", "same-file DIRECT call stays EXTRACTED");
		const heuristic = store.read(() =>
			store.db.prepare(`SELECT resolution, confidence FROM call_edges WHERE from_function='caller' AND to_callee_text='obj.readFile('`).get(),
		) as { resolution: string; confidence: string } | undefined;
		assert.ok(heuristic && heuristic.resolution === "resolved" && heuristic.confidence === "INFERRED", "same-name method heuristic must be INFERRED");
		store.close();
		cleanup();
	});

	test("function_records view rows carry callee+confidence links and the distribution query works", async () => {
		const { root, cleanup } = tmpWorkdir();
		fs.writeFileSync(
			path.join(root, "big.ts"),
			[
				"export function target() { return 1; }",
				"export function caller() { return target(); }",
				...Array.from({ length: 200 }, (_, i) => `export const pad${i} = ${i};`),
			].join("\n") + "\n",
		);
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const row = store.read(() =>
			store.db.prepare(`SELECT out_links_json FROM function_records WHERE function_name='caller'`).get(),
		) as { out_links_json: string } | undefined;
		assert.ok(row?.out_links_json?.includes('"callee"') && row.out_links_json.includes('"confidence"'), row?.out_links_json);
		const dist = store.read(() => store.db.prepare(`SELECT kind, resolution, confidence, COUNT(*) AS n FROM call_edges GROUP BY kind, resolution, confidence`).all());
		assert.ok(dist.length > 0, "status distribution query shape must work");
		store.close();
		cleanup();
	});
});
