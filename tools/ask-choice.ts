/**
 * `ask_choice` tool — the choice-prompt contract as a Pi tool.
 *
 * Every user-facing planning/refinement question goes through this tool:
 * recommended option first, real alternatives next, `Other` second-last,
 * `Auto-complete` last. Auto-complete may answer planning and refinement
 * questions only; it is forbidden for execution handoff and any
 * external-state change (pass autoComplete: false there).
 *
 * Answers are recorded automatically in the active run's decisions.jsonl.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { disableAutoComplete, enableAutoComplete, isAutoCompleteEnabled, recordAskChoice } from "../src/autocomplete.ts";
import { truncateToWidth, visibleWidth } from "../src/refine-ui-helpers.ts";
import { normalizeWorkdir, readActive, recordDecision } from "../src/state.ts";

// ---------------------------------------------------------------------------
// Panel fitting: pi's ExtensionSelectorComponent renders each option as an
// auto-wrapping Text with NO height cap — an oversized panel exceeds the
// terminal rows and the TUI thrashes (flicker). These helpers sanitize and
// shrink the question/labels before they reach ctx.ui.select.
// ---------------------------------------------------------------------------

export const STATUS_BAR_HEIGHT = 1;
export const PANEL_SAFETY_MARGIN = 2;
export const PANEL_CHROME_LINES = 9; // 8 measured in extension-selector.js (DynamicBorder×2 + Spacer×4 + title + keyHint) + 1 slack
/** Each option renders in at most three wrapped lines (user-facing contract). */
export const OPTION_MAX_LINES = 3;
/**
 * Per-row width overhead, pinned to extension-selector.js: DynamicBorder 1 +
 * Text padding 1 + selected marker "→ " 2 = 4, plus 2 columns of slack for
 * word-wrap inefficiency. Re-verify against that file if pi changes its layout.
 */
export const SELECTOR_WIDTH_OVERHEAD = 6;
export const FALLBACK_COLUMNS = 100;
export const FALLBACK_ROWS = 30;
/** Minimal-form floor for tiny terminals (stage-3 width). */
const MINIMAL_LINE_WIDTH = 20;
/**
 * Truncation floor for fixed tail labels (Other…/Auto-complete/Auto-refine
 * loop): the longest magic prefix ("Auto-refine loop", 16 cols) plus slack.
 * These labels drive startsWith() answer routing and must never lose it.
 */
const FIXED_LABEL_FLOOR = 18;

export interface PanelItem {
	/** Label without description (degradation stage 1+). */
	core: string;
	/** Full display label: core + description (degradation stage 0). */
	display: string;
	/** Fixed tail labels (Other…/Auto-complete/Auto-refine loop): truncation keeps at least the magic prefix. */
	fixed?: boolean;
}

export interface FittedPanel {
	question: string;
	labels: string[];
	/** True when even the minimal form exceeds the terminal budget. */
	overflowWarned: boolean;
}

function sanitizeLine(text: string): string {
	return text.replace(/\r\n|\n|\r/g, " ");
}

function truncateWithDotDot(text: string, budget: number): string {
	if (visibleWidth(text) <= budget) return text;
	return `${truncateToWidth(text, Math.max(0, budget - 2), "")}..`;
}

function truncateForItem(item: PanelItem, budget: number): string {
	const effective = item.fixed ? Math.max(budget, FIXED_LABEL_FLOOR) : budget;
	return truncateWithDotDot(item.display, effective);
}

function wrappedLineCount(text: string, lineWidth: number): number {
	return Math.max(1, Math.ceil(visibleWidth(text) / lineWidth));
}

/**
 * Sanitize and shrink the question/labels so the projected panel height stays
 * under rows − statusBar − margin. Degradation order (D-001): per-label 3-line
 * budget → strip descriptions → labels to one line → truncate the question →
 * minimal 20-column form (overflowWarned; never fails closed).
 */
