/** Tests for the analyze_refs tool: gates, batching, records, failure contract. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { after, before, describe, it } from "node:test";
import { registerAnalyzeRefsTool } from "../tools/analyze-refs.ts";
import { initState, setRole, setLanguage, startRun, readActive } from "../src/state.ts";
import { fleet } from "../src/agent-fleet.ts";
import { fleetUi } from "../src/fleet-ui.ts";
import { fakeModelRegistry, installFakeAgents } from "./fake-agent-session.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

let tmpRoot: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-analyze-refs-"));
	// Isolate the global reviewer config (F-002): never touch ~/.pi/pi-plans.
	previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-analyze-refs-"));
	process.env.PI_PLANS_GLOBAL_DIR = globalDir;
});

after(() => {
	if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
	else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});

function mkWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
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
	return { cwd: workdir, modelRegistry: fakeModelRegistry };
}

/** TUI-mode ctx whose fake ui captures the fleet widget factory. */
function tuiCtx(workdir: string, widgets: Array<(width: number) => string[]>): unknown {
	const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
	return {
		cwd: workdir,
		mode: "tui",
		hasUI: true,
		modelRegistry: fakeModelRegistry,
		ui: {
			setWidget: (_key: string, content: unknown) => {
				if (typeof content !== "function") return;
				const component = (content as (tui: unknown, theme: unknown) => { render(w: number): string[] })({ requestRender() {} }, theme);
				widgets.push((width) => component.render(width));
			},
			onTerminalInput: () => () => undefined,
			getEditorText: () => "",
			custom: async () => undefined,
			setStatus: () => {},
			notify: () => {},
		},
	};
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

	it("refuses with embedded text guidance when the reviewer model is unconfirmed (headless)", async () => {
		const workdir = mkWorkdir("gates-unconfirmed");
		initState(workdir);
		const tool = loadTool();
		await assert.rejects(
			tool.execute("c1", { refs: [{ id: "ref-1", localPath: "." }] }, undefined, undefined, headlessCtx(workdir)),
			/model was never confirmed/,
		);
	});

	it("ignores the reviewer mode entirely (Q-4=B): current-session proceeds once a model is confirmed", async () => {
		const workdir = mkWorkdir("gates-current-session");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "current-session", modelSelector: "fake/model", confirmed: true });
		const refDir = path.join(workdir, "refs", "solo");
		fs.mkdirSync(refDir, { recursive: true });
		const restore = installFakeAgents(() => "OK");
		const tool = loadTool();
		try {
			const result = await tool.execute("c1", { refs: [{ id: "ref-1", localPath: refDir }] }, undefined, undefined, headlessCtx(workdir));
			assert.match(result.content[0]!.text, /mode is current-session, but analyze_refs always spawns/);
			assert.match(result.content[0]!.text, /OK/);
		} finally {
			restore();
		}
	});

	it("requires a confirmed model even in current-session mode (analysis always spawns)", async () => {
		const workdir = mkWorkdir("gates-current-session-unconfirmed");
		initState(workdir);
		// 'inherit' fully resets selector AND confirmation — the prior test's
		// confirmed selector must not carry over (the global config is shared).
		setRole(workdir, { role: "reviewer", mode: "current-session", modelSelector: "inherit" });
		const tool = loadTool();
		await assert.rejects(
			tool.execute("c1", { refs: [{ id: "ref-1", localPath: "." }] }, undefined, undefined, headlessCtx(workdir)),
			/model was never confirmed/,
		);
	});
});

describe("analyze_refs subagent list chrome language (issue #3)", () => {
	it("the subagent list follows the chrome language (D-010)", async () => {
		const refDir = path.join(tmpRoot, "overlay-lang-ref");
		fs.mkdirSync(refDir, { recursive: true });
		const restore = installFakeAgents(() => "OK");
		const tool = loadTool();
		try {
			for (const [tag, expected] of [
				["zh-Hans", "↓ 浏览子代理"],
				["en", "↓ browse subagents"],
			] as const) {
				fleetUi.detach();
				fleet.clear();
				const workdir = mkWorkdir(`overlay-lang-${tag}`);
				initState(workdir);
				setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
				setLanguage(workdir, tag, "user");
				const widgets: Array<(width: number) => string[]> = [];
				await tool.execute("c1", { refs: [{ id: "ref-1", localPath: refDir }] }, undefined, undefined, tuiCtx(workdir, widgets));
				assert.equal(widgets.length, 1, "the list must register one widget");
				const lines = widgets[0]!(120);
				assert.ok(lines.some((line) => line.includes(expected)), `expected "${expected}" in the list for tag ${tag}: ${JSON.stringify(lines)}`);
				assert.ok(lines.some((line) => line.includes("ref-1")), "one bullet per reference");
			}
		} finally {
			restore();
			fleetUi.detach();
			fleet.clear();
		}
	});
});

describe("analyze_refs fanout", () => {
	it("spawns one lane per ref (at most 3 at once), records spawns, and returns sections", async () => {
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

		const restore = installFakeAgents(({ cwd, prompt }) => `ANALYSIS from ${path.basename(cwd)}\n${prompt}`);
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
			assert.equal(result.details.batches, 2, "five refs at a concurrency of three");
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

		const restore = installFakeAgents(() => "OK analysis");
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

	it("queues references beyond the concurrency cap as queued bullets", async () => {
		const workdir = mkWorkdir("fanout-queue");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
		const refs = [1, 2, 3, 4, 5].map((n) => {
			const dir = path.join(workdir, "refs", `queue-${n}`);
			fs.mkdirSync(dir, { recursive: true });
			return { id: `ref-${n}`, localPath: dir };
		});
		let inFlight = 0;
		let peak = 0;
		const statusesAtPeak: string[][] = [];
		const restore = installFakeAgents(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			if (inFlight === 3) statusesAtPeak.push(fleet.list().map((entry) => entry.lane.status));
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return "ok";
		});
		const tool = loadTool();
		try {
			fleet.clear();
			await tool.execute("c1", { refs }, undefined, undefined, headlessCtx(workdir));
			assert.equal(peak, 3, "never more than three lanes at once");
			assert.ok(statusesAtPeak[0]!.includes("queued"), "lanes beyond the cap stay queued in the fleet");
		} finally {
			restore();
			fleet.clear();
		}
	});

	it("skips recording without an active run (adhoc) and still succeeds", async () => {
		const workdir = mkWorkdir("adhoc");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/model", confirmed: true });
		const refDir = path.join(workdir, "refs", "solo");
		fs.mkdirSync(refDir, { recursive: true });

		const restore = installFakeAgents(() => "adhoc analysis");
		const tool = loadTool();
		try {
			const result = await tool.execute("c1", { refs: [{ id: "ref-1", localPath: refDir }] }, undefined, undefined, headlessCtx(workdir));
			assert.match(result.content[0]!.text, /### pi-plans-refs-adhoc-ref-1/);
			assert.equal(readActive(workdir), null);
			const ledger = path.join(workdir, ".git", "pi-plans", "runs");
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
