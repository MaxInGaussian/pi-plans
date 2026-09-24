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
import { assertAutoApprovable, isAutoApproveEnabled } from "../src/auto-approve.ts";
import {
	TERMINATION_QUESTION,
	TERMINATION_OPTIONS,
	TERMINATION_RECORDING_INSTRUCTIONS,
	implReviewerCountPromptLine,
	renderTerminationOptions,
} from "../src/termination-prompt.ts";
import { truncateToWidth, visibleWidth } from "../src/refine-ui-helpers.ts";
import { stripRecommendedMarker } from "../src/ask-form.ts";
import {
	FORM_QUESTION_MAX,
	formAnswers,
	createFormState,
	formHandleKey,
	type FormQuestion,
	type FormResult,
	renderFormCall,
	runQuestionForm,
} from "../src/ask-form.ts";
import { normalizeWorkdir, readActive, recordDecision } from "../src/state.ts";
import { resolveUiLanguage } from "../src/ui-language.ts";
import { resolveActiveRun } from "../src/run-context.ts";
import { applyQuestionAnswered, applyQuestionAsked, applyQuestionsAnswered, applyQuestionsAsked, loadCheckpoint, mutateCheckpoint } from "../src/workflow-state.ts";

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

// F-0.5.3 (batch-form-first-option-loss): every object closes its property
// set — stray keys at ANY level (e.g. the first option's label/description
// hoisted to the question level) fail TypeBox Check loudly at the tool
// boundary instead of silently rendering a form missing its first option.
export const Option = Type.Object(
	{
		label: Type.String({ description: "Option label" }),
		description: Type.Optional(Type.String({ description: "Short tradeoff that matters, shown to the user" })),
		recommended: Type.Optional(Type.Boolean({ description: "Mark exactly one recommended option; put it first. Never embed (推荐)/(recommended) text in labels — the UI renders the ★ marker automatically" })),
	},
	{ additionalProperties: false },
);

export const BatchQuestionParams = Type.Object(
	{
		question: Type.String({ description: "The question to ask, in the configured language" }),
		options: Type.Array(Option, { description: "Ordered options: recommended first, alternatives next. Do not include Other or Auto-complete yourself." }),
		allowOther: Type.Optional(Type.Boolean({ description: "Offer free-form input for this question (default true)" })),
		autoComplete: Type.Optional(
			Type.Boolean({
				description:
					"Batches accept only autoComplete: true (or omitted) items — scope/handoff questions MUST stay single-question calls with autoComplete: false.",
			}),
		),
		questionId: Type.Optional(Type.String({ description: "Stable id for cross-session dedupe (unique within the batch)." })),
		purpose: Type.Optional(Type.String({ description: "Short machine-readable purpose." })),
	},
	{ additionalProperties: false },
);

