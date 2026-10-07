import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setSessionFactoryForTests, runAgentSession, startAgentSession, splitSelector } from "../src/agent-session.ts";
import type { SubagentProgressEvent } from "../src/subagent.ts";
import { FakeSession, type FakeBehavior } from "./fake-agent-session.ts";

const MODEL = { provider: "fake", id: "model" };
const host = {
	model: MODEL,
	modelRegistry: { find: (provider: string, id: string) => (provider === "devin" && id === "claude-sonnet-5.5" ? { provider, id } : undefined) },
};

let lastOptions: Record<string, unknown> | undefined;
let lastSession: FakeSession | undefined;

function install(behavior: FakeBehavior): void {
	__setSessionFactoryForTests(async (options) => {
		lastOptions = options;
		lastSession = new FakeSession(behavior);
		return { session: lastSession };
	});
}

afterEach(() => {
	__setSessionFactoryForTests(null);
	lastOptions = undefined;
	lastSession = undefined;
});

const base = { systemPrompt: "sp", task: "do it", cwd: process.cwd(), host };

describe("runAgentSession", () => {
	it("returns the final assistant text, forwards progress and sums usage", async () => {
		install(async (api) => {
			api.emit({ type: "turn_start" });
			api.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
			api.say("first", { usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1, cost: { total: 0.01 } } });
			api.say("final conclusion", { usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } });
		});
		const progress: string[] = [];
		const result = await runAgentSession({ ...base, onProgress: (event: SubagentProgressEvent) => progress.push(`${event.type}:${"phase" in event ? event.phase : ""}`) });
		assert.equal(result.ok, true);
		assert.equal(result.output, "final conclusion");
		assert.equal(result.model, "fake/model");
		assert.equal(result.turns, 2);
		assert.equal(result.usage?.input, 30);
		assert.equal(result.usage?.cacheRead, 3);
		assert.ok(Math.abs((result.usage?.cost ?? 0) - 0.03) < 1e-9);
		assert.ok(progress.includes("process:started"));
		assert.ok(progress.includes("transcript:update"));
		assert.ok(progress.includes("process:exited"));
		assert.equal(lastSession?.disposed, true, "one-shot runs dispose the session");
		assert.match(lastSession?.prompts[0] ?? "", /^Task: do it/);
	});

	it("omits usage when the session reports none", async () => {
		install((api) => api.say("final"));
		const result = await runAgentSession(base);
		assert.equal(result.ok, true);
		assert.equal(result.usage, undefined);
	});

	it("resolves the exact provider/model selector and passes thinking only when set", async () => {
		install((api) => api.say("ok"));
		await runAgentSession({ ...base, model: "devin/claude-sonnet-5.5", thinkingLevel: "high" });
		assert.deepEqual(lastOptions?.model, { provider: "devin", id: "claude-sonnet-5.5" });
		assert.equal(lastOptions?.thinkingLevel, "high");
		await runAgentSession({ ...base, model: "devin/claude-sonnet-5.5" });
		assert.equal("thinkingLevel" in (lastOptions ?? {}), false, "null level must not set thinkingLevel");
		await runAgentSession({ ...base, thinkingLevel: "off" });
		assert.equal(lastOptions?.thinkingLevel, "off", "explicit off is a real value");
		assert.deepEqual(lastOptions?.model, MODEL, "no selector inherits the dispatching model");
	});

	it("defaults to the read-only tool allowlist and forwards custom tools", async () => {
		install((api) => api.say("ok"));
		await runAgentSession(base);
		assert.deepEqual(lastOptions?.tools, ["read", "grep", "find", "ls"]);
		await runAgentSession({ ...base, customTools: [{ name: "x" }] });
		assert.deepEqual(lastOptions?.tools, ["read", "grep", "find", "ls", "x"], "custom tools are allowlisted too (the SDK enables only named tools)");
		assert.deepEqual(lastOptions?.customTools, [{ name: "x" }]);
	});

	it("fails cleanly for an unknown or malformed selector", async () => {
		install((api) => api.say("ok"));
		const missing = await runAgentSession({ ...base, model: "nope/none" });
		assert.equal(missing.ok, false);
		assert.match(missing.errorMessage ?? "", /not available/);
		const bad = await runAgentSession({ ...base, model: "noslash" });
		assert.match(bad.errorMessage ?? "", /invalid model selector/);
		assert.equal(lastSession, undefined, "no session is created for an unresolved model");
	});

	it("rejects an errored final turn instead of reporting success", async () => {
		install((api) => api.say("partial", { stopReason: "error", errorMessage: "rate limited" }));
		const result = await runAgentSession(base);
		assert.equal(result.ok, false);
		assert.equal(result.errorMessage, "rate limited");
	});

	it("reports no final output as a failure", async () => {
		install(() => undefined);
		const result = await runAgentSession(base);
		assert.equal(result.ok, false);
		assert.match(result.errorMessage ?? "", /no final output/);
	});

	it("returns a cancelled result on abort", async () => {
		install(async (api) => {
			await api.aborted;
		});
		const abort = new AbortController();
		const promise = runAgentSession({ ...base, signal: abort.signal, timeoutMs: 5000 });
		setTimeout(() => abort.abort(), 20);
		const result = await promise;
		assert.equal(result.ok, false);
		assert.equal(result.cancelled, true);
		assert.equal(result.timedOut, undefined);
	});

	it("returns a timed out result when the run exceeds the budget", async () => {
		install(async (api) => {
			await api.aborted;
		});
		const result = await runAgentSession({ ...base, timeoutMs: 30 });
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.equal(result.cancelled, undefined);
	});

	it("turns a thrown prompt into a failed result", async () => {
		install(() => {
			throw new Error("boom");
		});
		const result = await runAgentSession(base);
		assert.equal(result.ok, false);
		assert.equal(result.errorMessage, "boom");
	});
});

