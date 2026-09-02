/**
 * Validates the summary batching behavior introduced by the
 * summary-batching plan: bounded requests, batch isolation, error
 * persistence, and oversize singleton handling. Uses a fake completion
 * handle so no real model or network is contacted.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/code-graph/store.ts";
import {
	buildBatches,
	generateSummaries,
	type CompletionHandle,
	type PendingSummary,
} from "../src/code-graph/summary.ts";

function makeEntry(name: string, fullCode: string): PendingSummary {
	return {
		fileDir: "pkg",
		fileName: "math.js",
		functionName: name,
		fullCodeHash: name,
		language: "javascript",
		fullCode,
	};
}

function seedEntries(store: Store, entries: PendingSummary[]): void {
	store.tx(() => {
		const stmt = store.db.prepare(
			`INSERT INTO functions (file_dir, file_name, function_name, language, kind,
				full_code, full_code_hash, render_code, render_code_hash,
				move_supported, is_primary,
				provenance_start_byte, provenance_end_byte, provenance_start_line,
				provenance_start_col, provenance_end_line, provenance_end_col, version)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		);
		for (const entry of entries) {
			stmt.run(
				entry.fileDir,
				entry.fileName,
				entry.functionName,
				entry.language,
				"declaration",
				entry.fullCode,
				entry.fullCodeHash,
				entry.fullCode,
				entry.fullCodeHash,
				1,
				1,
				0,
				entry.fullCode.length,
				1,
				0,
				1,
				0,
				1,
			);
		}
	});
}

async function openTemp(): Promise<{ store: Store; cleanup: () => void } | null> {
	try {
		const sqlite = await import("node:sqlite");
		const worktreeRoot = fs.realpathSync(os.tmpdir());
		const dbPath = path.join(os.tmpdir(), `code-graph-batching-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
		const store = new Store({ dbPath, worktreeRoot, gitCommonDir: worktreeRoot }, sqlite);
		return {
			store,
			cleanup: () => {
				store.close();
				try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
			},
		};
	} catch {
		return null;
	}
}

function allowConsent(): CompletionHandle {
	return {
		complete: async () => ({ content: [{ type: "text", text: "" }] }),
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
}

test("buildBatches splits entries across batches by token budget", () => {
	const small = makeEntry("small", "function small() { return 1; }");
	const medium = makeEntry("medium", "function medium() {\n  // pad\n".repeat(120) + "}");
	const large = makeEntry("large", "// " + "x".repeat(20_000));
	const batches = buildBatches([small, medium, large], 512);
	assert.equal(batches.length >= 2, true);
	const flat = batches.flat();
	assert.equal(flat.length, 3);
	assert.deepEqual(flat.map((entry) => entry.functionName), ["small", "medium", "large"]);
	const largeBatch = batches.find((batch) => batch.some((entry) => entry.functionName === "large"));
	assert.equal(largeBatch?.length, 1, "oversize entry must remain a singleton batch");
});

test("generateSummaries issues multiple completion calls and aggregates counts", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const entries = Array.from({ length: 6 }, (_, i) => makeEntry(`alpha${i}`, `function alpha${i}() { return ${i}; }`));
	seedEntries(store, entries);

	let callCount = 0;
	const seenNames: string[][] = [];
	const handle: CompletionHandle = {
		complete: async (request) => {
			callCount++;
			const names = request.messages[0]?.content.split("\n---\n").map((chunk) => chunk.split("::").pop()?.split("\n")[0] ?? "") ?? [];
			seenNames.push(names);
			const records = names.map((name) => ({
				description: `summarizes ${name}`,
				inputs: ["x"],
				outputs: ["y"],
			}));
			return { content: [{ type: "text", text: records.map((record) => JSON.stringify(record)).join("\n") }] };
		},
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle, batchTokens: 200 });
	assert.equal(report.batches >= 2, true, `expected multiple batches, got ${report.batches}`);
	assert.equal(callCount, report.batches);
	assert.equal(report.processed, 6);
	assert.equal(report.ok, 6);
	assert.equal(report.failed, 0);
	assert.equal(report.declined, 0);
	const flat = seenNames.flat();
	assert.deepEqual(flat, ["alpha0", "alpha1", "alpha2", "alpha3", "alpha4", "alpha5"]);
	const okCount = store.read(() =>
		store.db.prepare("SELECT COUNT(*) AS n FROM functions WHERE summary_status = 'ok'").get(),
	) as { n: number };
	assert.equal(okCount.n, 6);
});

test("generateSummaries isolates a failing batch and continues the rest", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const entries = Array.from({ length: 4 }, (_, i) => makeEntry(`beta${i}`, `function beta${i}() { return ${i}; }`));
	seedEntries(store, entries);

	const notified: string[] = [];
	let callIndex = 0;
	const handle: CompletionHandle = {
		complete: async () => {
			callIndex++;
			if (callIndex === 1) {
				return { content: [{ type: "text", text: "not jsonl" }] };
			}
			const records = entries.slice(2, 4).map((entry) => ({
				description: `summarizes ${entry.functionName}`,
				inputs: ["x"],
				outputs: ["y"],
			}));
			return { content: [{ type: "text", text: records.map((record) => JSON.stringify(record)).join("\n") }] };
		},
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: (message) => { notified.push(message); },
	};
	const report = await generateSummaries({ store, ctx: handle, batchTokens: 100 });
	assert.equal(report.batches >= 2, true);
	assert.equal(callIndex, report.batches);
	assert.equal(report.ok, 2);
	assert.equal(report.failed, 2);
	const failed = store.read(() =>
		store.db.prepare("SELECT function_name, summary_error FROM functions WHERE summary_status = 'failed' ORDER BY function_name").all(),
	) as Array<{ function_name: string; summary_error: string | null }>;
	assert.ok(failed.every((row) => row.summary_error && row.summary_error.length > 0), "every failed row must persist a non-null summary_error");
	const okNames = (store.read(() =>
		store.db.prepare("SELECT function_name FROM functions WHERE summary_status = 'ok' ORDER BY function_name").all(),
	) as Array<{ function_name: string }>).map((row) => row.function_name);
	assert.deepEqual(okNames, ["beta2", "beta3"]);
	assert.ok(notified.some((line) => line.includes("batch 1/")));
	assert.ok(notified.some((line) => line.includes("batch 2/")));
});

test("successful retry clears stale summary_error from prior failure", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const entry = makeEntry("gamma", "function gamma() { return 42; }");
	seedEntries(store, [entry]);
	store.tx(() => {
		store.db.prepare(
			"UPDATE functions SET summary_status='pending', summary_error='boom', summary_updated_at=? WHERE function_name='gamma'",
		).run(new Date().toISOString());
	});
	const handle: CompletionHandle = {
		complete: async () => ({
			content: [{ type: "text", text: JSON.stringify({ description: "ok", inputs: ["a"], outputs: ["b"] }) }],
		}),
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle });
	assert.equal(report.ok, 1);
	const row = store.read(() =>
		store.db.prepare("SELECT summary_status, summary_error FROM functions WHERE function_name='gamma'").get(),
	) as { summary_status: string; summary_error: string | null };
	assert.equal(row.summary_status, "ok");
	assert.equal(row.summary_error, null);
});

test("completion throw marks only the current batch as failed and continues", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const entries = Array.from({ length: 4 }, (_, i) =>
		makeEntry(`delta${i}`, `function delta${i}() { return ${i}; }\n`),
	);
	seedEntries(store, entries);
	let callIndex = 0;
	const batchSizes: number[] = [];
	const handle: CompletionHandle = {
		complete: async (request) => {
			callIndex++;
			const prompt = request.messages[0]?.content ?? "";
			const size = prompt.split("\n---\n").length;
			batchSizes.push(size);
			if (callIndex === 1) throw new Error("provider outage");
			return { content: [{ type: "text", text: JSON.stringify({ description: "ok", inputs: ["a"], outputs: ["b"] }) }] };
		},
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle, batchTokens: 50 });
	assert.equal(report.batches >= 2, true, `expected multiple batches, got ${report.batches}`);
	assert.equal(report.failed, batchSizes[0]);
	assert.equal(report.ok, report.processed - report.failed);
	assert.equal(report.ok + report.failed, entries.length);
	const failed = store.read(() =>
		store.db.prepare("SELECT COUNT(*) AS n FROM functions WHERE summary_status='failed'").get(),
	) as { n: number };
	assert.equal(failed.n, batchSizes[0]);
	const errorRow = store.read(() =>
		store.db.prepare("SELECT summary_error FROM functions WHERE summary_status='failed' LIMIT 1").get(),
	) as { summary_error: string | null };
	assert.equal(errorRow.summary_error, "provider outage");
});

test("summary_error is truncated to the bounded length", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const entry = makeEntry("epsilon", "function epsilon() {}");
	seedEntries(store, [entry]);
	const longMessage = "x".repeat(5_000);
	const handle: CompletionHandle = {
		complete: async () => { throw new Error(longMessage); },
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
	await generateSummaries({ store, ctx: handle, batchTokens: 50 });
	const row = store.read(() =>
		store.db.prepare("SELECT summary_error FROM functions WHERE function_name='epsilon'").get(),
	) as { summary_error: string | null };
	assert.ok(row.summary_error);
	assert.ok(row.summary_error!.length <= 240, `expected <=240, got ${row.summary_error!.length}`);
});

test("oversize entry still produces a singleton batch completion", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	const huge = makeEntry("huge", "// " + "x".repeat(40_000));
	const small = makeEntry("tiny", "function tiny() {}");
	seedEntries(store, [huge, small]);
	const observed: number[] = [];
	const handle: CompletionHandle = {
		complete: async () => {
			observed.push(1);
			return { content: [{ type: "text", text: JSON.stringify({ description: "ok", inputs: ["a"], outputs: ["b"] }) }] };
		},
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle, batchTokens: 200 });
	assert.equal(report.batches, 2);
	assert.equal(report.ok, 2);
	assert.deepEqual(observed, [1, 1]);
});

test("declined consent still short-circuits before batching", async (t) => {
	const opened = await openTemp();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { store } = opened;
	seedEntries(store, [makeEntry("zeta", "function zeta() {}")]);
	let completeCalled = false;
	const handle: CompletionHandle = {
		complete: async () => { completeCalled = true; return { content: [{ type: "text", text: "" }] }; },
		model: () => ({ provider: "test", id: "test-model", api: "openai-completions", reasoning: false }),
		thinkingLevel: () => "low",
		hasUI: true,
		confirm: async () => false,
		notify: () => {},
	};
	const report = await generateSummaries({ store, ctx: handle });
	assert.equal(report.declined, 1);
	assert.equal(completeCalled, false);
	const row = store.read(() =>
		store.db.prepare("SELECT summary_status FROM functions WHERE function_name='zeta'").get(),
	) as { summary_status: string };
	assert.equal(row.summary_status, "declined");
});
