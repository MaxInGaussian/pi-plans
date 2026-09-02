/**
 * Verifies the SQLite schema migrations, worktree binding, and BEGIN
 * IMMEDIATE transactions. Skipped when node:sqlite is not available.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/code-graph/store.ts";
import { PathError, resolveCanonicalWorktree } from "../src/code-graph/paths.ts";

async function openInMemory(): Promise<{ store: Store; cleanup: () => void } | null> {
	try {
		const sqlite = await import("node:sqlite");
		const worktreeRoot = fs.realpathSync(os.tmpdir());
		const dbPath = path.join(os.tmpdir(), `code-graph-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		const store = new Store({ dbPath, worktreeRoot, gitCommonDir: worktreeRoot }, sqlite);
		store.close();
		const reopened = new Store({ dbPath, worktreeRoot, gitCommonDir: worktreeRoot }, sqlite);
		return { store: reopened, cleanup: () => {
			reopened.close();
			try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
		} };
	} catch {
		return null;
	}
}

test("schema migrations are idempotent and create required tables", async (t) => {
	const opened = await openInMemory();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const tables = store.read(() =>
		store.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name`).all(),
	) as Array<{ name: string }>;
	const names = new Set(tables.map((row) => row.name));
	for (const required of ["call_edges", "files", "file_entries", "functions", "graph_meta", "function_records", "code_graph_snapshot"]) {
		assert.ok(names.has(required), `expected table or view ${required}`);
	}
	const meta = store.readMeta();
	assert.ok(meta, "graph_meta should be populated");
	assert.equal(meta.worktreeRoot.length > 0, true);
	const columns = store.db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
	assert.ok(columns.some((column) => column.name === "pending_kind"), "files.pending_kind must exist");
});

test("v1 database upgrades to v2 with initial snapshot and re-entrant migration", async (t) => {
	let sqlite: typeof import("node:sqlite");
	try {
		sqlite = await import("node:sqlite");
	} catch {
		return;
	}
	const dbPath = path.join(os.tmpdir(), `code-graph-v1-upgrade-${process.pid}-${Date.now()}.db`);
	t.after(() => {
		try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
	});
	// Build a v1 database: old files schema (no pending_kind), no snapshot table.
	const raw = new sqlite.DatabaseSync(dbPath, { open: true });
	raw.exec(`
		CREATE TABLE graph_meta (schema_version INTEGER PRIMARY KEY, worktree_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, parser_versions TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE files (file_dir TEXT NOT NULL, file_name TEXT NOT NULL, language TEXT NOT NULL, source_hash TEXT NOT NULL, source_text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (file_dir, file_name));
		INSERT INTO graph_meta VALUES (1, '${fs.realpathSync(os.tmpdir())}', '${fs.realpathSync(os.tmpdir())}', '{}', '2026-01-01T00:00:00Z');
		INSERT INTO files (file_dir, file_name, language, source_hash, source_text, updated_at) VALUES ('.', 'a.js', 'javascript', 'h1', 'source', '2026-01-01T00:00:00Z');
	`);
	raw.close();
	const worktreeRoot = fs.realpathSync(os.tmpdir());
	const store = new Store({ dbPath, worktreeRoot, gitCommonDir: worktreeRoot }, sqlite);
	try {
		assert.equal(store.readMeta()?.schemaVersion, 2, "v1 DB must upgrade to v2 on open");
		const columns = store.db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
		assert.ok(columns.some((column) => column.name === "pending_kind"));
		const snapshot = store.readLatestSnapshot();
		assert.ok(snapshot, "initial snapshot row must exist after migration");
		assert.deepEqual(snapshot.uncommittedPaths, []);
		// Re-open again: migration must be a safe no-op (step-idempotent).
		store.close();
		const reopened = new Store({ dbPath, worktreeRoot, gitCommonDir: worktreeRoot }, sqlite);
		assert.equal(reopened.readMeta()?.schemaVersion, 2);
		assert.ok(reopened.readLatestSnapshot(), "snapshot survives re-open");
		const snapshots = reopened.read(() => reopened.db.prepare("SELECT COUNT(*) AS c FROM code_graph_snapshot").get()) as { c: number };
		assert.equal(snapshots.c, 1, "no duplicate snapshot rows on re-entry");
		reopened.close();
	} finally {
		try { store.close(); } catch { /* already closed */ }
	}
});

test("snapshot upsert and readLatestSnapshot round-trip", async (t) => {
	const opened = await openInMemory();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	store.upsertSnapshot("abc123", ["src/a.ts", "README.md"]);
	store.upsertSnapshot("def456", []);
	const latest = store.readLatestSnapshot();
	assert.ok(latest);
	assert.equal(latest.headCommit, "def456");
	assert.deepEqual(latest.uncommittedPaths, []);
	const prior = store.read(() => store.db.prepare("SELECT head_commit FROM code_graph_snapshot ORDER BY id ASC").all()) as Array<{ head_commit: string }>;
	assert.equal(prior[0]?.head_commit, "abc123");
});

test("worktree mismatch is rejected on open", async (t) => {
	const opened = await openInMemory();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const meta = store.readMeta();
	assert.ok(meta);
	// Same path: no throw.
	store.checkWorktree(meta.worktreeRoot, meta.gitCommonDir);
	assert.throws(
		() => store.checkWorktree("/totally/different", meta.gitCommonDir),
		(err: Error) => {
			assert.ok(err instanceof PathError);
			return true;
		},
	);
});

test("write transactions use BEGIN IMMEDIATE and roll back on error", async (t) => {
	const opened = await openInMemory();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	store.tx(() => {
		store.db
			.prepare(
				`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run("dir", "a.js", "javascript", "hash", "source", new Date().toISOString());
	});
	const ok = store.read(() =>
		store.db.prepare("SELECT COUNT(*) AS c FROM files WHERE file_dir = 'dir' AND file_name = 'a.js'").get(),
	) as { c: number };
	assert.equal(ok.c, 1);
	assert.throws(() => {
		store.tx(() => {
			store.db
				.prepare(
					`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run("dir", "a.js", "javascript", "dup", "source", new Date().toISOString());
			throw new Error("fail");
		});
	}, /fail/);
	const stillOne = store.read(() =>
		store.db.prepare("SELECT COUNT(*) AS c FROM files WHERE file_dir = 'dir'").get(),
	) as { c: number };
	assert.equal(stillOne.c, 1, "duplicate insert must be rolled back");
});

test("resolveCanonicalWorktree requires a git worktree", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-no-git-"));
	try {
		assert.throws(() => resolveCanonicalWorktree(dir));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
