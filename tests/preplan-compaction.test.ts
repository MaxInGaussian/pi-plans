/**
 * v0.10.x compaction lifecycle regressions.
 *
 * Two behaviours are pinned here, both driven through the REAL extension
 * wiring (the factory's registered handlers) rather than by calling internals:
 *
 * 1. The pre-plan compaction runs on the `turn_end` boundary as a `compaction`
 *    draft. Nothing aborts the running turn, so there is no aborted assistant
 *    message and no resume message — the exact failure mode that produced
 *    "This operation was aborted" before every compaction and occasionally
 *    never resumed the run.
 * 2. A MANUAL compaction (`/compact`) still aborts the live turn, so pi-plans
 *    resumes it exactly once — on success and on failure — gated by the raw
 *    `continueAfterThresholdCompact` setting (never the version-gated
 *    `shouldScheduleAutoContinue`), and it lifts the stall pause the settle
 *    path latched for the aborted turn.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import piPlansExtension from "../index.ts";
import { DEFAULT_VCC_SETTINGS, loadVccSettings, scaffoldVccSettings, vccSettingsPath, type CompactionEntryLike } from "../src/compaction.ts";
import {
	DISPLACED_ABORT_TTL_MS,
	PREPLAN_COMPACT_STALE_MS,
	markPrePlanCompactPending,
	pendingDisplacedAbort,
	pendingPrePlanCompaction,
	takePrePlanCompactionRequest,
} from "../src/compaction-lifecycle.ts";
import { PLANNING_PREPLAN_COMPACT_HINT } from "../src/compaction.ts";
import { getExecution, startExecution } from "../src/exec.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { bindRun } from "../src/run-context.ts";
import { initState, resolveStateRootOrNull, startRun } from "../src/state.ts";
import {
	applyExecutionApproved,
	applyPlanWritten,
	createCheckpoint,
	mutateCheckpoint,
	planIdentityOf,
} from "../src/workflow-state.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-preplan-unit-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;

const PLAN = `# PLAN_v1 - preplan unit

## Tasks

- Task-1: parser — files: src/a.ts; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: parser green
`;

interface SentMessage {
	customType?: string;
	content?: string;
	display?: boolean;
	opts?: { triggerTurn?: boolean };
}

interface ExtensionHarness {
	workdir: string;
	runId: string;
	ctx: Record<string, unknown>;
	sent: SentMessage[];
	notifies: string[];
	fire(name: string, event: unknown): Promise<unknown>;
}

/** Boots the real extension against a fake `pi` and a real workdir/run. */
function makeHarness(name: string, options: { withRun?: boolean } = {}): ExtensionHarness {
	serial += 1;
	const workdir = fs.mkdtempSync(path.join(root, `${serial}-${name}-`));
	spawnSync("git", ["init"], { cwd: workdir });
	spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
	spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
	initState(workdir);
	let runId = "";
	if (options.withRun !== false) {
		const { run } = startRun(workdir, { topic: name, skill: "plan-normal", requestText: "x" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		runId = run.run_id;
	}
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sent: SentMessage[] = [];
	const notifies: string[] = [];
	const pi = {
		on(handlerName: string, fn: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(handlerName) ?? [];
			list.push(fn);
			handlers.set(handlerName, list);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		sendMessage(message: SentMessage, opts?: { triggerTurn?: boolean }) {
			sent.push({ ...message, opts });
		},
		sendUserMessage: async () => {},
		appendEntry() {},
	};
	piPlansExtension(pi as never);
	setMessagingApi(pi as never);
	const sessionManager: Record<string, unknown> = {
		// The handler reads the session branch (the same source
		// `session_before_compact` receives), not the projected `event.context`.
		getBranch: () => branchEntries(),
	};
	if (options.withRun !== false) bindRun(sessionManager, workdir, runId);
	const ctx = {
		cwd: workdir,
		sessionManager,
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string) => notifies.push(message),
			setStatus() {},
			setWidget() {},
			theme: { fg: (_c: string, text: string) => text },
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
	} as Record<string, unknown>;
	return {
		workdir,
		runId,
		ctx,
		sent,
		notifies,
		async fire(handlerName: string, event: unknown) {
			let last: unknown;
			for (const fn of handlers.get(handlerName) ?? []) {
				const result = await fn(event, ctx);
				if (result !== undefined) last = result;
			}
			return last;
		},
	};
}

function writeVccSettings(workdir: string, overrides: Partial<typeof DEFAULT_VCC_SETTINGS>): void {
	const stateRoot = resolveStateRootOrNull(workdir);
	assert.ok(stateRoot, "state root resolves");
	scaffoldVccSettings(stateRoot);
	fs.writeFileSync(vccSettingsPath(stateRoot), JSON.stringify({ ...DEFAULT_VCC_SETTINGS, ...overrides }), "utf8");
}

function messageEntry(id: string, role: string, text: string): CompactionEntryLike {
	return { id, type: "message", message: { role, content: [{ type: "text", text }] } };
}

/** Enough live messages for the VCC cut (>= 3 live, at least two user turns). */
function branchEntries(): CompactionEntryLike[] {
	return [
		messageEntry("u1", "user", "please plan something for this repository"),
		messageEntry("a1", "assistant", "sure, let me look around first"),
		messageEntry("u2", "user", "more details to give the cut something to work with"),
		messageEntry("a2", "assistant", "ok, planning now"),
		messageEntry("u3", "user", "continue with the interview"),
		messageEntry("a3", "assistant", "working on it"),
	];
}

function turnEndEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {},
		toolResults: [{ toolName: "plans", isError: false }],
		context: { contextEntries: branchEntries() },
		...overrides,
	};
}

