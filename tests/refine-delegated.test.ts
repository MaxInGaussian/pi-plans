/**
 * The delegated spawn path of `refine`: reviewers run as in-process sessions
 * registered in the fleet. (Regression: a call-site argument mix-up made every
 * delegated round crash with `spec.lanes.map is not a function`.)
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fleet } from "../src/agent-fleet.ts";
import { __setSessionFactoryForTests } from "../src/agent-session.ts";
import { fleetUi } from "../src/fleet-ui.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { initState, readActive, setRole, startRun } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint, recordLaneOutcome, startReviewRound } from "../src/workflow-state.ts";
import { registerRefineTool } from "../tools/refine.ts";
import { FakeSession } from "./fake-agent-session.ts";
import { fakeModelRegistry, installFakeAgents } from "./fake-agent-session.ts";

const BASE_DIR = path.resolve(import.meta.dirname, "..");

let tmpRoot = "";
let globalDir = "";
let previousGlobalDir: string | undefined;
let counter = 0;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-refine-delegated-"));
	previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-refine-delegated-"));
	process.env.PI_PLANS_GLOBAL_DIR = globalDir;
});

after(() => {
	if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
	else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
	fs.rmSync(globalDir, { recursive: true, force: true });
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
	__setSessionFactoryForTests(null);
	fleetUi.detach();
	fleet.clear();
});

interface Tool {
	execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function loadTool(): Tool {
	let captured: Tool | undefined;
	registerRefineTool({ registerTool: (definition: unknown) => void (captured = definition as Tool) } as never, BASE_DIR);
	assert.ok(captured, "refine tool registered");
	return captured!;
}

function setup(): { workdir: string; runId: string; planPath: string } {
	counter += 1;
	const workdir = path.join(tmpRoot, `repo-${counter}`);
	fs.mkdirSync(workdir, { recursive: true });
	spawnSync("git", ["init"], { cwd: workdir });
	initState(workdir);
	setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "fake/reviewer", thinkingLevel: "high", confirmed: true });
	const { run } = startRun(workdir, { topic: `d${counter}`, skill: "plan-big", requestText: "t" });
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
	fs.writeFileSync(planPath, "# plan\n\nTask: do the thing.\n", "utf8");
	setMessagingApi({ appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: async () => {} });
	return { workdir, runId: run.run_id, planPath };
}

const headlessCtx = (workdir: string) => ({
	cwd: workdir,
	sessionManager: {},
	model: null,
	mode: "print",
	hasUI: false,
	modelRegistry: fakeModelRegistry,
	ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
});

function tuiCtx(workdir: string, widgets: Array<(width: number) => string[]>) {
	const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
	return {
		...headlessCtx(workdir),
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme,
			setWidget: (_key: string, content: unknown) => {
				if (typeof content !== "function") return;
				const component = (content as (tui: unknown, theme: unknown) => { render(w: number): string[] })({ requestRender() {} }, theme);
				widgets.push((width) => component.render(width));
			},
			onTerminalInput: () => () => undefined,
			getEditorText: () => "",
			custom: async () => undefined,
		},
	};
}

/** The lens id a brief was written for ("general" when it carries none). */
function laneOf(prompt: string): string {
	if (prompt.includes("requirements fit")) return "correctness";
	if (prompt.includes("architecture, sequencing")) return "ordering";
	if (prompt.includes("verification rigor")) return "verification";
	return "general";
}

