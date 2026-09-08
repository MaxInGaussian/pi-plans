/**
 * Real-Pi-host /resume-plans lifecycle tests (I-007): full extension
 * dispatch via session.prompt("/resume-plans"), cross-session execution
 * resume, linked-worktree discovery, concurrent-owner refusal, and print
 * mode staying silent.
 */

import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { InMemoryCredentialStore, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piPlansExtension from "../index.ts";
import { startExecution } from "../src/exec.ts";
import { resetRunBindingForTests } from "../src/run-context.ts";
import { processStartOf } from "../src/run-ownership.ts";
import { createCheckpoint, loadCheckpoint, mutateCheckpoint, applyQuestionAsked } from "../src/workflow-state.ts";
import { getRun, initState, startRun } from "../src/state.ts";

initTheme("dark", false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-resume-life-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

const PLAN_TEXT = `# Plan

## Verifier Checklist

- [ ] \`VC-001\` covers \`I-001\`; pass condition: first.
- [ ] \`VC-002\` covers \`I-002\`; pass condition: second.
`;

interface Fixture {
	/** Deterministic script of assistant replies (text or toolUse). */
	script: Array<{ kind: "text"; text: string } | { kind: "tool" }>;
	calls: { messages: unknown; systemPrompt: string }[];
}

function fixtureRuntime(cwd: string, fixture: Fixture) {
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: path.join(cwd, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	}).then(async (modelRuntime) => {
		modelRuntime.registerProvider("local-resume-test", {
			baseUrl: "http://unused.invalid",
			api: "openai-completions",
			apiKey: "not-a-real-key",
			models: [
				{
					id: "fixture",
					name: "fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					contextWindow: 100000,
					maxTokens: 1024,
				},
			],
			streamSimple: (model: unknown, context: { messages: unknown; systemPrompt: string }) => {
				fixture.calls.push(structuredClone({ messages: context.messages, systemPrompt: context.systemPrompt }));
				const step = fixture.script[Math.min(fixture.calls.length, fixture.script.length) - 1] ?? { kind: "text", text: "done" } as const;
				const tool = step.kind === "tool";
				const message = {
					role: "assistant",
					api: "openai-completions",
					provider: "local-resume-test",
					model: "fixture",
					content: tool
						? [{ type: "toolCall", id: `call-${fixture.calls.length}`, name: "probe", arguments: {} }]
						: [{ type: "text", text: (step as { text: string }).text }],
					stopReason: tool ? "toolUse" : "stop",
					timestamp: Date.now(),
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
				return stream;
			},
		});
		return modelRuntime;
	});
}

function uiContext(notifies: string[]) {
	return {
		setStatus: () => {},
		notify: (message: string) => {
			notifies.push(message);
		},
		confirm: async () => true,
		select: async (_title: string, options: string[]) => options[0],
		input: async () => "typed",
		theme: { fg: (_c: string, s: string) => s },
	} as never;
}

async function makeSession(options: {
	cwd: string;
	fixture: Fixture;
	mode: "tui" | "rpc" | "print" | "json";
	extraExtension?: (pi: never) => void;
	notifies?: string[];
}) {
	const { cwd, fixture, mode } = options;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await fixtureRuntime(cwd, fixture);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: path.join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		systemPromptOverride: () => "Deterministic test.",
		extensionFactories: [piPlansExtension as never, ...(options.extraExtension ? [options.extraExtension] : [])],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(cwd, "agent"),
		modelRuntime,
		model: modelRuntime.getModel("local-resume-test", "fixture")!,
		thinkingLevel: "off",
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		tools: ["probe"],
		customTools: [
			{
				name: "probe",
				label: "Probe",
				description: "Local test probe",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			} as never,
		],
	});
	const errors: string[] = [];
	await session.bindExtensions({
		mode,
		...(mode === "tui" || mode === "rpc" ? { uiContext: uiContext(options.notifies ?? []) } : {}),
		onError: (error: { error: string }) => errors.push(error.error),
	});
	return { session, errors };
}

