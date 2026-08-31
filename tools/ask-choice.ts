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
import { normalizeWorkdir, readActive, recordDecision } from "../src/state.ts";

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
			"Ask the user one planning or refinement question as a numbered choice prompt: recommended option first, alternatives next, then Other and Auto-complete. One question per call. Use for every user-facing planning question, the final scope confirmation, refinement-mode questions, language/role/model settings, and the execution handoff (with autoComplete: false).",
		promptSnippet: "Ask structured planning questions with recommended/Other/Auto-complete ordering",
		promptGuidelines: [
			"Use ask_choice for every pi-plans question to the user instead of plain-text questions; it enforces option ordering and records decisions.",
		],
		parameters: AskChoiceParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);
			const allowOther = params.allowOther ?? true;
			const autoComplete = params.autoComplete ?? true;
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

			const displayLabels: string[] = options.map((option, index) => {
				let label = `${index + 1}. ${option.label}`;
				if (option === recommended) label += "  (recommended)";
				if (option.description) label += ` — ${option.description}`;
				return label;
			});
			if (allowOther) displayLabels.push("Other…  (type your own answer)");
			if (autoComplete) displayLabels.push("Auto-complete  (take the recommended option)");

			const selected = await ctx.ui.select(params.question, displayLabels);
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

			const index = displayLabels.indexOf(selected);
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
