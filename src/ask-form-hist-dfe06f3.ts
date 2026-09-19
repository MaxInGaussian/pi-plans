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

import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
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
			// Recommended labels render as ★; strip an agent-embedded marker so
			// the returned answer stays the clean label text.
			const chosen = q.options[opt];
			const answer = chosen.recommended ? stripRecommendedMarker(chosen.label) : chosen.label;
			out.push({ index: i, questionId: q.questionId || undefined, answer, source: "user" });
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

/** Trailing marker an agent may accidentally embed in a label text. */
const RECOMMENDED_MARKER_RE = /[（(]\s*(?:推荐|recommended)\s*[)）]\s*$/i;

/**
 * Strip a trailing (推荐)/(recommended) marker from an option label. The form
 * renders its own ★ marker for recommended options, so an embedded marker
 * would otherwise duplicate it.
 */
export function stripRecommendedMarker(label: string): string {
	return label.replace(RECOMMENDED_MARKER_RE, "").trimEnd();
}

/** Themed rendering surface (structural subset of the pi Theme). */
export interface FormTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

function optionRows(q: FormQuestion, selected: number, width: number, theme?: FormTheme): string[] {
	const rows: string[] = [];
	q.options.forEach((opt, i) => {
		const isSelected = i === selected;
		const marker = isSelected ? (theme ? theme.fg("accent", "→ ") : "→ ") : "  ";
		const body = `${i + 1}. ${stripRecommendedMarker(opt.label)}`;
		let label = `${marker}${theme ? theme.fg(isSelected ? "accent" : "text", body) : body}`;
		if (opt.recommended) label += theme ? theme.fg("success", " ★") : " ★";
		if (opt.description && width >= 60) label += ` — ${opt.description}`;
		rows.push(fit(label, width));
	});
	if (q.allowOther) {
		const otherSelected = q.options.length === selected;
		const marker = otherSelected ? (theme ? theme.fg("accent", "→ ") : "→ ") : "  ";
		rows.push(fit(`${marker}${CUSTOM_LABEL}`, width));
	}
	return rows;
}

/** Frame reserve for the custom dialog (editor chrome + status + slack). */
export const FORM_ROWS_RESERVE = 4;
export const FORM_FALLBACK_ROWS = 30;

/**
 * pi-goal-x aligned question-tab frame: accent borders, tab chips with a
 * selectedBg background on the active chip (■ answered / □ pending), colored
 * question line, dim key hints. Under a `rows` budget it degrades richest
 * first — descriptions, then blank separators, then the borders (the chips
 * row keeps its background), then the question text, and only as a last
 * resort option rows are capped behind a "… +N more" indicator. The footer
 * hint line always survives.
 */
function themedQuestionFrame(
	state: FormState,
	q: FormQuestion,
	w: number,
	rows: number | undefined,
	theme: FormTheme,
): string[] {
	const n = state.questions.length;
	const border = theme.fg("accent", "─".repeat(w));
	const allAnswered = state.questions.every(
		(_, i) => state.custom[i] !== null || (state.selection[i] ?? -1) >= 0,
	);
	const chips: string[] = [];
	for (let i = 0; i <= n; i++) {
		const isSubmit = i === n;
		const answered = state.custom[i] !== null || (state.selection[i] ?? -1) >= 0;
		const raw = isSubmit ? " ✓ 提交 " : ` ${answered ? "■" : "□"}Q${i + 1} `;
		if (i === state.tab) chips.push(theme.bg("selectedBg", theme.fg("text", raw)));
		else if (isSubmit) chips.push(theme.fg(allAnswered ? "success" : "dim", raw));
		else chips.push(theme.fg(answered ? "success" : "muted", raw));
	}
	const tabsRow = fit(` ← ${chips.join(" ")} →`, w);
	const questionLine = fit(theme.fg("accent", `Q${state.tab + 1}/${n} · ${q.question}`), w);
	const shortQuestion = fit(theme.fg("accent", `Q${state.tab + 1}/${n}`), w);
	const hint = "[↑/↓] 选择  [Enter] 选定  [Tab] 下一题  [Esc] 取消";
	const footer = fit(theme.fg("dim", hint), w);
	const optsFull = optionRows(q, state.selection[state.tab], w, theme);
	const optsCompact = optionRows(
		{ ...q, options: q.options.map((o) => ({ ...o, description: undefined })) },
		state.selection[state.tab],
		w,
		theme,
	);
	const candidates: string[][] = [
		[border, tabsRow, "", questionLine, "", ...optsFull, "", footer, border],
		[border, tabsRow, questionLine, ...optsCompact, footer, border],
		[tabsRow, questionLine, ...optsCompact, footer],
		[shortQuestion, ...optsCompact, footer],
	];
	for (const candidate of candidates) {
		if (rows === undefined || candidate.length <= rows) return candidate;
	}
	// Last resort: cap option rows behind an overflow indicator; keep footer.
	const keep = Math.max(0, (rows ?? 0) - 3); // question + overflow line + footer
	const hidden = optsCompact.length - keep;
	return [shortQuestion, ...optsCompact.slice(0, keep), fit(theme.fg("dim", `… +${hidden} more`), w), footer];
}

