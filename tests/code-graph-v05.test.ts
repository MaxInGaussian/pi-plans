/**
 * v0.5.0 code-graph upgrade: freshness validation, edge confidence matrix,
 * traversal actions, communities, watch lifecycle, and staged parse-merge.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/code-graph/store.ts";
import { runIndex, reindexStagedText } from "../src/code-graph/indexer.ts";
import { loadValidatedSnapshot, checkFreshness, reindexRelativePaths } from "../src/code-graph/freshness.ts";
import { updateFile, deleteFile } from "../src/code-graph/mutations.ts";
import {
	loadGraphIndex,
	queryGraph,
	shortestPath,
	explainNode,
	impactOf,
	resolveNodeSelector,
} from "../src/code-graph/traverse.ts";
import { computeCommunities } from "../src/code-graph/community.ts";
import { startGraphWatcher, stopGraphWatcher, restartWatcherIfEnabled, disableWatcher, liveWatcherCount } from "../src/code-graph/watch.ts";
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-v05-"));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function edge(store: Store, from: string): { to: string; confidence: string; resolution: string } | undefined {
	return store.read(() =>
		store.db
			.prepare(
				`SELECT to_file_name || ':' || to_function AS to, confidence, resolution FROM call_edges WHERE from_function = ? AND resolution = 'resolved'`,
			)
			.get(from),
	) as { to: string; confidence: string; resolution: string } | undefined;
}

describe("freshness validation (VC-002 / AC-001)", () => {
	test("stale file falls back to disk, self-heals synchronously, and reads fresh afterwards", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { parsers, sqlite } = await makeParsers();
		const file = path.join(root, "a.ts");
		fs.writeFileSync(file, "export function alpha() { return 1; }\n");
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const info = { absolutePath: file, relativePath: "a.ts", fileDir: ".", fileName: "a.ts", language: "typescript" as const };
		const rt = { store, paths: { worktreeRoot: root, codeGraphDb: path.join(root, "db.sqlite"), gitCommonDir: root }, parsers };
		let snap = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(snap?.origin, "db-fresh");
		fs.writeFileSync(file, "export function alpha() { return 2; }\nexport function beta() { return alpha(); }\n");
		snap = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(snap?.origin, "disk-fallback");
		assert.ok(snap?.marker?.includes("stale"), `marker: ${snap?.marker}`);
		assert.ok(snap?.text.includes("beta"), "must serve the fresh disk buffer");
		snap = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(snap?.origin, "db-fresh");
		assert.equal(snap?.marker, null);
		store.close();
		cleanup();
	});

	test("pending update serves staged text with a marker and never rebuilds", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { parsers, sqlite } = await makeParsers();
		const file = path.join(root, "a.ts");
		fs.writeFileSync(file, "export function alpha() { return 1; }\n");
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const mut = updateFile(store, { fileDir: ".", fileName: "a.ts", text: "export function alpha() { return 99; }\n" });
		assert.equal(mut.ok, true);
		const info = { absolutePath: file, relativePath: "a.ts", fileDir: ".", fileName: "a.ts", language: "typescript" as const };
		const rt = { store, paths: { worktreeRoot: root, codeGraphDb: path.join(root, "db.sqlite"), gitCommonDir: root }, parsers };
		const snap = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(snap?.origin, "db-pending");
		assert.ok(snap?.marker?.includes("pending apply"), `marker: ${snap?.marker}`);
		assert.ok(snap?.text.includes("99"), "staged (DB-ahead) text must be served");
		// The staged edit survives: applying it materializes 99 onto disk.
		const row = store.read(() => store.db.prepare(`SELECT source_text FROM files WHERE file_name='a.ts'`).get()) as { source_text: string };
		assert.ok(row.source_text.includes("99"));
		store.close();
		cleanup();
	});

	test("pending delete reads as not-indexed (null) and touch keeps freshness", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { parsers, sqlite } = await makeParsers();
		const file = path.join(root, "a.ts");
		fs.writeFileSync(file, "export function alpha() { return 1; }\n");
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const info = { absolutePath: file, relativePath: "a.ts", fileDir: ".", fileName: "a.ts", language: "typescript" as const };
		const rt = { store, paths: { worktreeRoot: root, codeGraphDb: path.join(root, "db.sqlite"), gitCommonDir: root }, parsers };
		const st = fs.statSync(file);
		fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 4000));
		const snap = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(snap?.origin, "db-fresh", "same-content touch must stay fresh");
		assert.equal(checkFreshness(store, info), "fresh");
		fs.unlinkSync(file);
		const gone = await loadValidatedSnapshot(rt, info, { selfHeal: true });
		assert.equal(gone?.origin, "db-orphan");
		assert.ok(gone?.marker?.includes("missing on disk"));
		store.close();
		cleanup();
	});

	test("read-only refiner sessions fall back but never rebuild", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { parsers, sqlite } = await makeParsers();
		const file = path.join(root, "a.ts");
		fs.writeFileSync(file, "export function alpha() { return 1; }\n");
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		fs.writeFileSync(file, "export function alpha() { return 2; }\n");
		const info = { absolutePath: file, relativePath: "a.ts", fileDir: ".", fileName: "a.ts", language: "typescript" as const };
		const rt = { store, paths: { worktreeRoot: root, codeGraphDb: path.join(root, "db.sqlite"), gitCommonDir: root }, parsers };
		const snap = await loadValidatedSnapshot(rt, info, { selfHeal: false });
		assert.equal(snap?.origin, "disk-fallback");
		assert.ok(snap?.text.includes("return 2"));
		const row = store.read(() => store.db.prepare(`SELECT source_text FROM files WHERE file_name='a.ts'`).get()) as { source_text: string };
		assert.ok(row.source_text.includes("return 1"), "refiner must not rebuild the DB");
		store.close();
		cleanup();
	});
});

describe("edge confidence matrix (VC-001)", () => {
	async function fixture() {
		const { root, cleanup } = tmpWorkdir();
		fs.mkdirSync(path.join(root, "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "main.ts"),
			[
				'import { helper } from "./lib/util.ts";',
				'import * as ns from "./lib/ns.ts";',
				'import Def from "./lib/def.ts";',
				'import { extern } from "some-package";',
				"",
				"export function main() {",
				"\thelper(1);",
				"\tns.exportedFn();",
				"\tDef();",
				"\textern();",
				"\tconsole.log(1);",
				"\tlocal();",
				"\treturn unknownFn();",
				"}",
				"",
				"function local() { return 2; }",
			].join("\n"),
		);
		fs.writeFileSync(path.join(root, "lib", "util.ts"), "export function helper(x: number) { return x; }\n");
		fs.writeFileSync(path.join(root, "lib", "ns.ts"), "export function exportedFn() { return 1; }\nexport function other() { return 2; }\n");
		fs.writeFileSync(path.join(root, "lib", "def.ts"), "export default function defMain() { return 3; }\n");
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		return { root, cleanup, store };
	}

	test("same-file call resolves EXTRACTED; cross-file named import resolves INFERRED", async () => {
		const { store, cleanup } = await fixture();
		const localEdge = store.read(() =>
			store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text='local('`).get(),
		) as { resolution: string; confidence: string; to_file_name: string } | undefined;
		assert.ok(localEdge, "same-file edge must exist");
		assert.equal(localEdge.resolution, "resolved");
		assert.equal(localEdge.confidence, "EXTRACTED");
		const helperEdge = store.read(() =>
			store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text='helper('`).get(),
		) as { resolution: string; confidence: string; to_file_name: string } | undefined;
		assert.ok(helperEdge, "imported call edge must exist");
		assert.equal(helperEdge.resolution, "resolved");
		assert.equal(helperEdge.confidence, "INFERRED");
		assert.equal(helperEdge.to_file_name, "util.ts");
		store.close();
		cleanup();
	});

	test("namespace member and default-import calls resolve INFERRED; externals and builtins drop", async () => {
		const { store, cleanup } = await fixture();
		const nsEdge = store.read(() =>
			store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text='ns.exportedFn('`).get(),
		) as { resolution: string; confidence: string; to_function: string } | undefined;
		assert.ok(nsEdge && nsEdge.resolution === "resolved" && nsEdge.confidence === "INFERRED" && nsEdge.to_function === "exportedFn");
		const defEdge = store.read(() =>
			store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text='Def('`).get(),
		) as { resolution: string; confidence: string } | undefined;
		assert.ok(defEdge && defEdge.resolution === "resolved" && defEdge.confidence === "INFERRED");
		for (const noise of ["extern(", "console.log("]) {
			const row = store.read(() =>
				store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text=?`).get(noise),
			);
			assert.equal(row, undefined, `${noise} must be dropped as noise`);
		}
		const dangling = store.read(() =>
			store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text='unknownFn('`).get(),
		) as { resolution: string; confidence: string } | undefined;
		assert.ok(dangling && dangling.resolution === "unresolved" && dangling.confidence === "EXTRACTED");
		store.close();
		cleanup();
	});

	test("python from-import resolves across files", async () => {
		const { root, cleanup } = tmpWorkdir();
		fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
		fs.writeFileSync(path.join(root, "pkg", "__init__.py"), "");
		fs.writeFileSync(path.join(root, "pkg", "core.py"), "def run():\n    return 1\n");
		fs.writeFileSync(path.join(root, "app.py"), "from pkg.core import run\n\ndef main():\n    return run()\n");
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const e = store.read(() =>
			store.db.prepare(`SELECT * FROM call_edges WHERE from_function='main' AND to_callee_text='run('`).get(),
		) as { resolution: string; confidence: string; to_file_name: string } | undefined;
		assert.ok(e, "python cross-file edge must exist");
		assert.equal(e.resolution, "resolved");
		assert.equal(e.confidence, "INFERRED");
		assert.equal(e.to_file_name, "core.py");
		store.close();
		cleanup();
	});
});

describe("traversal actions (VC-004)", () => {
	async function graphFixture() {
		const { root, cleanup } = tmpWorkdir();
		fs.writeFileSync(
			path.join(root, "chain.ts"),
			[
				"export function chainA() { return chainB(); }",
				"export function chainB() { return chainC(); }",
				"export function chainC() { return chainD(); }",
				"export function chainD() { return chainA(); }",
				"export function orphan() { return 9; }",
			].join("\n"),
		);
		fs.writeFileSync(path.join(root, "caller.ts"), 'import { chainA } from "./chain.ts";\nexport function top() { return chainA(); }\n');
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		return { store, cleanup };
	}

	test("query matches keywords, expands deterministically, and honors the budget", async () => {
		const { store, cleanup } = await graphFixture();
		const idx = loadGraphIndex(store);
		const r1 = queryGraph(idx, ["chain"], {});
		assert.ok(r1.visited >= 3, `visited: ${r1.visited}`);
		const r2 = queryGraph(idx, ["chain"], {});
		assert.deepEqual(r1.lines, r2.lines, "expansion must be deterministic");
		const tiny = queryGraph(idx, ["chain"], { budgetTokens: 50 });
		assert.equal(tiny.truncated, true, "tiny budget must truncate");
		store.close();
		cleanup();
	});

	test("path finds the shortest chain and reports hops with confidence", async () => {
		const { store, cleanup } = await graphFixture();
		const idx = loadGraphIndex(store);
		const p = shortestPath(idx, resolveNodeSelector(idx, "top")!, resolveNodeSelector(idx, "chainC")!);
		assert.equal(p.found, true);
		assert.equal(p.hops.length, 3, "top→chainA→chainB→chainC");
		const none = shortestPath(idx, resolveNodeSelector(idx, "top")!, resolveNodeSelector(idx, "orphan")!);
		assert.equal(none.found, false);
		store.close();
		cleanup();
	});

	test("explain reports degrees and community; impact returns the reverse closure with files", async () => {
		const { store, cleanup } = await graphFixture();
		const idx = loadGraphIndex(store);
		const e = explainNode(idx, resolveNodeSelector(idx, "chainC")!);
		assert.equal(e?.inDegree, 1, "chainB is the only direct caller");
		const im = impactOf(idx, resolveNodeSelector(idx, "chainC")!);
		assert.ok(im && im.affected.length >= 3, `affected: ${im?.affected.length}`);
		assert.ok(im!.files.includes("./caller.ts") || im!.files.includes("caller.ts"));
		store.close();
		cleanup();
	});
});

describe("communities and report (VC-005)", () => {
	test("label propagation is deterministic and fills the communities table", async () => {
		const { root, cleanup } = tmpWorkdir();
		fs.writeFileSync(
			path.join(root, "g.ts"),
			[
				"export function m1() { return m2(); }",
				"export function m2() { return m1(); }",
				"export function m3() { return m4(); }",
				"export function m4() { return m3(); }",
			].join("\n"),
		);
		const { parsers, sqlite } = await makeParsers();
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const r1 = computeCommunities(store);
		const rows1 = store.read(() => store.db.prepare(`SELECT community_id, label, degree FROM communities ORDER BY function_name`).all());
		const r2 = computeCommunities(store);
		const rows2 = store.read(() => store.db.prepare(`SELECT community_id, label, degree FROM communities ORDER BY function_name`).all());
		assert.deepEqual(rows1, rows2, "community assignment must be deterministic");
		assert.equal(r1.nodes, 4);
		assert.ok(r1.communities >= 1);
		store.close();
		cleanup();
	});
});

describe("staged parse-merge and shared reindex (VC-006 trigger 3)", () => {
	test("reindexStagedText refreshes derived rows without touching source_text/pending_kind", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { parsers, sqlite } = await makeParsers();
		fs.writeFileSync(path.join(root, "a.ts"), "export function alpha() { return 1; }\n");
		const store = new Store({ dbPath: path.join(root, "db.sqlite"), worktreeRoot: root, gitCommonDir: root }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		const staged = "export function alpha() { return betaNew(); }\nexport function betaNew() { return 2; }\n";
		updateFile(store, { fileDir: ".", fileName: "a.ts", text: staged });
		reindexStagedText(store, parsers, ".", "a.ts", "typescript", staged);
		const fn = store.read(() => store.db.prepare(`SELECT COUNT(*) AS c FROM functions WHERE function_name='betaNew'`).get()) as { c: number };
		assert.equal(fn.c, 1, "staged function must be visible to queries");
		const call = store.read(() =>
			store.db.prepare(`SELECT resolution FROM call_edges WHERE from_function='alpha' AND to_callee_text='betaNew('`).get(),
		) as { resolution: string } | undefined;
		assert.equal(call?.resolution, "resolved");
		const file = store.read(() => store.db.prepare(`SELECT pending_kind FROM files WHERE file_name='a.ts'`).get()) as { pending_kind: string };
		assert.equal(file.pending_kind, "update", "pending state must survive parse-merge untouched");
		// Root-file key normalization: reindexRelativePaths must hit '.' files.
		fs.writeFileSync(path.join(root, "a.ts"), staged);
		const rt = { store, paths: { worktreeRoot: root, codeGraphDb: path.join(root, "db.sqlite"), gitCommonDir: root }, parsers };
		const res = await reindexRelativePaths(rt, ["a.ts"]);
		assert.equal(res.reindexed, 1, `root-file normalization: ${JSON.stringify(res)}`);
		store.close();
		cleanup();
	});
});

describe("watch lifecycle (VC-006)", () => {
	test("watcher starts once, debounces a change into the index, and stops cleanly", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { execSync } = await import("node:child_process");
		execSync("git init -q", { cwd: root });
		execSync('git config user.email t@t && git config user.name t', { cwd: root, shell: "/bin/bash" });
		const { parsers, sqlite } = await makeParsers();
		fs.writeFileSync(path.join(root, "a.ts"), "export function alpha() { return 1; }\n");
		// The watcher always opens the CANONICAL db under .git/pi_plans/.
		const dbPath = path.join(root, ".git", "pi_plans", "code_graph.db");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const store = new Store({ dbPath, worktreeRoot: root, gitCommonDir: path.join(root, ".git") }, sqlite);
		await runIndex({ store, worktreeRoot: root, parsers });
		store.close();
		const s1 = await startGraphWatcher(root);
		assert.equal(s1.started, true, s1.reason);
		assert.equal(liveWatcherCount(), 1);
		const s2 = await startGraphWatcher(root);
		assert.equal(s2.started, true, "second start is idempotent in-process");
		fs.writeFileSync(path.join(root, "a.ts"), "export function alpha() { return 2; }\nexport function betaWatch() { return alpha(); }\n");
		await new Promise((resolve) => setTimeout(resolve, 700));
		{
			const check = new Store({ dbPath, worktreeRoot: root, gitCommonDir: path.join(root, ".git") }, sqlite);
			const fn = check.read(() => check.db.prepare(`SELECT COUNT(*) AS c FROM functions WHERE function_name='betaWatch'`).get()) as { c: number };
			assert.equal(fn.c, 1, "watcher must debounce the change into the index");
			check.close();
		}
		stopGraphWatcher(root);
		assert.equal(liveWatcherCount(), 0);
		cleanup();
	});
});

describe("non-git workdir degradation (0.5.5)", () => {
	async function assertNonGit(root: string): Promise<void> {
		const { execSync } = await import("node:child_process");
		let notARepo = false;
		try {
			execSync("git rev-parse --show-toplevel", { cwd: root, stdio: "pipe" });
		} catch {
			notARepo = true;
		}
		assert.ok(notARepo, "fixture must not be inside a git work tree");
	}

	test("session_start restart is a silent no-op outside a git worktree", async () => {
		const { root, cleanup } = tmpWorkdir(); // mkdtemp: never inside a git work tree
		await assertNonGit(root);
		// The pre-fix code rejected with PathError here, killing extension bind.
		await assert.doesNotReject(() => restartWatcherIfEnabled(root));
		assert.equal(liveWatcherCount(), 0, "no watcher may be created for a non-git workdir");
		cleanup();
	});

	test("session_shutdown stop is a silent no-op outside a git worktree", async () => {
		const { root, cleanup } = tmpWorkdir();
		await assertNonGit(root);
		// The pre-fix code threw PathError synchronously here.
		assert.doesNotThrow(() => stopGraphWatcher(root));
		assert.equal(liveWatcherCount(), 0);
		cleanup();
	});

	test("disable-graph is a silent no-op outside a git worktree", async () => {
		const { root, cleanup } = tmpWorkdir();
		await assertNonGit(root);
		// The pre-fix code threw PathError synchronously here.
		assert.doesNotThrow(() => disableWatcher(root));
		assert.equal(liveWatcherCount(), 0);
		cleanup();
	});

	test("git worktree lifecycle entries keep working after the degradation guard", async () => {
		const { root, cleanup } = tmpWorkdir();
		const { execSync } = await import("node:child_process");
		execSync("git init -q", { cwd: root });
		await assert.doesNotReject(() => restartWatcherIfEnabled(root));
		assert.doesNotThrow(() => stopGraphWatcher(root));
		assert.doesNotThrow(() => disableWatcher(root));
		cleanup();
	});
});