function abortMessage(): Record<string, unknown> {
	return { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" };
}

function beforeCompactEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "session_before_compact",
		customInstructions: PLANNING_PREPLAN_COMPACT_HINT,
		reason: "manual",
		willRetry: false,
		branchEntries: branchEntries(),
		preparation: { firstKeptEntryId: undefined, tokensBefore: undefined, previousSummary: null, fileOps: undefined },
		signal: new AbortController().signal,
		...overrides,
	};
}

function compactEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "session_compact", reason: "manual", willRetry: false, fromExtension: false, compactionEntry: { id: "c1" }, ...overrides };
}

function compactFailedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "session_compact_failed", reason: "manual", willRetry: false, aborted: true, errorMessage: "Compaction cancelled", fromExtension: false, ...overrides };
}

const resumeMessages = (sent: SentMessage[]): SentMessage[] =>
	sent.filter((message) => message.customType === "pi-plans-plan-resume" || message.customType === "pi-plans-exec-resume");

describe("pre-plan compaction on the turn_end boundary", () => {
	it("returns one VCC compaction draft, consumes the request, and never resumes", async () => {
		const harness = makeHarness("draft");
		markPrePlanCompactPending(harness.ctx, harness.runId);
		const result = await harness.fire("turn_end", turnEndEvent()) as { entries?: Array<Record<string, unknown>> } | undefined;
		assert.equal(result?.entries?.length, 1, "exactly one boundary draft");
		const draft = result!.entries![0];
		assert.equal(draft.type, "compaction");
		assert.equal((draft.details as { compactor?: string }).compactor, "pi-vcc");
		assert.equal((draft.details as { phase?: string }).phase, "planning");
		assert.equal(typeof draft.summary, "string");
		assert.equal(typeof draft.firstKeptEntryId, "string");
		assert.equal(pendingPrePlanCompaction(harness.ctx), null, "request consumed");
		assert.ok(harness.notifies.some((n) => n.includes("pi-vcc")), "success stats are notified");
		assert.equal(resumeMessages(harness.sent).length, 0, "nothing was aborted, so nothing resumes");
		assert.equal(pendingDisplacedAbort(harness.ctx), false, "no abort observation");
	});

	it("ignores turns that do not carry the plans tool result", async () => {
		const harness = makeHarness("no-plans");
		markPrePlanCompactPending(harness.ctx, harness.runId);
		const result = await harness.fire("turn_end", turnEndEvent({ toolResults: [{ toolName: "read", isError: false }] }));
		assert.equal(result, undefined);
		assert.ok(pendingPrePlanCompaction(harness.ctx), "request stays pending for the plans turn");
	});

	it("produces no second draft for the same request", async () => {
		const harness = makeHarness("once");
		markPrePlanCompactPending(harness.ctx, harness.runId);
		await harness.fire("turn_end", turnEndEvent());
		const second = await harness.fire("turn_end", turnEndEvent({ turnIndex: 1 }));
		assert.equal(second, undefined);
	});

	it("drops a stale request silently", async () => {
		const harness = makeHarness("stale");
		markPrePlanCompactPending(harness.ctx, harness.runId, Date.now() - PREPLAN_COMPACT_STALE_MS - 1);
		const result = await harness.fire("turn_end", turnEndEvent());
		assert.equal(result, undefined);
		assert.equal(pendingPrePlanCompaction(harness.ctx), null, "stale request is cleared");
		assert.equal(harness.notifies.length, 0, "silent");
	});

	it("stays silent when the setting is off", async () => {
		const harness = makeHarness("setting-off");
		writeVccSettings(harness.workdir, { prePlanCompact: false });
		assert.equal(loadVccSettings(resolveStateRootOrNull(harness.workdir)! as string).prePlanCompact, false, "fixture setting");
		markPrePlanCompactPending(harness.ctx, harness.runId);
		const result = await harness.fire("turn_end", turnEndEvent());
		assert.equal(result, undefined);
		assert.equal(harness.notifies.length, 0, "silent");
		assert.equal(pendingPrePlanCompaction(harness.ctx), null);
	});

	it("drops the request when an execution took over", async () => {
		const harness = makeHarness("execution-guard");
		markPrePlanCompactPending(harness.ctx, harness.runId);
		assert.equal(
			takePrePlanCompactionRequest(harness.ctx, { hasExecution: true }),
			null,
			"the guard decision used by the handler drops it",
		);
		assert.equal(pendingPrePlanCompaction(harness.ctx), null);
	});

	it("keeps a request for a different run from firing", async () => {
		const harness = makeHarness("other-run");
		markPrePlanCompactPending(harness.ctx, "20260101T000000Z-other");
		assert.equal(takePrePlanCompactionRequest(harness.ctx, { activeRunId: harness.runId }), null);
		assert.equal(pendingPrePlanCompaction(harness.ctx), null);
	});
});

