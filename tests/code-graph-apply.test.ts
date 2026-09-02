/**
 * Verifies the DB-to-source materializer refuses stale source unless force,
 * and roundtrips bytes for unchanged content.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/code-graph/store.ts";
import { materializeFile } from "../src/code-graph/materialize.ts";

async function setup(): Promise<{ store: Store; cleanup: () => void } | null> {
	try {
		const sqlite = await import("node:sqlite");
		const worktreeRoot = fs.realpathSync(os.tmpdir());
		const dbPath = path.join(os.tmpdir(), `code-graph-apply-${process.pid}-${Date.now()}.db`);
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

function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

test("materialize refuses stale source unless force is set", async (t) => {
	const opened = await setup();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const worktreeRoot = fs.realpathSync(os.tmpdir());
	const fileDir = "graph-apply-fixture";
	const fileName = "demo.txt";
	const absoluteDir = path.join(worktreeRoot, fileDir);
	fs.mkdirSync(absoluteDir, { recursive: true });
	const original = "hello graph";
	fs.writeFileSync(path.join(absoluteDir, fileName), original);
	const sourceHash = hashText(original);
	store.tx(() => {
		store.db
			.prepare(
				`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(fileDir, fileName, "javascript", sourceHash, original, new Date().toISOString());
		store.db
			.prepare(
				`INSERT INTO file_entries (file_dir, file_name, ordinal, kind, function_name, start_byte, end_byte, text)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(fileDir, fileName, 0, "raw", null, 0, original.length, original);
	});
	// File matches DB hash: write succeeds.
	const okResult = materializeFile(store, worktreeRoot, fileDir, fileName);
	assert.equal(okResult.status, "ok");
	// Now mutate the source on disk to be stale.
	fs.writeFileSync(path.join(absoluteDir, fileName), "external change");
	const staleResult = materializeFile(store, worktreeRoot, fileDir, fileName);
	assert.equal(staleResult.status, "stale");
	const forceResult = materializeFile(store, worktreeRoot, fileDir, fileName, { force: true });
	assert.equal(forceResult.status, "ok");
	assert.equal(fs.readFileSync(path.join(absoluteDir, fileName), "utf8"), original);
	fs.rmSync(absoluteDir, { recursive: true, force: true });
});

test("pending_kind drives convergence: update writes/creates, delete purges, missing skips", async (t) => {
	const sqliteAvailable = (async () => { try { await import("node:sqlite"); return true; } catch { return false; } })();
	if (!(await sqliteAvailable)) return;
	const sqlite = await import("node:sqlite");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-pending-"));
	t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
	const store = new Store({ dbPath: path.join(dir, "g.db"), worktreeRoot: dir, gitCommonDir: path.join(dir, ".git") }, sqlite);
	t.after(() => store.close());
	const now = new Date().toISOString();

	// 1. pending update creates a missing file (new-file path).
	store.tx(() => {
		store.db.prepare(
			`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, pending_kind, updated_at)
			 VALUES ('.', 'new.js', 'javascript', 'x', 'function n() { return 1; }\n', 'update', ?)`,
		).run(now);
	});
	const created = materializeFile(store, dir, ".", "new.js");
	assert.equal(created.status, "ok");
	assert.equal(fs.readFileSync(path.join(dir, "new.js"), "utf8"), "function n() { return 1; }\n");
	const cleared = store.read(() => store.db.prepare(`SELECT pending_kind FROM files WHERE file_name = 'new.js'`).get()) as { pending_kind: string | null };
	assert.equal(cleared.pending_kind, null, "pending cleared after apply");

	// 2. pending delete removes disk file and DB rows.
	fs.writeFileSync(path.join(dir, "doomed.js"), "function d() {}\n");
	store.tx(() => {
		store.db.prepare(
			`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, pending_kind, updated_at)
			 VALUES ('.', 'doomed.js', 'javascript', 'x', 'function d() {}\n', 'delete', ?)`,
		).run(now);
		store.db.prepare(
			`INSERT INTO functions (file_dir, file_name, function_name, language, kind, full_code, full_code_hash, render_code, render_code_hash,
			 move_supported, is_primary, provenance_start_byte, provenance_end_byte, provenance_start_line, provenance_start_col,
			 provenance_end_line, provenance_end_col, version)
			 VALUES ('.', 'doomed.js', 'd', 'javascript', 'declaration', 'function d() {}', 'h', 'function d() {}', 'h', 1, 1, 0, 18, 1, 1, 1, 19, 1)`,
		).run();
	});
	const deleted = materializeFile(store, dir, ".", "doomed.js");
	assert.equal(deleted.status, "deleted");
	assert.equal(fs.existsSync(path.join(dir, "doomed.js")), false, "disk file removed");
	const rows = store.read(() => store.db.prepare(`SELECT COUNT(*) AS c FROM files WHERE file_name = 'doomed.js'`).get()) as { c: number };
	assert.equal(rows.c, 0, "DB rows purged");

	// 3. pending-NULL + missing on disk: skipped, not resurrected.
	store.tx(() => {
		store.db.prepare(
			`INSERT INTO files (file_dir, file_name, language, source_hash, source_text, pending_kind, updated_at)
			 VALUES ('.', 'ghost.js', 'javascript', 'x', 'function g() {}\n', NULL, ?)`,
		).run(now);
	});
	const skipped = materializeFile(store, dir, ".", "ghost.js");
	assert.equal(skipped.status, "skipped-missing");
	assert.equal(fs.existsSync(path.join(dir, "ghost.js")), false, "ghost not resurrected");
});
