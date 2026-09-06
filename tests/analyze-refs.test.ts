/** Tests for the analyze_refs tool: gates, batching, records, failure contract. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { after, before, describe, it } from "node:test";
import { registerAnalyzeRefsTool } from "../tools/analyze-refs.ts";
import { initState, setRole, startRun, readActive } from "../src/state.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-analyze-refs-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function fakePiScript(body: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-fake-pi-"));
	const script = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		script,
		[
			'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
			'emit({ type: "turn_start" });',
			`async function main() { ${body} }`,
			"await main();",
		].join("\n"),
	);
	return script;
}

function withFakePi(scriptPath: string): () => void {
	const previousScript = process.argv[1];
	process.argv[1] = scriptPath;
	return () => {
		process.argv[1] = previousScript;
	};
}

interface CapturedTool {
	execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function loadTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool: (definition: unknown) => {
			captured = definition as CapturedTool;
		},
	};
	registerAnalyzeRefsTool(pi as any, ROOT);
	assert.ok(captured, "registerTool was not called");
	return captured!;
}

function headlessCtx(workdir: string): unknown {
	return { cwd: workdir };
}

function subagentLines(workdir: string): Array<any> {
	const active = readActive(workdir);
	assert.ok(active, "expected an active run");
	const file = path.join(active.run_dir, "subagents.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("analyze_refs gates", () => {
	it("refuses when no pi-plans state exists", async () => {
		const workdir = mkWorkdir("gates-no-state");
		const tool = loadTool();
		await assert.rejects(
			tool.execute("c1", { refs: [{ id: "ref-1", localPath: "." }] }, undefined, undefined, headlessCtx(workdir)),
			/no pi-plans state found/,
		);
	});

	it("refuses with role-setting guidance when reviewer mode is invalid", async () => {
		const workdir = mkWorkdir("gates-bad-mode");
		initState(workdir);
		const configPath = path.join(workdir, ".git", "pi_plans", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.reviewer.mode = "bogus";
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		const tool = loadTool();
		await assert.rejects(
			tool.execute("c1", { refs: [{ id: "ref-1", localPath: "." }] }, undefined, undefined, headlessCtx(workdir)),
			/reviewer role mode is missing or invalid/,
		);
	});

	it("refuses current-session reviewer mode with a switch-to-delegated message", async () => {
		const workdir = mkWorkdir("gates-current-session");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "current-session" });
		const tool = loadTool();
		await assert.rejects(
			tool.execute("c1", { refs: [{ id: "ref-1", localPath: "." }] }, undefined, undefined, headlessCtx(workdir)),
			/current-session.*delegated-subagent/s,
		);
	});

	it("refuses with confirmation guidance when the reviewer model is unconfirmed", async () => {
		const workdir = mkWorkdir("gates-unconfirmed");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent" });
		const tool = loadTool();
		await assert.rejects(
			tool.execute("c1", { refs: [{ id: "ref-1", localPath: "." }] }, undefined, undefined, headlessCtx(workdir)),
			/model was never confirmed/,
		);
	});
});

describe("analyze_refs fanout", () => {
	it("spawns one lane per ref in batches of at most 3, records spawns, and returns sections", async () => {
		const workdir = mkWorkdir("fanout");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
		startRun(workdir, { topic: "refs", skill: "plan-with-refs", requestText: "x" });

		const refs = [1, 2, 3, 4, 5].map((n) => {
			const dir = path.join(workdir, `refs`, `repo-${n}`);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "README.md"), `ref ${n}`);
			return { id: `ref-${n}`, localPath: dir, title: `Ref ${n}`, url: "https://example.com", kind: "project" };
		});

		const restore = withFakePi(
			fakePiScript(
				`const task = process.argv.filter((arg) => arg.startsWith("Task: ")).pop() ?? "";\n` +
					`emit({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: "ANALYSIS from " + process.cwd().split("/").pop() + "\\n" + task }] } });`,
			),
		);
		const tool = loadTool();
		try {
			const result = await tool.execute("c1", { refs, context: "pi-plans repo" }, undefined, undefined, headlessCtx(workdir));
			const text = result.content[0]!.text;
			for (let n = 1; n <= 5; n += 1) {
				assert.ok(text.includes(`### pi-plans-refs-`), "missing section header");
				assert.ok(text.includes(`ANALYSIS from repo-${n}`), `missing per-ref cwd output for repo-${n}`);
				assert.ok(text.includes(`Reference id: ref-${n}`), `brief must carry the ref id for repo-${n}`);
			}
			assert.ok(text.includes("Target repo context: pi-plans repo"), "brief must carry the target repo context");
			assert.ok(text.includes("## Evidence Gaps"), "brief must carry the seven-section contract");
			assert.match(text, /Persist: paste each reference's analysis into REF_ANALYSIS\.md/);
			assert.equal(result.details.batches, 2, "five refs must run as two batches");
			assert.equal(result.details.role, "ref-analyst");

			const spawns = subagentLines(workdir);
			assert.equal(spawns.length, 5);
			assert.ok(spawns.every((spawn: any) => spawn.role === "ref-analyst"));
			assert.equal(spawns[0].model, "fake/model");
			const names = spawns.map((spawn: any) => spawn.name).sort();
			for (let n = 1; n <= 5; n += 1) {
				assert.ok(names.some((name: string) => name.endsWith(`-ref-${n}`)), `missing spawn name ref-${n}`);
			}
		} finally {
			restore();
		}
	});

	it("section-fails missing ref directories without aborting the rest", async () => {
		const workdir = mkWorkdir("fanout-missing");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
		startRun(workdir, { topic: "refs-missing", skill: "plan-with-refs", requestText: "x" });

		const good = path.join(workdir, "refs", "good");
		fs.mkdirSync(good, { recursive: true });
		const refs = [
			{ id: "ref-1", localPath: path.join(workdir, "refs", "does-not-exist") },
			{ id: "ref-2", localPath: good },
		];

		const restore = withFakePi(
			fakePiScript(
				`emit({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: "OK analysis" }] } });`,
			),
		);
		const tool = loadTool();
		try {
			const result = await tool.execute("c1", { refs }, undefined, undefined, headlessCtx(workdir));
			const text = result.content[0]!.text;
			assert.match(text, /ref-1[^\n]*— FAILED\nreference directory not found:/);
			assert.match(text, /OK analysis/);
			const failed = result.details.outputs.find((output: any) => output.refId === "ref-1");
			assert.equal(failed.ok, false);
		} finally {
			restore();
		}
	});

	it("throws when every ref fails", async () => {
		const workdir = mkWorkdir("fanout-all-failed");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
		const tool = loadTool();
		await assert.rejects(
			tool.execute(
				"c1",
				{ refs: [{ id: "ref-1", localPath: path.join(workdir, "missing-a") }, { id: "ref-2", localPath: path.join(workdir, "missing-b") }] },
				undefined,
				undefined,
				headlessCtx(workdir),
			),
			/all reference analysis subagents failed/,
		);
	});

	it("pins the per-batch overlay lifecycle (open before spawn, close in finally, cap 3)", () => {
		const source = fs.readFileSync(path.join(ROOT, "tools", "analyze-refs.ts"), "utf8");
		assert.equal((source.match(/new RefineOverlayController\("refs"/g) ?? []).length, 1, "controller must be constructed per batch inside the loop");
		assert.match(source, /overlay\?\.open\(refineOverlayContext\(ctx\), modelLabel\)/);
		assert.match(source, /await overlay\?\.close\(\);/);
		assert.match(source, /const BATCH_SIZE = 3;/);
		assert.ok(source.indexOf("overlay?.open(") < source.indexOf("await overlay?.close();"), "open must precede close");
	});

	it("skips recording without an active run (adhoc) and still succeeds", async () => {
		const workdir = mkWorkdir("adhoc");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
		const refDir = path.join(workdir, "refs", "solo");
		fs.mkdirSync(refDir, { recursive: true });

		const restore = withFakePi(
			fakePiScript(
				`emit({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: "adhoc analysis" }] } });`,
			),
		);
		const tool = loadTool();
		try {
			const result = await tool.execute("c1", { refs: [{ id: "ref-1", localPath: refDir }] }, undefined, undefined, headlessCtx(workdir));
			assert.match(result.content[0]!.text, /### pi-plans-refs-adhoc-ref-1/);
			assert.equal(readActive(workdir), null);
			const ledger = path.join(workdir, ".git", "pi_plans", "runs");
			const runs = fs.existsSync(ledger) ? fs.readdirSync(ledger) : [];
			const spawnFiles = runs.flatMap((run) =>
				fs.existsSync(path.join(ledger, run, "subagents.jsonl")) ? [fs.readFileSync(path.join(ledger, run, "subagents.jsonl"), "utf8")] : [],
			);
			assert.equal(spawnFiles.join("").trim(), "", "adhoc calls must not record spawns");
		} finally {
			restore();
		}
	});
});
