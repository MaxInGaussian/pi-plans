/** Behavior tests for the ask_choice trailing option (post-execution
 * amelioration prompt): Auto-refine loop replaces Auto-complete, the
 * auto-answer mode is suppressed, and headless sessions stop instead of
 * auto-answering. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskChoiceTool } from "../tools/ask-choice.ts";

type ToolDef = {
	execute: (id: string, params: any, signal: undefined, update: undefined, ctx: any) => Promise<any>;
};

let root: string;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-ask-choice-"));
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

function makeCtx(opts: {
	hasUI?: boolean;
	select: (question: string, labels: string[]) => Promise<string | undefined>;
}) {
	return {
		cwd: root,
		hasUI: opts.hasUI ?? true,
		sessionManager: {},
		ui: {
			select: opts.select,
			input: async () => "typed",
		},
	};
}

const OPTIONS = [
	{ label: "Run one Reviewer round", recommended: true },
	{ label: "Run a Criticizer round" },
	{ label: "Finish here" },
];

describe("ask_choice trailing option", () => {
	it("renders Auto-refine loop as the trailing option and suppresses Auto-complete", async () => {
		const tool = loadTool();
		let seenLabels: string[] = [];
		const ctx = makeCtx({
			select: async (_question, labels) => {
				seenLabels = labels;
				return labels.find((label) => label.startsWith("Auto-refine loop"));
			},
		});
		const result = await tool.execute("t1", {
			question: "Ameliorate?",
			options: OPTIONS,
			autoComplete: true, // deliberately erroneous: trailing must suppress it
			trailing: "auto-refine-loop",
		}, undefined, undefined, ctx);

		assert.equal(seenLabels.at(-1)?.startsWith("Auto-refine loop"), true, "Auto-refine loop must be last");
		assert.equal(seenLabels.some((label) => label.startsWith("Auto-complete")), false, "Auto-complete must be absent");
		const text = result.content[0].text as string;
		assert.match(text, /User selected Auto-refine loop/);
		assert.match(text, /until no high-severity finding \(hard cap 5 rounds\)/);
		assert.match(text, /refine \(role: "reviewer", target: "implementation"\)/);
		assert.equal(result.details.source, "user");
		assert.equal(result.details.answer, "Auto-refine loop");
	});

	it("keeps Auto-complete as the trailing option without the trailing param", async () => {
		const tool = loadTool();
		let seenLabels: string[] = [];
		const ctx = makeCtx({
			select: async (_question, labels) => {
				seenLabels = labels;
				return labels[0];
			},
		});
		await tool.execute("t2", {
			question: "Planning question?",
			options: OPTIONS,
			autoComplete: true,
		}, undefined, undefined, ctx);
		assert.equal(seenLabels.at(-1)?.startsWith("Auto-complete"), true);
		assert.equal(seenLabels.some((label) => label.startsWith("Auto-refine loop")), false);
	});

	it("never auto-answers a trailing question in headless sessions", async () => {
		const tool = loadTool();
		const ctx = makeCtx({ hasUI: false, select: async () => undefined });
		await assert.rejects(
			tool.execute("t3", {
				question: "Ameliorate?",
				options: OPTIONS,
				autoComplete: true,
				trailing: "auto-refine-loop",
			}, undefined, undefined, ctx),
			/No UI available/,
		);
	});
});
