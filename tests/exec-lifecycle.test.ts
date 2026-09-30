/**
 * Execution lifecycle on the real Pi host (v0.6.1): an execution whose tasks
 * close through the task-status API completes through the audit gate wired
 * by the loaded extension's turn handlers.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { InMemoryCredentialStore, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piPlansExtension from "../index.ts";
import { __setAuditRunnerForTests } from "../src/exec.ts";
import { getRun, initState, startRun } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint } from "../src/workflow-state.ts";
import { setMessagingApi } from "../src/messaging.ts";

initTheme("dark", false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-exec-life-"));
after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	__setAuditRunnerForTests(null);
});
let serial = 0;

const PLAN = `# PLAN_v1 - lifecycle

## Tasks

- Task-1: parser — files: src/a.ts; wave: 1
- Task-2: tool — files: src/b.ts; wave: 1

### Execution Waves

- wave 1: Task-1, Task-2 — parallel

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: parser green
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: tool green
`;

interface Fixture {
	script: Array<{ kind: "text"; text: string }>;
	calls: { messages: unknown; systemPrompt: string }[];
}

function fixtureRuntime(cwd: string, fixture: Fixture) {
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: path.join(cwd, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	}).then((modelRuntime) => {
		modelRuntime.registerProvider("local-exec-life", {
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
				const message = {
					role: "assistant",
					api: "openai-completions",
					provider: "local-exec-life",
					model: "fixture",
					content: [{ type: "text", text: (step as { text: string }).text }],
					stopReason: "stop",
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

async function makeSession(options: { cwd: string; fixture: Fixture; mode: "rpc" }) {
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
		extensionFactories: [piPlansExtension as never],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(cwd, "agent"),
		modelRuntime,
		model: modelRuntime.getModel("local-exec-life", "fixture")!,
		thinkingLevel: "off",
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		customTools: [],
	});
	const errors: string[] = [];
	await session.bindExtensions({
		mode,
		uiContext: {
			setStatus: () => {},
			notify: () => {},
			confirm: async () => true,
			select: async (_t: string, options: string[]) => options[0],
			input: async () => "typed",
			theme: { fg: (_c: string, s: string) => s },
		},
		onError: (error: { error: string }) => errors.push(error.error),
	});
	(session as unknown as { errors: string[] }).errors = errors;
	return session as never as Awaited<ReturnType<typeof import("../index.ts").default>> extends never ? never : typeof session;
}

before(() => {
	// deterministic audit: every check passes
	__setAuditRunnerForTests(async ({ checklist }) => ({
		round: 1,
		passed: checklist.map((item) => {
			item.done = true;
			return item.id;
		}),
		failed: [],
		rolledBack: [],
		report: "all checks pass",
	}));
});

describe("execution lifecycle on the real host", () => {
	it("completes a task-tree execution through the audit gate", { timeout: 60000 }, async () => {
		serial += 1;
		const cwd = path.join(root, String(serial));
		fs.mkdirSync(cwd);
		spawnSync("git", ["init"], { cwd });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
		spawnSync("git", ["config", "user.name", "T"], { cwd });
		initState(cwd);
		const { run } = startRun(cwd, { topic: "lifecycle", skill: "plan-small", requestText: "x" });
		createCheckpoint(cwd, { runId: run.run_id, originWorkdir: cwd, workdir: cwd });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, PLAN, "utf8");
		spawnSync("git", ["add", "-A"], { cwd });
		spawnSync("git", ["commit", "-m", "seed"], { cwd });

		const fixture: Fixture = { script: [{ kind: "text", text: "All tasks verified." }], calls: [] };
		const session = (await makeSession({ cwd, fixture, mode: "rpc" })) as unknown as { prompt: (t: string) => Promise<unknown>; waitForIdle: () => Promise<void>; dispose: () => void; sessionManager: unknown; errors: string[] };
		try {
			// Same-process module instances as the session's extension wiring.
			const { startExecution, getExecution, persistTaskProgress } = await import("../src/exec.ts");
			const { parseChecklist, parsePlanTasks } = await import("../src/plan.ts");
			const { applyTaskUpdate } = await import("../src/task-tool.ts");
			const ctxLike = { cwd, sessionManager: session.sessionManager, hasUI: false, mode: "json", ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } } } as never;
		setMessagingApi({ appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: async () => {} });
			await startExecution(ctxLike, { planPath, planTasks: parsePlanTasks(PLAN), items: parseChecklist(PLAN) });
			applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "parser green");
			applyTaskUpdate(getExecution()!.tasks, "Task-2", "complete", "tool green");
			persistTaskProgress(ctxLike);

			await session.prompt("Finish the run.");
			await session.waitForIdle();

			const final = loadCheckpoint(cwd, run.run_id);
			assert.equal(final.status, "ok");
			assert.equal(final.checkpoint.phase, "completed", "audit passed → terminal phase");
			assert.equal(final.checkpoint.execution?.audit?.passed, true);
			assert.deepEqual((final.checkpoint.execution?.doneVcIds ?? []).sort(), ["VC-001", "VC-002"]);
			assert.equal(getRun(cwd, run.run_id)?.status, "done");
		} finally {
			session.dispose();
		}
	});
});
