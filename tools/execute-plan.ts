/**
 * `execute_plan` tool — the execution handoff. On explicit user approval (no
 * Auto-complete) the extension enters execution mode with checklist tracking.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getExecution,
	resumeActiveExecution,
	startExecution,
	type ExecutionRuntime,
} from "../src/exec.ts";
import { disableAutoComplete } from "../src/autocomplete.ts";
import { isAutoApproveEnabled } from "../src/auto-approve.ts";
import { latestPlanVersion, parseChecklist, parseImplItems } from "../src/plan.ts";
import { normalizeWorkdir, recordDecision, type RunSummary } from "../src/state.ts";
import { bindRun, resolveActiveRun } from "../src/run-context.ts";
import { executionCandidates, resolveCommandRun } from "../src/run-picker.ts";
import { collectModelSelectors, modelSelectorOf } from "../src/config-command.ts";
import { resolveUiLanguage } from "../src/ui-language.ts";


const ExecutePlanParams = Type.Object({
	planPath: Type.Optional(
		Type.String({ description: "Path to the accepted PLAN_vN.md. Default: highest version in the active run's artifact directory." }),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

export interface HandoffOutcome {
	status: "executing" | "declined" | "error";
	planPath?: string;
	itemCount?: number;
	message: string;
}

/** Shared handoff logic for the execute_plan tool and /plans-execute command. */
export async function executeHandoff(
	ctx: ExtensionContext,
	planPathArg?: string,
	workdirArg?: string,
	signal?: AbortSignal,
): Promise<HandoffOutcome> {
	const workdir = normalizeWorkdir(workdirArg ?? ctx.cwd);

	let planPath: string | null = null;
	let chosenRun: RunSummary | null = null;
	if (planPathArg) {
		planPath = path.resolve(workdir, planPathArg.replace(/^@/, ""));
	} else {
		// v0.6.0 (R-3): pick the run explicitly when several execution
		// candidates coexist; binding-first, single candidate stays direct.
		chosenRun = await resolveCommandRun(
			{ cwd: workdir, sessionManager: ctx.sessionManager, ui: ctx.ui },
			{ candidates: executionCandidates(workdir), title: "Execute which run?" },
		);
		if (!chosenRun) {
			return {
				status: "error",
				message: "No plan path given and no executable planning run found. Pass planPath or start a run first.",
			};
		}
		const latest = latestPlanVersion(chosenRun.artifact_dir);
		if (!latest) {
			return { status: "error", message: `No PLAN_vN.md found in ${chosenRun.artifact_dir}` };
		}
		planPath = latest.path;
	}
	if (!fs.existsSync(planPath)) {
		return { status: "error", message: `Plan file not found: ${planPath}` };
	}

	const planText = fs.readFileSync(planPath, "utf8");
	const items = parseChecklist(planText);
	if (items.length === 0) {
		return {
			status: "error",
			message: `${planPath} has no parsable \`## Verifier Checklist\` with \`- [ ] \`VC-###\` ...\` items. Fix the plan before execution.`,
		};
	}
	const implItems = parseImplItems(planText);

	disableAutoComplete(ctx, "execution handoff");
	// I-004/D-019: PI_PLANS_AUTO_APPROVE=1 short-circuits the confirm BEFORE
	// any UI dispatch — the handoff is a plan-lifecycle gate (whitelisted).
	const autoApprove = isAutoApproveEnabled();
	if (!autoApprove && !ctx.hasUI) {
		return {
			status: "error",
			message:
				"The execution handoff requires explicit user approval and must never be auto-completed. Run interactively.",
		};
	}

	let approved: boolean;
	if (autoApprove) {
		approved = true;
	} else {
		const preview = items.map((item) => `- ${item.done ? "☑" : "☐"} ${item.id}`).join("\n");
		approved = await ctx.ui.confirm(
			"Execute this plan now?",
			`${planPath}\n${items.length} verifier item(s):\n${preview}\n\nExecution mode enables write access and tracks [DONE:VC-xxx] progress.`,
		);
	}
	if (!approved) {
		return { status: "declined", message: "User declined execution. Stay in planning; ask how to proceed.", planPath };
	}

	// Attribute the handoff to the picked run before any state transition so
	// the approval checkpoint and status flip land on the run the user chose.
	if (chosenRun) bindRun(ctx.sessionManager, workdir, chosenRun.run_id);

	// v0.6.0 (R-8): runtime question — current session (recommended) or a
	// delegated executor on another model. Skipped under auto-approve/no-UI.
	const runtime = await chooseExecutionRuntime(ctx, workdir, autoApprove, chosenRun);

	await startExecution(getCurrentApi(), ctx, planPath, items, implItems, { runtime, signal });
	const scopeNote = implItems.length ? ` Tracking ${implItems.length} implementation item(s).` : "";
	const autoNote = autoApprove ? "[auto-approve] " : "";
	const runtimeNote = runtime === "current-session" ? "" : ` Delegated to executor model ${runtime.modelSelector}; progress mirrors in the overlay.`;
	return {
		status: "executing",
		planPath,
		itemCount: items.length,
		message: `${autoNote}Execution approved. ${items.length} verifier item(s) queued; implement in dependency order and mark verified items with [DONE:VC-xxx].${scopeNote}${runtimeNote}`,
	};
}