function spawnLedger(workdir: string): Array<{ role: string; name: string; model: string; thinking_level: string | null }> {
	const active = readActive(workdir);
	const file = active ? path.join(active.run_dir, "subagents.jsonl") : "";
	if (!file || !fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("refine: delegated reviewers", () => {
	it("reviewers: 3 runs one in-process session per lens and returns three sections", async () => {
		const { workdir, runId, planPath } = setup();
		const seen: Array<{ lane: string; model: unknown; thinking: unknown; tools: unknown }> = [];
		const restore = installFakeAgents(({ prompt, options }) => {
			const lane = laneOf(prompt);
			seen.push({ lane, model: options.model, thinking: options.thinkingLevel, tools: options.tools });
			return `## Findings\nNone from ${lane}.\n\n## Questions\nNone.`;
		});
		try {
			const result = await loadTool().execute("t1", { planPath, reviewers: 3 }, undefined, undefined, headlessCtx(workdir));
			const text = result.content[0]!.text;
			for (const lane of ["correctness", "ordering", "verification"]) {
				assert.match(text, new RegExp(`None from ${lane}\\.`), `section for ${lane}`);
			}
			assert.equal((text.match(/^### /gm) ?? []).length, 3, "three reviewer sections");
			assert.doesNotMatch(text, /FAILED/);
			assert.deepEqual(seen.map((entry) => entry.lane).sort(), ["correctness", "ordering", "verification"], "each lane got its own lens brief");
			for (const entry of seen) {
				assert.deepEqual(entry.model, { provider: "fake", id: "reviewer" });
				assert.equal(entry.thinking, "high");
				assert.deepEqual(entry.tools, ["read", "grep", "find", "ls"]);
			}
			assert.equal(result.details.reviewers, 3);
			assert.deepEqual(result.details.outputs.map((output: { ok: boolean }) => output.ok), [true, true, true]);
			assert.deepEqual(spawnLedger(workdir).map((entry) => entry.role), ["reviewer", "reviewer", "reviewer"]);
			const checkpoint = loadCheckpoint(workdir, runId);
			assert.ok(checkpoint.status === "ok");
			assert.deepEqual(checkpoint.checkpoint.reviewRounds.at(-1)?.lanes.map((lane) => lane.status), ["complete", "complete", "complete"]);
		} finally {
			restore();
		}
	});

	it("registers one fleet entry per reviewer lane and shows them as bullets in a TUI", async () => {
		const { workdir, planPath } = setup();
		const widgets: Array<(width: number) => string[]> = [];
		const restore = installFakeAgents(() => "## Findings\nNone.\n\n## Questions\nNone.");
		try {
			await loadTool().execute("t1", { planPath, reviewers: 3 }, undefined, undefined, tuiCtx(workdir, widgets));
			const entries = fleet.list().filter((entry) => entry.role === "reviewer");
			assert.deepEqual(entries.map((entry) => entry.laneId), ["correctness", "ordering", "verification"]);
			assert.ok(entries.every((entry) => entry.lane.status === "complete"), "every finished lane stays listed as done");
			assert.ok(entries.every((entry) => entry.modelLabel?.includes("fake/reviewer")), "the model label reaches the list");
			assert.equal(widgets.length, 1, "one fleet widget");
			const lines = widgets[0]!(120);
			assert.equal(lines.filter((line) => line.startsWith("•")).length, 3, "three bullets");
			assert.ok(lines.some((line) => line.includes("correctness")));
		} finally {
			restore();
		}
	});

	it("reviewers: 1 uses the general lane", async () => {
		const { workdir, planPath } = setup();
		const lanes: string[] = [];
		const restore = installFakeAgents(({ prompt }) => {
			lanes.push(laneOf(prompt));
			return "## Findings\nNone.\n\n## Questions\nNone.";
		});
		try {
			const result = await loadTool().execute("t1", { planPath }, undefined, undefined, headlessCtx(workdir));
			assert.deepEqual(lanes, ["general"]);
			assert.equal(result.details.outputs.length, 1);
		} finally {
			restore();
		}
	});

	it("a failed lane becomes a FAILED section while the others still return", async () => {
		const { workdir, planPath } = setup();
		__setSessionFactoryForTests(async (options) => ({
			session: new FakeSession(async (api) => {
				if (laneOf(api.prompt) === "ordering") throw new Error("provider exploded");
				api.say(`ok from ${laneOf(api.prompt)} (${String(options.cwd).length > 0})`);
			}),
		}));
		const result = await loadTool().execute("t1", { planPath, reviewers: 3 }, undefined, undefined, headlessCtx(workdir));
		const text = result.content[0]!.text;
		assert.match(text, /— FAILED\nprovider exploded/);
		assert.match(text, /ok from correctness/);
		assert.match(text, /ok from verification/);
		assert.deepEqual(result.details.outputs.map((output: { ok: boolean }) => output.ok), [true, false, true]);
		assert.equal(fleet.list().find((entry) => entry.laneId === "ordering")?.lane.status, "failed");
	});

	it("throws when every reviewer fails", async () => {
		const { workdir, planPath } = setup();
		__setSessionFactoryForTests(async () => ({
			session: new FakeSession(() => {
				throw new Error("no capacity");
			}),
		}));
		await assert.rejects(
			loadTool().execute("t1", { planPath, reviewers: 2 }, undefined, undefined, headlessCtx(workdir)),
			/all reviewer subagents failed: no capacity/,
		);
	});

	it("resuming a round runs only the lanes that are not complete and reuses the rest", async () => {
		const { workdir, runId, planPath } = setup();
		const roundId = "plan-reviewer-resume";
		startReviewRound(workdir, runId, {
			roundId,
			role: "reviewer",
			target: "plan",
			reviewers: 3,
			planPath,
			lanes: [
				{ laneId: "correctness", lens: "requirements fit and correctness of claims against the repository" },
				{ laneId: "ordering", lens: "architecture, sequencing, and dependency ordering" },
				{ laneId: "verification", lens: "verification rigor, risks, and evidence gaps" },
			],
		});
		recordLaneOutcome(workdir, runId, roundId, "correctness", { ok: true, output: "PERSISTED correctness output" });
		const lanes: string[] = [];
		const restore = installFakeAgents(({ prompt }) => {
			lanes.push(laneOf(prompt));
			return `fresh output for ${laneOf(prompt)}`;
		});
		try {
			const result = await loadTool().execute("t1", { planPath, reviewers: 3, resumeRoundId: roundId }, undefined, undefined, headlessCtx(workdir));
			assert.deepEqual(lanes.sort(), ["ordering", "verification"], "the completed lane is not re-run");
			assert.deepEqual(fleet.list().map((entry) => entry.laneId).sort(), ["ordering", "verification"], "only the runnable lanes enter the list");
			const text = result.content[0]!.text;
			assert.match(text, /REUSED \(round plan-reviewer-resume, no re-run\)\nPERSISTED correctness output/);
			assert.match(text, /fresh output for ordering/);
			assert.deepEqual(result.details.reusedLanes, ["correctness"]);
		} finally {
			restore();
		}
	});

	it("an aborted tool call cancels the reviewer sessions instead of leaving them running", async () => {
		const { workdir, planPath } = setup();
		const controller = new AbortController();
		__setSessionFactoryForTests(async () => ({
			session: new FakeSession(async (api) => {
				await api.aborted;
			}),
		}));
		const pending = loadTool().execute("t1", { planPath, reviewers: 2 }, controller.signal, undefined, headlessCtx(workdir));
		setTimeout(() => controller.abort(), 30);
		await assert.rejects(pending, /all reviewer subagents failed/);
		assert.ok(fleet.list().every((entry) => entry.lane.status === "cancelled"), "aborted lanes end as cancelled");
	});
});