export const AskChoiceParams = Type.Object(
	{
		question: Type.Optional(Type.String({ description: "The single question to ask, in the configured language (mutually exclusive with questions)." })),
	options: Type.Optional(Type.Array(Option, { description: "Ordered options (single-question form): recommended first, alternatives next. Do not include Other or Auto-complete yourself." })),
	questions: Type.Optional(
		Type.Array(BatchQuestionParams, {
			description:
				"Batch mode (2-8 questions): opens ONE tabbed multiple-choice form with a submit page instead of asking one question at a time. After the batch, think about the answers and follow up in later calls — phased questioning stays agent-driven. Not allowed for scope confirmation or execution handoff (those must stay single-question with autoComplete: false).",
		}),
	),
	allowOther: Type.Optional(Type.Boolean({ description: "Offer free-form input (default true)" })),
	autoComplete: Type.Optional(
		Type.Boolean({
			description:
				"Offer the Auto-complete option (default true). MUST be false for the execution handoff, install waivers, publishing, deployment, merge, push, credential use, or any external-state change.",
		}),
	),
	questionId: Type.Optional(
		Type.String({
			description:
				"Stable id for this question so cross-session resume can deduplicate (e.g. 'termination-condition'). Provide one for planning/refinement questions that gate progress.",
		}),
	),
	purpose: Type.Optional(
		Type.String({ description: "Short machine-readable purpose (e.g. 'scope', 'termination-condition')." }),
	),
	trailing: Type.Optional(
		StringEnum(["auto-refine-loop"] as const, {
			description:
				'Replace the trailing Auto-complete option with "Auto-refine loop" (post-execution amelioration prompt). Selecting it returns instructions to ask the rounds/termination follow-up; Auto-complete is suppressed entirely for this question.',
		}),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
	},
	{ additionalProperties: false },
);

interface AskChoiceDetails {
	question: string;
	options: string[];
	answer: string | null;
	source: "user" | "auto-complete" | "other" | "cancelled";
	/** Batch mode: one entry per answered/recorded question. */
	batch?: Array<{
		question: string;
		options: string[];
		answer: string | null;
		source: "user" | "auto-complete" | "other" | "cancelled";
	}>;
}

/** Question ids reserved for single-question flows (R-013b/D-025): scope
 *  confirmation and the execution handoff must never ride inside a batch,
 *  where auto-complete could answer them without explicit user approval. */
const FORBIDDEN_BATCH_QUESTION_IDS = new Set([
	"termination-condition",
	"impl-review-reviewer-count",
	"scope-confirm",
	"scope-confirm-handoff",
]);

interface BatchRuntime {
	workdir: string;
	activeRun: ReturnType<typeof resolveActiveRun>;
	hasCheckpoint: boolean;
	recordDecision(entry: {
		question: string;
		options: string[];
		answer: string;
		answer_source: "user" | "auto-complete";
		questionId?: string;
		purpose?: string;
	}): void;
	markAsked(qs: Array<{ question: string; options: string[]; questionId?: string; purpose?: string }>): void;
	markAnswered(questionId: string, answer: string, source: "user" | "auto-complete" | "other"): void;
}

function buildBatchRuntime(params: { workdir?: string }, ctx: ExtensionContext): BatchRuntime {
	const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);
	const activeRun = resolveActiveRun(ctx.sessionManager, workdir);
	const hasCheckpoint = activeRun !== null && loadCheckpoint(workdir, activeRun.run_id).status === "ok";
	const recordEntry = (entry: {
		question: string;
		options: string[];
		answer: string;
		answer_source: "user" | "auto-complete";
		questionId?: string;
		purpose?: string;
	}): void => {
		const active = resolveActiveRun(ctx.sessionManager, workdir);
		if (!active) return;
		try {
			recordDecision(workdir, active.run_id, {
				question: entry.question,
				options: entry.options,
				answer: entry.answer,
				answer_source: entry.answer_source,
				...(entry.questionId ? { questionId: entry.questionId } : {}),
			});
		} catch {
			/* recording is best-effort; the question still gets answered */
		}
	};
	return {
		workdir,
		activeRun,
		hasCheckpoint,
		recordEntry,
		markAsked(qs) {
			if (!hasCheckpoint || !activeRun) return;
			const withIds = qs.filter((q) => q.questionId);
			if (withIds.length === 0) return;
			try {
				mutateCheckpoint(workdir, activeRun.run_id, (cp) =>
					applyQuestionsAsked(
						cp,
						withIds.map((q) => ({
							questionId: q.questionId!,
							question: q.question,
							options: q.options.map((o) => (typeof o === "string" ? o : o.label)),
							purpose: q.purpose,
						})),
					),
				);
			} catch {
				/* checkpoint bookkeeping must not block the form itself */
			}
		},
		markAnswered(questionId, answer, source) {
			if (!hasCheckpoint || !activeRun || !questionId) return;
			try {
				mutateCheckpoint(workdir, activeRun.run_id, (cp) =>
					applyQuestionsAnswered(cp, questionId, answer, source),
				);
			} catch {
				/* the decisions ledger already holds the answer; reconcile covers the gap */
			}
		},
	};
}