const MODEL_SELECTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * R-8: ask where the execution runs. Uses ctx.ui.select directly (ask_choice
 * is a tool and cannot be invoked from tool/command context). Under
 * auto-approve or no-UI the question is skipped: current session, decision
 * recorded with the [auto-approve] annotation convention.
 */
async function chooseExecutionRuntime(
	ctx: ExtensionContext,
	workdir: string,
	autoApprove: boolean,
	chosenRun: RunSummary | null,
): Promise<ExecutionRuntime> {
	const record = (answer: string, source: "user" | "auto-complete", question: string, options: string[]): void => {
		const runId = chosenRun?.run_id ?? resolveActiveRun(ctx.sessionManager, workdir)?.run_id ?? null;
		if (!runId) return;
		try {
			recordDecision(workdir, runId, {
				question,
				options,
				answer,
				answer_source: source,
			});
		} catch {
			/* decision audit trail is best-effort */
		}
	};
	if (autoApprove || !ctx.hasUI) {
		record("current session [auto-approve]", "auto-complete", "Execution runtime", ["current session", "switch model"]);
		return "current-session";
	}
	const lang = resolveUiLanguage(workdir);
	const currentLabel = lang === "zh" ? "使用当前会话（推荐）" : "Use the current session (recommended)";
	const switchLabel = lang === "zh" ? "切换至其他模型…" : "Switch to another model…";
	const title = lang === "zh" ? "执行运行时" : "Execution runtime";
	const first = await ctx.ui.select(title, [currentLabel, switchLabel]);
	if (first === undefined || first === currentLabel) {
		record("current session", "user", "Execution runtime", [currentLabel, switchLabel]);
		return "current-session";
	}
	// Model picker: switch targets exclude the current selector by design
	// (option 1 IS the current session).
	const currentSelector = modelSelectorOf(ctx.model);
	const targets = collectModelSelectors(ctx, currentSelector);
	const otherLabel = lang === "zh" ? "其他（输入 provider/model）…" : "Other (type provider/model)…";
	const modelTitle = lang === "zh" ? "切换至哪个模型执行？" : "Switch to which model?";
	let modelPick = await ctx.ui.select(modelTitle, [...targets, otherLabel]);
	if (modelPick === otherLabel) {
		const typed = await ctx.ui.input(modelTitle, "provider/model");
		modelPick = typed && MODEL_SELECTOR_RE.test(typed.trim()) ? typed.trim() : undefined;
	}
	if (modelPick === undefined || !MODEL_SELECTOR_RE.test(modelPick)) {
		// Cancelled or invalid: fall back to the current session, recorded.
		record("current session (model switch cancelled)", "user", "Execution runtime", [currentLabel, switchLabel]);
		return "current-session";
	}
	record(`switch model: ${modelPick}`, "user", "Execution runtime", [currentLabel, switchLabel, ...targets, otherLabel]);
	return { modelSelector: modelPick };
}

/** The user command may resume an approved execution; the tool always asks. */
export async function executeCommand(ctx: ExtensionContext, planPathArg?: string): Promise<HandoffOutcome> {
	const activeExecution = getExecution();
	const planPath = planPathArg ? path.resolve(ctx.cwd, planPathArg.replace(/^@/, "")) : activeExecution?.planPath;
	if (activeExecution && planPath && path.resolve(activeExecution.planPath) === path.resolve(planPath)) {
		const resumed = resumeActiveExecution(getCurrentApi(), ctx);
		return {
			status: "executing",
			planPath,
			itemCount: activeExecution.items.length,
			message: resumed ? "Execution resumed; verified progress preserved." : "This plan is already executing.",
		};
	}
	return executeHandoff(ctx, planPathArg);
}

// The tool registers with the ExtensionAPI in scope; keep a module-level
// reference so the shared handoff helper can reach appendEntry/sendMessage.
let currentApi: ExtensionAPI | null = null;
export function setCurrentApi(api: ExtensionAPI): void {
	currentApi = api;
}
function getCurrentApi(): ExtensionAPI {
	if (!currentApi) throw new Error("execute_plan used before extension initialization");
	return currentApi;
}

export function registerExecutePlanTool(pi: ExtensionAPI): void {
	setCurrentApi(pi);
	pi.registerTool({
		name: "execute_plan",
		label: "Execute Plan",
		description:
			"Execution handoff for an accepted plan. Asks the user for explicit approval (never auto-completed), then asks which runtime executes the plan — the current session (recommended) or a delegated executor subagent on another model (>=3 switch targets listed; the child writes natively and reports [DONE:VC-xxx] markers the parent tracks). Either way the extension tracks Verifier-Checklist progress. When several runs with plans exist, a run-picker form selects the target run first. Only call after the user chose 'Execute this plan now' at the handoff question.",
		promptSnippet: "Hand an accepted plan off to the tracked execution loop",
		parameters: ExecutePlanParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outcome = await executeHandoff(ctx, params.planPath, params.workdir, signal);
			if (outcome.status === "error") throw new Error(outcome.message);
			return {
				content: [{ type: "text", text: outcome.message }],
				details: outcome,
			};
		},

		renderCall(args, theme) {
			const short = args.planPath ? args.planPath.split("/").pop() : "latest accepted plan";
			return new Text(
				theme.fg("toolTitle", theme.bold("execute_plan ")) + theme.fg("accent", short ?? ""),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			return new Text(theme.fg("success", "🚀 ") + theme.fg("muted", raw.slice(0, 160)), 0, 0);
		},
	});
}
