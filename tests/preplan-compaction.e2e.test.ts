/**
 * Pre-plan compaction end-to-end on the REAL Pi host.
 *
 * The scenario is the production one: a scripted model calls the extension's
 * `plans start-run` tool mid-run, and that turn must end with a VCC compaction
 * applied as a `turn_end` boundary draft.
 *
 * What this pins (the two symptoms the fix targets):
 * - NO aborted assistant message (`stopReason: "error"` /
 *   "This operation was aborted") anywhere in the session — the old path ran
 *   `ctx.compact()`, whose first step is `await abort()`, before every pre-plan
 *   compaction.
 * - A real compaction entry lands (`details.compactor === "pi-vcc"`,
 *   `phase === "planning"`) and the NEXT provider request already sees the
 *   compacted context, so no `pi-plans-preplan-resume` message is needed.
 *
 * Harness notes: `tools: ["plans"]` is required — `allowedToolNames` filters
 * the extension-registered tool registry, so `tools: []` would make the `plans`
 * tool uncallable. `compaction.enabled = false` keeps automatic compaction out
 * of the way while leaving the extension's own path free to run, and a low
 * `keepRecentTokens` lets the VCC cut find a boundary in a small session.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { InMemoryCredentialStore, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piPlansExtension from "../index.ts";
import { initState } from "../src/state.ts";

initTheme("dark", false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-preplan-e2e-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

const FIRST_PROMPT = "FIRST-PROMPT-MARKER: start the session with a question";
const SECOND_PROMPT = "SECOND-PROMPT-MARKER: keep going";
const PLANS_PROMPT = "PLANS-PROMPT-MARKER: create the run now";
const FOURTH_PROMPT = "FOURTH-PROMPT-MARKER: after the compaction";

interface Fixture {
	script: Array<{ kind: "text"; text: string } | { kind: "plans" }>;
	calls: { messages: Array<{ role?: string; content?: unknown }>; systemPrompt: string }[];
}

function fixtureRuntime(cwd: string, fixture: Fixture) {
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: path.join(cwd, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	}).then((modelRuntime) => {
		modelRuntime.registerProvider("local-preplan-e2e", {
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
			streamSimple: (_model: unknown, context: { messages: Array<{ role?: string }>; systemPrompt: string }) => {
				fixture.calls.push(structuredClone({ messages: context.messages, systemPrompt: context.systemPrompt }));
				const index = Math.min(fixture.calls.length, fixture.script.length) - 1;
				const step = fixture.script[index] ?? { kind: "text", text: "done" };
				const tool = step.kind === "plans";
				const message = {
					role: "assistant",
					api: "openai-completions",
					provider: "local-preplan-e2e",
					model: "fixture",
					content: tool
						? [
							{
								type: "toolCall",
								id: `call-${fixture.calls.length}`,
								name: "plans",
								arguments: {
									action: "start-run",
									topic: "preplan-e2e",
									skill: "plan-normal",
									requestText: "Pre-plan compaction e2e",
								},
							},
						]
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

async function makeSession(cwd: string, fixture: Fixture) {
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false, keepRecentTokens: 2_000 },
		retry: { enabled: false },
	} as never);
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
		model: modelRuntime.getModel("local-preplan-e2e", "fixture")!,
		thinkingLevel: "off",
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		tools: ["plans"],
		customTools: [],
	});
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "rpc",
		uiContext: {
			setStatus: () => {},
			notify: () => {},
			confirm: async () => true,
			select: async (_title: string, options: string[]) => options[0],
			input: async () => "typed",
			theme: { fg: (_c: string, text: string) => text },
		} as never,
		onError: (error: { error: string }) => errors.push(error.error),
	});
	return { session, errors };
}

describe("pre-plan compaction on the real host", () => {
	it("compacts after `plans start-run` without aborting the turn or resuming", { timeout: 60000 }, async () => {
		serial += 1;
		const cwd = path.join(root, `repo-${serial}`);
		fs.mkdirSync(cwd, { recursive: true });
		spawnSync("git", ["init"], { cwd });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
		spawnSync("git", ["config", "user.name", "T"], { cwd });
		initState(cwd);

		const fixture: Fixture = {
			script: [
				{ kind: "text", text: "Answering the first question." },
				{ kind: "text", text: "Answering the second question." },
				{ kind: "plans" },
				{ kind: "text", text: "Planning continues on the lean context." },
				{ kind: "text", text: "Answering the fourth question." },
			],
			calls: [],
		};
		const { session, errors } = await makeSession(cwd, fixture);
		try {
			await session.prompt(FIRST_PROMPT);
			await session.prompt(SECOND_PROMPT);
			await session.prompt(PLANS_PROMPT);
			await session.prompt(FOURTH_PROMPT);
			await session.waitForIdle();

			const manager = session.sessionManager as unknown as {
				getEntries: () => Array<Record<string, unknown>>;
				buildSessionProjection: () => { messages: unknown[] };
			};
			const entries = manager.getEntries();

			// 1. No aborted assistant message anywhere (symptom 1).
			const aborted = entries.filter((entry) => {
				const message = (entry as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
				if (message?.role !== "assistant") return false;
				return message.stopReason === "error" || /this operation was aborted/i.test(message.errorMessage ?? "");
			});
			assert.equal(aborted.length, 0, `no aborted assistant messages: ${JSON.stringify(aborted.slice(0, 2))}`);

			// 2. A real VCC planning compaction landed (symptom-free lean context).
			const compactions = entries.filter((entry) => entry.type === "compaction");
			assert.ok(compactions.length >= 1, "a compaction entry exists");
			const details = compactions[0].details as { compactor?: string; phase?: string } | undefined;
			assert.equal(details?.compactor, "pi-vcc");
			assert.equal(details?.phase, "planning");

			// 3. Nothing had to resume the aborted turn (symptom 2).
			const resumes = entries.filter((entry) => (entry as { customType?: string }).customType === "pi-plans-preplan-resume");
			assert.equal(resumes.length, 0, "no pre-plan resume message is needed");

			// 4. The compaction is part of the live projected context (the next
			//    provider request runs on the compacted session). How MUCH a small
			//    fixture session summarizes depends on the VCC cut policy (a tiny tail
			//    can cut below the last user anchor), so this asserts the summary is
			//    applied rather than a specific message count.
			const projection = manager.buildSessionProjection();
			const projectionText = JSON.stringify(projection.messages);
			assert.ok(projectionText.includes("[Session Goal]"), "the VCC summary is in the projected context");
			const lastCall = fixture.calls[fixture.calls.length - 1];
			assert.ok(JSON.stringify(lastCall.messages).includes("PLANS-PROMPT-MARKER"), "the kept turn survives the compaction");
			assert.equal(errors.length, 0, `extension errors: ${JSON.stringify(errors)}`);
		} finally {
			session.dispose();
		}
	});
});
