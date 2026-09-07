import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	GOAL_WAIT_CUSTOM_TYPE, filterGoalWaitMessages, getExecution, noteCompactionStarted,
	registerExecutionTurnHandlers, restoreFromSession, startExecution, stopExecution,
} from "../src/exec.ts";
import { executeCommand, executeHandoff, setCurrentApi } from "../tools/execute-plan.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

async function setup(mode = "tui") {
	const cwd = path.join(root, String(++serial));
	fs.mkdirSync(cwd);
	const planPath = path.join(cwd, "PLAN_v1.md");
	fs.writeFileSync(planPath, "## Verifier Checklist\n- [ ] `VC-001` first\n- [ ] `VC-002` second\n");
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const messages: any[] = [];
	const entries: any[] = [];
	const notices: string[] = [];
	const pending: unknown[] = [];
	let idle = true;
	let status = "";
	const ctx: any = {
		cwd, mode, hasUI: mode === "tui" || mode === "rpc", sessionManager: {},
		isIdle: () => idle, hasPendingMessages: () => pending.length > 0,
		ui: { setStatus: (_key: string, s: string) => { status = s; },
			notify: (s: string) => notices.push(s), theme: { fg: (_c: string, s: string) => s },
			confirm: async () => { throw new Error("same-plan resume must not re-enter handoff"); } },
	};
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendUserMessage: () => { throw new Error("goal-wait must not impersonate a user"); },
		sendMessage: (message: any, options: any) => {
			messages.push({ ...message, options });
			if (message.customType === GOAL_WAIT_CUSTOM_TYPE && options?.triggerTurn) idle = false;
		},
	};
	registerExecutionTurnHandlers(pi);
	setCurrentApi(pi);
	await startExecution(pi, ctx, planPath, [
		{ id: "VC-001", text: "first", done: false }, { id: "VC-002", text: "second", done: false },
	]);
	const emit = async (name: string, event = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const begin = async () => { idle = false; await emit("agent_start"); };
	const turn = async (text = "working", stopReason = "stop") => emit("turn_end", {
		message: { role: "assistant", stopReason, content: [{ type: "text", text },
			...(stopReason === "toolUse" ? [{ type: "toolCall", id: "call", name: "read", arguments: {} }] : [])],
			usage: { input: 10, output: 5 } }, toolResults: [],
	});
	const settle = async () => { idle = true; await emit("agent_settled"); };
	const run = async (text = "working", stopReason = "stop") => { await begin(); await turn(text, stopReason); await settle(); };
	return { pi, ctx, planPath, messages, entries, notices, pending, emit, begin, turn, settle, run,
		wakes: () => messages.filter(m => m.customType === GOAL_WAIT_CUSTOM_TYPE),
		status: () => status, setIdle: (value: boolean) => { idle = value; } };
}