describe("startAgentSession handle", () => {
	it("runs several prompts on the same live session", async () => {
		install((api) => api.say(`answer to ${api.prompt}`));
		const started = await startAgentSession(base);
		assert.ok("handle" in started);
		const { handle } = started as { handle: Awaited<ReturnType<typeof startAgentSession>> extends infer R ? Extract<R, { handle: unknown }>["handle"] : never };
		const one = await handle.run("wave 1");
		const two = await handle.run("wave 2");
		assert.equal(one.output, "answer to wave 1");
		assert.equal(two.output, "answer to wave 2");
		assert.equal(two.turns, 1, "turn count is per run");
		assert.deepEqual(lastSession?.prompts, ["wave 1", "wave 2"]);
		assert.equal(lastSession?.disposed, false, "the handle owns disposal");
		handle.dispose();
		assert.equal(lastSession?.disposed, true);
	});

	it("steers a running session without ending it", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		install(async (api) => {
			await gate;
			api.say(`saw ${api.steered.length} steer`);
		});
		const started = await startAgentSession(base);
		assert.ok("handle" in started);
		const handle = (started as { handle: { run: (t: string) => Promise<{ output: string }>; steer: (t: string) => void; isRunning: () => boolean; dispose: () => void } }).handle;
		const running = handle.run("go");
		assert.equal(handle.isRunning(), true);
		handle.steer("also check the tests");
		release();
		const result = await running;
		assert.deepEqual(lastSession?.steered, ["also check the tests"]);
		assert.equal(result.output, "saw 1 steer");
		handle.dispose();
	});

	it("buffers a steer sent while idle into the next prompt", async () => {
		install((api) => api.say("ok"));
		const started = await startAgentSession(base);
		assert.ok("handle" in started);
		const handle = (started as { handle: { run: (t: string) => Promise<unknown>; steer: (t: string) => void; dispose: () => void } }).handle;
		handle.steer("remember the lint rule");
		await handle.run("next task");
		assert.match(lastSession?.prompts[0] ?? "", /^remember the lint rule\n\nnext task$/);
		assert.deepEqual(lastSession?.steered, []);
		handle.dispose();
	});

	it("refuses a second concurrent run", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		install(async (api) => {
			await gate;
			api.say("ok");
		});
		const started = await startAgentSession(base);
		const handle = (started as { handle: { run: (t: string) => Promise<{ ok: boolean; errorMessage?: string }>; dispose: () => void } }).handle;
		const first = handle.run("a");
		const second = await handle.run("b");
		assert.equal(second.ok, false);
		assert.match(second.errorMessage ?? "", /already running/);
		release();
		assert.equal((await first).ok, true);
		handle.dispose();
	});
});

describe("splitSelector", () => {
	it("splits at the first slash and keeps slashes in the model id", () => {
		assert.deepEqual(splitSelector("openrouter/anthropic/claude"), { provider: "openrouter", id: "anthropic/claude" });
		assert.equal(splitSelector("noslash"), null);
		assert.equal(splitSelector("/x"), null);
		assert.equal(splitSelector("x/"), null);
	});
});
