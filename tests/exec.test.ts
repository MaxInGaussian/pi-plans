/** Tests for the execution loop: marker tracking, session restore, completion. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	AMELIORATION_PROMPT_TEXT,
	applyDoneMarkers,
	applyImplMarkers,
	applyCurrentIMarker,
	buildExecutionCompactionResult,
	buildPlanningCompactionResult,
	completeExecution,
	consumePendingExecutionFlush,
	consumePlanningCompactionResumeGuard,
	drainExecutionFlush,
	executionContextMessage,
	filterExecutionResumeMessages,
	filterPlanningResumeMessages,
	getExecution,
	resumeGoalWaitIfPaused,
	handleExecutionBeforeCompact,
	handleExecutionCompact,
	handleExecutionTurnCompaction,
	handleExecutionCompactFailed,
	compactionInFlight,
	noteCompactionStarted,
	noteCompactionEnded,
	handlePlanningBeforeCompact,
	handlePlanningCompact,
	handlePlanningCompactFailed,
	isExecutionComplete,
	PLANNING_PLAN_WRITTEN_CUSTOM_TYPE,
	PLANNING_RUN_START_CUSTOM_TYPE,
	refreshPlanningCompactionCooldown,
	requestPlanningCompaction,
	restoreFromSession,
	resetGoalWaitTurnFlags,
	shouldTriggerPlanningCompaction,
	startExecution,
	recordExecutionTurn,
	registerExecutionTurnHandlers,
	stopExecution,
	updateStatusWidget,
} from "../src/exec.ts";
import type { CheckItem } from "../src/plan.ts";
import { initState, setGraphEnabled, setRunStatus, startRun } from "../src/state.ts";

interface Recorded {
	entries: { type: string; customType?: string; data?: unknown }[];
	messages: { customType: string; content: string; options?: { triggerTurn?: boolean } }[];
	status: string | undefined;
	statusCalls: number;
	colors: string[];
	models: { provider: string; id: string }[];
	thinkingLevels: (string | null)[];
	notifies: { message: string; severity: string }[];
	selects: { title: string; options: string[] }[];
	selectAnswer?: string;
	current: { provider: string; id: string } | null;
	thinking: string | null;
	userMessages: string[];
	userMessageOptions: Array<Record<string, unknown> | null>;
	compacts?: { customInstructions?: string }[];
}

interface Harness {
	pi: any;
	ctx: any;
	recorded: Recorded;
	emit: (eventName: string, event: unknown) => Promise<unknown[]>;
}

function makeHarness(workdir: string): Harness {
	const recorded: Recorded = {
		entries: [],
		messages: [],
		status: undefined,
		statusCalls: 0,
		colors: [],
		models: [],
		thinkingLevels: [],
		notifies: [],
		selects: [],
		current: { provider: "p", id: "m" },
		thinking: "high",
		userMessages: [],
		userMessageOptions: [],
	};
	let contextPercent: number | null = 0;
	const registryModels = [
		{ provider: "p", id: "m" },
		{ provider: "prov", id: "other" },
	];
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const emit = async (eventName: string, event: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(eventName) ?? []) {
			results.push(await handler(event, ctx));
		}
		return results;
	};
	const pi = {
		on: (eventName: string, handler: (event: unknown, ctx: any) => unknown) => {
			const registered = handlers.get(eventName) ?? [];
			registered.push(handler);
			handlers.set(eventName, registered);
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		appendEntry: (customType: string, data: unknown) => {
			recorded.entries.push({ type: "custom", customType, data });
		},
		sendMessage: (message: { customType: string; content: string }, options?: { triggerTurn?: boolean }) => {
			recorded.messages.push({ ...message, options });
		},
		sendUserMessage: async (content: string, options?: Record<string, unknown>) => {
			recorded.userMessages.push(content);
			recorded.userMessageOptions.push(options ?? null);
		},
		setModel: async (model: { provider: string; id: string }) => {
			recorded.models.push({ provider: model.provider, id: model.id });
			recorded.current = { provider: model.provider, id: model.id };
			return true;
		},
		setThinkingLevel: (level: string) => {
			recorded.thinkingLevels.push(level);
			recorded.thinking = level;
		},
	};
	const ui = {
		setStatus: (_key: string, value: string | undefined) => {
			recorded.statusCalls += 1;
			recorded.status = value;
		},
		notify: (message: string, severity: string) => {
			recorded.notifies.push({ message, severity });
		},
		select: async (title: string, options: string[]) => {
			recorded.selects.push({ title, options });
			return recorded.selectAnswer ?? options[0];
		},
		theme: {
			fg: (color: string, text: string) => {
				recorded.colors.push(color);
				return text;
			},
			strikethrough: (text: string) => `~~${text}~~`,
		},
	};
	const sessionManager: any = {};
	const ctx = {
		cwd: workdir,
		ui,
		isIdle: () => true,
		hasUI: true,
		scopedModels: [] as Array<{ model: { provider: string; id: string }; thinkingLevel?: string }>,
		get model() {
			return recorded.current;
		},
		get thinkingLevel() {
			return recorded.thinking;
		},
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				registryModels.find((entry) => entry.provider === provider && entry.id === modelId),
			getAvailable: () => registryModels,
		},
		getContextUsage: () =>
			contextPercent === null
				? undefined
				: { tokens: contextPercent * 1000, contextWindow: 100000, percent: contextPercent },
		compact: (options: { customInstructions?: string }) => {
			recorded.compacts = recorded.compacts ?? [];
			recorded.compacts.push(options);
		},
		sessionManager,
		setUsagePercent: (percent: number | null) => {
			contextPercent = percent;
		},
	};
	return { pi, ctx, recorded, emit, setUsagePercent: ctx.setUsagePercent } as Harness & { setUsagePercent: (percent: number | null) => void };
}

function items(...ids: string[]): CheckItem[] {
	return ids.map((id) => ({ id, text: `\`${id}\` demo item`, done: false }));
}

function compactableBranchEntries(): any[] {
	return [
		{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "start the work" }] } },
		{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "made progress" }] } },
		{ id: "u-2", type: "message", message: { role: "user", content: [{ type: "text", text: "continue from here" }] } },
		{ id: "a-2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "tail work" }] } },
	];
}

function startActiveRun(workdir: string, status: "planning" | "executing" = "planning") {
	initState(workdir);
	const { run } = startRun(workdir, { topic: "compact", skill: "plan-normal", requestText: "x" });
	if (status !== "planning") setRunStatus(workdir, run.run_id, status);
	return run;
}

describe("execution loop", () => {
	let tmpRoot: string;
	let counter = 0;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-exec-"));
	});

	after(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	function freshWorkdir(): string {
		counter += 1;
		const workdir = path.join(tmpRoot, `repo-${counter}`);
		fs.mkdirSync(workdir, { recursive: true });
		return workdir;
	}

	it("tracks done markers and completes", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001", "VC-002"));

		assert.match(recorded.status ?? "", /⌛ plans 0\/2: spent \d{2}:\d{2}:\d{2}/);
		assert.match(recorded.status ?? "", /in-toks/);
		assert.match(recorded.status ?? "", /out-toks/);

		assert.ok(getExecution());
		const rules = executionContextMessage(ctx)!;
		assert.match(rules, /PI-PLANS EXECUTION/);
		assert.match(rules, /VC-001/);
		assert.match(rules, /subprocess-backed verification/);
		assert.match(rules, /waiting for/);
		assert.match(rules, /5s\s*->\s*10s\s*->\s*20s\s*->\s*40s\s*->\s*80s/);
		assert.match(rules, /keep polling at 80s/);
		assert.match(rules, /restart at 5s for each new subprocess/);
		// Representative anchors for the core execution rules (PLAN_v2 D-003/D-004).
		assert.match(rules, /for the long term/);
		assert.match(rules, /Simplest implementation/);
		assert.match(rules, /grow the change in layers/);
		assert.match(rules, /existing dependencies \(docs and types\)/);
		assert.match(rules, /well-maintained libraries/);
		assert.match(rules, /clearly separated concerns/);
		assert.match(rules, /no stopgaps/);
		assert.doesNotMatch(rules, /ponytail/i);

		assert.deepEqual(applyDoneMarkers("progress… [DONE:VC-001] done"), ["VC-001"]);
		assert.equal(isExecutionComplete(), false);
		assert.deepEqual(applyDoneMarkers("final: [DONE:VC-002]"), ["VC-002"]);
		assert.equal(isExecutionComplete(), true);

		await completeExecution(pi, ctx);
		assert.equal(getExecution(), null);
		assert.ok(recorded.messages.some((message) => message.customType === "pi-plans-complete"));
	});

	it("completion enters goal-running continuation and triggers a turn in interactive sessions", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		const planPath = path.join(workdir, "PLAN_v1.md");
		await startExecution(pi, ctx, planPath, items("VC-001", "VC-002"));
		assert.deepEqual(applyDoneMarkers("[DONE:VC-001] [DONE:VC-002]"), ["VC-001", "VC-002"]);

		await completeExecution(pi, ctx);

		const completeMessage = recorded.messages.find((message) => message.customType === "pi-plans-complete");
		assert.ok(completeMessage);
		assert.match(completeMessage.content, /Goal-running continuation/);
		assert.match(completeMessage.content, /How should the implementation-review loop terminate\?/);
		assert.match(completeMessage.content, /goal wait: continue until no unpassed VCs remain/);
		assert.doesNotMatch(completeMessage.content, /Run a post-execution amelioration round/);
		assert.equal(completeMessage.options?.triggerTurn, true);
		const ameliorateEntry = recorded.entries.find((entry) => entry.customType === "pi-plans-ameliorate");
		assert.ok(ameliorateEntry);
		const data = ameliorateEntry.data as Record<string, unknown>;
		assert.equal(data.phase, "goal-started");
		assert.equal(data.rounds, null);
		assert.equal(data.currentRound, 0);
		assert.equal(data.planPath, planPath);
	});

	it("completion stays silent in headless sessions", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		assert.deepEqual(applyDoneMarkers("[DONE:VC-001]"), ["VC-001"]);
		(ctx as any).hasUI = false;

		await completeExecution(pi, ctx);

		const completeMessage = recorded.messages.find((message) => message.customType === "pi-plans-complete");
		assert.ok(completeMessage);
		assert.doesNotMatch(completeMessage.content, /Goal-running continuation/);
		assert.equal(completeMessage.options?.triggerTurn, false);
		assert.equal(
			recorded.entries.some((entry) => entry.customType === "pi-plans-ameliorate"),
			false,
			"headless completion must not append the ameliorate entry",
		);
	});

	it("restoreFromSession completion triggers the same goal-running continuation in interactive sessions", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan");
		const snapshot = {
			planPath,
			items: items("VC-001", "VC-002"),
			startedAt: "2026-08-25T00:00:00Z",
			usage: { inToks: 0, outToks: 0 },
			implItems: [],
			implStatus: {},
			compaction: {
				inFlight: true,
				resumeGuard: true,
				cooldownActive: true,
				lastAttemptReason: "threshold",
				lastSuccessfulUsagePercent: 100,
				lastSuccessfulAt: "2026-08-25T00:01:00Z",
			},
		};
		const entries = [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "did [DONE:VC-001] [DONE:VC-002]" }] },
			},
		];
		await restoreFromSession(pi, ctx, entries as any);
		const completeMessage = recorded.messages.find((message) => message.customType === "pi-plans-complete");
		assert.ok(completeMessage, "restore path must fire completeExecution");
		assert.match(completeMessage.content, /Goal-running continuation/);
		assert.equal(completeMessage.options?.triggerTurn, true);
		assert.ok(recorded.entries.some((entry) => entry.customType === "pi-plans-ameliorate"));
	});

	it("restores progress from session entries and rescans messages", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		const snapshot = {
			planPath: path.join(workdir, "PLAN_v1.md"),
			items: items("VC-001", "VC-002"),
			startedAt: "2026-08-25T00:00:00Z",
			compaction: {
				inFlight: true,
				resumeGuard: true,
				cooldownActive: true,
				lastAttemptReason: "threshold",
				lastSuccessfulUsagePercent: 100,
				lastSuccessfulAt: "2026-08-25T00:01:00Z",
			},
		};
		fs.writeFileSync(snapshot.planPath, "# plan");
		const entries = [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "did [DONE:VC-001]" }] },
			},
		];
		await restoreFromSession(pi, ctx, entries as any);
		const execution = getExecution();
		assert.ok(execution);
		assert.equal("compaction" in execution!, false, "legacy scheduler state must not reactivate on restore");

		const clearedEntries = [...entries, { type: "custom", customType: "pi-plans-exec-cleared", data: {} }];
		await restoreFromSession(pi, ctx, clearedEntries as any);
		assert.equal(getExecution(), null);
	});

	it("ignores restore when the plan file vanished", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		const entries = [
			{
				type: "custom",
				customType: "pi-plans-exec",
				data: {
					planPath: path.join(workdir, "missing-plan.md"),
					items: items("VC-001"),
					startedAt: "2026-08-25T00:00:00Z",
				},
			},
		];
		await restoreFromSession(pi, ctx, entries as any);
		assert.equal(getExecution(), null);
	});

	it("stop clears execution", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		await stopExecution(pi, ctx, "test");
		assert.equal(getExecution(), null);
	});

	it("starts execution without switching models", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v6.md"), items("VC-001"));

		assert.deepEqual(recorded.models, []);
		assert.equal(recorded.thinking, "high");
		assert.match(recorded.status ?? "", /⌛ plans 0\/1/);

		await stopExecution(pi, ctx, "restore-check");
		assert.deepEqual(recorded.models, []);
		assert.equal(recorded.thinking, "high");
	});

	it("keeps the execution status bar current while executing", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v2.md"), items("VC-001", "VC-002"));

		// Bottom status bar carries the count — the same layer as ⛔/⌛ — so both
		// execution states read from one consistent place.
		assert.match(recorded.status ?? "", /⌛ plans 0\/2: spent \d{2}:\d{2}:\d{2}/);
		assert.match(recorded.status ?? "", /in-toks/);

		const start = recorded.messages.find((message) => message.customType === "pi-plans-exec-start");
		assert.ok(start);
		assert.match(start.content, /Progress appears in the bottom status bar/);
		assert.doesNotMatch(start.content, /footer/);

		applyDoneMarkers("[DONE:VC-001]");
		await completeExecution(pi, ctx);
		assert.equal(getExecution(), null);

	});

	it("renders the idle indicator by run status", () => {
		const workdir = freshWorkdir();
		const { ctx, recorded } = makeHarness(workdir);
		initState(workdir);
		const { run } = startRun(workdir, { topic: "demo", skill: "plan-small", requestText: "x" });

		// planning before any PLAN draft exists: 💬 (Q&A phase).
		updateStatusWidget(ctx);
		assert.match(recorded.status ?? "", /💬 plans: /);
		assert.equal(recorded.colors.at(-1), "muted");

		// Once a draft lands: 📝, kept until execution starts.
		fs.writeFileSync(path.join(run.artifact_dir, "PLAN_v1.md"), "# plan");
		updateStatusWidget(ctx);
		assert.match(recorded.status ?? "", /📝 plans: /);
		assert.equal(recorded.colors.at(-1), "muted");

		setRunStatus(workdir, run.run_id, "accepted");
		updateStatusWidget(ctx);
		assert.match(recorded.status ?? "", /⌛ plans: /);
		assert.equal(recorded.colors.at(-1), "warning");

		setRunStatus(workdir, run.run_id, "stopped");
		updateStatusWidget(ctx);
		assert.match(recorded.status ?? "", /⛔ plans: /);
		assert.equal(recorded.colors.at(-1), "warning");

		setRunStatus(workdir, run.run_id, "done");
		updateStatusWidget(ctx);
		assert.match(recorded.status ?? "", /🎯 plans: .*\(done\)/);
		assert.equal(recorded.colors.at(-1), "success");

		setRunStatus(workdir, run.run_id, "abandoned");
		updateStatusWidget(ctx);
		assert.match(recorded.status ?? "", /🚫 plans: /);
		assert.equal(recorded.colors.at(-1), "error");
	});

	it("accumulates token usage on token-only and completion turns", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v5.md"), items("VC-001", "VC-002"));

		recordExecutionTurn(pi, ctx, [], { input: 100, output: 40 });
		updateStatusWidget(ctx);
		assert.equal(getExecution()?.usage.inToks, 100);
		assert.equal(getExecution()?.usage.outToks, 40);
		assert.match(recorded.status ?? "", /100 in-toks/);
		assert.match(recorded.status ?? "", /40 out-toks/);

		assert.deepEqual(applyDoneMarkers("[DONE:VC-001]"), ["VC-001"]);
		recordExecutionTurn(pi, ctx, ["VC-001"], { input: 20, output: 10 });
		updateStatusWidget(ctx);
		assert.equal(getExecution()?.usage.inToks, 120);
		assert.equal(getExecution()?.usage.outToks, 50);
		assert.equal(getExecution()?.items[0].done, true);
		assert.match(recorded.status ?? "", /120 in-toks/);
		assert.match(recorded.status ?? "", /50 out-toks/);

		await stopExecution(pi, ctx, "test-done");
		assert.equal(getExecution(), null);
	});

	it("returns control to Pi core without active execution or planning state", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);

		await startExecution(pi, ctx, path.join(workdir, "PLAN_v0.md"), items("VC-001"));
		const executionResult = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(executionResult, undefined);
		await stopExecution(pi, ctx, "no-active-run");

		const planningResult = handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(planningResult, undefined);
	});

	it("lets Pi core own execution compaction scheduling and customizes safe reasons", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v8.md"), items("VC-001", "VC-002"));

		const threshold = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(threshold?.cancel, undefined);
		assert.ok(threshold?.compaction, "threshold compaction should use the VCC summary when a legal cut exists");

		const overflowRetry = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("overflow", null),
			branchEntries: [],
			reason: "overflow",
			willRetry: true,
			signal: new AbortController().signal,
		});
		assert.equal(overflowRetry, undefined, "overflow retry falls back to Pi core when VCC has no safe cut");

		const manual = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("manual", null),
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(manual?.cancel, true, "manual compaction cancels instead of discarding unsafe context");
		assert.ok(recorded.notifies.some((note) => note.message.includes("Nothing to compact")));

		await stopExecution(pi, ctx, "test-done");
	});

	it("does not proactively request execution compaction", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v9.md"), items("VC-001", "VC-002"));

		setUsagePercent(99);
		handleExecutionTurnCompaction(ctx);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 0, "execution scheduling is owned by Pi core");

		await stopExecution(pi, ctx, "test-done");
	});

	it("ignores current-I growth for proactive execution compaction", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v22.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);
		(ctx.sessionManager as any).getBranch = () => [
			{ id: "only", type: "message", tokens: 30000, message: { role: "assistant", content: [{ type: "text", text: "[I-001:current] one oversized turn" }] } },
		];
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 0);
		await stopExecution(pi, ctx, "no-prefix");
	});
	it("wires execution compaction without restoring proactive requests or model helpers", () => {
		const indexSource = fs.readFileSync(path.join(process.cwd(), "index.ts"), "utf8");
		const execSource = fs.readFileSync(path.join(process.cwd(), "src/exec.ts"), "utf8");
		assert.match(indexSource, /handleExecutionTurnCompaction/);
		assert.match(execSource, /shouldTriggerExecutionCompaction/);
		assert.doesNotMatch(execSource, /ctx\.compact\(/);
		assert.doesNotMatch(
			indexSource,
			/setExecutionModel|chooseExecutionModelSelection|snapshotCurrentModelSelector|ensureExecutionModelActive|restorePlanningModel/,
		);
		assert.doesNotMatch(
			execSource,
			/setExecutionModel|chooseExecutionModelSelection|snapshotCurrentModelSelector|ensureExecutionModelActive|restorePlanningModel|buildModelExecutionCompactionResult|modelRegistry\.complete/,
		);
	});

	it("auto-continues execution only for threshold/overflow and honors manual follow-up prompts", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx, recorded } = makeHarness(workdir);
		(ctx as any).piVersion = "0.84.3";
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v9.md"), items("VC-001"));

		const threshold = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.ok(threshold?.compaction);
		await handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: false,
			reason: "threshold",
			willRetry: false,
		});
		assert.equal(recorded.messages.filter((message) => message.customType === "pi-plans-exec-resume").length, 1);
		assert.ok(recorded.notifies.some((note) => note.message.startsWith("pi-vcc: kept")));

		handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("manual", null),
			branchEntries: compactableBranchEntries(),
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		await handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});
		assert.equal(recorded.messages.filter((message) => message.customType === "pi-plans-exec-resume").length, 1);

		handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("manual", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "Run focused tests keep:1",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		await handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});
		assert.deepEqual(recorded.userMessages, ["Run focused tests"]);

		handleExecutionCompactFailed(pi, ctx, {
			type: "session_compact_failed",
			reason: "manual",
			aborted: false,
			willRetry: false,
			fromExtension: true,
			errorMessage: "boom",
		});
		assert.ok(getExecution(), "compaction failure must keep execution active");
		assert.ok(recorded.notifies.some((note) => note.severity === "warning" && note.message.includes("execution remains active")));

		await stopExecution(pi, ctx, "test-done");
	});

	it("builds a VCC execution summary with phase context and previous summary", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v10.md"), items("VC-001", "VC-002"), [
			{ id: "I-001", text: "First item." },
			{ id: "I-002", text: "Second item." },
		]);

		const previousSummary = "## Legacy Summary\nDeliver auto-compact in execution phase.";
		applyCurrentIMarker("[I-002:current]");
		const preparation = makePreparation("threshold", previousSummary);
		const branchEntries: any[] = [
			{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "implement VC-001" }] } },
			{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "wrote helper [I-002:current]" }] } },
			{ id: "u-2", type: "message", message: { role: "user", content: [{ type: "text", text: "implement VC-002" }] } },
			{ id: "a-2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "almost done" }] } },
		];
		const result = buildExecutionCompactionResult(
			{
				type: "session_before_compact",
				preparation,
				branchEntries,
				customInstructions: "keep:1",
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx,
		);
		assert.ok(result);
		assert.equal(result!.firstKeptEntryId, "u-2");
		assert.match(result!.summary, /\[Session Goal\]/);
		assert.match(result!.summary, /Execute accepted plan/);
		assert.match(result!.summary, /\[Outstanding Context\]/);
		assert.match(result!.summary, /Current implementation item: I-002/);
		assert.match(result!.summary, /Remaining verifier items: VC-001, VC-002/);
		assert.match(result!.summary, /Previous compact summary: Legacy Summary Deliver auto-compact/);
		assert.equal((result!.details as any).compactor, "pi-vcc");
		assert.equal((result!.details as any).phase, "execution");

		await stopExecution(pi, ctx, "test-done");
	});

	it("does not call model helpers and respects overrideDefaultCompaction=false", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v21.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);
		let completeCalled = false;
		(ctx.modelRegistry as any).complete = async () => {
			completeCalled = true;
			return {};
		};
		const event: any = {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		};
		const valid = handleExecutionBeforeCompact(pi, ctx, event);
		assert.ok(valid?.compaction);
		assert.equal(completeCalled, false);

		const configPath = path.join(workdir, ".git", "pi_plans", "pi-vcc-config.json");
		fs.writeFileSync(configPath, JSON.stringify({ overrideDefaultCompaction: false }), "utf8");
		const fallback = handleExecutionBeforeCompact(pi, ctx, { ...event, signal: new AbortController().signal });
		assert.equal(fallback, undefined, "override-disabled should return control to Pi default compaction");

		await stopExecution(pi, ctx, "model-test");
	});
	it("filters the hidden resume message out of the model context payload", () => {
		const messages = [
			{ customType: "user", content: "real prompt" },
			{ customType: "pi-plans-exec-resume", content: "Continue execution." },
			{ customType: "pi-plans-plan-resume", content: "Continue planning." },
			{ customType: "assistant", content: "ok" },
		];
		assert.equal(filterExecutionResumeMessages(messages).length, 3);
		assert.equal(filterPlanningResumeMessages(messages).length, 3);
	});

	it("builds a VCC planning summary from active-run session context", () => {
		const workdir = freshWorkdir();
		const { ctx } = makeHarness(workdir);
		initState(workdir);
		const { run } = startRun(workdir, { topic: "planning compact", skill: "plan-normal", requestText: "demo" });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan");

		const branchEntries = [
			{ id: "rs", type: "custom", customType: PLANNING_RUN_START_CUSTOM_TYPE, data: { runId: run.run_id, artifactDir: run.artifact_dir } },
			{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "background question?" }] } },
			{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "some context [I-004:current]" }] } },
			{ id: "pw", type: "custom", customType: PLANNING_PLAN_WRITTEN_CUSTOM_TYPE, data: { runId: run.run_id, planPath } },
			{ id: "u-2", type: "message", message: { role: "user", content: [{ type: "text", text: "review please" }] } },
		] as any;
		const withPlan = buildPlanningCompactionResult(
			{
				type: "session_before_compact",
				preparation: makePreparation("threshold", "## Previous\nEarlier summary."),
				branchEntries,
				customInstructions: "keep:1",
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx,
		);
		assert.ok(withPlan);
		assert.deepEqual(withPlan!.firstKeptEntryId, "u-2");
		assert.match(withPlan!.summary, /\[Session Goal\]/);
		assert.match(withPlan!.summary, new RegExp(run.run_id));
		assert.match(withPlan!.summary, /\[Outstanding Context\]/);
		assert.match(withPlan!.summary, /Latest plan path from session/);
		assert.match(withPlan!.summary, /Planning artifact directory from session/);
		assert.match(withPlan!.summary, /Current implementation marker observed during planning: I-004/);
		assert.match(withPlan!.summary, /Previous compact summary: Previous Earlier summary\./);
		assert.equal((withPlan!.details as any).compactor, "pi-vcc");
		assert.equal((withPlan!.details as any).phase, "planning");
	});

	it("planning hook is gated by run.status=planning and defers while execution is running", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		initState(workdir);
		const { run } = startRun(workdir, { topic: "planning gate", skill: "plan-small", requestText: "x" });

		const resultPlanning = handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.ok(resultPlanning?.compaction);

		setRunStatus(workdir, run.run_id, "done");
		const resultDone = handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(resultDone, undefined);

		setRunStatus(workdir, run.run_id, "planning");
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v14.md"), items("VC-001"));
		const duringExecution = handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(duringExecution, undefined);
		await stopExecution(pi, ctx, "planning-gate");
	});

	it("turn_end writes are unconditionally deferred even when isIdle reads true", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v11.md"), items("VC-001", "VC-002"));
		const snapshotCount = () => recorded.entries.filter((e) => e.customType === "pi-plans-exec").length;
		const baseline = snapshotCount();

		// No isIdle override: the harness default (() => true) IS the real
		// turn_end reading — this encodes the field regression (60 writes in
		// 23 minutes) as a permanent zero-write assertion.
		recordExecutionTurn(pi, ctx, [], { input: 10, output: 5 });
		setUsagePercent(50);
		handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(snapshotCount(), baseline, "turn_end wrote session entries despite deferral");
		// Status line stays real-time while the write is deferred.
		assert.match(recorded.status ?? "", /10 in-toks/);

		drainExecutionFlush(pi, ctx);
		assert.equal(snapshotCount(), baseline + 1, "settle flush did not write exactly one snapshot");
		const last = (recorded.entries.filter((e) => e.customType === "pi-plans-exec").at(-1)?.data ?? {}) as { usage?: { inToks: number } };
		assert.equal(last.usage?.inToks, 10, "flushed snapshot missing busy-turn usage");
		drainExecutionFlush(pi, ctx);
		assert.equal(snapshotCount(), baseline + 1, "second drain wrote again");
		assert.equal(consumePendingExecutionFlush(), false);

		await stopExecution(pi, ctx, "done");
	});

	it("stop and complete drain pending writes synchronously with final state", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v12.md"), items("VC-001", "VC-002"));
		const snapshotCount = () => recorded.entries.filter((e) => e.customType === "pi-plans-exec").length;

		ctx.isIdle = () => false;
		recordExecutionTurn(pi, ctx, [], { input: 7, output: 3 });
		const busyCount = snapshotCount();

		await stopExecution(pi, ctx, "force");
		assert.ok(snapshotCount() > busyCount, "stop did not write the final snapshot");
		assert.ok(recorded.entries.some((e) => e.customType === "pi-plans-exec-cleared"));
		const lastStop = (recorded.entries.filter((e) => e.customType === "pi-plans-exec").at(-1)?.data ?? {}) as { usage?: { inToks: number } };
		assert.equal(lastStop.usage?.inToks, 7, "stop lost the busy-turn usage");

		await startExecution(pi, ctx, path.join(workdir, "PLAN_v13.md"), items("VC-001"));
		ctx.isIdle = () => false;
		applyDoneMarkers("[DONE:VC-001]");
		recordExecutionTurn(pi, ctx, ["VC-001"], { input: 1, output: 1 });
		await completeExecution(pi, ctx);
		assert.equal(getExecution(), null);
		const lastComplete = (recorded.entries.filter((e) => e.customType === "pi-plans-exec").at(-1)?.data ?? {}) as { items?: Array<{ done: boolean }> };
		assert.equal(lastComplete.items?.[0]?.done, true, "completion snapshot missing final done state");
	});

	it("updates the status bar in real time on every turn without session writes", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v15.md"), items("VC-001", "VC-002"), [
			{ id: "I-001", text: "First item." },
			{ id: "I-002", text: "Second item." },
		]);
		const snapshotCount = () => recorded.entries.filter((e) => e.customType === "pi-plans-exec").length;
		const baseline = snapshotCount();

		recordExecutionTurn(pi, ctx, [], { input: 33, output: 11 });
		// Real-time: status line already reflects the turn's usage...
		assert.match(recorded.status ?? "", /33 in-toks/);
		assert.match(recorded.status ?? "", /⌛ plans 0\/2: spent/);
		// ...without any session write (anti-jitter preserved).
		assert.equal(snapshotCount(), baseline);

		setUsagePercent(null);
		drainExecutionFlush(pi, ctx);
		assert.equal(snapshotCount(), baseline + 1);

		await stopExecution(pi, ctx, "done");
	});

	it("syncs progress through the registered message_end and turn_end handlers", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, emit } = makeHarness(workdir);
		registerExecutionTurnHandlers(pi);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v19.md"), items("VC-001", "VC-002", "VC-003"));

		// The usage is delivered by message_end and consumed by the following
		// turn_end, matching Pi's lifecycle contract.
		await emit("message_end", {
			message: { role: "assistant", usage: { input: 12, output: 5 } },
		});
		await emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "verified [DONE:VC-001]" }] },
		});
		assert.match(recorded.status ?? "", /⌛ plans 1\/3: spent/);
		assert.match(recorded.status ?? "", /12 in-toks/);

		await emit("message_end", {
			message: { role: "assistant", usage: { input: 8, output: 3 } },
		});
		await emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "verified [DONE:VC-002]" }] },
		});
		assert.match(recorded.status ?? "", /⌛ plans 2\/3: spent/);
		assert.match(recorded.status ?? "", /20 in-toks/);

		await stopExecution(pi, ctx, "event-chain-test");
	});
	it("applies impl markers with silent unknown ids and later-overwrite semantics", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v16.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);

		assert.deepEqual(applyImplMarkers("[I-999:implemented]"), []); // unknown id silently ignored
		assert.deepEqual(applyImplMarkers("[I-001:implemented]"), ["I-001"]);
		assert.deepEqual(applyImplMarkers("[I-001:validating]"), ["I-001"]); // later overwrites
		assert.equal(getExecution()?.implStatus?.["I-001"], "validating");

		await stopExecution(pi, ctx, "done");
	});

	it("applies current-I markers to the live progress bar and snapshot", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, emit } = makeHarness(workdir);
		registerExecutionTurnHandlers(pi);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v20.md"), items("VC-001", "VC-002", "VC-003"), [
			{ id: "I-001", text: "First item." },
			{ id: "I-002", text: "Second item." },
			{ id: "I-003", text: "Third item." },
		]);

		await emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "starting [I-003:current]" }] },
		});
		assert.match(recorded.status ?? "", /⌛ plans 2\/3: spent/);
		assert.equal(getExecution()?.currentI, "I-003");
		drainExecutionFlush(pi, ctx);
		const snapshot = recorded.entries.filter((entry) => entry.customType === "pi-plans-exec").at(-1)?.data as { currentI?: string };
		assert.equal(snapshot.currentI, "I-003");
		assert.equal(applyCurrentIMarker("[I-999:current]"), false);
		await stopExecution(pi, ctx, "current-I-test");
	});
	it("replays impl markers from post-snapshot messages on restore", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		const snapshot = {
			planPath: path.join(workdir, "PLAN_v17.md"),
			items: items("VC-001"),
			startedAt: "2026-08-29T00:00:00Z",
			implItems: [{ id: "I-001", text: "First item." }],
			implStatus: {},
		};
		fs.writeFileSync(snapshot.planPath, "# plan");
		const entries = [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "work done [I-001:implemented]" }] } },
		];
		await restoreFromSession(pi, ctx, entries as any);
		assert.equal(getExecution()?.implStatus?.["I-001"], "implemented");
	});


	it("keeps the injection rules teaching the impl markers", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v18.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);
		const rules = executionContextMessage(ctx)!;
		assert.match(rules, /\[I-001:implemented\]/);
		assert.match(rules, /\[I-001:validating\]/);
		assert.match(rules, /subprocess-backed verification/);
		assert.match(rules, /waiting for/);
		assert.match(rules, /5s\s*->\s*10s\s*->\s*20s\s*->\s*40s\s*->\s*80s/);
		assert.match(rules, /keep polling at 80s/);
		assert.match(rules, /restart at 5s for each new subprocess/);
		await stopExecution(pi, ctx, "done");
	});

	it("does not proactively request planning compaction", () => {
		const workdir = freshWorkdir();
		const { ctx, setUsagePercent, recorded } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "planning no-op", skill: "plan-normal", requestText: "x" });

		setUsagePercent(120);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), false);
		requestPlanningCompaction(ctx as any);
		refreshPlanningCompactionCooldown(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 0, "planning scheduling is owned by Pi core");
	});

	it("auto-continues planning only for threshold/overflow and honors manual follow-up prompts", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		(ctx as any).piVersion = "0.84.3";
		initState(workdir);
		startRun(workdir, { topic: "planning success", skill: "plan-normal", requestText: "x" });

		const threshold = handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.ok(threshold?.compaction);
		await handlePlanningCompact(pi as any, ctx as any, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: false,
			reason: "threshold",
			willRetry: false,
		});
		assert.equal(recorded.messages.filter((message) => message.customType === "pi-plans-plan-resume").length, 1);
		assert.equal(consumePlanningCompactionResumeGuard(ctx as any), true);

		handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("manual", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "Ask the next question keep:1",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		await handlePlanningCompact(pi as any, ctx as any, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});
		assert.deepEqual(recorded.userMessages, ["Ask the next question"]);
		assert.equal(recorded.messages.filter((message) => message.customType === "pi-plans-plan-resume").length, 1);
	});

	it("planning request helper remains a no-op regardless of idleness", () => {
		const workdir = freshWorkdir();
		const { ctx, recorded, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "idle no-op", skill: "plan-normal", requestText: "x" });
		setUsagePercent(120);

		(ctx as any).isIdle = () => false;
		requestPlanningCompaction(ctx as any);
		(ctx as any).isIdle = () => true;
		(ctx as any).hasPendingMessages = () => false;
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 0);
		assert.equal((ctx as any).sessionManager.__planningCompaction, undefined);
	});

	it("planning compact failures notify but do not re-request proactively", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "failure notify", skill: "plan-normal", requestText: "x" });
		handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});

		handlePlanningCompactFailed(pi as any, ctx as any, {
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "Compaction failed: Nothing to compact (session too small)",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
		assert.ok(recorded.notifies.some((note) => note.message.includes("nothing to summarize")));
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 0);

		handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		handlePlanningCompactFailed(pi as any, ctx as any, {
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "network down",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
		assert.ok(recorded.notifies.some((note) => note.message.includes("will try again")));
	});

	it("execution turn compaction helper remains a no-op and failures keep execution active", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v23.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);

		setUsagePercent(96);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 0, "execution scheduling is owned by Pi core");

		handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		handleExecutionCompactFailed(pi, ctx, {
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "Compaction failed: Already compacted",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
		assert.ok(getExecution());
		assert.ok(recorded.notifies.some((note) => note.message.includes("nothing to summarize")));

		await stopExecution(pi, ctx, "test-done");
	});

	it("treats planning abort/stream compact failures as terminal and notifies explicitly", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "abort-stream classification", skill: "plan-normal", requestText: "x" });

		const abortMessages = [
			"Auto-compaction failed: Turn prefix summarization failed: This operation was aborted",
			"Error: OpenAI Responses stream ended before a terminal response event",
			"Auto-compaction failed: context overflow recovery failed",
			"this operation was aborted",
			"aborted",
		];
		for (const errorMessage of abortMessages) {
			recorded.notifies.length = 0;
			handlePlanningBeforeCompact(pi as any, ctx as any, {
				type: "session_before_compact",
				preparation: makePreparation("threshold", null),
				branchEntries: compactableBranchEntries(),
				customInstructions: "keep:1",
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			});
			handlePlanningCompactFailed(pi as any, ctx as any, {
				type: "session_compact_failed",
				reason: "threshold",
				errorMessage,
				aborted: errorMessage.includes("aborted"),
				willRetry: false,
				fromExtension: false,
			});
			const backoffNote = recorded.notifies.find((n) => n.message.includes("was aborted"));
			assert.ok(backoffNote, `expected abort-class notify for: ${errorMessage}`);
			assert.match(backoffNote!.message, /provider interruption|competing manual/);
			const before = recorded.compacts?.length ?? 0;
			requestPlanningCompaction(ctx as any);
			assert.equal((recorded.compacts?.length ?? 0) - before, 0);
		}
	});

	it("event.aborted=true with empty errorMessage still enters abort-class handling", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "aborted-no-message", skill: "plan-normal", requestText: "x" });
		handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});

		handlePlanningCompactFailed(pi as any, ctx as any, {
			type: "session_compact_failed",
			reason: "threshold",
			errorMessage: undefined,
			aborted: true,
			willRetry: false,
			fromExtension: false,
		});
		const backoffNote = recorded.notifies.find((n) => n.message.includes("was aborted"));
		assert.ok(backoffNote);
		const before = recorded.compacts?.length ?? 0;
		requestPlanningCompaction(ctx as any);
		assert.equal((recorded.compacts?.length ?? 0) - before, 0);
	});

	it("network-style planning failures stay retryable without proactive requests", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "network-retryable", skill: "plan-normal", requestText: "x" });
		handlePlanningBeforeCompact(pi as any, ctx as any, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});

		handlePlanningCompactFailed(pi as any, ctx as any, {
			type: "session_compact_failed",
			reason: "threshold",
			errorMessage: "network down",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
		const abortNote = recorded.notifies.find((n) => n.message.includes("was aborted"));
		assert.equal(abortNote, undefined, "network down must not be classified as abort-class");
		const retryNote = recorded.notifies.find((n) => n.message.includes("will try again"));
		assert.ok(retryNote, "network down must keep the retryable path");
		const before = recorded.compacts?.length ?? 0;
		requestPlanningCompaction(ctx as any);
		assert.equal((recorded.compacts?.length ?? 0) - before, 0);
	});

	it("lifecycle flags distinguish unhinted and phase-attributed compactions", () => {
		const workdir = freshWorkdir();
		const { ctx } = makeHarness(workdir);

		noteCompactionStarted(ctx as any, undefined);
		assert.equal(compactionInFlight(ctx as any, "planning"), true, "unhinted compaction marks planning inFlight");
		assert.equal(compactionInFlight(ctx as any, "execution"), true, "unhinted compaction marks execution inFlight");
		noteCompactionEnded(ctx as any, undefined);
		assert.equal(compactionInFlight(ctx as any, "planning"), false);
		assert.equal(compactionInFlight(ctx as any, "execution"), false);

		noteCompactionStarted(ctx as any, "pi-plans planning auto compact");
		assert.equal(compactionInFlight(ctx as any, "planning"), true);
		assert.equal(compactionInFlight(ctx as any, "execution"), false);
		noteCompactionEnded(ctx as any, "pi-plans planning auto compact");
		assert.equal(compactionInFlight(ctx as any, "planning"), false);

		noteCompactionStarted(ctx as any, "pi-plans execution auto compact");
		assert.equal(compactionInFlight(ctx as any, "planning"), false);
		assert.equal(compactionInFlight(ctx as any, "execution"), true);
		noteCompactionEnded(ctx as any, "pi-plans execution auto compact");
		assert.equal(compactionInFlight(ctx as any, "execution"), false);
	});

	it("execution handler classifies abort/stream failures as terminal", async () => {
		const workdir = freshWorkdir();
		startActiveRun(workdir);
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v4.md"), items("VC-001"));

		const abortMessages = [
			"Auto-compaction failed: Turn prefix summarization failed: This operation was aborted",
			"Error: OpenAI Responses stream ended before a terminal response event",
			"Auto-compaction failed: context overflow recovery failed",
			"aborted",
		];
		for (const errorMessage of abortMessages) {
			recorded.notifies.length = 0;
			handleExecutionBeforeCompact(pi, ctx, {
				type: "session_before_compact",
				preparation: makePreparation("threshold", null),
				branchEntries: compactableBranchEntries(),
				customInstructions: "keep:1",
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			});
			handleExecutionCompactFailed(pi, ctx, {
				type: "session_compact_failed",
				reason: "threshold",
				errorMessage,
				aborted: errorMessage.includes("aborted"),
				willRetry: false,
				fromExtension: false,
			});
			const note = recorded.notifies.find((n) => n.message.includes("was aborted"));
			assert.ok(note, `expected abort-class notify for: ${errorMessage}`);
			assert.match(note!.message, /provider interruption|competing manual/);
		}
		handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: compactableBranchEntries(),
			customInstructions: "keep:1",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		handleExecutionCompactFailed(pi, ctx, {
			type: "session_compact_failed",
			reason: "threshold",
			errorMessage: undefined,
			aborted: true,
			willRetry: false,
			fromExtension: false,
		});
		const cleanNote = recorded.notifies.find((n) => n.message.includes("was aborted"));
		assert.ok(cleanNote, "aborted-without-message must enter abort-class handling on execution side too");
		await stopExecution(pi, ctx, "test-done");
	});

	it("index.ts wires session_compact/session_compact_failed to clear inFlight flags (F-003/F-004 coverage)", () => {
		const indexSource = fs.readFileSync(path.join(process.cwd(), "index.ts"), "utf8");
		assert.match(indexSource, /await handleExecutionCompact\(pi, ctx, event\)/);
		assert.match(indexSource, /await handlePlanningCompact\(pi, ctx, event\)/);

		const workdir = freshWorkdir();
		// Use a minimal harness that exposes sessionManager so we can inspect the
		// in-flight store after dispatching the registered event handlers.
		const ctx: any = {
			cwd: workdir,
			hasUI: false,
			sessionManager: {},
		};
		// Simulate the lifecycle that index.ts wires in production:
		noteCompactionStarted(ctx, undefined);
		assert.equal(compactionInFlight(ctx, "planning"), true);
		assert.equal(compactionInFlight(ctx, "execution"), true);
		noteCompactionEnded(ctx, undefined);
		assert.equal(compactionInFlight(ctx, "planning"), false);
		assert.equal(compactionInFlight(ctx, "execution"), false);
		// And a planning-attributed start + end still clears both (end has no hint).
		noteCompactionStarted(ctx, "pi-plans planning auto compact");
		assert.equal(compactionInFlight(ctx, "planning"), true);
		noteCompactionEnded(ctx, "pi-plans planning auto compact");
		assert.equal(compactionInFlight(ctx, "planning"), false);
	});
});

describe("execution injection reads graph config live", () => {
	it("reflects graph_enabled flips on the next assembly and surfaces config failures", async (t) => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-exec-graph-"));
		t.after(() => {
			try {
				fs.rmSync(workdir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});
		const { pi, ctx } = makeHarness(workdir);
		setGraphEnabled(workdir, true);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));

		const enabledRules = executionContextMessage(ctx)!;
		assert.match(enabledRules, /Code graph loop: indexed code files read as a function digest/);
		assert.doesNotMatch(enabledRules, /Code graph disabled/);

		setGraphEnabled(workdir, false);
		assert.match(executionContextMessage(ctx)!, /Code graph disabled/);

		fs.writeFileSync(path.join(workdir, ".git", "pi_plans", "config.json"), "{broken");
		const brokenRules = executionContextMessage(ctx)!;
		assert.match(brokenRules, /Code graph disabled/);
		assert.match(brokenRules, /config unreadable this turn/);
	});

	it("keeps no graphEnabled snapshot in the execution state source", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "src", "exec.ts"), "utf8");
		assert.doesNotMatch(source, /graphEnabled/);
		assert.match(source, /resolveGraphMode/);
	});
});

function makePreparation(reason: "manual" | "threshold" | "overflow", previousSummary: string | null): any {	return {
		firstKeptEntryId: "a-2",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 12345,
		previousSummary,
		fileOps: { read: [], written: [], edited: [] },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	};
}

describe("execution goal-wait continuation", () => {
	// Fresh per-turn continuation flags, mirroring the before_agent_start reset.
	const setup = (workdir: string) => {
		resetGoalWaitTurnFlags();
		const harness = makeHarness(workdir);
		registerExecutionTurnHandlers(harness.pi);
		return harness;
	};

	it("sends a goal-wait followUp when a turn ends with unpassed VCs", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx, recorded, emit } = setup(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		recorded.userMessages.length = 0;
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
		assert.equal(recorded.userMessages.length, 1);
		assert.match(recorded.userMessages[0], /Goal wait: 1\/1 verifier items still open/);
		assert.match(recorded.userMessages[0], /\`VC-001\`/);
		assert.equal(recorded.userMessageOptions.at(-1)?.deliverAs, "followUp");
		assert.match(recorded.status ?? "", /goal-wait · 无进展 1\/3 · 等待 0\/6/);
	});

	it("sends the goal-wait followUp in headless sessions too", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx, recorded, emit } = setup(workdir);
		(ctx as any).hasUI = false;
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		recorded.userMessages.length = 0;
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
		assert.equal(recorded.userMessages.length, 1);
		assert.match(recorded.userMessages[0], /Goal wait: 1\/1 verifier items still open/);
	});

	it("does not goal-wait when every VC is done (completion path)", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx, recorded, emit } = setup(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		recorded.userMessages.length = 0;
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "done [DONE:VC-001]" }] } });
		assert.equal(recorded.userMessages.length, 0);
		assert.ok(recorded.messages.some((message) => message.customType === "pi-plans-complete"));
	});

	it("skips goal-wait while any compaction continuation flag is active", async () => {
		const variants = [
			{ inFlight: true, resumeGuard: false, pendingFollowUpPrompt: null },
			{ inFlight: false, resumeGuard: true, pendingFollowUpPrompt: null },
			{ inFlight: false, resumeGuard: false, pendingFollowUpPrompt: "compaction follow-up" },
		];
		for (const flags of variants) {
			const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
			const { pi, ctx, recorded, emit } = setup(workdir);
			await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
			(ctx.sessionManager as any).__executionCompaction = { ...flags, cooldownActive: false };
			recorded.userMessages.length = 0;
			await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
			assert.equal(recorded.userMessages.length, 0, `flags ${JSON.stringify(flags)} must skip goal-wait`);
		}
	});

	it("pauses after 3 no-progress rounds and resumes on kick", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx, recorded, emit } = setup(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		recorded.userMessages.length = 0;
		for (let round = 0; round < 3; round++) {
			await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
		}
		assert.equal(getExecution()?.goalWait?.paused, true);
		assert.equal(recorded.userMessages.length, 2, "third quiet round must not queue another followUp");
		assert.ok(recorded.notifies.some((entry) => /goal-wait paused/.test(entry.message)));
		assert.match(recorded.status ?? "", /⏸ goal-wait paused/);

		resumeGoalWaitIfPaused(pi, ctx);
		assert.equal(getExecution()?.goalWait?.paused, false);
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "progress [DONE:VC-001]" }] } });
		assert.match(recorded.userMessages.at(-1) ?? "", /Goal wait/);
	});

	it("waiting rounds are exempt until the sixth quiet waiting round", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx, recorded, emit } = setup(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001"));
		for (let round = 1; round <= 5; round++) {
			await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: `waiting for CI (${round})` }] } });
			assert.equal(getExecution()?.goalWait?.paused, false, `round ${round} must not pause`);
		}
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "waiting for CI (6)" }] } });
		assert.equal(getExecution()?.goalWait?.paused, true);
		assert.ok(recorded.notifies.some((entry) => /waiting without progress for 6 rounds/.test(entry.message)));
	});

	it("progress resets both guard counters", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx, emit } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001", "VC-002"));
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
		await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "progress [DONE:VC-001]" }] } });
		assert.equal(getExecution()?.goalWait?.noProgressRounds, 0);
		assert.equal(getExecution()?.goalWait?.waitRounds, 0);
	});

	it("keeps goal-wait counters across restore", async () => {
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-goal-wait-"));
		const { pi, ctx } = setup(workdir);
		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(planPath, "# plan");
		const snapshot = {
			planPath,
			items: items("VC-001"),
			startedAt: "2026-08-25T00:00:00Z",
			usage: { inToks: 0, outToks: 0 },
			implItems: [],
			implStatus: {},
			goalWait: { noProgressRounds: 2, waitRounds: 1, lastMarkers: null, paused: false },
		};
		const entries = [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "no new progress this turn" }] } },
		];
		await restoreFromSession(pi, ctx, entries as any);
		// Replay advanced the marker snapshot past the persisted baseline → counters reset (D-010).
		assert.equal(getExecution()?.goalWait?.noProgressRounds, 0);
		assert.equal(getExecution()?.goalWait?.waitRounds, 0);
	});
});

describe("amelioration termination prompt", () => {
	it("recommends goal-wait first and keeps the round options", () => {
		assert.match(AMELIORATION_PROMPT_TEXT, /goal wait: continue until no unpassed VCs remain/);
		assert.match(AMELIORATION_PROMPT_TEXT, /until no high-severity finding \(hard cap 5 rounds\)/);
		assert.match(AMELIORATION_PROMPT_TEXT, /How should the implementation-review loop terminate\?/);
	});
});
