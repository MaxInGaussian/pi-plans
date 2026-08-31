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
	startExecution,
} from "../src/exec.ts";
import { disableAutoComplete } from "../src/autocomplete.ts";
import { latestPlanVersion, parseChecklist, parseImplItems } from "../src/plan.ts";
import { normalizeWorkdir, readActive } from "../src/state.ts";


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
): Promise<HandoffOutcome> {
	const workdir = normalizeWorkdir(workdirArg ?? ctx.cwd);

	let planPath: string | null = null;
	if (planPathArg) {
		planPath = path.resolve(workdir, planPathArg.replace(/^@/, ""));
	} else {
		const active = readActive(workdir);
		if (!active) {
			return {
				status: "error",
				message: "No plan path given and no active planning run found. Pass planPath or start a run first.",
			};
		}
		const latest = latestPlanVersion(active.artifact_dir);
		if (!latest) {
			return { status: "error", message: `No PLAN_vN.md found in ${active.artifact_dir}` };
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
	if (!ctx.hasUI) {
		return {
			status: "error",
			message:
				"The execution handoff requires explicit user approval and must never be auto-completed. Run interactively.",
		};
	}

	const preview = items.map((item) => `- ${item.done ? "☑" : "☐"} ${item.id}`).join("\n");
	const approved = await ctx.ui.confirm(
		"Execute this plan now?",
		`${planPath}\n${items.length} verifier item(s):\n${preview}\n\nExecution mode enables write access and tracks [DONE:VC-xxx] progress.`,
	);
	if (!approved) {
		return { status: "declined", message: "User declined execution. Stay in planning; ask how to proceed.", planPath };
	}

	await startExecution(getCurrentApi(), ctx, planPath, items, implItems);
	const scopeNote = implItems.length ? ` Tracking ${implItems.length} implementation item(s).` : "";
	return {
		status: "executing",
		planPath,
		itemCount: items.length,
		message: `Execution approved. ${items.length} verifier item(s) queued; implement in dependency order and mark verified items with [DONE:VC-xxx].${scopeNote}`,
	};
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
			"Execution handoff for an accepted plan. Asks the user for explicit approval (never auto-completed), then enters plan-execution mode: the extension injects the remaining Verifier Checklist every turn, tracks [DONE:VC-xxx] markers, and completes when every item passes. Only call after the user chose 'Execute this plan now' at the handoff question.",
		promptSnippet: "Hand an accepted plan off to the tracked execution loop",
		parameters: ExecutePlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const outcome = await executeHandoff(ctx, params.planPath, params.workdir);
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
