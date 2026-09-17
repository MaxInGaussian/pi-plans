/**
 * Batch multiple-choice form for ask_choice (0.4.0, feature 1).
 *
 * The form is a tabbed dialog opened via ctx.ui.custom: one tab per question
 * (options always visible in the first frame — options-first fit contract from
 * pi-goal-x's questionnaire) plus a final submit page listing every Q/A, and a
 * "✏️ 自定义答案…" row per tab that switches into a Focusable single-line input
 * (CURSOR_MARKER + hardware cursor so zh-Hans IME composition works).
 *
 * Everything user-visible is a pure state machine (createFormState /
 * formRender / formHandleKey) so node:test covers the interaction contract
 * without a terminal; runQuestionForm wires that machine to ctx.ui.custom,
 * suspends the working spinner while open (churn guard), and returns the
 * final per-question answers plus the cancelled flag (D-009: partial answers
 * come back on Esc; the agent continues with what it got).
 */

import { CURSOR_MARKER, type TUI, type Theme } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "./refine-ui-helpers.ts";

export const FORM_QUESTION_MAX = 8;
const CUSTOM_LABEL = "✏️ 自定义答案…";

export interface FormOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface FormQuestion {
	question: string;
	options: FormOption[];
	allowOther: boolean;
	/** Empty string when the caller did not provide a stable id. */
	questionId: string;
	purpose?: string;
	autoComplete: boolean;
}

export interface FormAnswer {
	index: number;
	questionId?: string;
	answer: string;
	source: "user" | "other";
}

export interface FormResult {
	answers: FormAnswer[];
	/** Esc on the form (or on the free-form input) → partial answers returned. */
	cancelled: boolean;
	/** The host cannot show a custom dialog (RPC, no UI, older pi). */
	unavailable: boolean;
}

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

export interface FormState {
	questions: FormQuestion[];
	/** Selected option index per question (-1 = none; custom row = options.length). */
	selection: number[];
	/** Custom-answer text per question (null = not custom). */
	custom: (string | null)[];
	/** Current tab: 0..N-1 = question tabs, N = submit page. */
	tab: number;
	editing: boolean;
	buffer: string;
}

export function createFormState(questions: FormQuestion[]): FormState {
	return {
		questions,
		selection: questions.map((q) => q.options.findIndex((o) => o.recommended === true)),
		custom: questions.map(() => null),
		tab: 0,
		editing: false,
		buffer: "",
	};
}

export function allAnswered(state: FormState): boolean {
	return state.questions.every(
		(q, i) =>
			state.custom[i] !== null || (state.selection[i] >= 0 && state.selection[i] < q.options.length),
	);
}

export type FormKeyEvent =
	| "noop"
	| "render"
	| "submit"
	| "cancel"
	| "start-editing"
	| "confirm-buffer"
	| "abort-editing";

/**
 * Advance the state machine by one raw terminal key chunk. Returns the event
 * the caller should react to (submit/cancel/editing transitions need UI-level
 * side effects: hardware cursor, done(), ledger writes).
 */