describe("pre-plan request state machine", () => {
	it("marks, claims once, and refuses a double claim", () => {
		const sessionManager: Record<string, unknown> = {};
		const ctx = { sessionManager };
		markPrePlanCompactPending(ctx, "run-1", 1000);
		assert.equal(pendingPrePlanCompaction(ctx)?.runId, "run-1");
		const claimed = takePrePlanCompactionRequest(ctx, { now: 1000 });
		assert.equal(claimed?.inFlight, true);
		assert.equal(pendingPrePlanCompaction(ctx)?.inFlight, true);
		assert.equal(takePrePlanCompactionRequest(ctx, { now: 1000 }), null, "second claim drops the request");
		assert.equal(pendingPrePlanCompaction(ctx), null);
	});

	it("expires a request after the staleness window", () => {
		const ctx = { sessionManager: {} };
		markPrePlanCompactPending(ctx, "run-1", 0);
		assert.equal(takePrePlanCompactionRequest(ctx, { now: PREPLAN_COMPACT_STALE_MS })?.runId, "run-1", "exactly at the window it is still claimable");
		markPrePlanCompactPending(ctx, "run-1", 0);
		assert.equal(takePrePlanCompactionRequest(ctx, { now: PREPLAN_COMPACT_STALE_MS + 1 }), null, "one millisecond later it expires silently");
	});
});

describe("displaced-abort observation", () => {
	it("records abort signatures and expires them", async () => {
		const harness = makeHarness("abort-observation");
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		assert.equal(pendingDisplacedAbort(harness.ctx), true);
		assert.equal(pendingDisplacedAbort(harness.ctx, Date.now() + DISPLACED_ABORT_TTL_MS + 1), false, "TTL expires the attribution");
	});

	it("ignores non-abort error turns and clears on user input", async () => {
		const harness = makeHarness("abort-clearing");
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: { role: "assistant", stopReason: "error", errorMessage: "provider exploded" } }));
		assert.equal(pendingDisplacedAbort(harness.ctx), false, "unrelated errors are not aborts");
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		assert.equal(pendingDisplacedAbort(harness.ctx), true);
		await harness.fire("input", { text: "please continue", source: "interactive" });
		assert.equal(pendingDisplacedAbort(harness.ctx), false, "fresh input clears the attribution");
	});
});