describe("goal-wait settled lifecycle", () => {
	it("never queues on ten tool turns and never wakes after completion", async () => {
		const h = await setup();
		await h.begin();
		for (let i = 0; i < 10; i++) await h.turn("working", "toolUse");
		assert.equal(h.wakes().length, 0);
		assert.equal(getExecution()?.goalWait?.noProgressRounds, 0);
		await h.turn("[DONE:VC-001] [DONE:VC-002]");
		await h.settle();
		await h.settle();
		assert.equal(getExecution(), null);
		assert.equal(h.wakes().length, 0);
		assert.equal(h.messages.filter(m => m.customType === "pi-plans-complete").length, 1);
	});

	for (const mode of ["tui", "rpc"]) {
		it(`${mode}: sends one hidden fresh wake and deduplicates settled`, async () => {
			const h = await setup(mode);
			await h.run("[DONE:VC-001]");
			await h.settle();
			const [wake] = h.wakes();
			assert.equal(h.wakes().length, 1);
			assert.equal(wake.display, false);
			assert.equal(wake.options.triggerTurn, true);
			assert.match(wake.content, /1\/2 verifier items done/);
			assert.match(wake.content, /- `VC-002` second/);
			assert.doesNotMatch(wake.content, /- `VC-001` first/);
			assert.deepEqual(filterGoalWaitMessages([wake]), [wake]);
			assert.equal(getExecution()?.goalWait?.noProgressRounds, 0);
		});
	}

	for (const mode of ["print", "json"]) {
		it(`${mode}: tracks markers without any automatic wake`, async () => {
			const h = await setup(mode);
			await h.run("[DONE:VC-001]");
			assert.equal(getExecution()?.items[0].done, true);
			await h.run("failed", "error");
			await h.run("[DONE:VC-002]");
			assert.equal(h.wakes().length, 0);
			assert.equal(getExecution(), null);
			assert.equal(h.messages.find(m => m.customType === "pi-plans-complete").options.triggerTurn, false);
		});
	}

	for (const gate of ["busy", "pending", "inFlight", "resumeGuard", "pendingFollowUpPrompt", "lifecycle"]) {
		it(`does not send or count when ${gate} owns continuation`, async () => {
			const h = await setup();
			await h.begin();
			await h.turn();
			h.setIdle(gate !== "busy");
			if (gate === "pending") h.pending.push("user message", { customType: "another-extension" });
			else if (gate === "lifecycle") noteCompactionStarted(h.ctx, undefined);
			else if (gate !== "busy") h.ctx.sessionManager.__executionCompaction = { [gate]: gate === "pendingFollowUpPrompt" ? "follow-up" : true };
			const original = structuredClone(h.pending);
			await h.emit("agent_settled");
			assert.equal(h.wakes().length, 0);
			assert.equal(getExecution()?.goalWait?.noProgressRounds, 0);
			assert.deepEqual(h.pending, original);
			if (gate === "busy") {
				await h.settle();
				assert.equal(h.wakes().length, 1, "a busy notification must not consume the real settled cycle");
			}
		});
	}

	for (const stopReason of ["error", "aborted"]) {
		it(`${stopReason}: pauses once and only genuine input resumes`, async () => {
			const h = await setup();
			await h.run("failed", stopReason);
			assert.equal(getExecution()?.goalWait?.paused, true);
			await h.settle();
			assert.equal(h.notices.length, 1);
			await h.emit("input", { source: "extension" });
			await h.emit("before_agent_start");
			assert.equal(getExecution()?.goalWait?.paused, true);
			assert.equal(h.wakes().length, 0);
			await h.emit("input", { source: "rpc" });
			assert.equal(getExecution()?.goalWait?.paused, false);
			assert.equal(h.wakes().length, 0, "input is already owned by Pi");
			await h.run();
			assert.equal(h.wakes().length, 1);
		});
	}

	it("leaves retries to Pi and refuses unknown or intentional tool termination", async () => {
		const h = await setup();
		await h.begin();
		await h.turn("retryable failure", "error");
		await h.emit("agent_end");
		assert.equal(h.wakes().length, 0);
		assert.equal(getExecution()?.goalWait?.paused, false);
		await h.turn("recovered");
		await h.settle();
		assert.equal(h.wakes().length, 1);
		for (const reason of ["toolUse", "length", "unknown"]) await h.run("intentional stop", reason);
		assert.equal(h.wakes().length, 1);
	});

	for (const [text, count, field] of [["working", 3, "noProgressRounds"], ["waiting for CI", 6, "waitRounds"]] as const) {
		it(`pauses at ${count} ${field} settled cycles, not intermediate turns`, async () => {
			const h = await setup();
			for (let i = 1; i <= count; i++) {
				await h.begin();
				for (let j = 0; j < 4; j++) await h.turn("tool work", "toolUse");
				assert.equal(getExecution()?.goalWait?.[field], i - 1);
				await h.turn(text);
				await h.settle();
				await h.settle();
				assert.equal(getExecution()?.goalWait?.[field], i);
			}
			assert.equal(h.wakes().length, count - 1);
			assert.equal(getExecution()?.goalWait?.paused, true);
			assert.match(h.status(), /goal-wait paused/);
		});
	}

	it("real progress resets both nonzero counters through registered handlers", async () => {
		const h = await setup();
		await h.run();
		await h.run("waiting for tests");
		assert.equal(getExecution()?.goalWait?.noProgressRounds, 1);
		assert.equal(getExecution()?.goalWait?.waitRounds, 1);
		await h.run("[DONE:VC-001]");
		assert.equal(getExecution()?.goalWait?.noProgressRounds, 0);
		assert.equal(getExecution()?.goalWait?.waitRounds, 0);
		const persisted = h.entries.filter(e => e.customType === "pi-plans-exec").at(-1).data;
		assert.equal(persisted.items[0].done, true);
		assert.equal(persisted.goalWait.noProgressRounds, 0);
	});

	it("same-plan explicit handoff resumes without losing verified progress", async () => {
		const h = await setup();
		await h.run("[DONE:VC-001]");
		await h.run("cancelled", "aborted");
		const ex = getExecution()!;
		const before = structuredClone(ex);
		const outcome = await executeCommand(h.ctx, h.planPath);
		assert.equal(outcome.status, "executing");
		assert.equal(getExecution(), ex);
		assert.deepEqual(ex.items, before.items);
		assert.deepEqual(ex.usage, before.usage);
		assert.equal(ex.startedAt, before.startedAt);
		assert.equal(ex.goalWait?.paused, false);
		assert.equal(h.wakes().length, 2);
		await executeCommand(h.ctx, h.planPath);
		assert.equal(h.wakes().length, 2);
		await assert.rejects(executeHandoff(h.ctx, h.planPath), /must not re-enter handoff/);
		const other = path.join(h.ctx.cwd, "PLAN_v2.md");
		fs.copyFileSync(h.planPath, other);
		await assert.rejects(executeCommand(h.ctx, other), /must not re-enter handoff/);
	});

	it("a paused command during another run preserves its next settled opportunity", async () => {
		const h = await setup();
		await h.run("interrupted", "aborted");
		await h.begin();
		const outcome = await executeCommand(h.ctx, h.planPath);
		assert.equal(outcome.status, "executing");
		assert.equal(getExecution()?.goalWait?.paused, false);
		assert.equal(h.wakes().length, 0, "busy command must not enqueue a kick");
		await h.turn("still incomplete");
		await h.settle();
		assert.equal(h.wakes().length, 1);
	});

	it("restore preserves pause and counters but cannot replay a wake", async () => {
		const h = await setup();
		for (let i = 0; i < 3; i++) await h.run();
		const oldWake = h.wakes().at(-1);
		const before = structuredClone(getExecution()?.goalWait);
		await restoreFromSession(h.pi, h.ctx, h.entries);
		await h.settle();
		assert.deepEqual(getExecution()?.goalWait, before);
		assert.equal(h.wakes().length, 2);
		assert.deepEqual(filterGoalWaitMessages([oldWake]), []);
	});

	for (const exit of ["stop", "complete", "replacement", "shutdown"]) {
		it(`${exit} invalidates wake identity without filtering user messages`, async () => {
			const h = await setup();
			await h.run();
			const wake = h.wakes()[0];
			if (exit === "stop") await stopExecution(h.pi, h.ctx, "test");
			if (exit === "complete") await h.turn("[DONE:VC-001] [DONE:VC-002]");
			if (exit === "replacement") await startExecution(h.pi, h.ctx, h.planPath, [{ id: "VC-003", text: "new", done: false }]);
			if (exit === "shutdown") await h.emit("session_shutdown");
			await h.settle();
			const user = { role: "user", content: "Goal wait: this is my text" };
			const other = { customType: "another-extension", content: "continue" };
			assert.deepEqual(filterGoalWaitMessages([wake, user, other]), [user, other]);
			assert.equal(h.wakes().length, 1);
		});
	}

	it("a synchronous dispatch failure pauses once instead of leaving a retry lock", async () => {
		const h = await setup();
		h.pi.sendMessage = () => { throw new Error("dispatch failed"); };
		await h.run();
		await h.settle();
		assert.equal(getExecution()?.goalWait?.paused, true);
		assert.match(h.notices[0], /dispatch failed/);
		assert.equal(h.notices.length, 1);
	});
});