export function fitAskChoicePanel(question: string, items: PanelItem[], columns: number, rows: number): FittedPanel {
	const cols = columns > 0 ? columns : FALLBACK_COLUMNS;
	const termRows = rows > 0 ? rows : FALLBACK_ROWS;
	const lineBudget = Math.max(20, cols - SELECTOR_WIDTH_OVERHEAD);
	const rowBudget = Math.max(10, termRows - STATUS_BAR_HEIGHT - PANEL_SAFETY_MARGIN);

	const cleanQuestion = sanitizeLine(question);
	const clean = items.map((item) => ({ core: sanitizeLine(item.core), display: sanitizeLine(item.display), fixed: item.fixed === true }));

	const projected = (q: string, ls: string[]) =>
		PANEL_CHROME_LINES + wrappedLineCount(q, lineBudget) + ls.reduce((sum, l) => sum + wrappedLineCount(l, lineBudget), 0);

	// Stage 0: full display labels, each within the 3-line budget.
	// (Signature note: items carry {core, display} because D-001 stage 1 strips
	// descriptions, which a plain string list cannot express.)
	let currentQuestion = cleanQuestion;
	let currentLabels = clean.map((item) => truncateForItem(item, OPTION_MAX_LINES * lineBudget));

	if (projected(currentQuestion, currentLabels) >= rowBudget) {
		// Stage 1: strip descriptions (core labels only).
		currentLabels = clean.map((item) => truncateForItem({ ...item, display: item.core }, OPTION_MAX_LINES * lineBudget));
	}
	if (projected(currentQuestion, currentLabels) >= rowBudget) {
		// Stage 2: labels to a single line.
		currentLabels = clean.map((item) => truncateForItem({ ...item, display: item.core }, lineBudget));
	}
	if (projected(currentQuestion, currentLabels) >= rowBudget) {
		// Stage 3: truncate the question too.
		currentQuestion = truncateWithDotDot(currentQuestion, lineBudget);
	}
	let overflowWarned = false;
	if (projected(currentQuestion, currentLabels) >= rowBudget) {
		// Minimal form for tiny terminals: 20-column floor; still over → warn, never fail closed.
		currentQuestion = truncateWithDotDot(cleanQuestion, MINIMAL_LINE_WIDTH);
		currentLabels = clean.map((item) => truncateForItem({ ...item, display: item.core }, MINIMAL_LINE_WIDTH));
		overflowWarned = projected(currentQuestion, currentLabels) >= rowBudget;
	}
	return { question: currentQuestion, labels: currentLabels, overflowWarned };
}

