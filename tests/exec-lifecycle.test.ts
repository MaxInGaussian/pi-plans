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

/**
 * v0.10: the non-high repair flag and its derived credit travel the whole
 * checkpoint/session surface. This is the lifecycle-level round-trip (the
 * predicate and loop behaviour live in tests/exec-review-loop.test.ts).
 */
describe("non-high repair checkpoint plumbing (v0.10)", () => {
	it("round-trips all three flag states with the derived credit and drops them on stop", async () => {
		serial += 1;
		const cwd = path.join(root, `repair-${serial}`);
		fs.mkdirSync(cwd);
		spawnSync("git", ["init"], { cwd });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
		spawnSync("git", ["config", "user.name", "T"], { cwd });
		initState(cwd);
		const { run } = startRun(cwd, { topic: "repair-plumbing", skill: "plan-small", requestText: "x" });
		createCheckpoint(cwd, { runId: run.run_id, originWorkdir: cwd, workdir: cwd });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, PLAN, "utf8");
		const {
			applyExecutionApproved,
			applyExecutionCompleted,
			applyExecutionProgress,
			applyExecutionStopped,
			applyPlanWritten,
			mutateCheckpoint,
			planIdentityOf,
		} = await import("../src/workflow-state.ts");
		const plan = planIdentityOf(planPath, 1);
		mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionApproved(
			applyPlanWritten({ ...cp, nextAction: "accept-execute" }, plan),
			{ plan, worktree: cwd, headAtApproval: null, approvedAt: cp.updatedAt },
		));
		for (const state of ["available", "granted", "used"] as const) {
			mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionProgress(cp, { reviewNonHighRepair: state, reviewNonHighCredits: 1 }));
			const loaded = loadCheckpoint(cwd, run.run_id);
			assert.equal(loaded.status, "ok");
			assert.equal(loaded.checkpoint.execution?.reviewNonHighRepair, state, `${state} round-trips`);
			assert.equal(
				loaded.checkpoint.execution?.reviewNonHighCredits,
				state === "granted" ? 1 : 0,
				`${state} credit is derived from the flag`,
			);
		}
		// A legacy shape (no flag at all) stays absent, not corrupt.
		mutateCheckpoint(cwd, run.run_id, (cp) => {
			const { reviewNonHighRepair: _flag, reviewNonHighCredits: _credits, ...execution } = cp.execution!;
			return { ...cp, execution: execution as typeof cp.execution };
		});
		const legacy = loadCheckpoint(cwd, run.run_id);
		assert.equal(legacy.status, "ok");
		assert.equal(legacy.checkpoint.execution?.reviewNonHighRepair, undefined, "absent stays absent");
		// A stop drops the flag and the credit with the rest of the budget state;
		// completion drops them too (a review that no longer runs carries neither).
		const liveCp = loadCheckpoint(cwd, run.run_id).checkpoint;
		mutateCheckpoint(cwd, run.run_id, () => applyExecutionProgress(liveCp, { reviewNonHighRepair: "granted", reviewNonHighCredits: 1 }));
		const finalCp = loadCheckpoint(cwd, run.run_id).checkpoint;
		const stopped = applyExecutionStopped(finalCp as never, "user stop");
		assert.equal(stopped.execution?.reviewNonHighRepair, undefined);
		assert.equal(stopped.execution?.reviewNonHighCredits, undefined);
		const completed = applyExecutionCompleted(finalCp as never);
		assert.equal(completed.execution?.reviewNonHighRepair, undefined);
		assert.equal(completed.execution?.reviewNonHighCredits, undefined);
	});

	it("derives the credit on write and read, rejects unknown flags, and treats a negative credit as corrupt", async () => {
		serial += 1;
		const cwd = path.join(root, `repair-normalize-${serial}`);
		fs.mkdirSync(cwd);
		spawnSync("git", ["init"], { cwd });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
		spawnSync("git", ["config", "user.name", "T"], { cwd });
		initState(cwd);
		const { run } = startRun(cwd, { topic: "repair-normalize", skill: "plan-small", requestText: "x" });
		createCheckpoint(cwd, { runId: run.run_id, originWorkdir: cwd, workdir: cwd });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
		fs.writeFileSync(planPath, PLAN, "utf8");
		const {
			applyExecutionApproved,
			applyExecutionProgress,
			applyPlanWritten,
			mutateCheckpoint,
			planIdentityOf,
		} = await import("../src/workflow-state.ts");
		const plan = planIdentityOf(planPath, 1);
		mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionApproved(
			applyPlanWritten({ ...cp, nextAction: "accept-execute" }, plan),
			{ plan, worktree: cwd, headAtApproval: null, approvedAt: cp.updatedAt },
		));
		// The WRITE path derives the credit from the flag it stores.
		mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionProgress(cp, { reviewNonHighRepair: "available", reviewNonHighCredits: 1 }));
		const file = path.join(cwd, ".git", "pi-plans", "runs", run.run_id, "checkpoint.json");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).execution.reviewNonHighCredits, 0, "write derivation");
		// A hand-edited (or pre-fix) file that disagrees is normalized on read.
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		raw.execution.reviewNonHighCredits = 1; // claim a credit while the flag is `available`
		fs.writeFileSync(file, JSON.stringify(raw), "utf8");
		assert.equal(loadCheckpoint(cwd, run.run_id).checkpoint.execution?.reviewNonHighCredits, 0, "read derivation");
		assert.throws(
			() => mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionProgress(cp, { reviewNonHighRepair: "granted " as never })),
			/reviewNonHighRepair/,
		);
		// null clears the flag (delete-on-null).
		mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionProgress(cp, { reviewNonHighRepair: "granted", reviewNonHighCredits: 1 }));
		mutateCheckpoint(cwd, run.run_id, (cp) => applyExecutionProgress(cp, { reviewNonHighRepair: null }));
		assert.equal(loadCheckpoint(cwd, run.run_id).checkpoint.execution?.reviewNonHighRepair, undefined, "null clears the flag");
		// A negative stored credit is a corrupt checkpoint, never silently used.
		raw.execution.reviewNonHighCredits = -1;
		fs.writeFileSync(file, JSON.stringify(raw), "utf8");
		assert.equal(loadCheckpoint(cwd, run.run_id).status, "corrupt", "a negative credit is rejected on read");
	});

	it("a huge-version completion resets the non-high repair state for the next version", async () => {
		serial += 1;
		const cwd = path.join(root, `repair-huge-${serial}`);
		fs.mkdirSync(cwd);
		spawnSync("git", ["init"], { cwd });
		spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
		spawnSync("git", ["config", "user.name", "T"], { cwd });
		initState(cwd);
		const { run } = startRun(cwd, { topic: "repair-per-version", skill: "plan-huge", requestText: "x" });
		const {
			applyExecutionApproved,
			applyExecutionProgress,
			applyHugeOverallAccepted,
			applyHugeOverallPlanWritten,
			applyHugeVersionCompleted,
			applyHugeVersionPlanWritten,
			planIdentityOf,
		} = await import("../src/workflow-state.ts");
		let cp = createCheckpoint(cwd, { runId: run.run_id, originWorkdir: cwd, workdir: cwd });
		cp = applyHugeOverallAccepted(applyHugeOverallPlanWritten(cp, {
			round: 1,
			versions: [
				{ label: "v0.1.0", mission: "a", done: "b" },
				{ label: "v0.2.0", mission: "c", done: "d" },
			],
		}));
		cp = applyHugeVersionPlanWritten(cp, { stream: "v0.1.0", round: 1 });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		const planPath = path.join(run.artifact_dir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(planPath, "# plan\n", "utf8");
		cp = applyExecutionApproved({ ...cp, nextAction: "accept-execute" }, {
			plan: planIdentityOf(planPath, 1),
			worktree: cp.worktreeRoot,
			headAtApproval: null,
			approvedAt: "2026-10-05T00:00:00Z",
		});
		cp = applyExecutionProgress(cp, { reviewNonHighRepair: "granted", reviewNonHighCredits: 1, reviewRoundsTotal: 2, audit: { rounds: 1, passed: true } });
		const next = applyHugeVersionCompleted(cp, {});
		assert.equal(next.execution?.reviewNonHighRepair, undefined, "the repair flag resets with the version");
		assert.equal(next.execution?.reviewNonHighCredits, undefined, "the credit resets with the version");
	});
});

