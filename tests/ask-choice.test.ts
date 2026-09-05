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
import { fitAskChoicePanel, OPTION_MAX_LINES, PANEL_CHROME_LINES, PANEL_SAFETY_MARGIN, SELECTOR_WIDTH_OVERHEAD, STATUS_BAR_HEIGHT, registerAskChoiceTool } from "../tools/ask-choice.ts";
import { visibleWidth } from "../src/refine-ui-helpers.ts";

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

let notifyCalls: Array<{ message: string; severity?: string }> = [];

function makeCtx(opts: {
	hasUI?: boolean;
	select: (question: string, labels: string[]) => Promise<string | undefined>;
}) {
	notifyCalls = [];
	return {
		cwd: root,
		hasUI: opts.hasUI ?? true,
		sessionManager: {},
		ui: {
			select: opts.select,
			input: async () => "typed",
			notify: (message: string, severity?: string) => {
				notifyCalls.push({ message, severity });
			},
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

describe("ask_choice panel fitting", () => {
	it("sanitizes newlines in the question and labels", () => {
		const fitted = fitAskChoicePanel("Q line1\nQ line2", [{ core: "1. a\nb", display: "1. a\nb — desc" }], 100, 30);
		assert.doesNotMatch(fitted.question, /\r?\n/);
		for (const label of fitted.labels) assert.doesNotMatch(label, /\r?\n/);
	});

	it("caps each label at the 3-line budget with a .. marker (CJK included)", () => {
		const columns = 100;
		const budget = OPTION_MAX_LINES * Math.max(20, columns - SELECTOR_WIDTH_OVERHEAD);
		const cjkLabel = `1. ${"选项".repeat(200)}`; // 800 visible columns, far over the budget
		const fitted = fitAskChoicePanel("q", [{ core: cjkLabel, display: cjkLabel }], columns, 60);
		assert.equal(fitted.labels.length, 1);
		assert.ok(visibleWidth(fitted.labels[0]) <= budget, `label exceeds 3-line budget: ${visibleWidth(fitted.labels[0])}`);
		assert.match(fitted.labels[0], /\.\.$/);
	});

	it("degrades: stage 1 strips descriptions before touching labels", () => {
		const columns = 100;
		const rows = 30; // rowBudget = 27 → content budget 17 lines after chrome
		const items = Array.from({ length: 12 }, (_, i) => ({
			core: `${i + 1}. option-${i}`,
			display: `${i + 1}. option-${i} — ${"detail ".repeat(40)}`,
		}));
		const fitted = fitAskChoicePanel("q", items, columns, rows);
		for (const label of fitted.labels) assert.doesNotMatch(label, /detail/);
		assert.match(fitted.labels[0] ?? "", /^1\. option-0/);
	});

	it("degrades: stage 2 collapses labels to one line before truncating the question", () => {
		const columns = 100;
		const rows = 30;
		const items = Array.from({ length: 15 }, (_, i) => ({
			core: `${i + 1}. ${"x".repeat(170)}`,
			display: `${i + 1}. ${"x".repeat(170)} — description`,
		}));
		const fitted = fitAskChoicePanel("the question", items, columns, rows);
		for (const label of fitted.labels) assert.ok(visibleWidth(label) <= Math.max(20, columns - SELECTOR_WIDTH_OVERHEAD));
		assert.equal(fitted.question, "the question"); // question untouched at stage 2
	});

	it("warns once when even the minimal form exceeds a tiny terminal", () => {
		const columns = 60;
		const rows = 12; // rowBudget = 9; 30 options can never fit
		const items = Array.from({ length: 30 }, (_, i) => ({ core: `${i + 1}. opt-${i}`, display: `${i + 1}. opt-${i}` }));
		const fitted = fitAskChoicePanel("q", items, columns, rows);
		assert.equal(fitted.overflowWarned, true);
		for (const label of fitted.labels) assert.ok(visibleWidth(label) <= 20);
	});

	it("degrades: stage 3 truncates the question only after labels are single-lined", () => {
		const columns = 100;
		const rows = 32; // rowBudget = 29; chrome 9 → content budget 20 lines
		const longQuestion = "q".repeat(300);
		const items = Array.from({ length: 18 }, (_, i) => ({ core: `${i + 1}. opt-${i}`, display: `${i + 1}. opt-${i}` }));
		const fitted = fitAskChoicePanel(longQuestion, items, columns, rows);
		assert.equal(fitted.overflowWarned, false); // stops at stage 3, not the minimal form
		assert.ok(visibleWidth(fitted.question) <= Math.max(20, columns - SELECTOR_WIDTH_OVERHEAD));
		assert.match(fitted.question, /\.\.$/);
		assert.match(fitted.labels[0] ?? "", /^1\. opt-0$/); // labels stay single-line and untruncated
	});

	it("keeps Other/Auto-complete/Auto-refine prefixes alive even on tiny terminals", () => {
		const columns = 26;
		const rows = 12; // minimal form: 20-column floor
		const items = [
			{ core: "1. keep-current", display: "1. keep-current" },
			{ core: "Other…  (type your own answer)", display: "Other…  (type your own answer)", fixed: true },
			{ core: "Auto-complete  (take the recommended option)", display: "Auto-complete  (take the recommended option)", fixed: true },
			{ core: "Auto-refine loop  (run refinement rounds until no high-severity finding or the 5-round cap)", display: "Auto-refine loop  (run refinement rounds until no high-severity finding or the 5-round cap)", fixed: true },
		];
		const fitted = fitAskChoicePanel("q", items, columns, rows);
		assert.match(fitted.labels[1] ?? "", /^Other…/);
		assert.match(fitted.labels[2] ?? "", /^Auto-complete/);
		assert.match(fitted.labels[3] ?? "", /^Auto-refine loop/);
	});

	it("execute notifies once when the minimal form still overflows a tiny terminal", async () => {
		const tool = loadTool();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-ask-choice-overflow-"));
		const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 60, configurable: true });
		try {
			const ctx = makeCtx({
				select: async (_question, labels) => labels[0],
			});
			// makeCtx binds cwd at construction; point it at the temp dir via workdir param instead.
			await tool.execute(
				"id",
				{
					question: "Pick one",
					options: Array.from({ length: 30 }, (_, i) => ({ label: `opt-${i}`, description: `${"detail ".repeat(20)}` })),
					autoComplete: false,
					allowOther: false,
					workdir: dir,
				},
				undefined,
				undefined,
				ctx,
			);
			assert.equal(notifyCalls.length, 1);
			assert.match(notifyCalls[0]!.message, /Terminal too small/);
		} finally {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			if (colsDesc) Object.defineProperty(process.stdout, "columns", colsDesc);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pi-tui Text renders every fitted label within 3 lines at real panel width", async () => {
		let Text: any;
		try {
			({ Text } = await import("@earendil-works/pi-tui"));
		} catch {
			return; // D-007 sanctioned fallback: pi-tui not resolvable in this layout
		}
		const columns = 100;
		const rows = 60;
		const realWidth = columns - 4; // border + padding + marker, per extension-selector.js
		const items = Array.from({ length: 8 }, (_, i) => ({
			core: `${i + 1}. option-${i}`,
			display: `${i + 1}. option-${i} — ${"中文描述 " .repeat(30)}mixed ascii tail ${"x".repeat(60)}`,
		}));
		const fitted = fitAskChoicePanel("q", items, columns, rows);
		let totalLines = PANEL_CHROME_LINES + 1; // chrome + question line
		for (const label of fitted.labels) {
			const component = new Text(label, 1, 0);
			const rendered = component.render(realWidth);
			assert.ok(rendered.length <= OPTION_MAX_LINES, `label renders ${rendered.length} lines: ${JSON.stringify(label.slice(0, 60))}`);
			totalLines += rendered.length;
		}
		assert.ok(totalLines < rows - STATUS_BAR_HEIGHT - PANEL_SAFETY_MARGIN);
	});
});
