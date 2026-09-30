/**
 * Stale-ctx regression (PLAN_v2 2026-09-30, revised after SDK source audit).
 *
 * SDK facts this encodes (pi 0.99.0, agent-session.js / extensions/runner.js):
 * - The per-call ExtensionContext does NOT carry appendEntry/sendMessage/
 *   sendUserMessage — those live only on the ExtensionAPI ("pi") handed to
 *   the extension factory.
 * - Session replacement (newSession/fork/switchSession) disposes the old
 *   session: every old ctx/pi channel throws ("stale"). The NEW session's
 *   runner RE-RUNS every extension factory, which is where index.ts refreshes
 *   the module-level messaging reference (setMessagingApi). Note: compaction
 *   itself is in-session and does NOT invalidate; only a replacement/reload
 *   that follows does.
 *
 * So the correct contract is: after a session swap, once the factory has
 * re-run for the new session, all pi-plans paths complete using ONLY the new
 * session's messaging surface; the old one is never touched. The narrow race
 * window (a call dispatched before the new factory ran) surfaces the stale
 * error — asserted here as documented behavior.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerExecutePlanTool, executeCommand } from "../tools/execute-plan.ts";
import { registerPlansTool } from "../tools/plans.ts";
import { getExecution, stopExecution } from "../src/exec.ts";
import { initState } from "../src/state.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { AUTO_APPROVE_ENV } from "../src/auto-approve.ts";

const PLAN = `## Tasks

- Task-1: only — files: src/a.ts; wave: 1

### Execution Waves

- wave 1: Task-1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: x
`;

let root: string;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-stale-ctx-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env[AUTO_APPROVE_ENV];
	setMessagingApi(null);
});

interface Recorder {
	appendEntry: number;
	sendMessage: number;
	sendUserMessage: number;
}

/** A per-call ctx with the REAL ExtensionContext shape: no messaging methods. */
function makeCallCtx(workdir: string): ExtensionContext {
	return {
		cwd: workdir,
		sessionManager: {},
		hasUI: false,
		mode: "print",
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

/** The messaging surface of one session's pi. Throws on every channel once
 * stale flips — exactly what the runner does to old ctx/pi after replacement. */
function makeSessionPi(): { calls: Recorder; setStale: () => void; api: ExtensionAPI } {
	let stale = false;
	const calls: Recorder = { appendEntry: 0, sendMessage: 0, sendUserMessage: 0 };
	const guard = (name: keyof Recorder) => {
		if (stale) throw new Error(`stale ctx: ${name} called after session replacement`);
		calls[name] += 1;
	};
	const api = {
		appendEntry: () => guard("appendEntry"),
		sendMessage: () => guard("sendMessage"),
		sendUserMessage: async () => guard("sendUserMessage"),
		registerTool: (def: { name: string }) => def,
	} as unknown as ExtensionAPI;
	return { calls, setStale: () => { stale = true; }, api };
}

function writePlan(workdir: string): string {
	const planPath = path.join(workdir, "PLAN_v1.md");
	fs.writeFileSync(planPath, PLAN, "utf8");
	return planPath;
}

describe("stale ctx: messaging follows the factory re-run, never the registration capture", () => {
	it("execute_plan tool path completes on the new session's pi only", async () => {
		const workdir = path.join(root, "tool-path");
		fs.mkdirSync(workdir, { recursive: true });
		initState(workdir);
		const planPath = writePlan(workdir);

		// Session A: factory ran (messaging = pi A). Session replaced: pi A is stale.
		const a = makeSessionPi();
		setMessagingApi(a.api);
		registerExecutePlanTool(a.api);
		a.setStale();

		// Session B: its runner re-runs the factory → messaging refreshed to pi B.
		const b = makeSessionPi();
		setMessagingApi(b.api);
		const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
		const extB = { registerTool: (def: { name: string } & { execute: (...args: never[]) => Promise<unknown> }) => tools.set(def.name, def) } as unknown as ExtensionAPI;
		registerExecutePlanTool(extB);

		process.env[AUTO_APPROVE_ENV] = "1";
		try {
			// The per-call ctx carries no messaging; all writes go through pi B.
			await tools.get("execute_plan")!.execute("t1", { planPath } as never, undefined as never, undefined as never, makeCallCtx(workdir) as never);
		} finally {
			delete process.env[AUTO_APPROVE_ENV];
		}
		assert.ok(getExecution(), "execution started");
		assert.ok(b.calls.appendEntry > 0, "pi-plans-exec persisted via pi B");
		assert.ok(b.calls.sendMessage > 0, "exec-start message sent via pi B");
		assert.equal(a.calls.appendEntry + a.calls.sendMessage + a.calls.sendUserMessage, 0, "stale pi A never touched");
		await stopExecution(makeCallCtx(workdir), "test teardown");
	});

	it("plans start-run appends pi-plans-run-start on the new session's pi only", async () => {
		const workdir = path.join(root, "start-run-path");
		fs.mkdirSync(workdir, { recursive: true });
		initState(workdir);

		const a = makeSessionPi();
		setMessagingApi(a.api);
		registerPlansTool(a.api);
		a.setStale();

		const b = makeSessionPi();
		setMessagingApi(b.api);

		const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
		const extB = { registerTool: (def: { name: string } & { execute: (...args: never[]) => Promise<unknown> }) => tools.set(def.name, def) } as unknown as ExtensionAPI;
		registerPlansTool(extB);

		const result = (await tools.get("plans")!.execute(
			"t1",
			{ action: "start-run", topic: "stale-check", skill: "plan-small", requestText: "x" } as never,
			undefined as never,
			undefined as never,
			makeCallCtx(workdir) as never,
		)) as { content: Array<{ text: string }> };
		const payload = JSON.parse(result.content[0]!.text) as { run: { run_id: string } };
		assert.ok(payload.run.run_id);
		assert.equal(b.calls.appendEntry, 1, "run-start entry appended via pi B");
		assert.equal(a.calls.appendEntry + a.calls.sendMessage + a.calls.sendUserMessage, 0, "stale pi A never touched");
	});

	it("documents the race window: before the factory re-runs, the stale error propagates", async () => {
		const workdir = path.join(root, "race-window");
		fs.mkdirSync(workdir, { recursive: true });
		initState(workdir);
		writePlan(workdir);

		// Session A's pi is still the messaging surface and has just gone stale
		// (the new session's factory has not re-run yet in this process). With
		// auto-approve on, the handoff reaches startExecution, which creates the
		// in-memory execution and then fails its first REQUIRED persistence write
		// (pi-plans-exec appendEntry) on the stale surface — the exact incident.
		const a = makeSessionPi();
		setMessagingApi(a.api);
		a.setStale();

		process.env[AUTO_APPROVE_ENV] = "1";
		try {
			await assert.rejects(
				() => executeCommand(makeCallCtx(workdir), path.join(workdir, "PLAN_v1.md")),
				/stale/,
				"a required persistence write dispatched before the new factory ran surfaces the stale error",
			);
		} finally {
			delete process.env[AUTO_APPROVE_ENV];
		}
		// The crashed window leaves the in-memory execution created but unpersisted.
		assert.ok(getExecution(), "crashed handoff left the in-memory execution created");
		// The sanctioned recovery starts with the new session's factory re-run;
		// from here on every write goes through the new pi only.
		const b = makeSessionPi();
		setMessagingApi(b.api);
		await stopExecution(makeCallCtx(workdir), "test teardown");

		// A full retry completes using only the new session's pi.
		process.env[AUTO_APPROVE_ENV] = "1";
		let outcome: Awaited<ReturnType<typeof executeCommand>>;
		try {
			outcome = await executeCommand(makeCallCtx(workdir), path.join(workdir, "PLAN_v1.md"));
		} finally {
			delete process.env[AUTO_APPROVE_ENV];
		}
		assert.equal(outcome.status, "executing");
		assert.ok(b.calls.appendEntry > 0 && b.calls.sendMessage > 0, "retry persisted and announced via pi B");
		assert.equal(a.calls.appendEntry + a.calls.sendMessage + a.calls.sendUserMessage, 0, "stale pi A never touched");
		await stopExecution(makeCallCtx(workdir), "test teardown");
	});
});