/**
 * Render the current tab. Deterministic row counts for golden tests. With a
 * `rows` budget the layout degrades options-first (F-001): descriptions are
 * stripped, blank separators dropped, the question truncated to one short
 * line — and only as a last resort option rows are capped behind a
 * "… +N more" indicator; the key-hint footer line always survives.
 */
export function formRender(state: FormState, width: number, rows?: number, theme?: FormTheme): string[] {
	const w = Math.max(12, width);
	const n = state.questions.length;
	if (rows !== undefined && rows < 5) rows = 5; // minimal viable form
	if (state.editing) {
		const q = state.questions[state.tab];
		const header = `输入答案 — Q${state.tab + 1}/${n}: ${q.question}`;
		const hint = "[Enter] 确认  [Esc] 放弃输入";
		return [
			fit(theme ? theme.fg("accent", header) : header, w),
			"",
			`${state.buffer}${CURSOR_MARKER}`,
			"",
			fit(theme ? theme.fg("dim", hint) : hint, w),
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
		const header = `提交 — 全部 ${n} 题答案确认`;
		const lines = [fit(theme ? theme.fg("accent", theme.bold(header)) : header, w), ""];
		for (let i = 0; i < n; i++) {
			const qLine = `${i + 1}. ${state.questions[i].question}`;
			const aLine = `   ↳ ${answerFor(i)}`;
			lines.push(fit(theme ? theme.fg("text", qLine) : qLine, w));
			lines.push(fit(theme ? theme.fg("text", aLine) : aLine, w));
		}
		lines.push("");
		const foot = missing.length > 0
			? `[Enter] 提交（还差 ${missing.length} 题未作答: Q${missing.map((i) => i + 1).join("/Q")}）  [←→] 返回修改  [Esc] 取消`
			: "[Enter] 提交全部  [←→] 返回修改  [Esc] 取消";
		lines.push(fit(theme ? theme.fg(missing.length > 0 ? "warning" : "success", foot) : foot, w));
		return lines;
	}
	const q = state.questions[state.tab];
	if (theme) return themedQuestionFrame(state, q, w, rows, theme);
	const tabs = Array.from({ length: n + 1 }, (_, i) => (i === state.tab ? `●${i + 1}` : `○${i + 1}`))
		.join(" ")
		.concat(" 提交");
	const footer = fit(`${tabs}  [↑/↓] 选择  [Enter] 选定  [Tab] 下一题  [Esc] 取消`, w);
	const questionLine = fit(`Q${state.tab + 1}/${n} · ${q.question}`, w);
	if (rows === undefined) {
		return [questionLine, "", ...optionRows(q, state.selection[state.tab], w), "", footer];
	}
	// Rows-budget degradation (F-001): options-first fit.
	const compact = optionRows(
		{ ...q, options: q.options.map((o) => ({ ...o, description: undefined })) },
		state.selection[state.tab],
		w,
	);
	const withBlanks = [questionLine, "", ...compact, "", footer];
	if (withBlanks.length <= rows) return withBlanks;
	const noBlanks = [questionLine, ...compact, footer];
	if (noBlanks.length <= rows) return noBlanks;
	const shortQuestion = fit(`Q${state.tab + 1}/${n}`, w);
	const withShort = [shortQuestion, ...compact, footer];
	if (withShort.length <= rows) return withShort;
	// Last resort: cap option rows behind an overflow indicator; keep footer.
	const keep = Math.max(0, rows - 3); // question + overflow line + footer
	const hidden = compact.length - keep;
	return [shortQuestion, ...compact.slice(0, keep), fit(`… +${hidden} more`, w), footer];
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
			theme: FormTheme,
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
					const rows = Math.max(5, (process.stdout.rows ?? FORM_FALLBACK_ROWS) - FORM_ROWS_RESERVE);
					return formRender(state, width, rows, theme);
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
		const labels = q.options.map((o, i) => `${i + 1}. ${stripRecommendedMarker(o.label)}${o.recommended ? " ★" : ""}`);
		text += `\n${theme.fg("dim", `  Options: ${labels.join(", ")}`)}`;
	}
	return text;
}