const Option = Type.Object({
	label: Type.String({ description: "Option label" }),
	description: Type.Optional(Type.String({ description: "Short tradeoff that matters, shown to the user" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark exactly one recommended option; put it first" })),
});

const AskChoiceParams = Type.Object({
	question: Type.String({ description: "The question to ask, in the configured language" }),
	options: Type.Array(Option, { description: "Ordered options: recommended first, alternatives next. Do not include Other or Auto-complete yourself." }),
	allowOther: Type.Optional(Type.Boolean({ description: "Offer free-form input (default true)" })),
	autoComplete: Type.Optional(
		Type.Boolean({
			description:
				"Offer the Auto-complete option (default true). MUST be false for the execution handoff, install waivers, publishing, deployment, merge, push, credential use, or any external-state change.",
		}),
	),
	trailing: Type.Optional(
		StringEnum(["auto-refine-loop"] as const, {
			description:
				'Replace the trailing Auto-complete option with "Auto-refine loop" (post-execution amelioration prompt). Selecting it returns instructions to ask the rounds/termination follow-up; Auto-complete is suppressed entirely for this question.',
		}),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

interface AskChoiceDetails {
	question: string;
	options: string[];
	answer: string | null;
	source: "user" | "auto-complete" | "other" | "cancelled";
}

export function registerAskChoiceTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_choice",
		label: "Ask Choice",
		description:
			"Ask the user one planning or refinement question as a numbered choice prompt: recommended option first, alternatives next, then Other and Auto-complete. One question per call. Use for every user-facing planning question, the final scope confirmation, refinement-mode questions, language/role/model settings, and the execution handoff (with autoComplete: false). The optional trailing parameter swaps the trailing option to Auto-refine loop for the post-execution amelioration prompt.",
		promptSnippet: "Ask structured planning questions with recommended/Other/Auto-complete ordering",
		promptGuidelines: [
			"Use ask_choice for every pi-plans question to the user instead of plain-text questions; it enforces option ordering and records decisions.",
		],
		parameters: AskChoiceParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);
			const allowOther = params.allowOther ?? true;
			// Param normalization: a trailing option replaces Auto-complete entirely,
			// so an erroneously passed autoComplete flag is suppressed here.
			const trailing = params.trailing;
			const autoComplete = (params.autoComplete ?? true) && trailing === undefined;
			const options = params.options;
			if (options.length === 0) throw new Error("ask_choice requires at least one option");
			const recommended = options.find((option) => option.recommended) ?? options[0];

			const record = (answer: string, source: AskChoiceDetails["source"]) => {
				const active = readActive(workdir);
				if (!active) return;
				try {
					recordDecision(workdir, active.run_id, {
						question: params.question,
						options: options.map((option) => option.label),
						answer,
						answer_source: source === "auto-complete" ? "auto-complete" : "user",
					});
				} catch {
					/* recording is best-effort; the question still gets answered */
				}
			};

			const details = (answer: string | null, source: AskChoiceDetails["source"]): AskChoiceDetails => ({
				question: params.question,
				options: options.map((option) => option.label),
				answer,
				source,
			});

			// Once enabled for this planning run, eligible questions answer with the
			// recommendation without opening another UI prompt.
			if (autoComplete && isAutoCompleteEnabled(ctx)) {
				recordAskChoice(ctx, true);
				record(recommended.label, "auto-complete");
				return {
					content: [{ type: "text", text: `Auto-complete selected the recommended option: ${recommended.label}` }],
					details: details(recommended.label, "auto-complete"),
				};
			}

			// No UI (print/json mode): planning questions may auto-complete;
			// questions without Auto-complete must stop and wait for the user.
			if (!ctx.hasUI) {
				if (!autoComplete) {
					disableAutoComplete(ctx, "non-interactive boundary");
					throw new Error(
						"No UI available and this question must not be auto-completed (execution handoff or external-state change). Stop and wait for the user.",
					);
				}
				enableAutoComplete(ctx);
				recordAskChoice(ctx, true);
				record(recommended.label, "auto-complete");
				return {
					content: [
						{
							type: "text",
							text: `No UI available. Auto-complete selected the recommended option: ${recommended.label}`,
						},
					],
					details: details(recommended.label, "auto-complete"),
				};
			}

			const AUTO_REFINE_LOOP_LABEL =
				"Auto-refine loop  (run refinement rounds until no high-severity finding or the 5-round cap)";
			const panelItems: PanelItem[] = options.map((option, index) => {
				const core = `${index + 1}. ${option.label}${option === recommended ? "  (recommended)" : ""}`;
				let display = `${index + 1}. ${option.label}`;
				if (option === recommended) display += "  (recommended)";
				if (option.description) display += ` — ${option.description}`;
				return { core, display };
			});
			if (allowOther) panelItems.push({ core: "Other…  (type your own answer)", display: "Other…  (type your own answer)", fixed: true });
			if (autoComplete) panelItems.push({ core: "Auto-complete  (take the recommended option)", display: "Auto-complete  (take the recommended option)", fixed: true });
			else if (trailing) panelItems.push({ core: AUTO_REFINE_LOOP_LABEL, display: AUTO_REFINE_LOOP_LABEL, fixed: true });

			const panel = fitAskChoicePanel(
				params.question,
				panelItems,
				process.stdout.columns ?? 0,
				process.stdout.rows ?? 0,
			);
			if (panel.overflowWarned) {
				ctx.ui.notify?.("Terminal too small: the ask_choice panel may overflow even in its minimal form.", "warning");
			}

			const selected = await ctx.ui.select(panel.question, panel.labels);
			if (selected === undefined) {
				disableAutoComplete(ctx, "question cancelled");
				return {
					content: [
						{
							type: "text",
							text: "User cancelled the question. Do not treat this as approval for anything; ask again later or stop.",
						},
					],
					details: details(null, "cancelled"),
				};
			}

			if (autoComplete && selected.startsWith("Auto-complete")) {
				enableAutoComplete(ctx);
				recordAskChoice(ctx, true);
				record(recommended.label, "auto-complete");
				return {
					content: [
						{
							type: "text",
							text: `User selected Auto-complete; take the recommended option: ${options.findIndex((o) => o === recommended) + 1}. ${recommended.label}`,
						},
					],
					details: details(recommended.label, "auto-complete"),
				};
			}

			if (trailing && selected.startsWith("Auto-refine loop")) {
				recordAskChoice(ctx, false);
				record("Auto-refine loop", "user");
				return {
					content: [
						{
							type: "text",
							text: `User selected Auto-refine loop. Immediately ask the follow-up with ask_choice (autoComplete: false, in the session language): how should the amelioration loop terminate? Options (recommended first): 1. until no high-severity finding (hard cap 5 rounds) 2. 1 round 3. 2 rounds 4. 3 rounds. Then run the loop per the completion instructions: each round calls refine (role: "reviewer", target: "implementation"), accepts findings on evidence, applies fixes, re-runs relevant tests, and continues until the termination condition or the 5-round cap.`,
						},
					],
					details: details("Auto-refine loop", "user"),
				};
			}

			if (allowOther && selected.startsWith("Other…")) {
				const typed = await ctx.ui.input(`${params.question} — your answer:`);
				if (typed === undefined || !typed.trim()) {
					disableAutoComplete(ctx, "free-form answer cancelled");
					return {
						content: [{ type: "text", text: "User cancelled the free-form answer. Ask again or stop." }],
						details: details(null, "cancelled"),
					};
				}
				recordAskChoice(ctx, false);
				const answer = typed.trim();
				record(answer, "user");
				return {
					content: [{ type: "text", text: `User wrote: ${answer}` }],
					details: details(answer, "other"),
				};
			}

			const index = panel.labels.indexOf(selected);
			const option = index >= 0 && index < options.length ? options[index] : undefined;
			if (!option) {
				recordAskChoice(ctx, false);
				return {
					content: [{ type: "text", text: `User selected: ${selected}` }],
					details: details(selected, "user"),
				};
			}
			recordAskChoice(ctx, false);
			record(option.label, "user");
			return {
				content: [{ type: "text", text: `User selected: ${index + 1}. ${option.label}` }],
				details: details(option.label, "user"),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ask_choice ")) + theme.fg("muted", args.question);
			const labels = (args.options ?? []).map((option: { label: string }, i: number) => `${i + 1}. ${option.label}`);
			if (labels.length) text += `\n${theme.fg("dim", `  Options: ${labels.join(", ")}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskChoiceDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.answer === null || details.source === "cancelled") {
				return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
			}
			const prefix =
				details.source === "auto-complete"
					? theme.fg("muted", "✓ (auto-complete) ")
					: details.source === "other"
						? theme.fg("muted", "✓ (wrote) ")
						: theme.fg("success", "✓ ");
			return new Text(prefix + theme.fg("accent", details.answer), 0, 0);
		},
	});
}