export function formHandleKey(state: FormState, data: string): FormKeyEvent {
	if (state.editing) {
		if (data === "\r" || data === "\n") return confirmBuffer(state);
		if (data === "\x1b") {
			state.editing = false;
			state.buffer = "";
			return "abort-editing";
		}
		if (data === "\x7f" || data === "\x08") {
			state.buffer = state.buffer.slice(0, -1);
			return "render";
		}
		if (data.startsWith("\x1b")) return "noop"; // arrow/CSI sequences ignored while typing
		state.buffer += data;
		return "render";
	}
	const n = state.questions.length;
	if (data === "\x1b") return "cancel";
	if (data === "\t") {
		state.tab = state.tab + 1 > n ? 0 : state.tab + 1;
		return "render";
	}
	if (data === "\x1b[Z") {
		state.tab = state.tab - 1 < 0 ? n : state.tab - 1;
		return "render";
	}
	if (data === "\x1b[C") {
		state.tab = Math.min(n, state.tab + 1);
		return "render";
	}
	if (data === "\x1b[D") {
		state.tab = Math.max(0, state.tab - 1);
		return "render";
	}
	if (state.tab === n) {
		if (data === "\r" || data === "\n") {
			return allAnswered(state) ? "submit" : "render";
		}
		return "noop";
	}
	// Question tab.
	const q = state.questions[state.tab];
	const total = q.options.length + (q.allowOther ? 1 : 0);
	if (data === "\x1b[A" || data === "\x1b[B") {
		const delta = data === "\x1b[A" ? -1 : 1;
		const row = state.selection[state.tab];
		state.selection[state.tab] = total === 0 ? -1 : (row + delta + total + 1) % (total + 1);
		return "render";
	}
	if (data === "\r" || data === "\n") {
		const row = state.selection[state.tab];
		if (q.allowOther && row === q.options.length) {
			state.editing = true;
			state.buffer = "";
			return "start-editing";
		}
		if (row >= 0 && row < q.options.length) {
			state.tab = Math.min(n, state.tab + 1);
			return "render"; // confirmed → advance
		}
		return "noop";
	}
	return "noop";
}

function confirmBuffer(state: FormState): FormKeyEvent {
	const text = state.buffer.trim();
	if (!text) return "noop";
	state.custom[state.tab] = text;
	state.editing = false;
	state.buffer = "";
	state.tab = Math.min(state.questions.length, state.tab + 1);
	return "confirm-buffer";
}

export function formAnswers(state: FormState): FormAnswer[] {
	const out: FormAnswer[] = [];
	state.questions.forEach((q, i) => {
		const custom = state.custom[i];
		if (custom !== null) {
			out.push({ index: i, questionId: q.questionId || undefined, answer: custom, source: "other" });
			return;
		}
		const opt = state.selection[i];
		if (opt >= 0 && opt < q.options.length) {
			out.push({ index: i, questionId: q.questionId || undefined, answer: q.options[opt].label, source: "user" });
		}
	});
	return out;
}

// ---------------------------------------------------------------------------
// Rendering (width-safe: every line visibleWidth <= width)
// ---------------------------------------------------------------------------

function fit(text: string, width: number): string {
	return visibleWidth(text) <= width ? text : truncateToWidth(text, width);
}

function optionRows(q: FormQuestion, selected: number, width: number): string[] {
	const rows: string[] = [];
	q.options.forEach((opt, i) => {
		const marker = i === selected ? "→ " : "  ";
		let label = `${marker}${i + 1}. ${opt.label}`;
		if (opt.recommended) label += "  (推荐)";
		if (opt.description && width >= 60) label += ` — ${opt.description}`;
		rows.push(fit(label, width));
	});
	if (q.allowOther) {
		rows.push(fit(`${q.options.length === selected ? "→ " : "  "}${CUSTOM_LABEL}`, width));
	}
	return rows;
}