function setupRun(name: string): { cwd: string; runId: string; artifactDir: string } {
	const cwd = path.join(root, `${String(++serial)}-${name}`);
	fs.mkdirSync(cwd, { recursive: true });
	spawnSync("git", ["init"], { cwd });
	spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
	spawnSync("git", ["config", "user.name", "T"], { cwd });
	initState(cwd);
	const { run } = startRun(cwd, { topic: name, skill: "plan-normal", requestText: "Lifecycle resume test" });
	createCheckpoint(cwd, { runId: run.run_id, originWorkdir: cwd, workdir: cwd });
	fs.mkdirSync(run.artifact_dir, { recursive: true });
	fs.writeFileSync(path.join(run.artifact_dir, "PLAN_v1.md"), PLAN_TEXT, "utf8");
	spawnSync("git", ["add", "-A"], { cwd });
	spawnSync("git", ["commit", "-m", "seed"], { cwd });
	return { cwd, runId: run.run_id, artifactDir: run.artifact_dir };
}

describe("/resume-plans on the real Pi host", () => {
	it(
		"resumes an interrupted execution across sessions via command dispatch",
		{ timeout: 30000 },
		async () => {
			resetRunBindingForTests();
			const { cwd, runId } = setupRun("cross-session");
			// Session 1: execution starts, VC-001 lands, then the session ends.
			const fixture1: Fixture = {
				script: [
					{ kind: "tool" },
					{ kind: "text", text: "[DONE:VC-001] Partial progress; stopping here." },
				],
				calls: [],
			};
			const session1 = await makeSession({
				cwd,
				fixture: fixture1,
				mode: "rpc",
				extraExtension: ((pi: never) => {
					const realPi = pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
					realPi.on("session_start", async (_event: unknown, ctx: never) => {
						await startExecution(realPi, ctx as never, path.join(artifactDirRelative(cwd), "PLAN_v1.md"), [
							{ id: "VC-001", text: "first", done: false },
							{ id: "VC-002", text: "second", done: false },
						]);
					});
				}) as never,
			});
			try {
				await session1.session.prompt("Begin execution.");
				await session1.session.waitForIdle();
				assert.deepEqual(session1.errors, []);
				const mid = loadCheckpoint(cwd, runId);
				assert.equal(mid.status, "ok");
				if (mid.status === "ok") {
					assert.deepEqual(mid.checkpoint.execution?.doneVcIds, ["VC-001"], "progress persisted by session 1");
					assert.ok(mid.checkpoint.execution?.approval?.headAtApproval, "approval evidence persisted");
				}
			} finally {
				session1.session.dispose();
			}
			// The next session rebuilds execution from the checkpoint; the
			// in-memory module state is irrelevant across sessions.

			// Session 2: fresh session, resume via the command.
			const fixture2: Fixture = {
				script: [{ kind: "text", text: "[DONE:VC-002] All items verified." }],
				calls: [],
			};
			const notifies: string[] = [];
			const session2 = await makeSession({ cwd, fixture: fixture2, mode: "rpc", notifies });
			try {
				await session2.session.prompt("/resume-plans");
				await waitForModelCalls(fixture2, session2.session, 1);
				assert.deepEqual(session2.errors, []);
				// The kickoff brief reached the model as the user message.
				assert.ok(fixture2.calls.length >= 1);
				const firstPayload = JSON.stringify(fixture2.calls[0]);
				assert.match(firstPayload, /PI-PLANS RESUME/);
				assert.match(firstPayload, /VC-001/);
				assert.ok(notifies.some((message) => /Resumed/.test(message)), "resume notification shown");
				// Both VCs are done; the run advanced to the review phase.
				const final = loadCheckpoint(cwd, runId);
				assert.equal(final.status, "ok");
				if (final.status === "ok") {
					assert.deepEqual(final.checkpoint.execution?.doneVcIds.sort(), ["VC-001", "VC-002"]);
					assert.equal(final.checkpoint.phase, "implementation-review");
				}
				assert.equal(getRun(cwd, runId)?.status, "done");
			} finally {
				session2.session.dispose();
			}
		},
	);

	it(
		"resumes a planning run with a pending question (command dispatch)",
		{ timeout: 30000 },
		async () => {
			resetRunBindingForTests();
			const { cwd, runId } = setupRun("planning");
			mutateCheckpoint(cwd, runId, (cp) =>
				applyQuestionAsked(cp, { questionId: "q-depth", question: "How deep?", options: ["shallow", "deep"] }),
			);
			const fixture: Fixture = { script: [{ kind: "text", text: "Answering the pending question next." }], calls: [] };
			const notifies: string[] = [];
			const session = await makeSession({ cwd, fixture, mode: "rpc", notifies });
			try {
				await session.session.prompt("/resume-plans");
				await waitForModelCalls(fixture, session.session, 1);
				assert.deepEqual(session.errors, []);
				const payload = JSON.stringify(fixture.calls[0]);
				assert.match(payload, /PI-PLANS RESUME/);
				assert.match(payload, /q-depth/);
				assert.match(payload, /PENDING question/);
			} finally {
				session.session.dispose();
			}
		},
	);

	it(
		"tui mode dispatch resumes the same brief",
		{ timeout: 30000 },
		async () => {
			resetRunBindingForTests();
			const { cwd, runId } = setupRun("tui-planning");
			mutateCheckpoint(cwd, runId, (cp) =>
				applyQuestionAsked(cp, { questionId: "q-scope", question: "Which scope?", options: ["A", "B"] }),
			);
			const fixture: Fixture = { script: [{ kind: "text", text: "Continuing in the TUI session." }], calls: [] };
			const session = await makeSession({ cwd, fixture, mode: "tui", notifies: [] });
			try {
				await session.session.prompt("/resume-plans");
				await waitForModelCalls(fixture, session.session, 1);
				assert.deepEqual(session.errors, []);
				const payload = JSON.stringify(fixture.calls[0]);
				assert.match(payload, /PI-PLANS RESUME/);
				assert.match(payload, /q-scope/);
			} finally {
				session.session.dispose();
			}
		},
	);

	it(
		"refuses when another live owner holds the run",
		{ timeout: 30000 },
		async () => {
			resetRunBindingForTests();
			const { cwd, runId } = setupRun("owned");
			const child = spawn("sleep", ["30"], { stdio: "ignore" });
			try {
				fs.writeFileSync(
					path.join(cwd, ".git", "pi_plans", "runs", runId, "owner.json"),
					JSON.stringify({
						schema: 1,
						host: os.hostname(),
						pid: child.pid,
						pidStart: processStartOf(child.pid!),
						sessionId: null,
						processToken: "foreign-live",
						generation: 1,
						acquiredAt: "2026-09-07T00:00:00Z",
					}),
					"utf8",
				);
				const fixture: Fixture = { script: [{ kind: "text", text: "must not run" }], calls: [] };
				const notifies: string[] = [];
				const session = await makeSession({ cwd, fixture, mode: "rpc", notifies });
				try {
					await session.session.prompt("/resume-plans");
					await session.session.waitForIdle();
					assert.equal(fixture.calls.length, 0, "no model call without ownership");
					assert.ok(notifies.some((message) => /actively owned/.test(message)));
				} finally {
					session.session.dispose();
				}
			} finally {
				child.kill("SIGKILL");
			}
		},
	);

	it(
		"print mode stays silent (no resume flow)",
		{ timeout: 30000 },
		async () => {
			resetRunBindingForTests();
			const { cwd } = setupRun("print-mode");
			const fixture: Fixture = { script: [{ kind: "text", text: "idle" }], calls: [] };
			const session = await makeSession({ cwd, fixture, mode: "print" });
			try {
				await session.session.prompt("/resume-plans");
				await session.session.waitForIdle();
				// Command refused before any model call: the only input is the
				// raw command turn the host itself ran (print mode has no UI).
				const payloads = fixture.calls.map((call) => JSON.stringify(call));
				assert.ok(
					payloads.every((payload) => !payload.includes("PI-PLANS RESUME")),
					"no resume brief in print mode",
				);
			} finally {
				session.session.dispose();
			}
		},
	);
});

function artifactDirRelative(cwd: string): string {
	const root = path.join(cwd, "docs", "pi-plans");
	return path.join(root, fs.readdirSync(root)[0]!);
}

/** The command's kickoff message starts after prompt() returns; poll until
 * the fixture model actually ran (or fail after a deadline). */
async function waitForModelCalls(fixture: Fixture, session: { waitForIdle: () => Promise<void> }, minimum: number): Promise<void> {
	const deadline = Date.now() + 10000;
	while (fixture.calls.length < minimum && Date.now() < deadline) {
		await session.waitForIdle();
		if (fixture.calls.length < minimum) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await session.waitForIdle();
}