describe("manual compaction resume (planning)", () => {
	it("resumes exactly once after a displaced manual compaction", async () => {
		const harness = makeHarness("manual-planning");
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		await harness.fire("session_before_compact", beforeCompactEvent());
		await harness.fire("session_compact", compactEvent());
		const resumes = resumeMessages(harness.sent);
		assert.equal(resumes.length, 1, "exactly one resume");
		assert.equal(resumes[0].customType, "pi-plans-plan-resume");
		assert.equal(resumes[0].opts?.triggerTurn, true);
		assert.equal(resumes[0].display, false);
		// The latch closes after the send: a repeated terminal event must not wake again.
		await harness.fire("session_compact", compactEvent());
		assert.equal(resumeMessages(harness.sent).length, 1, "still exactly one resume");
	});

	it("resumes after a FAILED manual compaction too (the turn was already aborted)", async () => {
		const harness = makeHarness("manual-planning-failed");
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		await harness.fire("session_before_compact", beforeCompactEvent());
		await harness.fire("session_compact_failed", compactFailedEvent());
		const resumes = resumeMessages(harness.sent);
		assert.equal(resumes.length, 1, "a failed compaction still resumes the aborted turn");
		assert.equal(resumes[0].customType, "pi-plans-plan-resume");
	});

	it("does not resume when the auto-continue setting is off", async () => {
		const harness = makeHarness("manual-planning-off");
		writeVccSettings(harness.workdir, { continueAfterThresholdCompact: false });
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		await harness.fire("session_before_compact", beforeCompactEvent());
		await harness.fire("session_compact", compactEvent());
		assert.equal(resumeMessages(harness.sent).length, 0, "raw setting gate keeps the resume off");
	});

	it("does not resume a threshold compaction", async () => {
		const harness = makeHarness("threshold");
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		await harness.fire("session_before_compact", beforeCompactEvent({ reason: "threshold" }));
		await harness.fire("session_compact", compactEvent({ reason: "threshold" }));
		assert.equal(resumeMessages(harness.sent).length, 0, "only the aborting (manual) path resumes");
	});

	it("does not resume a manual compaction that displaced nothing", async () => {
		const harness = makeHarness("manual-idle");
		await harness.fire("session_before_compact", beforeCompactEvent());
		await harness.fire("session_compact", compactEvent());
		assert.equal(resumeMessages(harness.sent).length, 0);
	});
});

describe("manual compaction resume (execution)", () => {
	async function startRunExecution(harness: ExtensionHarness): Promise<string> {
		const planPath = path.join(harness.workdir, "PLAN_v1.md");
		fs.mkdirSync(path.dirname(planPath), { recursive: true });
		fs.writeFileSync(planPath, PLAN, "utf8");
		mutateCheckpoint(harness.workdir, harness.runId, (cp) =>
			applyExecutionApproved(
				applyPlanWritten({ ...cp, nextAction: "accept-execute" }, planIdentityOf(planPath, 1)),
				{ plan: planIdentityOf(planPath, 1), worktree: harness.workdir, headAtApproval: null, approvedAt: cp.updatedAt },
			),
		);
		await startExecution(harness.ctx as never, {
			planPath,
			planTasks: parsePlanTasks(PLAN),
			items: parseChecklist(PLAN),
		});
		return planPath;
	}

	it("lifts the settle pause and resumes once after a displaced manual compaction", async () => {
		const harness = makeHarness("manual-execution");
		await startRunExecution(harness);
		assert.ok(getExecution(), "execution active");
		// The aborted turn settles: the execution loop latches the stall pause
		// ("agent failed") before the compaction's terminal event arrives.
		await harness.fire("turn_end", turnEndEvent({ toolResults: [], message: abortMessage() }));
		await harness.fire("agent_settled", {});
		assert.equal(getExecution()!.stall.paused, true, "settle paused the run for the aborted turn");
		await harness.fire("session_before_compact", beforeCompactEvent({ customInstructions: "pi-plans execution auto compact" }));
		await harness.fire("session_compact", compactEvent());
		const resumes = resumeMessages(harness.sent);
		assert.equal(resumes.length, 1, "exactly one execution resume");
		assert.equal(resumes[0].customType, "pi-plans-exec-resume");
		assert.equal(resumes[0].opts?.triggerTurn, true);
		assert.equal(getExecution()!.stall.paused, false, "the resume lifts the compaction-caused pause");
		// Module-level execution state is global: release it so later suites in this
		// file are not silently guarded by an active execution.
		await harness.fire("session_shutdown", {});
		assert.equal(getExecution(), null, "execution released");
	});
});

describe("planning compaction helpers still behave", () => {
	it("keeps the planning phase context wired to the active run", async () => {
		const harness = makeHarness("context");
		markPrePlanCompactPending(harness.ctx, harness.runId);
		const result = await harness.fire("turn_end", turnEndEvent()) as { entries?: Array<Record<string, unknown>> } | undefined;
		const details = result!.entries![0].details as { reason?: string; willRetry?: boolean; phase?: string; previousSummaryUsed?: boolean };
		assert.equal(details.phase, "planning");
		assert.equal(details.reason, "manual");
		assert.equal(details.willRetry, false);
		assert.equal(details.previousSummaryUsed, false, "no previous summary in a fresh session");
	});
});
