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
	stripRecommendedMarker,
	type FormQuestion,
	type FormTheme,
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
	it("preselects the recommended option as cursor without marking it answered", () => {
		const state = createFormState(qs(2));
		assert.deepEqual(state.selection, [0, 0]);
		// goal-x semantics: a pre-positioned cursor is NOT an answer — chips
		// stay □ until the user presses Enter (or commits a custom answer).
		assert.equal(allAnswered(state), false);
		assert.deepEqual(state.confirmed, [false, false]);
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

	it("submits only when every question is confirmed and returns partial answers on Esc", () => {
		// Fresh form: nothing confirmed → submit page Enter is blocked.
		const state0 = createFormState(qs(2));
		state0.tab = 2;
		assert.equal(formHandleKey(state0, "\r"), "render");
		assert.equal(allAnswered(state0), false);

		// Confirm Q1 (Enter on the preselected option) → advance; confirm Q2.
		const state = createFormState(qs(2));
		assert.equal(formHandleKey(state, "\r"), "render");
		assert.equal(state.tab, 1);
		assert.equal(formHandleKey(state, "\r"), "render");
		assert.equal(state.tab, 2); // submit page
		assert.equal(formHandleKey(state, "\r"), "submit");
		assert.equal(formAnswers(state).length, 2);

		// One unconfirmed question blocks the submit page; Esc returns the
		// confirmed subset only.
		const state2 = createFormState(qs(2));
		assert.equal(formHandleKey(state2, "\r"), "render"); // confirm Q1
		state2.tab = 2;
		assert.equal(formHandleKey(state2, "\r"), "render");
		assert.equal(allAnswered(state2), false);
		assert.equal(formHandleKey(state2, "\x1b"), "cancel");
		assert.equal(formAnswers(state2).length, 1, "Esc returns the confirmed subset");
	});

	it("renders deterministic row shapes for question tab, submit page and editing", () => {
		const state = createFormState(qs(2));
		const tabLines = formRender(state, 80);
		assert.ok(tabLines[0].includes("Q1/2"));
		assert.ok(tabLines.some((l) => l.includes("Opt A1")));
		assert.ok(tabLines.at(-1)!.includes("Tab"));

		state.tab = 2;
		const freshSubmit = formRender(state, 80);
		assert.ok(freshSubmit[0].includes("提交"));
		assert.ok(freshSubmit.some((l) => l.includes("(未作答)")), "unconfirmed rows show (未作答)");

		state.tab = 0;
		formHandleKey(state, "\r"); // confirm Q1 (advances to tab 1)
		state.tab = 2;
		const submitLines = formRender(state, 80);
		assert.ok(submitLines[0].includes("提交"));
		assert.ok(submitLines.some((l) => l.includes("↳ Opt A1")));
		assert.ok(submitLines.some((l) => l.includes("(未作答)")), "Q2 still unconfirmed");

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

describe("recommended marker hygiene (0.4.1)", () => {
	it("renders a single ★ and strips an agent-embedded full-width （推荐） marker", () => {
		const state = createFormState([
			{
				question: "主线目标?",
				options: [
					{ label: "信任+能力并举（推荐）", recommended: true },
					{ label: "只修 adoption" },
				],
				allowOther: false,
			},
		]);
		const lines = formRender(state, 80);
		const optionLine = lines.find((l) => l.includes("信任")) ?? "";
		assert.ok(optionLine.includes("★"), `expected ★ in: ${optionLine}`);
		assert.ok(!optionLine.includes("（推荐）"), `embedded marker leaked: ${optionLine}`);
		assert.ok(!optionLine.includes("(推荐)"), `embedded marker leaked: ${optionLine}`);
	});

	it("strips a half-width (recommended) marker and trims trailing space", () => {
		assert.equal(stripRecommendedMarker("Opt A (recommended)"), "Opt A");
		assert.equal(stripRecommendedMarker("Opt A （推荐） "), "Opt A");
		assert.equal(stripRecommendedMarker("Opt A"), "Opt A");
	});

	it("formAnswers returns the clean label for recommended options", () => {
		const state = createFormState([
			{
				question: "Q?",
				options: [
					{ label: "信任+能力并举（推荐）", recommended: true },
					{ label: "只修 adoption（推荐）" },
				],
				allowOther: false,
			},
		]);
		const answers0 = formAnswers(state);
		assert.equal(answers0.length, 0, "unconfirmed preselection returns no answer");
		formHandleKey(state, "\r"); // confirm the recommended row
		const answers = formAnswers(state);
		assert.equal(answers[0]?.answer, "信任+能力并举");
		// Non-recommended labels keep their verbatim text (agent-authored).
		assert.equal(answers[0] && null, null);
		const state2 = createFormState([
			{
				question: "Q?",
				options: [
					{ label: "信任+能力并举（推荐）", recommended: true },
					{ label: "只修 adoption（推荐）" },
				],
				allowOther: false,
			},
		]);
		state2.selection[0] = 1;
		assert.equal(formAnswers(state2).length, 0, "still unconfirmed");
		state2.tab = 0;
		formHandleKey(state2, "\r"); // confirm the moved cursor
		assert.equal(formAnswers(state2)[0]?.answer, "只修 adoption（推荐）");
	});
});

describe("themed question frame (pi-goal-x alignment, 0.4.1)", () => {
	const T: FormTheme = {
		fg: (c, t) => `⟪${c}⟩${t}⟪/⟫`,
		bg: (c, t) => `⟦${c}⟧${t}⟦/⟧`,
		bold: (t) => `𝐁${t}`,
	};

	it("draws accent borders, a selectedBg tab chip, an accent question and dim hints", () => {
		const state = createFormState(qs(2));
		const lines = formRender(state, 80, undefined, T);
		// frame: border, tabs, blank, question, blank, 3 option rows (2 opts + Other), blank, footer, border
		assert.equal(lines.length, 11);
		assert.match(lines[0]!, /^⟪muted⟩─+⟪\/⟫$/);
		assert.ok(lines[1]!.includes("⟦selectedBg⟧"), `active chip lacks selectedBg: ${lines[1]}`);
		assert.ok(lines[1]!.includes("□Q1") && lines[1]!.includes("□Q2") && lines[1]!.includes("✓ 提交"));
		assert.ok(lines[3]!.includes("⟪accent⟩") && lines[3]!.includes("Question 1?"), `question not accented: ${lines[3]}`);
		const optLine = lines[5]!;
		assert.ok(optLine.includes(T.fg("accent", "→ ")) && optLine.includes("1. Opt A1"), `selected option not accented: ${optLine}`);
		assert.ok(optLine.includes(T.fg("success", " ★")), `recommended star missing: ${optLine}`);
		assert.ok(lines[9]!.includes("⟪dim⟩") && lines[9]!.includes("[Esc] 取消"));
		assert.match(lines[10]!, /^⟪muted⟩─+⟪\/⟫$/);
		// Width safety with real (zero-width) ANSI styling, as the host theme emits.
		const TANSI: FormTheme = {
			fg: (_c, t) => `\u001b[3m${t}\u001b[23m`,
			bg: (_c, t) => `\u001b[7m${t}\u001b[27m`,
			bold: (t) => `\u001b[1m${t}\u001b[22m`,
		};
		for (const l of formRender(state, 80, undefined, TANSI)) {
			assert.ok(visibleWidth(l) <= 80, `width overflow: ${visibleWidth(l)} ${l}`);
		}
	});

	it("marks answered vs pending chips and dims the submit chip until complete", () => {
		const state = createFormState(qs(2));
		state.selection[1] = -1; // Q2 unanswered
		const lines = formRender(state, 80, undefined, T);
		assert.ok(lines[1]!.includes("□Q2"), "unanswered chip should be □");
		assert.ok(lines[1]!.includes("⟪dim⟩ ✓ 提交"), "submit chip should be dim while incomplete");
	});

	it("degrades borders before options under a tight rows budget", () => {
		const state = createFormState(qs(2));
		// rows=8: frame with blanks+descriptions stripped still keeps borders (8 lines)
		const l8 = formRender(state, 80, 8, T);
		assert.equal(l8.length, 8);
		assert.ok(l8[0]!.includes("─") && l8[7]!.includes("─"));
		// rows=7: borders dropped, tabs row (with selectedBg) survives
		const l7 = formRender(state, 80, 7, T);
		assert.ok(l7.length <= 7);
		assert.ok(!l7.some((l) => l.includes("─")), "borders should be dropped at rows=7");
		assert.ok(l7[0]!.includes("⟦selectedBg⟧"), "tabs chip row should survive border drop");
		// rows=5: question shortened, chips dropped
		const l5 = formRender(state, 80, 5, T);
		assert.ok(l5.length <= 5);
		assert.ok(l5[0]!.startsWith("⟪accent⟩Q1/2"), `short question expected: ${l5[0]}`);
		// rows<5 is clamped to the minimal viable form, so exercise the true
		// overflow path with more options than any layout can fit.
		const wide = createFormState([
			{
				question: "Many?",
				options: Array.from({ length: 6 }, (_, i) => ({ label: `Opt ${i + 1}` })),
				allowOther: false,
			},
		]);
		const l5w = formRender(wide, 80, 5, T);
		assert.equal(l5w.length, 5);
		assert.ok(l5w.some((l) => l.includes("… +4 more")), "overflow indicator expected");
		assert.ok(l5w[l5w.length - 1]!.includes("[Esc] 取消"), "footer must survive");
	});

	it("themes the submit page: accent bold header, warning line when incomplete", () => {
		const state = createFormState(qs(2));
		state.selection[1] = -1;
		state.tab = 2;
		const lines = formRender(state, 80, undefined, T);
		assert.ok(lines[0]!.includes("⟪accent⟩𝐁提交"), `header not accented/bold: ${lines[0]}`);
		assert.ok(lines[lines.length - 1]!.includes("⟪warning⟩"), `missing warning not styled: ${lines[lines.length - 1]}`);
	});

	it("themes the editing page: accent header, dim hint", () => {
		const state = createFormState(qs(2));
		state.editing = true;
		const lines = formRender(state, 80, undefined, T);
		assert.ok(lines[0]!.includes("⟪accent⟩"));
		assert.ok(lines[4]!.includes("⟪dim⟩"));
	});
});
