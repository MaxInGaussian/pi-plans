/** Tests for the agent-invokable code_graph "apply" action and its gates. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { test } from "node:test";
import { Store } from "../src/code-graph/store.ts";
import { runIndex } from "../src/code-graph/indexer.ts";
import { applyGraphCore } from "../src/code-graph/commands.ts";
import { updateFile } from "../src/code-graph/mutations.ts";
import { makeBackend } from "../src/code-graph/parsers/javascript.ts";
import { PythonBackend } from "../src/code-graph/parsers/python.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import type { ParserBackend } from "../src/code-graph/parser.ts";
import type { Language } from "../src/code-graph/types.ts";
import { initState, setRunStatus, startRun } from "../src/state.ts";
import { registerCodeGraphTool } from "../tools/code-graph.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function git(cwd: string, args: string[]): void {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
}

async function setupIndexedRepo(): Promise<{ root: string; store: Store; cleanup: () => void } | null> {
	const runtime = await loadGraphRuntime();
	if (!runtime.status.parserAvailable || !runtime.status.sqliteAvailable) return null;

	const raw = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-apply-action-"));
	git(raw, ["init", "--initial-branch=main"]);
	git(raw, ["config", "user.email", "test@example.com"]);
	git(raw, ["config", "user.name", "test"]);
	fs.writeFileSync(path.join(raw, "math.js"), "function add(a, b) { return a + b; }\n");
	git(raw, ["add", "-A"]);
	git(raw, ["commit", "-m", "init"]);
	const root = fs.realpathSync(raw);

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
	fs.mkdirSync(path.join(root, ".git", "pi_plans"), { recursive: true });
	const store = new Store(
		{ dbPath: path.join(root, ".git", "pi_plans", "code_graph.db"), worktreeRoot: root, gitCommonDir: path.join(root, ".git") },
		runtime.runtime.sqlite,
	);
	runIndex({ store, worktreeRoot: root, parsers, reindex: false });
	return {
		root,
		store,
		cleanup: () => {
			store.close();
			try {
				fs.rmSync(raw, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}

test("applyGraphCore refuses during planning runs and allows once executing or done", async (t) => {
	const opened = await setupIndexedRepo();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { root } = opened;

	initState(root);
	const { run } = startRun(root, { topic: "apply-gate", skill: "plan-small", requestText: "x" });

	const planning = await applyGraphCore(root);
	assert.match(planning.refused ?? "", /planning run is currently planning or accepted/);
	assert.equal(planning.report, undefined);

	setRunStatus(root, run.run_id, "executing");
	const mathBefore = fs.readFileSync(path.join(root, "math.js"), "utf8");
	const allowed = await applyGraphCore(root);
	assert.equal(allowed.refused, undefined);
	assert.ok(allowed.report, "expected a report once allowed");
	assert.ok(allowed.drift, "expected a drift summary once allowed");
	// Safe no-op with no pending staged edits: disk untouched, nothing stale or errored.
	assert.equal(fs.readFileSync(path.join(root, "math.js"), "utf8"), mathBefore);
	const noPendingCounts: Record<string, number> = { ok: 0, deleted: 0, stale: 0, "skipped-missing": 0, error: 0 };
	for (const file of allowed.report!.files) noPendingCounts[file.status] = (noPendingCounts[file.status] ?? 0) + 1;
	assert.equal(noPendingCounts.stale, 0);
	assert.equal(noPendingCounts.error, 0);

	setRunStatus(root, run.run_id, "done");
	const doneAllowed = await applyGraphCore(root);
	assert.equal(doneAllowed.refused, undefined);
	assert.ok(doneAllowed.report, "done runs must still be allowed");
});

test("applyGraphCore materializes pending DB edits and reports counts plus drift", async (t) => {
	const opened = await setupIndexedRepo();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { root, store } = opened;
	initState(root); // no active run → allowed

	const next = "function add(a, b) { return a + b + 1; }\n";
	const mutation = updateFile(store, { fileDir: ".", fileName: "math.js", text: next });
	assert.equal(mutation.ok, true);
	// Disk still has the original content before apply.
	assert.equal(fs.readFileSync(path.join(root, "math.js"), "utf8"), "function add(a, b) { return a + b; }\n");

	const core = await applyGraphCore(root);
	assert.equal(core.refused, undefined);
	assert.ok(core.report);
	const counts: Record<string, number> = { ok: 0, deleted: 0, stale: 0, "skipped-missing": 0, error: 0 };
	for (const file of core.report.files) counts[file.status] = (counts[file.status] ?? 0) + 1;
	assert.ok(counts.ok >= 1, "at least the staged file must materialize");
	assert.equal(fs.readFileSync(path.join(root, "math.js"), "utf8"), next);
	assert.ok(core.drift);
	assert.equal(core.drift.pending, 0);
	assert.equal(core.drift.ok, true);
});

test("code_graph tool apply action: refiner env refuses, planning gate holds, wiring present", async (t) => {
	const source = fs.readFileSync(path.join(ROOT, "tools", "code-graph.ts"), "utf8");
	assert.match(source, /"apply"/);
	assert.match(source, /PI_PLANS_REFINER/);
	assert.match(source, /applyGraphCore/);

	const opened = await setupIndexedRepo();
	if (!opened) return;
	t.after(() => opened.cleanup());
	const { root } = opened;
	initState(root);
	const { run } = startRun(root, { topic: "apply-tool", skill: "plan-small", requestText: "x" });

	let captured: {
		execute: (id: string, params: any, signal: unknown, onUpdate: unknown, ctx: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
	} | undefined;
	registerCodeGraphTool({
		registerTool: (definition: never) => {
			captured = definition as typeof captured;
		},
	} as never);
	assert.ok(captured, "registerTool was not called");

	// Refiner marker refuses before any run-state lookup.
	const previous = process.env.PI_PLANS_REFINER;
	process.env.PI_PLANS_REFINER = "1";
	try {
		const refused = await captured!.execute("c1", { action: "apply", workdir: root }, undefined, undefined, { cwd: root });
		const payload = JSON.parse(refused.content[0]!.text) as { ok: boolean; reason: string };
		assert.equal(payload.ok, false);
		assert.match(payload.reason, /PI_PLANS_REFINER/);
	} finally {
		if (previous === undefined) delete process.env.PI_PLANS_REFINER;
		else process.env.PI_PLANS_REFINER = previous;
	}

	// Planning run (without the marker) is refused by the run-state gate.
	setRunStatus(root, run.run_id, "planning");
	const gateRefused = await captured!.execute("c2", { action: "apply", workdir: root }, undefined, undefined, { cwd: root });
	const gatePayload = JSON.parse(gateRefused.content[0]!.text) as { ok: boolean; reason: string };
	assert.equal(gatePayload.ok, false);
	assert.match(gatePayload.reason, /planning run is currently planning or accepted/);
});
