/**
 * The in-process engine against the REAL pi SDK (no session-factory fake):
 * a scripted provider drives a delegated session that calls a custom tool
 * mid-run, returns text, and is prompted again on the same live session.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { InMemoryCredentialStore, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, defineTool, initTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startAgentSession } from "../src/agent-session.ts";

initTheme("dark", false);

let root = "";
let previousAgentDir: string | undefined;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-sdk-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

interface Call {
	systemPrompt: string;
	toolNames: string[];
	lastUser: string;
}

async function scriptedRegistry(script: (call: Call, index: number) => { text?: string; tool?: { name: string; args: unknown } }) {
	const calls: Call[] = [];
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: path.join(root, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerProvider("local-sdk", {
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
		streamSimple: (_model: unknown, context: { systemPrompt: string; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> }) => {
			const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
			const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
			// This pi version projects the system prompt into the leading system message.
			const call = { systemPrompt: JSON.stringify(context.messages), toolNames: (context.tools ?? []).map((tool) => tool.name), lastUser: text };
			calls.push(call);
			const step = script(call, calls.length - 1);
			const content = step.tool
				? [{ type: "toolCall", id: `call-${calls.length}`, name: step.tool.name, arguments: step.tool.args }]
				: [{ type: "text", text: step.text ?? "done" }];
			const message = {
				role: "assistant",
				api: "openai-completions",
				provider: "local-sdk",
				model: "fixture",
				content,
				stopReason: step.tool ? "toolUse" : "stop",
				timestamp: Date.now(),
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
	return { registry: new ModelRegistry(runtime), runtime, calls };
}

describe("agent sessions on the real SDK", () => {
	it("runs a custom tool mid-run, returns text, and accepts a second prompt on the same session", async () => {
		const seen: string[] = [];
		const progressTool = defineTool({
			name: "report_progress",
			label: "Report",
			description: "Report one finished item",
			parameters: Type.Object({ item: Type.String() }),
			execute: async (_id, params) => {
				seen.push(params.item);
				return { content: [{ type: "text", text: `recorded ${params.item}` }], details: {} };
			},
		});
		const { registry, calls } = await scriptedRegistry((call, index) => {
			if (index === 0) return { tool: { name: "report_progress", args: { item: "Task-1" } } };
			return { text: index === 1 ? "final after tool" : `answer ${index}`, ...(call ? {} : {}) };
		});
		const started = await startAgentSession({
			systemPrompt: "You are a delegated test worker.",
			task: "",
			cwd: root,
			host: { modelRegistry: registry },
			model: "local-sdk/fixture",
			thinkingLevel: "off",
			tools: ["read", "grep"],
			customTools: [progressTool],
		});
		assert.ok("handle" in started, "error" in started ? started.error : "");
		const { handle } = started as Extract<typeof started, { handle: unknown }>;
		const first = await handle.run("Task: first assignment");
		assert.equal(first.ok, true, first.errorMessage);
		assert.deepEqual(seen, ["Task-1"], "the custom tool ran inside the run");
		assert.equal(first.output, "final after tool");
		assert.ok(first.usage && first.usage.input >= 20, "usage is metered across both model calls");
		assert.match(calls[0]!.systemPrompt, /You are a delegated test worker\./, `the role prompt reaches the model: ${JSON.stringify(calls[0]!.systemPrompt.slice(0, 400))}`);

		const second = await handle.run("Task: second assignment");
		assert.equal(second.ok, true, second.errorMessage);
		assert.match(calls.at(-1)!.lastUser, /second assignment/);
		handle.dispose();
	});

	it("fails cleanly for a model that is not in the registry", async () => {
		const { registry } = await scriptedRegistry(() => ({ text: "x" }));
		const started = await startAgentSession({ systemPrompt: "p", task: "", cwd: root, host: { modelRegistry: registry }, model: "nope/missing" });
		assert.ok("error" in started);
		assert.match((started as { error: string }).error, /not available/);
	});

	it("aborts a running session and reports it as cancelled", async () => {
		const { registry } = await scriptedRegistry(() => ({ text: "never delivered" }));
		const started = await startAgentSession({ systemPrompt: "p", task: "", cwd: root, host: { modelRegistry: registry }, model: "local-sdk/fixture", thinkingLevel: "off" });
		assert.ok("handle" in started);
		const { handle } = started as Extract<typeof started, { handle: unknown }>;
		const controller = new AbortController();
		controller.abort();
		const result = await handle.run("Task: go", { signal: controller.signal });
		assert.equal(result.ok, false);
		assert.equal(result.cancelled, true);
		handle.dispose();
	});
});