/**
 * v0.10 (F-008): the huge-version completion headline is keyed on the newest
 * round's finding count, never on the completion ledger's line count — a fully
 * repaired cycle still renders `fixed` lines but keeps the ✅ headline.
 */
describe("huge-version completion headline (v0.10)", () => {
	it("keeps the pass framing for a repaired-only ledger and warns only on real leftovers", async () => {
		const { hugeVersionCompletionMessage } = await import("../src/exec.ts");
		const base = {
			version: "v0.1.0",
			position: "1/2",
			planPath: "/tmp/PLAN_v0.1.0_v1.md",
			next: "v0.2.0",
			summary: "- ✓ `Task-1` a",
			residualNote: "\n\nExecution-review findings repaired during the cycle:\n- F-001 — fixed (repaired by Task-3; no longer reported)",
		};
		const repaired = hugeVersionCompletionMessage({ ...base, findingCount: 0, unresolvedCount: 0, deferredCount: 0 });
		assert.match(repaired, /✅/, "a repaired-only ledger keeps the pass framing");
		assert.doesNotMatch(repaired, /⚠️/, "no warning icon for a resolved cycle");
		const leftover = hugeVersionCompletionMessage({ ...base, findingCount: 2, unresolvedCount: 1, deferredCount: 1 });
		assert.match(leftover, /2 review finding\(s\) without a resolved verdict: 1 unresolved, 1 deferred/);
		assert.match(leftover, /⚠️/);
		assert.doesNotMatch(leftover, /✅/);
	});
});