/** Recommended-option short circuit shared by auto-approve / auto-complete /
 *  no-UI paths. Records every question of the batch (D-022: whole-batch
 *  gate — batches never contain autoComplete:false items per R-013b). */
function shortCircuitBatch(
	runtime: BatchRuntime,
	qs: Array<{ question: string; options: Array<{ label: string; description?: string; recommended?: boolean }>; questionId?: string; purpose?: string }>,
): AskChoiceDetails {
	const answered = qs.map((q, index) => {
		const recommended = q.options.find((option) => option.recommended) ?? q.options[0];
		runtime.recordEntry({
			question: q.question,
			options: q.options.map((option) => option.label),
			answer: recommended.label,
			answer_source: "auto-complete",
			...(q.questionId ? { questionId: q.questionId } : {}),
			...(q.purpose ? { purpose: q.purpose } : {}),
		});
		runtime.markAnswered(q.questionId ?? "", recommended.label, "auto-complete");
		return {
			question: q.question,
			options: q.options.map((option) => option.label),
			answer: recommended.label,
			source: "auto-complete" as const,
			index: index + 1,
		};
	});
	return {
		question: `[batch of ${qs.length}]`,
		options: [],
		answer: answered.map((a) => a.answer).join(" | "),
		source: "auto-complete",
		batch: answered.map(({ index: _index, ...rest }) => rest),
	};
}

