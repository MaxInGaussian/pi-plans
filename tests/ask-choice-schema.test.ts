/** 0.5.3 fix suite (run 20260919T014927Z-batch-form-first-option-loss):
 * malformed batch ask_choice calls (first option's label/description hoisted
 * to the question level, recommended flag lost) must fail LOUDLY at the tool
 * boundary — schema rejects stray keys, runtime enforces a recommended
 * option — instead of silently rendering a form missing its first option.
 * Evidence chain: PROBLEM_ANALYSIS.md E2 (raw session toolCall). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { AskChoiceParams, Option, BatchQuestionParams, registerAskChoiceTool } from "../tools/ask-choice.ts";

interface ToolDef {
	name: string;
	parameters: unknown;
	execute: (id: string, params: any, signal: undefined, update: undefined, ctx: any) => Promise<any>;
}

let root: string;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-ask-choice-schema-"));
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

function makeCtx(): { cwd: string; sessionManager: Record<string, unknown>; ui: Record<string, unknown> } {
	return {
		cwd: root,
		sessionManager: {},
		ui: {
			select: async () => {
				throw new Error("form must never open for malformed batches");
			},
			input: async () => {
				throw new Error("input must never open for malformed batches");
			},
			notify: () => {},
		},
	};
}

/** The exact malformed shape captured from the live session (E2): every
 * question lost its first option's label/description to the question level
 * and its recommended flag entirely. */
const HOISTED_FIRST_OPTION_BATCH = {
	questions: [
		{
			label: "边框改纯装饰（推荐）",
			description: "第 7 行变 ╰────╯，图例唯一由第 6 行 markers 行承载（含 DONE:VC）；改动最小、7 行信封不动",
			options: [
				{ label: "边框图例补 DONE", description: "边框图例补上 [DONE:VC-###] 作为唯一图例，第 6 行腾给增量信息" },
				{ label: "面板完全去图例", description: "图例只保留在注入给 agent 的提示词里，面板两行都去掉图例" },
			],
			question: "去重策略：由哪一行承载 marker 图例？（7 行恒定信封维持不变）",
		},
	],
	workdir: root,
};

describe("VC-1 · schema closes every object's property set", () => {
	it("Option / BatchQuestionParams / AskChoiceParams all declare additionalProperties: false", () => {
		for (const schema of [Option, BatchQuestionParams, AskChoiceParams]) {
			assert.equal((schema as { additionalProperties?: unknown }).additionalProperties, false);
		}
	});

	it("registered tool parameters are the very schema under test", () => {
		const tool = loadTool();
		assert.equal(tool.name, "ask_choice");
		assert.equal(tool.parameters, AskChoiceParams);
	});

	it("E2 replay: question-level stray label/description fails Value.Check on the registered parameters", () => {
		const tool = loadTool();
		assert.equal(Value.Check(tool.parameters as never, HOISTED_FIRST_OPTION_BATCH), false);
		assert.equal(Value.Check(AskChoiceParams as never, HOISTED_FIRST_OPTION_BATCH), false);
	});

	it("stray keys inside an option object fail Value.Check", () => {
		const malformed = {
			questions: [
				{
					question: "Q?",
					options: [{ label: "A", recommended: true, core: "1. A" }],
				},
			],
		};
		assert.equal(Value.Check(AskChoiceParams as never, malformed), false);
	});

	it("stray keys at the top level fail Value.Check", () => {
		const malformed = { question: "Q?", options: [{ label: "A", recommended: true }], emphasis: "bold" };
		assert.equal(Value.Check(AskChoiceParams as never, malformed), false);
	});

	it("well-formed batch shape still passes Value.Check", () => {
		const wellFormed = {
			questions: [
				{
					question: "去重策略：由哪一行承载 marker 图例？",
					options: [
						{ label: "边框改纯装饰", description: "第 7 行变 ╰────╯", recommended: true },
						{ label: "边框图例补 DONE", description: "边框图例补上 DONE" },
						{ label: "面板完全去图例", description: "面板两行都去掉图例" },
					],
					allowOther: true,
					questionId: "dedupe-strategy",
					purpose: "legend-dedupe",
				},
				{
					question: "第 6 行放什么增量信息？",
					options: [
						{ label: "run id + plan 版本", recommended: true },
						{ label: "最近活动/轮次" },
						{ label: "留空" },
					],
					questionId: "line6-content",
				},
			],
			workdir: root,
		};
		assert.equal(Value.Check(AskChoiceParams as never, wellFormed), true);
	});
});

describe("VC-2 · hardening does not wound legitimate single-question shapes", () => {
	it("single question with options passes Value.Check", () => {
		const wellFormed = {
			question: "范围确认：按 PLAN_v1 执行？",
			options: [
				{ label: "确认范围（推荐）", description: "双保险 + 负例测试 + 0.5.3", recommended: true },
				{ label: "再调整范围" },
			],
			autoComplete: false,
			questionId: "scope-confirmation",
			workdir: root,
		};
		assert.equal(Value.Check(AskChoiceParams as never, wellFormed), true);
	});

	it("single question with trailing + autoComplete:false passes Value.Check", () => {
		const wellFormed = {
			question: "实现评审循环如何终止？",
			options: [
				{ label: "goal wait：直到无未通过 VC", recommended: true },
				{ label: "直到无高危发现（硬帽 5 轮）" },
			],
			trailing: "auto-refine-loop",
			autoComplete: false,
		};
		assert.equal(Value.Check(AskChoiceParams as never, wellFormed), true);
	});
});

describe("VC-3 · zero-recommended batches reject loudly with zero side effects", () => {
	it("executeAskChoiceBatch rejects, error names 'recommended' and 'hoisted', and nothing is recorded", async () => {
		const tool = loadTool();
		const before = fs.readdirSync(root);
		// Shape-checked params (schema-level stray keys are stripped only by
		// nothing here — we call execute directly with the post-validation
		// object a lenient host could have passed: options present, zero
		// recommended flags).
		const noRecommended = {
			questions: [
				{
					question: "去重策略：由哪一行承载 marker 图例？",
					options: [
						{ label: "边框图例补 DONE", description: "…" },
						{ label: "面板完全去图例", description: "…" },
					],
					questionId: "dedupe-strategy",
				},
			],
			workdir: root,
		};
		await assert.rejects(
			tool.execute("call-schema-1", noRecommended, undefined, undefined, makeCtx()),
			(error: Error) => {
				assert.match(error.message, /recommended/);
				assert.match(error.message, /hoisted/);
				return true;
			},
		);
		// No decisions ledger, no checkpoint: rejection happened before any
		// recording/short-circuit side effect (D-7).
		assert.deepEqual(fs.readdirSync(root), before);
	});

	it("recommended NOT in first position is accepted (D-4: at-least-one contract)", async () => {
		const tool = loadTool();
		// autoComplete: true + no active run-level gate → the batch short-circuits
		// with the recommended option (D-022). A resolved result proves the
		// invariant let the non-first recommended option through.
		const shape = {
			questions: [
				{
					question: "第 6 行放什么？",
					options: [{ label: "留空" }, { label: "最近活动/轮次", recommended: true }],
					questionId: "line6-content",
					autoComplete: true,
				},
			],
			workdir: root,
		};
		const ctx = makeCtx();
		(ctx.ui as Record<string, unknown>).select = async () => "留空";
		const result = await tool.execute("call-schema-2", shape, undefined, undefined, ctx);
		const text = JSON.stringify(result);
		assert.ok(text.includes("最近活动/轮次"), `short-circuit should answer with the recommended option: ${text}`);
	});
});
