/**
 * ask_choice batch mode (0.4.0 feature 1) at the tool boundary: validation
 * layer (R-013b), decision-ledger + checkpoint persistence (D-021/D-024),
 * partial-cancel semantics (D-009) and crash-recovery replay (VC-004 fixture).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskChoiceTool } from "../tools/ask-choice.ts";
import { initState, recordDecision, startRun } from "../src/state.ts";
import { createCheckpoint, loadCheckpoint } from "../src/workflow-state.ts";
import { reconcileCheckpointWithLedger } from "../src/resume.ts";
import { readDecisionLedger } from "../src/resume.ts";

type ToolDef = {
	execute: (id: string, params: any, signal: undefined, update: undefined, ctx: any) => Promise<any>;
};

let root: string;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-batch-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function loadTool(): ToolDef {
	let tool: ToolDef | undefined;
	const pi = {
		registerTool: (definition: ToolDef) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	registerAskChoiceTool(pi);
	if (!tool) throw new Error("ask_choice tool not registered");
	return tool;
}

function freshWorkdir(): string {
	const workdir = path.join(root, `repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	fs.mkdirSync(workdir, { recursive: true });
	return workdir;
}

function startActiveRun(workdir: string) {
	initState(workdir);
	const { run } = startRun(workdir, { topic: "batch", skill: "plan-small", requestText: "x" });
	// The plans tool creates the checkpoint right after start-run; mirror that
	// so checkpoint-backed batch persistence has a durable home (I-003).
	createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
	return run;
}

function makeCtx(workdir: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd: workdir,
		hasUI: true,
		sessionManager: {},
		ui: {
			custom: undefined,
			select: async () => undefined,
			input: async () => "typed",
			theme: { fg: (_c: string, s: string) => s },
			...overrides,
		},
	};
}

function recordDecisionEntry(workdir: string, runId: string, entry: Record<string, unknown>): void {
	recordDecision(workdir, runId, entry as never);
}

const Q1 = { question: "Q1?", options: [{ label: "A1", recommended: true }, { label: "B1" }], questionId: "q-1" };
const Q2 = { question: "Q2?", options: [{ label: "A2", recommended: true }, { label: "B2" }], questionId: "q-2" };

/** Drive the custom form: N Enters to confirm preselected options and submit. */
function formHarness(keys: string[]) {
	return async function custom(factory: unknown): Promise<unknown> {
		let resolvePromise: ((r: unknown) => void) | undefined;
		const promise = new Promise((resolve) => {
			resolvePromise = resolve;
		});
		const comp = (factory as (...a: unknown[]) => { handleInput(d: string): void; render(w: number): string[] })(
			{ setShowHardwareCursor: () => {} },
			{},
			{},
			(r: unknown) => resolvePromise?.(r),
		);
		for (const key of keys) comp.handleInput(key);
		return promise;
	};
}

describe("ask_choice batch validation (R-013b/D-025)", () => {
	it("rejects batches over 8 questions with a split hint", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const ctx = makeCtx(workdir);
		const nine = Array.from({ length: 9 }, (_, i) => ({
			question: `Q${i}?`,
			options: [{ label: `O${i}` }],
		}));
		await assert.rejects(
			() => tool.execute("t", { questions: nine }, undefined, undefined, ctx),
			/at most 8 questions/,
		);
	});

	it("rejects scope/handoff questionIds and autoComplete: false items in batches", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const ctx = makeCtx(workdir);
		await assert.rejects(
			() => tool.execute("t", { questions: [{ ...Q1, questionId: "scope-confirm-handoff" }, Q2] }, undefined, undefined, ctx),
			/reserved questionId/,
		);
		await assert.rejects(
			() => tool.execute("t", { questions: [{ ...Q1, autoComplete: false }, Q2] }, undefined, undefined, ctx),
			/autoComplete: false/,
		);
		await assert.rejects(
			() => tool.execute("t", { questions: [{ ...Q1, questionId: "termination-condition" }, Q2] }, undefined, undefined, ctx),
			/reserved questionId/,
		);
	});

	it("rejects duplicate questionIds", async () => {
		const tool = loadTool();
		const ctx = makeCtx(freshWorkdir());
		await assert.rejects(
			() => tool.execute("t", { questions: [{ ...Q1, questionId: "same" }, { ...Q2, questionId: "same" }] }, undefined, undefined, ctx),
			/duplicate questionId/,
		);
	});
});

