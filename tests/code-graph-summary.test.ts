/**
 * Validates summary record validation and cache behavior. Does not require
 * a real model — uses a fake completion handle.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/code-graph/store.ts";
import {
	generateSummaries,
	type CompletionHandle,
	clearSummaryCache,
	summaryCacheStats,
} from "../src/code-graph/summary.ts";

async function openTemp(): Promise<{ store: Store; cleanup: () => void } | null> {
	try {
		const sqlite = await import("node:sqlite");
		const worktreeRoot = fs.realpathSync(os.tmpdir());
		const dbPath = path.join(os.tmpdir(), `code-graph-summary-${process.pid}-${Date.now()}.db`);
		const store = new Store({ dbPath, worktreeRoot, gitCommonDir: worktreeRoot }, sqlite);
		return { store, cleanup: () => {
			store.close();
			try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
		} };
	} catch {
		return null;
	}
}

function seedFunction(store: Store): void {
	store.tx(() => {
		store.db
			.prepare(
				`INSERT INTO functions (file_dir, file_name, function_name, language, kind,
					full_code, full_code_hash, render_code, render_code_hash,
					move_supported, is_primary,
					provenance_start_byte, provenance_end_byte, provenance_start_line,
					provenance_start_col, provenance_end_line, provenance_end_col, version)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				"src",
				"a.js",
				"alpha",
				"javascript",
				"declaration",
				"function alpha() { return 1; }",
				"deadbeef",
				"function alpha() { return 1; }",
				"deadbeef",
				1,
				1,
				0,
				25,
				1,
				0,
				1,
				0,
				1,
			);
	});
}

test("generateSummaries writes ok status and validates schema", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	clearSummaryCache();
	seedFunction(store);
	const handle: CompletionHandle = {
		complete: async () => ({
			content: [{ type: "text", text: '{"description":"adds two numbers","inputs":["a: number","b: number"],"outputs":["number"]}' }],
			stopReason: "stop",
		}),
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: true }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle });
	assert.equal(report.ok, 1);
	assert.equal(report.failed, 0);
	const row = store.read(() => store.db.prepare("SELECT summary_status, summary_inputs FROM functions WHERE function_name='alpha'").get()) as { summary_status: string; summary_inputs: string };
	assert.equal(row.summary_status, "ok");
	assert.equal(JSON.parse(row.summary_inputs)[0], "a: number");
});

test("declined consent marks summaries as declined without sending source", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	clearSummaryCache();
	seedFunction(store);
	let sendCalled = false;
	const handle: CompletionHandle = {
		complete: async () => {
			sendCalled = true;
			return { content: [{ type: "text", text: "" }] };
		},
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => false,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle });
	assert.equal(report.declined, 1);
	assert.equal(sendCalled, false);
	const row = store.read(() => store.db.prepare("SELECT summary_status FROM functions WHERE function_name='alpha'").get()) as { summary_status: string };
	assert.equal(row.summary_status, "declined");
});

test("headless consent auto-declines", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	clearSummaryCache();
	seedFunction(store);
	let sendCalled = false;
	const handle: CompletionHandle = {
		complete: async () => {
			sendCalled = true;
			return { content: [{ type: "text", text: "" }] };
		},
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: false,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle });
	assert.equal(report.declined, 1);
	assert.equal(sendCalled, false);
	const row = store.read(() => store.db.prepare("SELECT summary_status FROM functions WHERE function_name='alpha'").get()) as { summary_status: string };
	assert.equal(row.summary_status, "declined");
});

test("summary cache stats are non-negative", () => {
	clearSummaryCache();
	assert.equal(summaryCacheStats().size, 0);
});
