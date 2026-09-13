/** I-004/AC-005: benchmark auto-approve (PI_PLANS_AUTO_APPROVE=1) behavior —
 * env short-circuit answers lifecycle questions with the recommendation in
 * headless AND UI contexts, hard-rejects external-state questions, and leaves
 * default (env off) behavior unchanged. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskChoiceTool } from "../tools/ask-choice.ts";
import { executeHandoff, setCurrentApi } from "../tools/execute-plan.ts";
import {
	AUTO_APPROVE_ENV,
	assertAutoApprovable,
	isAutoApproveEnabled,
	isExternalStateQuestion,
} from "../src/auto-approve.ts";
import { getExecution, stopExecution } from "../src/exec.ts";

type ToolDef = {
	execute: (id: string, params: any, signal: undefined, update: undefined, ctx: any) => Promise<any>;
};

let root: string;
let selectCalls = 0;
let confirmCalls = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-auto-approve-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function setEnv(value: string | undefined): void {
	if (value === undefined) delete process.env[AUTO_APPROVE_ENV];
	else process.env[AUTO_APPROVE_ENV] = value;
}

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

function makeCtx(opts: { hasUI?: boolean } = {}): any {
	selectCalls = 0;
	confirmCalls = 0;
	return {
		cwd: root,
		hasUI: opts.hasUI ?? false,
		sessionManager: {},
		ui: {
			select: async (_question: string, _labels: string[]) => {
				selectCalls += 1;
				return undefined;
			},
			confirm: async () => {
				confirmCalls += 1;
				return false;
			},
			input: async () => undefined,
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_kind: string, text: string) => text, bold: (text: string) => text },
		},
	};
}

const LIFECYCLE_OPTIONS = [
	{ label: "✓ Accept & execute now", recommended: true },
	{ label: "Accept, don't execute yet" },
];

describe("auto-approve env parsing", () => {
	it("is enabled only by the exact value 1", () => {
		setEnv(undefined);
		assert.equal(isAutoApproveEnabled(), false);
		setEnv("1");
		assert.equal(isAutoApproveEnabled(), true);
		setEnv("0");
		assert.equal(isAutoApproveEnabled(), false);
		setEnv("true");
		assert.equal(isAutoApproveEnabled(), false);
		setEnv(undefined);
	});
});

describe("external-state hard-reject (D-019)", () => {
	it("classifies lifecycle questions as approvable", () => {
		assert.equal(
			isExternalStateQuestion({
				question: "How should the implementation-review loop terminate?",
				questionId: "termination-condition",
				optionLabels: ["1 round", "goal wait: continue until no unpassed VCs remain"],
			}),
			false,
		);
		assert.equal(
			isExternalStateQuestion({ question: "✓ Accept & execute now?", optionLabels: ["Accept", "Decline"] }),
			false,
		);
	});

	it("flags publish/deploy/merge/push/credential/instal questions wherever they appear", () => {
		const cases: Array<{ input: Parameters<typeof isExternalStateQuestion>[0]; match: boolean }> = [
			{ input: { question: "Publish the package to npm?", optionLabels: ["Yes", "No"] }, match: true },
			{ input: { question: "Proceed?", optionLabels: ["Merge into main", "Abort"] }, match: true },
			{ input: { question: "Proceed?", purpose: "deployment", optionLabels: ["Go"] }, match: true },
			{ input: { question: "Use this credential?", optionLabels: ["Yes"] }, match: true },
			{ input: { question: "Grant the npm install waiver?", optionLabels: ["Yes"] }, match: true },
			{ input: { question: "Install the dependency in the disposable container?", optionLabels: ["Yes"] }, match: false },
		];
		for (const { input, match } of cases) assert.equal(isExternalStateQuestion(input), match, JSON.stringify(input));
	});

	it("assertAutoApprovable throws (fail closed) on external-state questions", () => {
		assert.throws(
			() => assertAutoApprovable({ question: "Push to the remote?", optionLabels: ["Yes"] }),
			/\[auto-approve\] refused/,
		);
		assert.doesNotThrow(() => assertAutoApprovable({ question: "Accept & execute now?", optionLabels: ["Yes"] }));
	});
});

describe("ask_choice under auto-approve", () => {
	it("answers the recommendation headlessly, annotated, without opening a panel", async () => {
		setEnv("1");
		const tool = loadTool();
		const ctx = makeCtx({ hasUI: false });
		const result = await tool.execute("t1", {
			question: "Accept the plan?",
			options: LIFECYCLE_OPTIONS,
			autoComplete: false,
			questionId: "accept-execute",
		}, undefined, undefined, ctx);
		assert.equal(selectCalls, 0, "no UI panel may open");
		const text = result.content[0].text as string;
		assert.match(text, /^\[auto-approve\]/);
		assert.match(text, /✓ Accept & execute now/);
		assert.equal(result.details.source, "auto-complete");
		assert.equal(result.details.answer, "✓ Accept & execute now");
		setEnv(undefined);
	});

	it("short-circuits before UI dispatch even when a UI exists (RPC determinism)", async () => {
		setEnv("1");
		const tool = loadTool();
		const ctx = makeCtx({ hasUI: true });
		const result = await tool.execute("t2", {
			question: "Ameliorate?",
			options: LIFECYCLE_OPTIONS,
			autoComplete: false,
		}, undefined, undefined, ctx);
		assert.equal(selectCalls, 0);
		assert.match(result.content[0].text as string, /^\[auto-approve\]/);
		setEnv(undefined);
	});

	it("hard-rejects external-state questions even with the env set", async () => {
		setEnv("1");
		const tool = loadTool();
		const ctx = makeCtx({ hasUI: false });
		await assert.rejects(
			tool.execute("t3", {
				question: "Publish to npm and push the tag?",
				options: [{ label: "Yes", recommended: true }, { label: "No" }],
				autoComplete: false,
			}, undefined, undefined, ctx),
			/\[auto-approve\] refused/,
		);
		setEnv(undefined);
	});

	it("hard-rejects Chinese external-state questions (F-005 zh-Hans coverage)", async () => {
		assert.equal(
			isExternalStateQuestion({ question: "推送到远端并发布？", optionLabels: ["是", "否"] }),
			true,
		);
		assert.equal(isExternalStateQuestion({ question: "使用该凭据登录？", optionLabels: ["确认"] }), true);
		assert.equal(isExternalStateQuestion({ question: "在容器中安装依赖？", optionLabels: ["是"] }), false);
	});

	it("auto-approve picks a bounded termination option over goal wait (F-010/C-008)", async () => {
		setEnv("1");
		const tool = loadTool();
		const ctx = makeCtx({ hasUI: false });
		const result = await tool.execute("t-f010", {
			question: "How should the implementation-review loop terminate?",
			options: [
				{ label: "goal wait: continue until no unpassed VCs remain (auto-continue each round)", recommended: true },
				{ label: "until no high-severity finding (hard cap 5 rounds)" },
				{ label: "1 round" },
			],
			autoComplete: false,
			questionId: "termination-condition",
		}, undefined, undefined, ctx);
		assert.equal(result.details.answer, "until no high-severity finding (hard cap 5 rounds)");
		assert.doesNotMatch(result.details.answer, /goal wait/i);
		setEnv(undefined);
	});

	it("default behavior is unchanged with the env off (headless autoComplete:false still stops)", async () => {
		setEnv(undefined);
		const tool = loadTool();
		const ctx = makeCtx({ hasUI: false });
		await assert.rejects(
			tool.execute("t4", {
				question: "Accept the plan?",
				options: LIFECYCLE_OPTIONS,
				autoComplete: false,
			}, undefined, undefined, ctx),
			/must not be auto-completed/,
		);
	});
});

describe("execute_handoff under auto-approve", () => {
	const planPath = path.join(root, "PLAN_v1.md");

	before(() => {
		fs.writeFileSync(
			planPath,
			[
				"# PLAN_v1 - fixture",
				"",
				"## Verifier Checklist",
				"",
				"- [ ] `VC-001` covers `I-001`; pass condition: fixture; evidence: fixture; metric: n/a.",
			].join("\n"),
		);
	});

	function makeExecMocks() {
		const pi = {
			appendEntry: () => {},
			sendMessage: () => {},
			setModel: async () => true,
		} as unknown as ExtensionAPI;
		setCurrentApi(pi);
		const ctx = makeCtx({ hasUI: false });
		ctx.cwd = root;
		return { pi, ctx };
	}

	it("approves headlessly with an [auto-approve] annotated result and no confirm call", async () => {
		setEnv("1");
		const { ctx } = makeExecMocks();
		try {
			const outcome = await executeHandoff(ctx, planPath);
			assert.equal(outcome.status, "executing");
			assert.match(outcome.message, /^\[auto-approve\] Execution approved/);
			assert.equal(confirmCalls, 0, "no confirm prompt may open");
		} finally {
			if (getExecution()) await stopExecution({ appendEntry: () => {}, sendMessage: () => {} } as any, ctx, "cleanup");
			setEnv(undefined);
		}
	});

	it("default behavior is unchanged with the env off (headless handoff refuses)", async () => {
		setEnv(undefined);
		const { ctx } = makeExecMocks();
		const outcome = await executeHandoff(ctx, planPath);
		assert.equal(outcome.status, "error");
		assert.match(outcome.message, /must never be auto-completed/);
	});
});
