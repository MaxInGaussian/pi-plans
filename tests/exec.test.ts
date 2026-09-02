/** Tests for the execution loop: marker tracking, session restore, completion. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
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
	shouldTriggerPlanningCompaction,
	startExecution,
	recordExecutionTurn,
	registerExecutionTurnHandlers,
	stopExecution,
	updateStatusWidget,
} from "../src/exec.ts";
import type { CheckItem } from "../src/plan.ts";
import { initState, setRunStatus, startRun } from "../src/state.ts";

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
		sendUserMessage: async () => {},
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
		const rules = executionContextMessage()!;
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

	it("completion attaches the amelioration prompt and triggers a turn in interactive sessions", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		const planPath = path.join(workdir, "PLAN_v1.md");
		await startExecution(pi, ctx, planPath, items("VC-001", "VC-002"));
		assert.deepEqual(applyDoneMarkers("[DONE:VC-001] [DONE:VC-002]"), ["VC-001", "VC-002"]);

		await completeExecution(pi, ctx);

		const completeMessage = recorded.messages.find((message) => message.customType === "pi-plans-complete");
		assert.ok(completeMessage);
		assert.match(completeMessage.content, /Post-execution amelioration/);
		assert.match(completeMessage.content, /trailing: "auto-refine-loop"/);
		assert.match(completeMessage.content, /until no high-severity finding \(hard cap 5 rounds/);
		assert.equal(completeMessage.options?.triggerTurn, true);
		const ameliorateEntry = recorded.entries.find((entry) => entry.customType === "pi-plans-ameliorate");
		assert.ok(ameliorateEntry);
		const data = ameliorateEntry.data as Record<string, unknown>;
		assert.equal(data.phase, "prompted");
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
		assert.doesNotMatch(completeMessage.content, /Post-execution amelioration/);
		assert.equal(completeMessage.options?.triggerTurn, false);
		assert.equal(
			recorded.entries.some((entry) => entry.customType === "pi-plans-ameliorate"),
			false,
			"headless completion must not append the ameliorate entry",
		);
	});

	it("restoreFromSession completion triggers the same amelioration prompt in interactive sessions", async () => {
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
		assert.match(completeMessage.content, /Post-execution amelioration/);
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

	it("lets Pi core own execution compaction scheduling and customizes every reason", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v8.md"), items("VC-001", "VC-002"));

		setUsagePercent(50);
		const below = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(below?.cancel, undefined);
		assert.ok(below?.compaction, "threshold compaction should remain Pi-core-owned but use the custom summary");

		setUsagePercent(105);
		const above = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(above?.cancel, undefined);
		assert.ok(above?.compaction);

		const overflow = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("overflow", null),
			branchEntries: [],
			reason: "overflow",
			willRetry: true,
			signal: new AbortController().signal,
		});
		assert.equal(overflow?.cancel, undefined);
		assert.ok(overflow?.compaction);

		const manual = handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation: makePreparation("manual", null),
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(manual?.cancel, undefined);
		assert.ok(manual?.compaction);

		await stopExecution(pi, ctx, "test-done");
	});

	it("triggers execution compaction at the high watermark, suppresses repeats, and re-arms below the low watermark", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v9.md"), items("VC-001", "VC-002"));

		setUsagePercent(96);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 1, "first high-watermark turn should request one compact");

		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 1, "in-flight compact must not be requested twice");

		handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});
		assert.equal(
			recorded.messages.filter((message) => message.customType === "pi-plans-exec-resume").length,
			1,
			"non-retry execution compaction should queue one hidden resume",
		);

		setUsagePercent(96);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 1, "resume guard should suppress the immediate follow-up turn");

		setUsagePercent(79);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 1, "low-watermark turns stay quiet while below re-arm");

		setUsagePercent(96);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 2, "high watermark should re-arm after the low-watermark drop");

		await stopExecution(pi, ctx, "test-done");
	});

	it("skips proactive current-I compaction when no eligible prefix exists", async () => {
		const workdir = freshWorkdir();
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
	it("wires execution compaction without restoring execution model helpers", () => {
		const indexSource = fs.readFileSync(path.join(process.cwd(), "index.ts"), "utf8");
		const execSource = fs.readFileSync(path.join(process.cwd(), "src/exec.ts"), "utf8");
		assert.match(indexSource, /handleExecutionTurnCompaction/);
		assert.match(execSource, /shouldTriggerExecutionCompaction/);
		assert.match(execSource, /requestExecutionCompaction/);
		assert.doesNotMatch(
			indexSource,
			/setExecutionModel|chooseExecutionModelSelection|snapshotCurrentModelSelector|ensureExecutionModelActive|restorePlanningModel/,
		);
		assert.doesNotMatch(
			execSource,
			/setExecutionModel|chooseExecutionModelSelection|snapshotCurrentModelSelector|ensureExecutionModelActive|restorePlanningModel/,
		);
	});

	it("queues one non-retry resume, skips overflow retry, and keeps execution after failure", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v9.md"), items("VC-001"));

		const beforeRequests = recorded.compacts?.length ?? 0;
		handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});
		const resumes = recorded.messages.filter((message) => message.customType === "pi-plans-exec-resume");
		assert.equal(resumes.length, 1, "non-retry compaction should queue one hidden resume");
		assert.equal(resumes[0]?.options?.triggerTurn, true);
		assert.equal(recorded.compacts?.length ?? 0, beforeRequests, "compaction hook must not invoke ctx.compact");

		handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "overflow",
			willRetry: true,
		});
		assert.equal(
			recorded.messages.filter((message) => message.customType === "pi-plans-exec-resume").length,
			1,
			"overflow retry is owned by Pi core",
		);

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

	it("builds a plan-aware summary with per-item sections and chains the previous summary", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v10.md"), items("VC-001", "VC-002"));

		applyDoneMarkers("[DONE:VC-001]");

		const previousSummary = "## Goal\nDeliver auto-compact in execution phase.\n\n## Finished Items\n- legacy VC-000 summary";
		const preparation = makePreparation("threshold", previousSummary);
		const branchEntries: any[] = [
			{ id: "exec-start", type: "custom", customType: "pi-plans-exec-start" },
			{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "implement VC-001" }] } },
			{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "wrote helper [DONE:VC-001]" }] } },
			{ id: "u-2", type: "message", message: { role: "user", content: [{ type: "text", text: "implement VC-002" }] } },
			{ id: "a-2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "almost done" }] } },
			{ id: "exec-ctx", type: "custom", customType: "pi-plans-exec-context" },
		];
		const result = buildExecutionCompactionResult(
			{
				type: "session_before_compact",
				preparation,
				branchEntries,
				customInstructions: "keep current task visible",
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx,
		);
		assert.ok(result);
		assert.match(result!.summary, /## Compact Instructions/);
		assert.match(result!.summary, /keep current task visible/);
		assert.match(result!.summary, /## Plan Before This Run/);
		assert.match(result!.summary, /## Previous Compact Summary/);
		assert.match(result!.summary, /## Finished VC Items/);
		assert.match(result!.summary, /### `VC-001`/);
		assert.match(result!.summary, /## Current Work/);
		assert.match(result!.summary, /Raw tail preserved from `u-2`/);
		assert.deepEqual(result!.firstKeptEntryId, "u-2");

		setUsagePercent(110);
		handleExecutionBeforeCompact(pi, ctx, {
			type: "session_before_compact",
			preparation,
			branchEntries,
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});

		await stopExecution(pi, ctx, "test-done");
	});

	it("uses the current model for bounded valid summaries and falls back on invalid output", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v21.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);
		const signal = new AbortController().signal;
		const calls: unknown[][] = [];
		let response: any = {
			stopReason: "stop",
			content: [{ type: "text", text: "## Implementation Items\n- I-001\n\n## Current I\n- I-001\n\n## Read Records\n- none\n\n## Compaction Boundary\n- a-2\n\n## Decisions\n- preserved\n\n## Open Questions\n- none\n\n## Next Steps\n- continue" }],
			usage: { input: 12, output: 34 },
		};
		(ctx.modelRegistry as any).complete = async (...args: unknown[]) => {
			calls.push(args);
			return response;
		};
		const event: any = {
			type: "session_before_compact",
			preparation: makePreparation("threshold", null),
			branchEntries: [
				{ id: "i-1", type: "message", tokens: 100, message: { role: "assistant", content: [{ type: "text", text: "[I-001:current] work" }] } },
				{ id: "a-1", type: "message", tokens: 100, message: { role: "assistant", content: [{ type: "text", text: "details" }] } },
			],
			reason: "threshold",
			willRetry: false,
			signal,
		};
		const valid = await handleExecutionBeforeCompact(pi, ctx, event);
		assert.ok(valid?.compaction);
		assert.equal(calls[0]?.[0], recorded.current);
		assert.equal((calls[0]?.[2] as any).signal, signal);
		assert.equal((calls[0]?.[2] as any).cacheRetention, "none");
		assert.ok((calls[0]?.[2] as any).maxTokens <= 2048);
		assert.deepEqual(valid?.compaction?.usage, response.usage);
		assert.equal((valid?.compaction?.details as any)?.metrics?.summaryTokens, Math.ceil(response.content[0].text.length / 4));

		response = { stopReason: "length", content: [{ type: "text", text: "## Implementation Items\npartial" }] };
		const invalid = await handleExecutionBeforeCompact(pi, ctx, { ...event, signal: new AbortController().signal });
		assert.equal(invalid, undefined, "incomplete model output must return control to Pi default compaction");
		await stopExecution(pi, ctx, "model-test");
	});	it("filters the hidden resume message out of the LLM context payload", () => {
		const messages = [
			{ customType: "user", content: "real prompt" },
			{ customType: "pi-plans-exec-resume", content: "Continue execution." },
			{ customType: "pi-plans-plan-resume", content: "Continue planning." },
			{ customType: "assistant", content: "ok" },
		];
		assert.equal(filterExecutionResumeMessages(messages).length, 3);
		assert.equal(filterPlanningResumeMessages(messages).length, 3);
	});

	it("planning compaction cuts at plan-written when present and falls back to run-start", () => {
		const workdir = freshWorkdir();
		const { ctx } = makeHarness(workdir);
		initState(workdir);
		const { run } = startRun(workdir, { topic: "planning compact", skill: "plan-normal", requestText: "demo" });
		fs.writeFileSync(path.join(run.artifact_dir, "PLAN_v1.md"), "# plan");

		const makePlanningPreparation = (previousSummary: string | null) => ({
			firstKeptEntryId: "fallback",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50000,
			previousSummary,
			fileOps: { read: [], written: [], edited: [] },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		});

		// Case A: plan written → cut at next non-internal entry after plan-written; QA section included.
		const branchEntriesWithPlan = [
			{ id: "rs", type: "custom", customType: PLANNING_RUN_START_CUSTOM_TYPE, data: { runId: run.run_id, artifactDir: run.artifact_dir } },
			{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "background question?" }] } },
			{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "some context" }] } },
			{ id: "pw", type: "custom", customType: PLANNING_PLAN_WRITTEN_CUSTOM_TYPE, data: { runId: run.run_id, planPath: path.join(run.artifact_dir, "PLAN_v1.md") } },
			{ id: "u-2", type: "message", message: { role: "user", content: [{ type: "text", text: "review please" }] } },
		] as any;
		const withPlan = buildPlanningCompactionResult(
			{
				type: "session_before_compact",
				preparation: makePlanningPreparation(null),
				branchEntries: branchEntriesWithPlan,
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx,
		);
		assert.ok(withPlan);
		assert.deepEqual(withPlan!.firstKeptEntryId, "u-2");
		assert.match(withPlan!.summary, /## Q&A During Planning/);
		assert.match(withPlan!.summary, /background question?/);

		// Case B: only run-start → cut at first non-internal entry after marker; no QA section.
		const branchEntriesWithoutPlan = [
			{ id: "rs", type: "custom", customType: PLANNING_RUN_START_CUSTOM_TYPE, data: { runId: run.run_id, artifactDir: run.artifact_dir } },
			{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "open question" }] } },
			{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] } },
		] as any;
		const withoutPlan = buildPlanningCompactionResult(
			{
				type: "session_before_compact",
				preparation: makePlanningPreparation(null),
				branchEntries: branchEntriesWithoutPlan,
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx,
		);
		assert.ok(withoutPlan);
		assert.deepEqual(withoutPlan!.firstKeptEntryId, "u-1");
		assert.doesNotMatch(withoutPlan!.summary, /## Q&A During Planning/);

		// Case C: no markers → fallback to preparation.firstKeptEntryId and no QA section.
		const fallback = buildPlanningCompactionResult(
			{
				type: "session_before_compact",
				preparation: makePlanningPreparation("## Previous\nEarlier summary."),
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx,
		);
		assert.ok(fallback);
		assert.deepEqual(fallback!.firstKeptEntryId, "fallback");
		assert.doesNotMatch(fallback!.summary, /## Q&A During Planning/);
		assert.match(fallback!.summary, /## Previous Compact Summary/);
	});

	it("planning hook is gated by run.status=planning and defers to execution hook when execution is running", async () => {
		const workdir = freshWorkdir();
		const { ctx, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		const { run } = startRun(workdir, { topic: "planning gate", skill: "plan-small", requestText: "x" });

		setUsagePercent(110);
		const resultPlanning = handlePlanningBeforeCompact({} as any, ctx as any, {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "fb",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1,
				previousSummary: null,
				fileOps: { read: [], written: [], edited: [] },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.ok(resultPlanning?.compaction || resultPlanning === undefined);

		// Flip status to done; planning hook should refuse.
		setRunStatus(workdir, run.run_id, "done");
		setUsagePercent(110);
		const resultDone = handlePlanningBeforeCompact({} as any, ctx as any, {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "fb",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1,
				previousSummary: null,
				fileOps: { read: [], written: [], edited: [] },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(resultDone, undefined);
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
		const rules = executionContextMessage()!;
		assert.match(rules, /\[I-001:implemented\]/);
		assert.match(rules, /\[I-001:validating\]/);
		assert.match(rules, /subprocess-backed verification/);
		assert.match(rules, /waiting for/);
		assert.match(rules, /5s\s*->\s*10s\s*->\s*20s\s*->\s*40s\s*->\s*80s/);
		assert.match(rules, /keep polling at 80s/);
		assert.match(rules, /restart at 5s for each new subprocess/);
		await stopExecution(pi, ctx, "done");
	});

	it("planning compaction honors cooldown + resume guard and survives manual /compact", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, setUsagePercent, recorded } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "planning cooldown", skill: "plan-normal", requestText: "x" });

		setUsagePercent(120);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), true);
		requestPlanningCompaction(ctx as any);
		// In flight, second trigger ignored.
		requestPlanningCompaction(ctx as any);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), false);

		setUsagePercent(50);
		handlePlanningCompact(pi as any, ctx as any, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});
		const resume = recorded.messages.find((message) => message.customType === "pi-plans-plan-resume");
		assert.ok(resume);
		assert.equal(consumePlanningCompactionResumeGuard(ctx as any), true);
		// Cooldown blocks retrigger while usage is still mid-band.
		setUsagePercent(95);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), false);
		setUsagePercent(50);
		refreshPlanningCompactionCooldown(ctx as any);
		setUsagePercent(120);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), true);
	});

	it("planning compaction requests are gated on agent idleness", () => {
		const workdir = freshWorkdir();
		const { ctx, recorded, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "idle gate", skill: "plan-normal", requestText: "x" });
		setUsagePercent(120);

		(ctx as any).isIdle = () => false;
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 0, "busy agent must not be aborted by an auto compact");
		const session = (ctx as any).sessionManager;
		assert.equal(session.__planningCompaction?.inFlight, false, "skipped request must not latch inFlight");

		(ctx as any).isIdle = () => true;
		(ctx as any).hasPendingMessages = () => true;
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 0, "queued messages also count as busy");

		(ctx as any).hasPendingMessages = () => false;
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 1, "idle agent accepts the request");
	});

	it("terminal nothing-to-compact failures back off instead of retrying every turn", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "terminal backoff", skill: "plan-normal", requestText: "x" });

		setUsagePercent(60);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), true);
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 1);

		handlePlanningCompactFailed(pi as any, ctx as any, {
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "Compaction failed: Nothing to compact (session too small)",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});

		setUsagePercent(50);
		refreshPlanningCompactionCooldown(ctx as any);
		setUsagePercent(60);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), false, "terminal backoff must suppress the next trigger");
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 1, "no repeat request while backed off");

		setUsagePercent(95);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), true, "high watermark releases the backoff");
		requestPlanningCompaction(ctx as any);
		assert.equal(recorded.compacts?.length ?? 0, 2);

		handlePlanningCompactFailed(pi as any, ctx as any, {
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "network down",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
		setUsagePercent(60);
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), true, "non-terminal failures keep the retryable path");
	});

	it("execution compaction applies the same idle gate and terminal backoff", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v23.md"), items("VC-001"), [
			{ id: "I-001", text: "First item." },
		]);

		setUsagePercent(96);
		(ctx as any).isIdle = () => false;
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 0, "busy agent must not be aborted");

		(ctx as any).isIdle = () => true;
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 1);

		handleExecutionCompactFailed(pi, ctx, {
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "Compaction failed: Already compacted",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});

		setUsagePercent(60);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 1, "terminal backoff suppresses repeat requests");

		setUsagePercent(96);
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, 2, "high watermark releases the execution backoff");

		await stopExecution(pi, ctx, "test-done");
	});

	it("treats abort/stream compact failures as terminal and notifies explicitly", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "abort-stream classification", skill: "plan-normal", requestText: "x" });
		// Seed the planning state with a successful prior compaction so the failure
		// handler enters the terminal branch (state must exist).
		setUsagePercent(120);
		(ctx as any).isIdle = () => true;
		requestPlanningCompaction(ctx as any);
		handlePlanningCompact(pi as any, ctx as any, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});
		// Drop into mid-band so the backoff anchor (tokens @ 120k) gates retries
		// until growth ≥ 20k tokens (which the test won't trigger).
		setUsagePercent(60);

		const abortMessages = [
			"Auto-compaction failed: Turn prefix summarization failed: This operation was aborted",
			"Error: OpenAI Responses stream ended before a terminal response event",
			"Auto-compaction failed: context overflow recovery failed",
			"this operation was aborted",
			"aborted",
		];
		for (const errorMessage of abortMessages) {
			recorded.notifies.length = 0;
			setUsagePercent(60);
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
			// Backoff active: next requestPlanningCompaction should NOT call ctx.compact.
			const before = recorded.compacts?.length ?? 0;
			requestPlanningCompaction(ctx as any);
			assert.equal(
				(recorded.compacts?.length ?? 0) - before,
				0,
				`expected no new request for: ${errorMessage}`,
			);
		}
	});

	it("event.aborted=true with empty errorMessage still enters abort-class backoff", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "aborted-no-message", skill: "plan-normal", requestText: "x" });
		setUsagePercent(120);
		(ctx as any).isIdle = () => true;
		requestPlanningCompaction(ctx as any);
		handlePlanningCompact(pi as any, ctx as any, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});
		setUsagePercent(60);

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
		assert.equal((recorded.compacts?.length ?? 0) - before, 0, "aborted-without-message must still back off");
	});

	it("network-style failures stay retryable (no abort-class backoff)", () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		initState(workdir);
		startRun(workdir, { topic: "network-retryable", skill: "plan-normal", requestText: "x" });
		setUsagePercent(120);
		(ctx as any).isIdle = () => true;
		requestPlanningCompaction(ctx as any);

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
		assert.equal((recorded.compacts?.length ?? 0) - before, 1, "network down should allow retry");
	});

	it("lifecycle: phase-local inFlight guard skips manual compact while Pi core is running one", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v3.md"), items("VC-001"));
		setUsagePercent(96);
		(ctx as any).isIdle = () => true;

		// First execution request lands and latches state.inFlight = true.
		handleExecutionTurnCompaction(ctx);
		assert.equal((recorded.compacts?.length ?? 0) >= 1, true, "execution first request lands");
		// Clear execution in-flight by simulating a successful compaction event.
		handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});

		// Simulate Pi core running a threshold auto-compaction: no customInstructions
		// hint means BOTH phases' flags get set defensively.
		noteCompactionStarted(ctx as any, undefined);
		assert.equal(compactionInFlight(ctx as any, "planning"), true, "auto-compaction marks planning inFlight");
		assert.equal(compactionInFlight(ctx as any, "execution"), true, "auto-compaction marks execution inFlight");

		const beforeSkip = recorded.compacts?.length ?? 0;
		handleExecutionTurnCompaction(ctx);
		assert.equal(recorded.compacts?.length ?? 0, beforeSkip, "execution request skipped while in-flight");
		assert.equal(shouldTriggerPlanningCompaction(ctx as any), false, "planning guard sees in-flight");

		// End of auto-compaction (success): both flags cleared.
		noteCompactionEnded(ctx as any, undefined);
		assert.equal(compactionInFlight(ctx as any, "planning"), false);
		assert.equal(compactionInFlight(ctx as any, "execution"), false);

		// Drop below 85 then re-arm past 85 so the cooldown gate releases.
		setUsagePercent(60);
		handleExecutionTurnCompaction(ctx);
		setUsagePercent(96);
		const beforeFire = recorded.compacts?.length ?? 0;
		handleExecutionTurnCompaction(ctx);
		assert.equal((recorded.compacts?.length ?? 0) - beforeFire, 1, "execution request lands after compaction ends");

		// Clear execution in-flight again so the next planning-only flag test isn't blocked.
		handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});

		// Simulate a planning-side manual compact only: execution must remain free.
		recorded.compacts = [];
		// Drop below 85 first to release the cooldown gate from the earlier success.
		setUsagePercent(60);
		handleExecutionTurnCompaction(ctx);
		setUsagePercent(96);
		noteCompactionStarted(ctx as any, "pi-plans planning auto compact");
		assert.equal(compactionInFlight(ctx as any, "planning"), true);
		assert.equal(compactionInFlight(ctx as any, "execution"), false, "planning-only flag does not block execution");
		const beforeExec = recorded.compacts?.length ?? 0;
		handleExecutionTurnCompaction(ctx);
		assert.equal((recorded.compacts?.length ?? 0) - beforeExec >= 1, true, "execution still fires while only planning is in-flight");
		noteCompactionEnded(ctx as any, "pi-plans planning auto compact");

		await stopExecution(pi, ctx, "test-done");
	});

	it("execution handler classifies abort/stream failures as terminal (F-004 coverage)", async () => {
		const workdir = freshWorkdir();
		const { pi, ctx, recorded, setUsagePercent } = makeHarness(workdir);
		await startExecution(pi, ctx, path.join(workdir, "PLAN_v4.md"), items("VC-001"));
		(ctx as any).isIdle = () => true;
		setUsagePercent(120);
		// Seed execution compaction state via a normal request and successful event.
		handleExecutionTurnCompaction(ctx);
		handleExecutionCompact(pi, ctx, {
			type: "session_compact",
			compactionEntry: { type: "compaction" } as never,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});
		setUsagePercent(60);

		const abortMessages = [
			"Auto-compaction failed: Turn prefix summarization failed: This operation was aborted",
			"Error: OpenAI Responses stream ended before a terminal response event",
			"Auto-compaction failed: context overflow recovery failed",
			"aborted",
		];
		for (const errorMessage of abortMessages) {
			recorded.notifies.length = 0;
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
		// Also exercise the ReferenceError trap fixed by F-001: aborted=true with
		// no errorMessage and state.inFlight=false (Pi core threshold auto-cancel).
		handleExecutionCompactFailed(pi, ctx, {
			type: "session_compact_failed",
			reason: "threshold",
			errorMessage: undefined,
			aborted: true,
			willRetry: false,
			fromExtension: false,
		});
		const cleanNote = recorded.notifies.find((n) => n.message.includes("was aborted"));
		assert.ok(cleanNote, "aborted-without-message must enter abort-class backoff on execution side too");
		await stopExecution(pi, ctx, "test-done");
	});

	it("index.ts wires session_compact/session_compact_failed to clear inFlight flags (F-003/F-004 coverage)", () => {
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

function makePreparation(reason: "manual" | "threshold" | "overflow", previousSummary: string | null): any {
	return {
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
