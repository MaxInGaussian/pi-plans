/**
 * End-to-end code-graph loop test: chore commit + snapshot → DB-first
 * mutation → apply → drift → final-commit → clean init; plus the human-edit
 * (update-graph) and deletion branches.
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
import { hashText } from "../src/code-graph/parser.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { computeDrift } from "../src/code-graph/commands.ts";
import { gitAddAllAndCommit, gitHead } from "../src/code-graph/git.ts";
import { finalCommit } from "../tools/plans.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";

function git(cwd: string, args: string[]): { code: number; stdout: string } {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	return { code: result.status ?? 1, stdout: result.stdout ?? "" };
}

function initRepo(): { root: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-loop-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	fs.writeFileSync(path.join(dir, "math.js"), "function add(a, b) { return a + b; }\n");
	fs.writeFileSync(path.join(dir, "helper.ts"), "function twice(n: number): number { return n * 2; }\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", "init"]);
	return {
		root: dir,
		cleanup: () => {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

function makeNotify(): { lines: string[]; notify: (message: string, kind?: "info" | "warning" | "error") => void } {
	const lines: string[] = [];
	return { lines, notify: (message) => { lines.push(message); } };
}

test("closed loop: init → mutation → apply → drift → final-commit → clean init", async (t) => {
	const runtime = await loadGraphRuntime();
	if (!runtime.status.parserAvailable || !runtime.status.sqliteAvailable) return;
	const { root, cleanup } = initRepo();
	t.after(cleanup);

	const stateRoot = path.join(root, ".git", "pi_plans");
	fs.mkdirSync(stateRoot, { recursive: true });
	const dbPath = path.join(stateRoot, "code_graph.db");
	const store = new Store({ dbPath, worktreeRoot: root, gitCommonDir: path.join(root, ".git") }, runtime.runtime.sqlite);
	t.after(() => store.close());

	const ParserCtor = runtime.runtime.parser.Parser as unknown as new () => {
		parse(input: string | Buffer): unknown;
		setLanguage(language: unknown): void;
	};
	const parsers: Record<Language, ParserBackend> = {
		javascript: makeBackend("javascript", ParserCtor, runtime.runtime.parser.javascript),
		typescript: makeBackend("typescript", ParserCtor, runtime.runtime.parser.typescript),
		tsx: makeBackend("tsx", ParserCtor, runtime.runtime.parser.tsx),
		python: new (await import("../src/code-graph/parsers/python.ts")).PythonBackend(ParserCtor, runtime.runtime.parser.python),
	};

	// 1. init-graph: dirty? no (we committed). index + snapshot.
	fs.writeFileSync(path.join(root, "dirty.js"), "// stray\n");
	const chore = gitAddAllAndCommit(root, "chore(code-graph): pre-init snapshot");
	assert.notEqual(chore, "", "chore commit created for dirty tree");
	await runIndex({ store, worktreeRoot: root, parsers });
	store.upsertSnapshot(gitHead(root), []);
	assert.ok(store.readLatestSnapshot(), "snapshot written");

	// 2. DB-first mutation: update-function on math.js:add. Maintains
	// functions.full_code and files.source_text (the canonical new content).
	const newBody = "function add(a, b) { return a + b + 100; }\n";
	const manifest = store.read(() =>
		store.db.prepare(`SELECT ordinal, start_byte, end_byte, text FROM file_entries WHERE file_name = 'math.js' ORDER BY ordinal`).all(),
	) as Array<{ ordinal: number; start_byte: number; end_byte: number; text: string }>;
	void manifest;
	store.tx(() => {
		store.db
			.prepare(`UPDATE functions SET full_code = ?, full_code_hash = ?, render_code = ?, render_code_hash = ? WHERE file_name = 'math.js' AND function_name = 'add'`)
			.run(newBody, "h1", newBody, "h1");
		const manifest2 = manifest;
		for (const row of manifest2) {
			if (!row.text.includes("return a + b;")) continue;
			const delta = newBody.length - row.text.length;
			store.db.prepare(`UPDATE file_entries SET text = ?, end_byte = ? WHERE file_name = 'math.js' AND ordinal = ?`).run(newBody, row.end_byte + delta, row.ordinal);
		}
		store.db.prepare(`UPDATE files SET source_text = ?, source_hash = ?, pending_kind = 'update' WHERE file_name = 'math.js'`).run(newBody, hashText(newBody));
		store.db.prepare(`INSERT INTO change_log (kind, detail, recorded_at) VALUES ('update-function', './math.js:add', ?)`).run(new Date().toISOString());
	});

	// 3. drift: pending reported, ok-with-note semantics → recommendation = apply.
	let drift = computeDrift(store, root);
	assert.ok(drift.pending.some((item) => item.path === "./math.js" && item.kind === "update"));

	// 4. apply: writes the file, clears pending.
	const applied = materializeFile(store, root, ".", "math.js");
	assert.equal(applied.status, "ok");
	assert.ok(fs.readFileSync(path.join(root, "math.js"), "utf8").includes("+ 100"));
	drift = computeDrift(store, root);
	assert.equal(drift.pending.length, 0, "pending cleared after apply");

	// 5. final-commit: drift clean → commits; second call is a no-op.
	const commit1 = await finalCommit(root, "feat(loop): add +100");
	assert.equal(commit1.ok, true);
	assert.equal(commit1.noop, false);
	assert.ok(commit1.committed);
	const commit2 = await finalCommit(root, "noop attempt");
	assert.equal(commit2.ok, true);
	assert.equal(commit2.noop, true, "clean tree is a safe no-op");

	// 6. Human-edit branch: change source directly, update-graph reindexes.
	fs.writeFileSync(path.join(root, "helper.ts"), "function twice(n: number): number { return n * 3; }\n");
	drift = computeDrift(store, root);
	assert.ok(drift.hashDrift.some((item) => item.path === "./helper.ts" && item.kind === "hash-mismatch"));
	const upd = await runIndex({ store, worktreeRoot: root, parsers, paths: ["./helper.ts"] });
	assert.deepEqual(upd.reindexedPaths, ["./helper.ts"]);
	drift = computeDrift(store, root);
	assert.ok(!drift.hashDrift.some((item) => item.path === "./helper.ts"));

	// 7. Deletion branch: remove file, update-graph purges rows; apply does not resurrect.
	fs.rmSync(path.join(root, "helper.ts"));
	drift = computeDrift(store, root);
	assert.ok(drift.hashDrift.some((item) => item.path === "./helper.ts"));
	const upd2 = await runIndex({ store, worktreeRoot: root, parsers, paths: ["./helper.ts"] });
	assert.deepEqual(upd2.purgedPaths, ["./helper.ts"]);
	const applyDeleted = materializeFile(store, root, ".", "helper.ts");
	assert.equal(applyDeleted.status, "error", "row gone; not resurrected");
	assert.equal(fs.existsSync(path.join(root, "helper.ts")), false);

	// 8. final-commit with pending set must refuse.
	store.tx(() => {
		store.db.prepare(`UPDATE files SET pending_kind = 'update' WHERE file_name = 'math.js'`).run();
	});
	const refused = await finalCommit(root, "should refuse");
	assert.equal(refused.ok, false);
	assert.match(refused.reason ?? "", /apply-graph/);
	store.tx(() => {
		store.db.prepare(`UPDATE files SET pending_kind = NULL WHERE file_name = 'math.js'`).run();
	});

	const { lines, notify } = makeNotify();
	void notify;
	assert.ok(lines !== undefined);
});