async function executeAskChoiceBatch(
	params: {
		questions: Array<{
			question: string;
			options: Array<{ label: string; description?: string; recommended?: boolean }>;
			allowOther?: boolean;
			autoComplete?: boolean;
			questionId?: string;
			purpose?: string;
		}>;
		workdir?: string;
	},
	ctx: ExtensionContext,
): Promise<{ content: { type: string; text: string }[]; details: AskChoiceDetails }> {
	const qs = params.questions;
	const runtime = buildBatchRuntime(params, ctx);

	// --- Validation layer (D-007/D-022/D-025/R-013b) ---------------------
	const allowed = FORBIDDEN_BATCH_QUESTION_IDS;
	for (const q of qs as Array<{ options: unknown[]; question: string; questionId?: string; autoComplete?: boolean }>) {
		if (q.options.length === 0) throw new Error(`ask_choice batch question needs options: ${q.question}`);
		// F-0.5.3: every batch question must carry a recommended option. A
		// malformed call (first option's fields hoisted to the question level,
		// recommended flag lost) previously slipped through schema validation
		// and silently rendered a form missing its first option. Fail loudly
		// BEFORE any recording/short-circuit side effects so the model retries.
		if (!(q.options as Array<{ recommended?: boolean }>).some((option) => option.recommended === true)) {
			throw new Error(
				`ask_choice batch question needs a recommended option (options[n].recommended: true): ${q.question} — did the first option's label/description get hoisted to the question level?`,
			);
		}
		// R-013b/D-025 safety red line: batches never carry questions that
		// must not be auto-completed (scope confirmation, execution handoff).
		if (q.autoComplete === false) {
			throw new Error(
				`ask_choice batch cannot carry autoComplete: false ("${q.question}") — ask it as a single question.`,
			);
		}
		if (q.questionId && allowed.has(q.questionId)) {
			throw new Error(
				`ask_choice batch cannot carry reserved questionId "${q.questionId}" — ask scope confirmation / execution handoff as a single question (autoComplete: false).`,
			);
		}
	}
	const seen = new Set<string>();
	for (const q of qs) {
		if (q.questionId) {
			if (seen.has(q.questionId)) throw new Error(`duplicate questionId in batch: ${q.questionId}`);
			seen.add(q.questionId);
		}
	}
	if (qs.length > FORM_QUESTION_MAX) {
		throw new Error(
			`ask_choice batch supports at most ${FORM_QUESTION_MAX} questions per call (got ${qs.length}) — split into sequential batches and follow up after each one.`,
		);
	}

	// --- Gates (D-022: whole-batch; R-005: fail-closed before any record) ---
	if (isAutoApproveEnabled()) {
		for (const q of qs) {
			assertAutoApprovable({
				question: q.question,
				purpose: q.purpose,
				questionId: q.questionId,
				optionLabels: q.options.map((option) => option.label),
			});
		}
		const details = shortCircuitBatch(runtime, qs);
		return {
			content: [{ type: "text", text: `[auto-approve] PI_PLANS_AUTO_APPROVE=1 answered ${qs.length} questions with their recommended options.` }],
			details,
		};
	}
	if (isAutoCompleteEnabled(ctx)) {
		recordAskChoice(ctx, true);
		const details = shortCircuitBatch(runtime, qs);
		return {
			content: [{ type: "text", text: `Auto-complete selected the recommended option for all ${qs.length} questions.` }],
			details,
		};
	}
	if (!ctx.hasUI) {
		enableAutoComplete(ctx);
		recordAskChoice(ctx, true);
		const details = shortCircuitBatch(runtime, qs);
		return {
			content: [
				{ type: "text", text: `No UI available. Auto-complete selected the recommended option for all ${qs.length} questions.` },
			],
			details,
		};
	}

	// --- Live batch form ---------------------------------------------------
	runtime.markAsked(qs);
	const formQuestions: FormQuestion[] = qs.map((q) => ({
		question: q.question,
		options: q.options,
		allowOther: q.allowOther ?? true,
		questionId: q.questionId ?? "",
		purpose: q.purpose,
		autoComplete: true,
	}));
	// Issue #3: resolve the form chrome language only where the form is about to
	// open (not on the batch runtime hot path).
	const formLang = resolveUiLanguage(normalizeWorkdir(params.workdir ?? ctx.cwd));
	let result: FormResult;
	try {
		result = await runQuestionForm(ctx.ui, formQuestions, formLang);
	} catch (error) {
		// Host threw while opening the custom dialog (e.g. RPC without custom
		// support): degrade to one sequential select per question.
		result = { answers: [], cancelled: false, unavailable: true };
	}
	if (result.unavailable) {
		const batch: AskChoiceDetails["batch"] = [];
		let cancelled = false;
		for (const q of formQuestions) {
			const panelItems: PanelItem[] = q.options.map((option, index) => {
				const label = stripRecommendedMarker(option.label);
				const core = `${index + 1}. ${label}${option.recommended ? "  ★" : ""}`;
				const display = core + (option.description ? ` — ${option.description}` : "");
				return { core, display };
			});
			if (q.allowOther) panelItems.push({ core: "Other…  (type your own answer)", display: "Other…  (type your own answer)", fixed: true });
			const panel = fitAskChoicePanel(q.question, panelItems, process.stdout.columns ?? 0, process.stdout.rows ?? 0);
			const selected = await ctx.ui.select(panel.question, panel.labels);
			if (selected === undefined) {
				cancelled = true;
				break;
			}
			let answer = selected;
			let source: "user" | "other" = "user";
			if (q.allowOther && selected.startsWith("Other…")) {
				const typed = await ctx.ui.input(`${q.question} — your answer:`);
				if (typed === undefined || !typed.trim()) {
					cancelled = true;
					break;
				}
				answer = typed.trim();
				source = "other";
			}
			runtime.recordEntry({
				question: q.question,
				options: q.options.map((o) => o.label),
				answer,
				answer_source: "user",
				questionId: q.questionId || undefined,
				purpose: q.purpose,
			});
			if (q.questionId) runtime.markAnswered(q.questionId, answer, source);
			batch.push({ question: q.question, options: q.options.map((o) => o.label), answer, source });
		}
		if (cancelled) {
			disableAutoComplete(ctx, "batch question cancelled");
			return {
				content: [
					{
						type: "text",
						text: `User cancelled mid-batch after ${batch.length}/${qs.length} questions. Use the answered subset and do not treat the rest as approved.`,
					},
				],
				details: { question: `[batch of ${qs.length}, cancelled at ${batch.length}]`, options: [], answer: null, source: "cancelled", batch },
			};
		}
		recordAskChoice(ctx, false);
		return {
			content: [{ type: "text", text: formatBatchAnswers(batch) }],
			details: { question: `[batch of ${qs.length}]`, options: [], answer: batch.map((b) => b.answer ?? "").join(" | "), source: "user", batch },
		};
	}

	const answers = result.answers;
	const batch: AskChoiceDetails["batch"] = answers.map((a) => {
		const q = qs[a.index];
		runtime.recordEntry({
			question: q.question,
			options: q.options.map((o) => o.label),
			answer: a.answer,
			answer_source: "user",
			questionId: a.questionId,
			purpose: q.purpose,
		});
		if (a.questionId) runtime.markAnswered(a.questionId, a.answer, a.source);
		return {
			question: q.question,
			options: q.options.map((o) => o.label),
			answer: a.answer,
			source: a.source,
		};
	});
	if (result.cancelled) {
		// D-009: partial answers come back; the batch-level state marks the
		// gap so resume drops only unanswered rows. Auto-complete is disabled
		// for the session just like the single-question cancel path.
		disableAutoComplete(ctx, "batch question cancelled");
		runtime.recordEntry({
			question: `[batch cancelled: ${batch.length}/${qs.length} answered]`,
			options: qs.map((q) => q.question),
			answer: batch.length > 0 ? batch.map((b) => `${b.question} → ${b.answer}`).join(" | ") : "(none answered)",
			answer_source: "user",
		});
		return {
			content: [
				{
					type: "text",
					text: `User cancelled the batch after ${batch.length}/${qs.length} questions answered. Answers so far: ${formatBatchAnswers(batch)}. Do not treat unanswered questions as approved — re-ask them (or proceed with what you have) after thinking.`,
				},
			],
			details: { question: `[batch of ${qs.length}, cancelled at ${batch.length}]`, options: [], answer: null, source: "cancelled", batch },
		};
	}
	recordAskChoice(ctx, false);
	return {
		content: [{ type: "text", text: formatBatchAnswers(batch) }],
		details: { question: `[batch of ${qs.length}]`, options: [], answer: batch.map((b) => b.answer ?? "").join(" | "), source: "user", batch },
	};
}

