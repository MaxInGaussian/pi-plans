/**
 * Batch multiple-choice form (0.4.0 feature 1): pure state machine contract,
 * validation layer, checkpoint persistence and gate short-circuits.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "../src/refine-ui-helpers.ts";
import {
	FORM_QUESTION_MAX,
	allAnswered,
	createFormState,
	formAnswers,
	formHandleKey,
	formRender,
	runQuestionForm,
	type FormQuestion,
} from "../src/ask-form.ts";

function qs(n = 2): FormQuestion[] {
	return Array.from({ length: n }, (_, i) => ({
		question: `Question ${i + 1}?`,
		options: [
			{ label: `Opt A${i + 1}`, recommended: true },
			{ label: `Opt B${i + 1}` },
		],
		allowOther: true,
		questionId: `q-${i + 1}`,
		autoComplete: true,
	}));
}

describe("form state machine", () => {
	it("preselects the recommended option per question", () => {
		const state = createFormState(qs(2));
		assert.deepEqual(state.selection, [0, 0]);
		assert.equal(allAnswered(state), true);
	});

	it("navigates tabs with Tab and right arrow, wrapping around", () => {
		const state = createFormState(qs(2));
		assert.equal(formHandleKey(state, "\t"), "render");
		assert.equal(state.tab, 1);
		assert.equal(formHandleKey(state, "\t"), "render");
		assert.equal(state.tab, 2); // submit page
		assert.equal(formHandleKey(state, "\x1b[Z"), "render");
		assert.equal(state.tab, 1);
		assert.equal(formHandleKey(state, "\x1b[C"), "render");
		assert.equal(state.tab, 2);
	});

	it("moves the selection row with arrow keys including the custom row", () => {
		const state = createFormState([{ ...qs(1)[0], options: [{ label: "Only" }], allowOther: true }]);
		assert.equal(formHandleKey(state, "\x1b[B"), "render"); // down → option 0
		assert.equal(state.selection[0], 0);
		assert.equal(formHandleKey(state, "\x1b[B"), "render"); // down → custom row (index 1)
		assert.equal(state.selection[0], 1);
		assert.equal(formHandleKey(state, "\r"), "start-editing");
		assert.equal(state.editing, true);
	});

	it("captures a custom answer with IME-safe buffering and confirms by Enter", () => {
		const state = createFormState(qs(1));
		assert.equal(formHandleKey(state, "\x1b[B"), "render"); // down → option 0
		assert.equal(formHandleKey(state, "\x1b[B"), "render"); // down → custom row
		assert.equal(formHandleKey(state, "\r"), "start-editing");
		for (const ch of ["自", "定", "义"]) assert.equal(formHandleKey(state, ch), "render");
		assert.equal(formHandleKey(state, "\x7f"), "render"); // backspace
		assert.equal(state.buffer, "自定");
		assert.equal(formHandleKey(state, "\r"), "confirm-buffer");
		assert.equal(state.custom[0], "自定");
		assert.equal(state.editing, false);
	});

	it("aborts editing with Esc without touching the answer", () => {
		const state = createFormState(qs(1));
		state.buffer = "partial";
		state.editing = true;
		assert.equal(formHandleKey(state, "\x1b"), "abort-editing");
		assert.equal(state.custom[0], null);
		assert.equal(state.editing, false);
	});

	it("submits only when every question is answered and returns partial answers on Esc", () => {
		const state = createFormState(qs(2));
		state.tab = 2;
		assert.equal(formHandleKey(state, "\r"), "submit");
		assert.equal(formAnswers(state).length, 2);

		// One unanswered question blocks the submit page.
		const state2 = createFormState(qs(2));
		state2.selection[1] = -1;
		state2.custom[1] = null;
		state2.tab = 2;
		assert.equal(formHandleKey(state2, "\r"), "render");
		assert.equal(allAnswered(state2), false);
		assert.equal(formHandleKey(state2, "\x1b"), "cancel");
		assert.equal(formAnswers(state2).length, 1, "Esc returns the answered subset");
	});

	it("renders deterministic row shapes for question tab, submit page and editing", () => {
		const state = createFormState(qs(2));
		const tabLines = formRender(state, 80);
		assert.ok(tabLines[0].includes("Q1/2"));
		assert.ok(tabLines.some((l) => l.includes("Opt A1")));
		assert.ok(tabLines.at(-1)!.includes("Tab"));

		state.tab = 2;
		const submitLines = formRender(state, 80);
		assert.ok(submitLines[0].includes("提交"));
		assert.ok(submitLines.some((l) => l.includes("↳ Opt A1")));

		state.tab = 0;
		state.editing = true;
		state.buffer = "回答";
		const editLines = formRender(state, 80);
		assert.ok(editLines[0].includes("输入答案"));
		assert.ok(editLines[2].includes("回答"));
		assert.ok(editLines[2].includes("\x1b_pi:c\x07"), "CURSOR_MARKER positions the hardware cursor");
	});
});

describe("runQuestionForm", () => {
	it("reports unavailable when the host has no custom dialog", async () => {
		const result = await runQuestionForm({}, qs(2));
		assert.equal(result.unavailable, true);
	});

	it("suspends and restores the working spinner around the dialog", async () => {
		const visible: boolean[] = [];
		const result = runQuestionForm(
			{
				setWorkingVisible: (v: boolean) => visible.push(v),
				custom: async (factory) => {
					let resolvePromise: ((r: unknown) => void) | undefined;
					const promise = new Promise((resolve) => {
						resolvePromise = resolve;
					});
					// factory(tui, theme, keybindings, done): drive the
					// component's handleInput manually; done() resolves the
					// custom() promise as pi would.
					const comp = (factory as (...a: unknown[]) => { handleInput(d: string): void; render(w: number): string[] })(
						{ setShowHardwareCursor: () => {} },
						{},
						{},
						(r: unknown) => resolvePromise?.(r),
					);
					comp.handleInput("\r"); // Q1 confirmed → tab 2
					comp.handleInput("\r"); // Q2 confirmed → submit page
					comp.handleInput("\r"); // submit all
					return promise;
				},
			},
			qs(2),
		);
		const out = await result;
		assert.equal(out.unavailable, false);
		assert.equal(out.answers.length, 2);
		assert.deepEqual(visible, [false, true], "spinner suspended while the form is open");
	});
});

describe("form render fit", () => {
	it("never emits a line wider than the terminal width (options-first fit)", () => {
		const long = qs(2).map((q, i) => ({
			...q,
			question: `这是一个非常长的规划问题文本用于验证宽度裁切行为第${i + 1}题?`,
			options: [
				{ label: `推荐选项甲${i + 1}（含较长说明文字）`, recommended: true, description: "这是一段较长的选项描述文字用于验证裁切" },
				{ label: `备选选项乙${i + 1}` },
				{ label: `备选选项丙${i + 1}` },
			],
		}));
		const state = createFormState(long);
		for (const width of [20, 30, 40, 60, 80, 100, 140]) {
			for (const tab of [0, 1, 2]) {
				state.tab = tab;
				const lines = formRender(state, width);
				for (const line of lines) {
					assert.ok(
						visibleWidth(line) <= width,
						`width ${width} tab ${tab}: ${JSON.stringify(line)} is ${visibleWidth(line)} wide`,
					);
				}
			}
		}
	});
});

describe("form rows budget (F-001)", () => {
	it("caps the question tab behind an overflow indicator and keeps the footer on short terminals", () => {
		const q = {
			question: "Short terminal?",
			options: Array.from({ length: 9 }, (_, i) => ({ label: `O${i}`, recommended: i === 0 })),
			allowOther: true,
			questionId: "q",
			autoComplete: true,
		};
		const state = createFormState([q]);
		const lines = formRender(state, 60, 8);
		assert.ok(lines.length <= 8, `rows budget respected (${lines.length})`);
		assert.ok(lines.some((l) => l.includes("+5 more")), "overflow indicator present");
		assert.match(lines.at(-1)!, /Tab/, "key-hint footer survives");
	});

	it("degrades to compact options before capping rows", () => {
		const q = {
			question: "Desc?",
			options: [
				{ label: "A", recommended: true, description: "long description that would widen rows" },
				{ label: "B", description: "another" },
				{ label: "C" },
			],
			allowOther: false,
			questionId: "q",
			autoComplete: true,
		};
		const state = createFormState([q]);
		const lines = formRender(state, 80, 8);
		assert.ok(lines.length <= 8);
		assert.ok(!lines.join("\n").includes("description"), "descriptions stripped under budget");
	});
});

describe("FORM_QUESTION_MAX", () => {
	it("covers the batch contract of 2..8 questions", () => {
		assert.equal(FORM_QUESTION_MAX, 8);
	});
});