describe("ask_choice batch persistence (D-021/D-024)", () => {
	it("records every answer to the ledger and prunes checkpoint pending rows on submit", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const run = startActiveRun(workdir);
		const ctx = makeCtx(workdir, { custom: formHarness(["\r", "\r", "\r"]) });
		const result = await tool.execute("t", { questions: [Q1, Q2] }, undefined, undefined, ctx);
		assert.equal(result.details.source, "user");
		assert.equal(result.details.batch.length, 2);

		const ledger = readDecisionLedger(workdir, run.run_id);
		const ids = ledger.filter((e) => e.questionId).map((e) => e.questionId);
		assert.ok(ids.includes("q-1") && ids.includes("q-2"));
		const checkpoint = loadCheckpoint(workdir, run.run_id);
		assert.equal(checkpoint.status, "ok");
		if (checkpoint.status === "ok") {
			assert.equal(checkpoint.checkpoint.pendingQuestions.length, 0, "batch rows pruned after submit");
			assert.equal(
				checkpoint.checkpoint.answeredQuestions.filter((a) => a.questionId === "q-1").length,
				1,
			);
		}
	});

	it("partial Esc returns the answered subset, records a batch cancelled row and disables auto-complete", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const run = startActiveRun(workdir);
		// Q1 confirmed (Enter) → Q2 answered too (preselected, Enter) → submit
		// page → Esc: everything is answered so Esc returns all answers with
		// the cancelled flag.
		const ctx = makeCtx(workdir, { custom: formHarness(["\r", "\r", "\x1b"]) });
		const result = await tool.execute("t", { questions: [Q1, Q2] }, undefined, undefined, ctx);
		assert.equal(result.details.source, "cancelled");
		assert.equal(result.details.batch.length, 2, "Esc after answering returns the full answered subset");
		const ledger = readDecisionLedger(workdir, run.run_id);
		assert.ok(ledger.some((e) => e.question.startsWith("[batch cancelled")));
	});

	it("crash fixture: q1 answered / q2 pending → reconcile replays only q2", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const run = startActiveRun(workdir);
		// Crash window: the form opened (both rows pending in the checkpoint),
		// q1's answer landed in the ledger, then the process died before the
		// per-question prune ran. Reconcile must keep q2 pending only.
		const ctx = makeCtx(workdir, { custom: formHarness([]) });
		// Start the batch (markAsked runs synchronously before the form opens),
		// then "crash": never resolve the form and write q1's answer directly
		// to the ledger as if the decisions write landed first.
		const started = tool.execute("t", { questions: [Q1, Q2] }, undefined, undefined, ctx);
		void started.catch(() => {}); // stays pending: the crash window
		await new Promise((resolve) => setImmediate(resolve));
		recordDecisionEntry(workdir, run.run_id, { question: Q1.question, options: Q1.options.map((o) => o.label), answer: "A1", answer_source: "user", questionId: "q-1" });

		const checkpoint = loadCheckpoint(workdir, run.run_id);
		assert.equal(checkpoint.status, "ok");
		if (checkpoint.status !== "ok") return;
		const reconciled = reconcileCheckpointWithLedger(workdir, run.run_id, checkpoint.checkpoint);
		assert.deepEqual(
			reconciled.pendingQuestions.map((q) => q.questionId),
			["q-2"],
			"resume replays only the unanswered question",
		);
	});
});

describe("ask_choice batch gates", () => {
	it("short-circuits the whole batch with recommendations under PI_PLANS_AUTO_APPROVE", async () => {
		const previous = process.env.PI_PLANS_AUTO_APPROVE;
		process.env.PI_PLANS_AUTO_APPROVE = "1";
		try {
			const tool = loadTool();
			const workdir = freshWorkdir();
			const run = startActiveRun(workdir);
			const ctx = makeCtx(workdir);
			const result = await tool.execute("t", { questions: [Q1, Q2] }, undefined, undefined, ctx);
			assert.equal(result.details.source, "auto-complete");
			assert.deepEqual(
				result.details.batch.map((b: { answer: string }) => b.answer),
				["A1", "A2"],
			);
			const ledger = readDecisionLedger(workdir, run.run_id);
			assert.equal(ledger.filter((e) => e.questionId).length, 2);
		} finally {
			if (previous === undefined) delete process.env.PI_PLANS_AUTO_APPROVE;
			else process.env.PI_PLANS_AUTO_APPROVE = previous;
		}
	});

	it("degrades to sequential selects when the host lacks a custom dialog (RPC)", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const seen: Array<{ question: string; labels: string[] }> = [];
		const ctx = makeCtx(workdir, {
			custom: undefined,
			select: async (question: string, labels: string[]) => {
				seen.push({ question, labels });
				return labels[0];
			},
		});
		const result = await tool.execute("t", { questions: [Q1, Q2] }, undefined, undefined, ctx);
		assert.equal(seen.length, 2, "one select per question in RPC fallback");
		assert.equal(result.details.batch.length, 2);
	});

	it("auto-completes every question in print/json mode without opening UI", async () => {
		const tool = loadTool();
		const workdir = freshWorkdir();
		const run = startActiveRun(workdir);
		const ctx = { ...makeCtx(workdir), hasUI: false };
		const result = await tool.execute("t", { questions: [Q1, Q2] }, undefined, undefined, ctx);
		assert.equal(result.details.source, "auto-complete");
		assert.deepEqual(
			result.details.batch.map((b: { answer: string }) => b.answer),
			["A1", "A2"],
		);
		const ledger = readDecisionLedger(workdir, run.run_id);
		assert.equal(ledger.filter((e) => e.questionId).length, 2);
	});
});