function formatBatchAnswers(batch: NonNullable<AskChoiceDetails["batch"]>): string {
	return batch
		.map((b, i) => `${i + 1}. ${b.question}${NL}   ↳ ${b.source === "other" ? "[custom] " : ""}${b.answer}`)
		.join(NL);
}
const NL = "\n";

export function registerAskChoiceTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_choice",
		label: "Ask Choice",
		description:
			"Ask the user planning or refinement questions as numbered choice prompts: recommended option first, alternatives next, then Other and Auto-complete. Two shapes: questions: [...] (2-8 questions) opens ONE tabbed multiple-choice form with a submit page — use it to batch a round of questions (≤8), then think about the answers and follow up in later calls (phased questioning stays agent-driven); question + options asks one question at a time (classic flow). Use ask_choice for every user-facing planning question, the final scope confirmation, refinement-mode questions, language/role/model settings, and the execution handoff. Scope confirmation and the execution handoff MUST stay single-question calls (autoComplete: false); batches reject autoComplete: false items and the termination/questionIds reserved for handoff. The optional trailing parameter swaps the trailing Auto-complete option to Auto-refine loop for the post-execution amelioration prompt.",
		promptSnippet: "Ask structured planning questions with recommended/Other/Auto-complete ordering; batch ≤8 questions per form",
		promptGuidelines: [
			"Use ask_choice for every pi-plans question to the user instead of plain-text questions; it enforces option ordering and records decisions.",
			"Batch a round's questions into one ask_choice call (questions: [...], 2-8 items) instead of asking one at a time, then think after the answers and follow up with later calls. Scope confirmation and execution handoff are always separate single-question calls (autoComplete: false).",
		],
		parameters: AskChoiceParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 0.4.0 batch mode: one tabbed form for a whole round of questions
			// (2-8). The single-question path below is untouched (C-004).
			// F-005 (impl review r1): ambiguous shapes fail loudly instead of
			// silently preferring one parameter set.
			if (params.questions !== undefined && params.questions.length > 0) {
				if (params.question !== undefined || params.options !== undefined) {
					throw new Error("ask_choice accepts either question+options or questions, not both");
				}
				if (params.trailing !== undefined) {
					throw new Error("ask_choice batch mode does not support trailing (single-question only)");
				}
				return executeAskChoiceBatch({ questions: params.questions, workdir: params.workdir }, ctx);
			}
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);
			const allowOther = params.allowOther ?? true;
			// I-003: cross-session question durability. Pending is recorded
			// before the panel opens; the answer is recorded before it returns.
			// Runs without a checkpoint (adhoc, pre-start-run setup questions)
			// skip silently — legacy behavior is unchanged.
			const activeRun = resolveActiveRun(ctx.sessionManager, workdir);
			const hasCheckpoint =
				activeRun !== null && loadCheckpoint(workdir, activeRun.run_id).status === "ok";
			const recordQuestionAsked = (): void => {
				if (!hasCheckpoint || !activeRun || !params.questionId) return;
				try {
					mutateCheckpoint(workdir, activeRun.run_id, (cp) =>
						applyQuestionAsked(cp, {
							questionId: params.questionId!,
							question: params.question,
							options: options.map((option) => option.label),
							purpose: params.purpose,
							allowOther,
							autoComplete,
						}),
					);
				} catch {
					/* checkpoint bookkeeping must not block the question itself */
				}
			};
			const recordQuestionAnswered = (answer: string, source: "user" | "auto-complete" | "other"): void => {
				if (!hasCheckpoint || !activeRun || !params.questionId) return;
				try {
					mutateCheckpoint(workdir, activeRun.run_id, (cp) =>
						applyQuestionAnswered(cp, params.questionId!, answer, source),
					);
				} catch {
					/* the decisions ledger already holds the answer; F-005 reconcile covers the gap */
				}
			};
			// Param normalization: a trailing option replaces Auto-complete entirely,
			// so an erroneously passed autoComplete flag is suppressed here.
			const trailing = params.trailing;
			const autoComplete = (params.autoComplete ?? true) && trailing === undefined;
			const options = params.options;
			if (options.length === 0) throw new Error("ask_choice requires at least one option");
			const recommended = options.find((option) => option.recommended) ?? options[0];

			const record = (answer: string, source: AskChoiceDetails["source"]) => {
				const active = resolveActiveRun(ctx.sessionManager, workdir);
				if (!active) return;
				try {
					recordDecision(workdir, active.run_id, {
						question: params.question,
						options: options.map((option) => option.label),
						answer,
						answer_source: source === "auto-complete" ? "auto-complete" : "user",
						// F-005 reconcile (implementation review): the ledger
						// carries the stable id so resume can drop stale pending
						// questions after a crash between the two writes.
						...(params.questionId ? { questionId: params.questionId } : {}),
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

			// I-004/D-019: benchmark auto-approve (PI_PLANS_AUTO_APPROVE=1).
			// The env short-circuits BEFORE any UI dispatch: lifecycle questions
			// answer with the recommended option; external-state questions are
			// hard-rejected (fail closed) even with the env set.
			if (isAutoApproveEnabled()) {
				assertAutoApprovable({
					question: params.question,
					purpose: params.purpose,
					questionId: params.questionId,
					optionLabels: options.map((option) => option.label),
				});
				// F-010/C-008: an unbounded auto-selected termination option
				// (goal wait) would loop forever headlessly — pick the first
				// bounded option instead.
				const isTerminationQuestion = params.questionId === "termination-condition";
				const boundedOption = options.find((o) => !/goal wait/i.test(o.label));
				const chosen = isTerminationQuestion && boundedOption ? boundedOption : recommended;
				record(chosen.label, "auto-complete");
				recordQuestionAsked();
				recordQuestionAnswered(chosen.label, "auto-complete");
				return {
					content: [
						{
							type: "text",
							text: `[auto-approve] PI_PLANS_AUTO_APPROVE=1 answered: ${chosen.label}`,
						},
					],
					details: details(chosen.label, "auto-complete"),
				};
			}

			// Once enabled for this planning run, eligible questions answer with the
			// recommendation without opening another UI prompt.
			if (autoComplete && isAutoCompleteEnabled(ctx)) {
				recordAskChoice(ctx, true);
				record(recommended.label, "auto-complete");
				recordQuestionAsked();
				recordQuestionAnswered(recommended.label, "auto-complete");
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
				recordQuestionAsked();
				recordQuestionAnswered(recommended.label, "auto-complete");
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
				const label = stripRecommendedMarker(option.label);
				const isRec = option === recommended;
				const core = `${index + 1}. ${label}${isRec ? "  ★" : ""}`;
				let display = `${index + 1}. ${label}`;
				if (isRec) display += "  ★";
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

			recordQuestionAsked();
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
				recordQuestionAnswered(recommended.label, "auto-complete");
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
				// Skill-aware reviewer-count default (D-1/D-4): same mapping the
				// goal-running continuation in src/exec.ts renders.
				const activeSkill = resolveActiveRun(ctx.sessionManager, workdir)?.skill;
			return {
					content: [
						{
							type: "text",
							text: `User selected Auto-refine loop. Immediately ask the follow-up with ask_choice (autoComplete: false, in the session language): "${TERMINATION_QUESTION}" Options (recommended first): ${renderTerminationOptions()}. ${TERMINATION_RECORDING_INSTRUCTIONS} ${implReviewerCountPromptLine(activeSkill)} Then run the loop per the completion instructions: each round calls refine (role: "reviewer", target: "implementation", reviewers: <configured reviewerCount>), accepts findings on evidence, applies fixes, re-runs relevant tests, and continues until the chosen termination condition — the goal-wait option keeps the loop running until no unpassed VCs remain.`,
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
				recordQuestionAnswered(answer, "other");
				return {
					content: [{ type: "text", text: `User wrote: ${answer}` }],
					details: details(answer, "other"),
				};
			}

			const index = panel.labels.indexOf(selected);
			const option = index >= 0 && index < options.length ? options[index] : undefined;
			if (!option) {
				recordAskChoice(ctx, false);
				recordQuestionAnswered(selected, "user");
				return {
					content: [{ type: "text", text: `User selected: ${selected}` }],
					details: details(selected, "user"),
				};
			}
			recordAskChoice(ctx, false);
			record(option.label, "user");
			recordQuestionAnswered(option.label, "user");
			return {
				content: [{ type: "text", text: `User selected: ${index + 1}. ${option.label}` }],
				details: details(option.label, "user"),
			};
		},

		renderCall(args, theme) {
			if (Array.isArray(args.questions) && args.questions.length > 0) {
				return new Text(
					renderFormCall(
						args.questions.map((q: { question: string; options: Array<{ label: string; description?: string; recommended?: boolean }> }) => ({
							question: q.question,
							options: q.options,
							allowOther: true,
							questionId: "",
							autoComplete: true,
						})),
						theme,
					),
					0,
					0,
				);
			}
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
			if (details.batch && details.batch.length > 0) {
				const lines = details.batch.map((b) => {
					const prefix =
						b.source === "auto-complete"
							? theme.fg("muted", "✓ (auto) ")
							: b.source === "other"
								? theme.fg("muted", "✓ (wrote) ")
								: theme.fg("success", "✓ ");
					return `${prefix}${theme.fg("accent", b.question)} ${theme.fg("muted", "→")} ${theme.fg("accent", b.answer ?? "")}`;
				});
				return new Text(lines.join("\n"), 0, 0);
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