/** Render the current tab. Deterministic row counts for golden tests. */
export function formRender(state: FormState, width: number): string[] {
	const w = Math.max(12, width);
	const n = state.questions.length;
	if (state.editing) {
		const q = state.questions[state.tab];
		return [
			fit(`输入答案 — Q${state.tab + 1}/${n}: ${q.question}`, w),
			"",
			`${state.buffer}${CURSOR_MARKER}`,
			"",
			fit("[Enter] 确认  [Esc] 放弃输入", w),
		];
	}
	if (state.tab === n) {
		const missing: number[] = [];
		state.questions.forEach((q, i) => {
			if (state.custom[i] === null && !(state.selection[i] >= 0 && state.selection[i] < q.options.length)) {
				missing.push(i);
			}
		});
		const answerFor = (i: number): string => {
			const custom = state.custom[i];
			if (custom !== null) return custom;
			const sel = state.selection[i];
			return sel >= 0 && sel < state.questions[i].options.length
				? state.questions[i].options[sel].label
				: "(未作答)";
		};
		const lines = [fit(`提交 — 全部 ${n} 题答案确认`, w), ""];
		for (let i = 0; i < n; i++) {
			lines.push(fit(`${i + 1}. ${state.questions[i].question}`, w));
			lines.push(fit(`   ↳ ${answerFor(i)}`, w));
		}
		lines.push("");
		lines.push(
			missing.length > 0
				? fit(`[Enter] 提交（还差 ${missing.length} 题未作答: Q${missing.map((i) => i + 1).join("/Q")}）  [←→] 返回修改  [Esc] 取消`, w)
				: fit("[Enter] 提交全部  [←→] 返回修改  [Esc] 取消", w),
		);
		return lines;
	}
	const q = state.questions[state.tab];
	const tabs = Array.from({ length: n + 1 }, (_, i) => (i === state.tab ? `●${i + 1}` : `○${i + 1}`))
		.join(" ")
		.concat(" 提交");
	return [
		fit(`Q${state.tab + 1}/${n} · ${q.question}`, w),
		"",
		...optionRows(q, state.selection[state.tab], w),
		"",
		fit(`${tabs}  [↑/↓] 选择  [Enter] 选定  [Tab] 下一题  [Esc] 取消`, w),
	];
}

// ---------------------------------------------------------------------------
// ctx.ui.custom wrapper
// ---------------------------------------------------------------------------

type TFormDone = (result: FormResult) => void;

/**
 * Open the tabbed form via ctx.ui.custom. Returns { unavailable: true } when
 * the host cannot render custom dialogs (caller falls back to sequential
 * selects). Suspends the working spinner for the dialog duration (churn
 * guard: an 80ms spinner tick drags scrolled-up users back to the bottom).
 */
export async function runQuestionForm(
	ui: {
		custom?: <T>(factory: unknown) => Promise<T | undefined>;
		setWorkingVisible?: (visible: boolean) => void;
	},
	questions: FormQuestion[],
): Promise<FormResult> {
	if (typeof ui.custom !== "function") return { answers: [], cancelled: false, unavailable: true };
	ui.setWorkingVisible?.(false);
	const state = createFormState(questions);
	try {
		const result = await ui.custom<TFormDone>((
			tui: TUI,
			_theme: Theme,
			_keybindings: unknown,
			done: TFormDone,
		) => {
			let cursorShown = false;
			const syncCursor = (editing: boolean): void => {
				const t = tui as unknown as { setShowHardwareCursor?: (v: boolean) => void };
				if (editing !== cursorShown) {
					try {
						t.setShowHardwareCursor?.(editing);
					} catch {
						/* best-effort cursor management */
					}
					cursorShown = editing;
				}
			};
			syncCursor(state.editing);
			return {
				render(width: number) {
					syncCursor(state.editing);
					return formRender(state, width);
				},
				handleInput(data: string) {
					const event = formHandleKey(state, data);
					syncCursor(state.editing);
					if (event === "submit") {
						done({ answers: formAnswers(state), cancelled: false, unavailable: false });
						return;
					}
					if (event === "cancel") {
						done({ answers: formAnswers(state), cancelled: true, unavailable: false });
						return;
					}
				},
			};
		});
		return result ?? { answers: [], cancelled: true, unavailable: false };
	} finally {
		ui.setWorkingVisible?.(true);
	}
}

/** Transcript rendering for the batch tool call (renderCall). */
export function renderFormCall(
	questions: FormQuestion[],
	theme: { fg(color: string, text: string): string; bold(text: string): string },
): string {
	let text = theme.fg("toolTitle", theme.bold("ask_choice ")) + theme.fg("muted", `[${questions.length} questions]`);
	for (const q of questions) {
		text += `\n${theme.fg("accent", q.question)}`;
		const labels = q.options.map((o, i) => `${i + 1}. ${o.label}${o.recommended ? " (推荐)" : ""}`);
		text += `\n${theme.fg("dim", `  Options: ${labels.join(", ")}`)}`;
	}
	return text;
}
