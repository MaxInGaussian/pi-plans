import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { InMemoryCredentialStore, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import piPlansExtension from "../index.ts";
import { GOAL_WAIT_CUSTOM_TYPE, getExecution, startExecution } from "../src/exec.ts";

initTheme("dark", false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-lifecycle-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

async function exercise(mode: "tui" | "rpc" | "print" | "json", needsWake: boolean, commandResume = false) {
	const cwd = path.join(root, String(++serial));
	fs.mkdirSync(cwd);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null,
		modelsStorePath: path.join(cwd, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
	});
	const inputs: any[] = [];
	let toolCalls = 0;
	modelRuntime.registerProvider("local-lifecycle-test", {
		baseUrl: "http://unused.invalid", api: "openai-completions", apiKey: "not-a-real-key",
		models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
		streamSimple: (model: any, context: any) => {
			inputs.push(structuredClone({ messages: context.messages, systemPrompt: context.systemPrompt }));
			const call = inputs.length;
			assert.ok(call <= 5, "unexpected extra model invocation");
			const tool = call <= 2;
			const text = call === 3
				? needsWake ? "[DONE:VC-001] More verification remains." : "[DONE:VC-001] [DONE:VC-002]"
				: call === 4 && needsWake ? "[DONE:VC-002]" : "Review awaits explicit user approval.";
			const message: any = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: tool ? [
					...(commandResume && call === 2 ? [{ type: "text", text: "[DONE:VC-001]" }] : []),
					{ type: "toolCall", id: `call-${call}`, name: "probe", arguments: {} },
				] : [{ type: "text", text: commandResume && call === 3 ? "Interrupted." : text }],
				stopReason: tool ? "toolUse" : commandResume && call === 3 ? "aborted" : "stop", timestamp: Date.now(),
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
			else stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
	let beforeAgentStarts = 0;
	const events: string[] = [];
	const errors: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd, agentDir: path.join(cwd, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Deterministic test.",
		extensionFactories: [piPlansExtension, pi => {
			pi.on("before_agent_start", () => { beforeAgentStarts++; });
			pi.on("session_start", async (_event, ctx) => {
				await startExecution(pi, ctx, path.join(cwd, "PLAN_v1.md"), [
					{ id: "VC-001", text: "first", done: false }, { id: "VC-002", text: "second", done: false },
				]);
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd, agentDir: path.join(cwd, "agent"), modelRuntime,
		model: modelRuntime.getModel("local-lifecycle-test", "fixture")!, thinkingLevel: "off",
		resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["probe"],
		customTools: [{ name: "probe", label: "Probe", description: "Local test probe", parameters: Type.Object({}),
			execute: async () => { toolCalls++; return { content: [{ type: "text", text: "ok" }], details: {} }; } }],
	});
	const unsubscribe = session.subscribe(event => events.push(event.type));
	try {
		await session.bindExtensions({
			mode,
			...(mode === "tui" || mode === "rpc" ? { uiContext: {
				setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, s: string) => s },
			} as any } : {}),
			onError: error => errors.push(error.error),
		});
		await session.prompt("Implement the test plan.");
		await session.waitForIdle();
		if (commandResume) {
			assert.equal(getExecution()?.goalWait?.paused, true);
			assert.deepEqual(getExecution()?.items.map(item => item.done), [true, false]);
			assert.equal(inputs.length, 3);
			await session.prompt("/plans-execute");
		}
		// SDK callers, unlike print mode, own the runtime until all nested wakes settle.
		await session.waitForIdle();
		assert.deepEqual(errors, []);
		assert.deepEqual(session.messages.filter((m: any) => m.role === "assistant" && m.stopReason === "error"), [], "fixture model must run successfully");
		const wakes = session.messages.filter((m: any) => m.customType === GOAL_WAIT_CUSTOM_TYPE) as any[];
		assert.equal(toolCalls, 2);
		assert.equal(beforeAgentStarts, 1, "custom wake must work without before_agent_start");
		const interactive = mode === "tui" || mode === "rpc";
		assert.equal(wakes.length, interactive && needsWake ? 1 : 0);
		assert.equal(inputs.length, interactive ? needsWake ? 5 : 4 : 3);
		if (interactive && needsWake) {
			assert.equal(wakes[0].display, false);
			assert.match(JSON.stringify(inputs[3].messages), /1\/2 verifier items done/);
			assert.match(wakes[0].content, /- `VC-002` second/);
			assert.doesNotMatch(wakes[0].content, /- `VC-001` first/);
		}
		if (interactive || !needsWake) assert.equal(getExecution(), null);
		else assert.deepEqual(getExecution()?.items.map(item => item.done), [true, false]);
		assert.equal(session.pendingMessageCount, 0);
		assert.equal(events.at(-1), "agent_settled");
		return { events, calls: inputs.length, wakes: wakes.length };
	} finally {
		unsubscribe();
		session.dispose();
	}
}

describe("goal-wait on the real Pi host", () => {
	it("dispatches the registered /plans-execute command and preserves completed VCs", { timeout: 15000 }, async () => {
		await exercise("rpc", true, true);
	});
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		for (const needsWake of [false, true]) {
			it(`${mode}: tools then ${needsWake ? "incomplete stop" : "completion"}`, { timeout: 15000 }, async () => {
				await exercise(mode, needsWake);
			});
		}
	}
});
