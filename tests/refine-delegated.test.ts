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

const DIRECTIONS = [
	{ id: "state-transitions", direction: "Probe how the plan changes persisted run state and what a half-applied or interrupted change leaves behind." },
	{ id: "blast-radius", direction: "Find the callers and modules the planned edits touch indirectly and check whether the tasks cover them." },
	{ id: "check-strength", direction: "Test whether each verification check could still pass while the behavior is broken, and what no check covers." },
];
const three = () => DIRECTIONS.map((entry) => ({ ...entry }));
const two = () => DIRECTIONS.slice(0, 2).map((entry) => ({ ...entry }));

/** The lane (direction id) a brief was written for ("general" when it has none). */
function laneOf(prompt: string): string {
	const match = DIRECTIONS.find((entry) => prompt.includes(`Your assigned direction: ${entry.direction}`));
	return match?.id ?? "general";
}

function spawnLedger(workdir: string): Array<{ role: string; name: string; model: string; thinking_level: string | null }> {
	const active = readActive(workdir);
	const file = active ? path.join(active.run_dir, "subagents.jsonl") : "";
	if (!file || !fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("refine: delegated reviewers", () => {
	it("reviewers: 3 runs one in-process session per planner direction and returns three sections", async () => {
		const { workdir, runId, planPath } = setup();
		const seen: Array<{ lane: string; model: unknown; thinking: unknown; tools: unknown }> = [];
		const restore = installFakeAgents(({ prompt, options }) => {
			const lane = laneOf(prompt);
			seen.push({ lane, model: options.model, thinking: options.thinkingLevel, tools: options.tools });
			return `## Findings\nNone from ${lane}.\n\n## Questions\nNone.`;
		});
		try {
			const result = await loadTool().execute("t1", { planPath, reviewers: 3, directions: three() }, undefined, undefined, headlessCtx(workdir));
			const text = result.content[0]!.text;
			for (const lane of DIRECTIONS.map((entry) => entry.id)) {
				assert.match(text, new RegExp(`None from ${lane}\\.`), `section for ${lane}`);
			}
			assert.equal((text.match(/^### /gm) ?? []).length, 3, "three reviewer sections");
			assert.doesNotMatch(text, /FAILED/);
			assert.deepEqual(seen.map((entry) => entry.lane).sort(), DIRECTIONS.map((entry) => entry.id).sort(), "each lane got its own direction");
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
			await loadTool().execute("t1", { planPath, reviewers: 3, directions: three() }, undefined, undefined, tuiCtx(workdir, widgets));
			const entries = fleet.list().filter((entry) => entry.role === "reviewer");
			assert.deepEqual(entries.map((entry) => entry.laneId), DIRECTIONS.map((entry) => entry.id));
			assert.ok(entries.every((entry) => entry.lane.status === "complete"), "every finished lane stays listed as done");
			assert.ok(entries.every((entry) => entry.modelLabel?.includes("fake/reviewer")), "the model label reaches the list");
			assert.equal(widgets.length, 1, "one fleet widget");
			// Once the three reviewers have returned the panel collapses by itself…
			const collapsed = widgets[0]!(120);
			assert.deepEqual(collapsed, ["Subagents (3) · 3 done · ↓ browse subagents"]);
			// …and ↓ with an empty editor expands it into one bullet per reviewer.
			assert.deepEqual(fleetUi.handleKey("\x1b[B"), { consume: true });
			const lines = widgets[0]!(120);
			assert.equal(lines.filter((line) => line.startsWith("•") || line.startsWith("▸")).length, 3, "three bullets");
			assert.ok(lines.some((line) => line.includes("state-transitions")));
			assert.deepEqual(fleetUi.handleKey("\x1b"), { consume: true });
			assert.equal(widgets[0]!(120).length, 1, "Esc collapses it again");
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
				if (laneOf(api.prompt) === "blast-radius") throw new Error("provider exploded");
				api.say(`ok from ${laneOf(api.prompt)} (${String(options.cwd).length > 0})`);
			}),
		}));
		const result = await loadTool().execute("t1", { planPath, reviewers: 3, directions: three() }, undefined, undefined, headlessCtx(workdir));
		const text = result.content[0]!.text;
		assert.match(text, /— FAILED\nprovider exploded/);
		assert.match(text, /ok from state-transitions/);
		assert.match(text, /ok from check-strength/);
		assert.deepEqual(result.details.outputs.map((output: { ok: boolean }) => output.ok), [true, false, true]);
		assert.equal(fleet.list().find((entry) => entry.laneId === "blast-radius")?.lane.status, "failed");
	});

	it("throws when every reviewer fails", async () => {
		const { workdir, planPath } = setup();
		__setSessionFactoryForTests(async () => ({
			session: new FakeSession(() => {
				throw new Error("no capacity");
			}),
		}));
		await assert.rejects(
			loadTool().execute("t1", { planPath, reviewers: 2, directions: two() }, undefined, undefined, headlessCtx(workdir)),
			/all reviewer subagents failed: no capacity/,
		);
	});

	function startStoredRound(workdir: string, runId: string, planPath: string, roundId: string, lanes: Array<{ laneId: string; lens?: string }>) {
		startReviewRound(workdir, runId, { roundId, role: "reviewer", target: "plan", reviewers: lanes.length, planPath, lanes });
	}

	it("resuming a round without directions reuses the stored lanes and runs only the incomplete ones", async () => {
		const { workdir, runId, planPath } = setup();
		const roundId = "plan-reviewer-resume";
		startStoredRound(workdir, runId, planPath, roundId, three().map((entry) => ({ laneId: entry.id, lens: entry.direction })));
		recordLaneOutcome(workdir, runId, roundId, "state-transitions", { ok: true, output: "PERSISTED state-transitions output" });
		const lanes: string[] = [];
		const briefs: string[] = [];
		const restore = installFakeAgents(({ prompt }) => {
			lanes.push(laneOf(prompt));
			briefs.push(prompt);
			return `fresh output for ${laneOf(prompt)}`;
		});
		try {
			const result = await loadTool().execute("t1", { planPath, resumeRoundId: roundId }, undefined, undefined, headlessCtx(workdir));
			assert.deepEqual(lanes.sort(), ["blast-radius", "check-strength"], "the completed lane is not re-run");
			assert.deepEqual(fleet.list().map((entry) => entry.laneId).sort(), ["blast-radius", "check-strength"], "only the runnable lanes enter the list");
			assert.ok(briefs.every((brief) => brief.includes(DIRECTIONS[0]!.direction)), "the reused lane's stored direction is still listed for the others");
			const text = result.content[0]!.text;
			assert.match(text, /REUSED \(round plan-reviewer-resume, no re-run\)\nPERSISTED state-transitions output/);
			assert.match(text, /fresh output for blast-radius/);
			assert.deepEqual(result.details.reusedLanes, ["state-transitions"]);
			assert.equal(result.details.reviewers, 3);
		} finally {
			restore();
		}
	});

	it("resuming with different directions than the stored lanes is refused", async () => {
		const { workdir, runId, planPath } = setup();
		startStoredRound(workdir, runId, planPath, "r-mismatch", two().map((entry) => ({ laneId: entry.id, lens: entry.direction })));
		const other = [
			{ id: "something-else", direction: "A direction whose id does not match the stored round at all." },
			{ id: "and-another", direction: "Another direction that also does not match the stored round." },
		];
		await assert.rejects(
			loadTool().execute("t1", { planPath, reviewers: 2, directions: other, resumeRoundId: "r-mismatch" }, undefined, undefined, headlessCtx(workdir)),
			/different lanes/,
		);
	});

	it("a round recorded with the old fixed lenses still resumes without directions", async () => {
		const { workdir, runId, planPath } = setup();
		const roundId = "legacy-lenses";
		startStoredRound(workdir, runId, planPath, roundId, [
			{ laneId: "correctness", lens: "requirements fit and correctness of claims against the repository" },
			{ laneId: "ordering", lens: "architecture, sequencing, and dependency ordering" },
		]);
		recordLaneOutcome(workdir, runId, roundId, "correctness", { ok: true, output: "legacy persisted" });
		const prompts: string[] = [];
		const restore = installFakeAgents(({ prompt }) => {
			prompts.push(prompt);
			return "fresh";
		});
		try {
			const result = await loadTool().execute("t1", { planPath, resumeRoundId: roundId }, undefined, undefined, headlessCtx(workdir));
			assert.equal(prompts.length, 1, "only the incomplete legacy lane runs");
			assert.match(prompts[0]!, /Your assigned direction: architecture, sequencing, and dependency ordering/);
			assert.match(prompts[0]!, /- correctness: requirements fit and correctness/);
			assert.match(result.content[0]!.text, /legacy persisted/);
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
		const pending = loadTool().execute("t1", { planPath, reviewers: 2, directions: two() }, controller.signal, undefined, headlessCtx(workdir));
		setTimeout(() => controller.abort(), 30);
		await assert.rejects(pending, /all reviewer subagents failed/);
		assert.ok(fleet.list().every((entry) => entry.lane.status === "cancelled"), "aborted lanes end as cancelled");
	});
});

describe("refine: tailored reviewer directions", () => {
	async function run(params: Record<string, unknown>, ctxFor: (workdir: string) => unknown = headlessCtx) {
		const { workdir, planPath } = setup();
		const spawned: string[] = [];
		const restore = installFakeAgents(({ prompt }) => {
			spawned.push(prompt);
			return "## Findings\nNone.\n\n## Questions\nNone.";
		});
		try {
			const outcome = await loadTool().execute("t1", { planPath, ...params }, undefined, undefined, ctxFor(workdir)).then(
				(result) => ({ result }),
				(error: Error) => ({ error }),
			);
			return { workdir, spawned, ...outcome };
		} finally {
			restore();
		}
	}

	it("each brief carries its own direction and lists only the OTHER reviewers' directions", async () => {
		const { spawned } = await run({ reviewers: 3, directions: three() });
		assert.equal(spawned.length, 3);
		for (const prompt of spawned) {
			const own = DIRECTIONS.find((entry) => prompt.includes(`Your assigned direction: ${entry.direction}`))!;
			assert.ok(own, "an assigned direction");
			assert.equal(prompt.split(own.direction).length - 1, 1, "the own direction appears exactly once");
			assert.match(prompt, /Other reviewers in this round cover different directions/);
			for (const other of DIRECTIONS.filter((entry) => entry.id !== own.id)) {
				assert.ok(prompt.includes(`- ${other.id}: ${other.direction}`), `lists ${other.id}`);
			}
			assert.doesNotMatch(prompt, new RegExp(`- ${own.id}: `), "does not list itself among the others");
			assert.match(prompt, /high-severity problem outside your direction, report it briefly/);
		}
	});

	it("reviewers: 2 runs two directions", async () => {
		const { spawned, result } = await run({ reviewers: 2, directions: two() });
		assert.equal(spawned.length, 2);
		assert.equal(result!.details.reviewers, 2);
		assert.deepEqual(result!.details.outputs.map((output: { lane: string }) => output.lane), ["state-transitions", "blast-radius"]);
		assert.equal(result!.details.outputs[0].direction, DIRECTIONS[0]!.direction);
	});

	it("more than one reviewer without directions is refused with guidance and spawns nothing", async () => {
		const { spawned, error, workdir } = await run({ reviewers: 2 });
		assert.ok(error);
		assert.match(error!.message, /needs tailor-made directions, but none were given/);
		assert.match(error!.message, /Name the concrete modules, flows or risks/);
		assert.equal(spawned.length, 0);
		assert.deepEqual(fleet.list(), []);
		const active = readActive(workdir)!;
		const checkpoint = loadCheckpoint(workdir, active.run_id);
		assert.ok(checkpoint.status === "ok" && checkpoint.checkpoint.reviewRounds.length === 0, "no round was started");
	});

	it("rejects a wrong count, duplicate ids, bad slugs and out-of-range text", async () => {
		const good = two();
		for (const [params, pattern] of [
			[{ reviewers: 3, directions: two() }, /needs exactly 3 directions, got 2/],
			[{ reviewers: 2, directions: [good[0], { ...good[1], id: good[0]!.id }] }, /used twice/],
			[{ reviewers: 2, directions: [good[0], { ...good[1], id: "Bad Slug" }] }, /not a valid slug/],
			[{ reviewers: 2, directions: [good[0], { ...good[1], direction: "too short" }] }, /must be 20-800 characters/],
			[{ reviewers: 2, directions: [good[0], { ...good[1], direction: "x".repeat(801) }] }, /must be 20-800 characters/],
			[{ reviewers: 1, directions: two() }, /reviewers: 1 takes at most one direction/],
		] as Array<[Record<string, unknown>, RegExp]>) {
			const { spawned, error } = await run(params);
			assert.ok(error, JSON.stringify(params).slice(0, 80));
			assert.match(error!.message, pattern);
			assert.equal(spawned.length, 0);
		}
	});

	it("directions are validated before any model panel could open (no reviewer gate needed)", async () => {
		// A delegated role that was never confirmed would normally walk the user
		// through the first-use panels; bad directions must fail first.
		const { workdir, planPath } = setup();
		setRole(workdir, { role: "reviewer", mode: "delegated-subagent", modelSelector: "inherit" });
		await assert.rejects(
			loadTool().execute("t1", { planPath, reviewers: 2 }, undefined, undefined, headlessCtx(workdir)),
			/needs tailor-made directions/,
		);
	});

	it("one reviewer takes an optional direction as its lane; none means the general lane", async () => {
		const withDirection = await run({ directions: [DIRECTIONS[0]] });
		assert.deepEqual(withDirection.result!.details.outputs.map((output: { lane: string }) => output.lane), ["state-transitions"]);
		assert.match(withDirection.spawned[0]!, /Your assigned direction: Probe how the plan/);
		assert.doesNotMatch(withDirection.spawned[0]!, /Other reviewers in this round/);
		const general = await run({});
		assert.deepEqual(general.result!.details.outputs.map((output: { lane: string }) => output.lane), ["general"]);
		assert.doesNotMatch(general.spawned[0]!, /Your assigned direction/);
	});

	it("current-session mode needs the directions too and lists them in the one brief", async () => {
		const { workdir, planPath } = setup();
		setRole(workdir, { role: "reviewer", mode: "current-session", confirmed: true });
		await assert.rejects(
			loadTool().execute("t1", { planPath, reviewers: 2 }, undefined, undefined, headlessCtx(workdir)),
			/needs tailor-made directions/,
		);
		const result = await loadTool().execute("t1", { planPath, reviewers: 2, directions: two() }, undefined, undefined, headlessCtx(workdir));
		const text = result.content[0]!.text;
		assert.match(text, /current-session/);
		assert.match(text, /You are the only reviewer here: cover each one in turn/);
		assert.match(text, /- state-transitions: Probe how/);
		assert.match(text, /- blast-radius: Find the callers/);
	});
});
