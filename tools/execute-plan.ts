/**
 * `execute_plan` tool — the execution handoff (v0.6.1). On explicit user
 * approval (no Auto-complete) the extension enters task-tree execution mode:
 * progress flows through `plans_update_task`, the dashboard tracks every
 * task, and the execution reviewer gates the final pass. Legacy I-### plans
 * parse through the fallback with an upgrade notice.
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
} from "../src/exec.ts";
import { disableAutoComplete } from "../src/autocomplete.ts";
import { isAutoApproveEnabled } from "../src/auto-approve.ts";
import { checklistHeaderName, latestPlanVersion, lintPlanTasks, parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { latestHugePlan, hugePlanFileName, parseHugePlanPath, type HugePlanFile } from "../src/huge-plan.ts";
import { loadCheckpoint } from "../src/workflow-state.ts";
import { getRun, normalizeWorkdir, type RunSummary } from "../src/state.ts";
import { bindRun, boundRunId, resolveActiveRun } from "../src/run-context.ts";
import { executionCandidates, resolveCommandRun } from "../src/run-picker.ts";
import { resolveUiLanguage } from "../src/ui-language.ts";
import { askExecutionMode, type ExecModeHost } from "../src/exec-mode-picker.ts";
import { executorLabel, isDelegated, type ExecutorChoice } from "../src/executor-config.ts";
import { loadGlobalConfig } from "../src/global-state.ts";


const ExecutePlanParams = Type.Object({
	planPath: Type.Optional(
		Type.String({
			description:
				"Path to the accepted plan. Default: the current version stream's latest round for a huge run, else the active run's highest PLAN_vN.md.",
		}),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

export interface HandoffOutcome {
	status: "executing" | "declined" | "error";
	planPath?: string;
	itemCount?: number;
	message: string;
}

/** plan-huge: the run the session is bound to (or the active run) when it
 * carries a huge checkpoint. */
function hugeRunOf(
	workdir: string,
	sessionManager: unknown,
): { runId: string; artifactDir: string; run: RunSummary; huge: NonNullable<ReturnType<typeof loadCheckpoint>["checkpoint"]>["huge"] } | null {
	const runId = boundRunId(sessionManager, workdir) ?? resolveActiveRun(sessionManager, workdir)?.run_id ?? null;
	if (!runId) return null;
	const info = getRun(workdir, runId);
	if (!info) return null;
	const load = loadCheckpoint(workdir, runId);
	if (load.status !== "ok" || !load.checkpoint.huge) return null;
	const run: RunSummary = {
		run_id: info.run_id,
		topic: info.topic,
		skill: info.skill,
		status: info.status,
		created_at: info.created_at,
		updated_at: info.updated_at,
		artifact_dir: info.artifact_dir,
	};
	return { runId, artifactDir: info.artifact_dir, run, huge: load.checkpoint.huge };
}

/** plan-huge: latest plan of the checkpoint's current version stream. */
export function currentHugeVersionPlan(artifactDir: string, huge: { versions: Array<{ label: string; status: string }>; currentIndex: number }): HugePlanFile | null {
	const current = huge.versions[huge.currentIndex];
	if (!current) return null;
	return latestHugePlan(artifactDir, current.label);
}

/** plan-huge: refuse overall plans, stale rounds and completed versions —
 * before any approval or state change. Returns an error message or null. */
function hugeExecutionGate(
	workdir: string,
	sessionManager: unknown,
	planPath: string,
): string | null {
	const parsed = parseHugePlanPath(planPath);
	if (!parsed) return null;
	const huge = hugeRunOf(workdir, sessionManager);
	if (parsed.kind === "overall") {
		const current = huge ? currentHugeVersionPlan(huge.artifactDir, huge.huge) : null;
		return `\`PLAN_overall_vN.md\` is a planning artifact and is never executable — execute the current version plan (当前版本计划) instead${current ? `: \`${current.path}\`` : "; plan the first version first"}.`;
	}
	if (!huge) {
		return `${planPath} is a huge version plan, but the resolved run has no \`huge\` checkpoint state. Start or resume the run that owns this plan.`;
	}
	const current = huge.huge.versions[huge.huge.currentIndex];
	if (!current) return `the run has no current version to execute`;
	if (parsed.stream !== current.label) {
		return `\`${parsed.stream}\` is not the current version of this run (current: ${current.label}); plan the current version instead.`;
	}
	if (current.status === "done") {
		return `version ${current.label} is already complete; plan the next version instead.`;
	}
	const latest = latestHugePlan(huge.artifactDir, current.label);
	if (latest && parsed.round < latest.round) {
		return `\`${planPath}\` is a stale round of ${current.label} (latest: v${latest.round}); execute the latest round.`;
	}
	return null;
}

/** Shared handoff logic for the execute_plan tool and /plans-execute command. */
export async function executeHandoff(
	ctx: ExtensionContext,
	planPathArg?: string,
	workdirArg?: string,
	_signal?: AbortSignal,
): Promise<HandoffOutcome> {
	const workdir = normalizeWorkdir(workdirArg ?? ctx.cwd);

	let planPath: string | null = null;
	let chosenRun: RunSummary | null = null;
	if (planPathArg) {
		planPath = path.resolve(workdir, planPathArg.replace(/^@/, ""));
	} else {
		// plan-huge: a bound/active huge run resolves its CURRENT version's
		// latest round directly — the overall plan is never a candidate.
		const huge = hugeRunOf(workdir, ctx.sessionManager);
		if (huge) {
			const hugePlan = currentHugeVersionPlan(huge.artifactDir, huge.huge);
			if (!hugePlan) {
				const current = huge.huge.versions[huge.huge.currentIndex];
				const expected = hugePlanFileName(current?.label ?? "v0.1.0", (current?.round ?? 0) + 1);
				return {
					status: "error",
					message: `No version plan found for the current version${current ? ` ${current.label}` : ""} in ${huge.artifactDir}; write ${expected} first (the overall plan is never executable).`,
				};
			}
			chosenRun = huge.run;
			planPath = hugePlan.path;
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
	}
	if (!fs.existsSync(planPath)) {
		return { status: "error", message: `Plan file not found: ${planPath}` };
	}

	// plan-huge gate: refuse the overall plan and out-of-stream/stale rounds
	// before any parsing, approval prompt or state change.
	const hugeGate = hugeExecutionGate(workdir, ctx.sessionManager, planPath);
	if (hugeGate) {
		return { status: "error", message: hugeGate };
	}

	const planText = fs.readFileSync(planPath, "utf8");
	const items = parseChecklist(planText);
	if (items.length === 0) {
		return {
			status: "error",
			message: `${planPath} has no parsable \`## Verification Checks\` (or legacy \`## Verifier Checklist\`) with \`- [ ] \`VC-###\` ...\` items. Fix the plan before execution.`,
		};
	}
	const planTasks = parsePlanTasks(planText);
	if (planTasks.tasks.length === 0) {
		return {
			status: "error",
			message: `${planPath} has no parsable tasks: add a \`## Tasks\` section (\`- \`Task-1\`: title — deps: …; files: …; wave: 1\`).`,
		};
	}
	// I-001/R-001: task-tree consistency is advisory while planning and
	// hard-rejected at this gate. Legacy I-### fallback plans are exempt
	// (their shape predates the microsyntax).
	if (!planTasks.legacy) {
		const lint = lintPlanTasks(planText);
		if (lint !== null) {
			return {
				status: "error",
				message: `${planPath} failed the task-tree consistency gate; fix these before execution:\n${lint}`,
			};
		}
	}

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

	const legacyPlan = planTasks.legacy || checklistHeaderName(planText) === "Verifier Checklist";

	let approved: boolean;
	if (autoApprove) {
		approved = true;
	} else {
		const lang = resolveUiLanguage(workdir);
		const preview = items.map((item) => `- ${item.done ? "☑" : "☐"} ${item.id}`).join("\n");
		const legacyNote = legacyPlan
			? (lang === "zh"
				? "\n\n注意：该计划使用旧版 I-### 格式，将以兼容映射执行；建议在下次修订时升级为 ## Tasks 新格式。"
				: "\n\nNote: this plan uses the legacy I-### format and executes through the compatibility mapping; upgrade it to the ## Tasks format at the next revision.")
			: "";
		approved = await ctx.ui.confirm(
			"Execute this plan now?",
			`${planPath}\n${items.length} verification check(s) over ${planTasks.tasks.length} task(s):\n${preview}${legacyNote}\n\nExecution mode enables write access; task progress is reported with the plans_update_task tool and gated by the execution reviewer.`,
		);
	}
	if (!approved) {
		return { status: "declined", message: "User declined execution. Stay in planning; ask how to proceed.", planPath };
	}

	// Where the plan runs: the current session (same model) or delegated
	// workers on a model/effort the user picks. Headless and auto-approved
	// handoffs have nobody to ask and always use the current session.
	let executor: ExecutorChoice | undefined;
	if (!autoApprove && ctx.hasUI) {
		let last: ExecutorChoice | null = null;
		try {
			last = loadGlobalConfig().config.executor_last ?? null;
		} catch {
			last = null;
		}
		const picked = await askExecutionMode(ctx as unknown as ExecModeHost, { lang: resolveUiLanguage(workdir), last });
		if (picked.status === "cancelled") {
			return {
				status: "declined",
				message: "User closed the execution-mode choice without picking. Stay in planning; ask how to proceed.",
				planPath,
			};
		}
		executor = picked.choice;
	}

	// Attribute the handoff to the picked run before any state transition so
	// the approval checkpoint and status flip land on the run the user chose.
	if (chosenRun) bindRun(ctx.sessionManager, workdir, chosenRun.run_id);

	const started = await startExecution(ctx, { planPath, planTasks, items, executor });
	// v0.9.4: a terminal run (done/abandoned) is refused inside `startExecution`
	// before any state change; report that refusal instead of claiming success.
	if (!started) {
		return {
			status: "error",
			planPath,
			message:
				"Execution refused: the resolved run is terminal (done or abandoned). A terminated run cannot be executed again — start a new run with the planning skills.",
		};
	}
	const autoNote = autoApprove ? "[auto-approve] " : "";
	const legacyNote = legacyPlan ? " Legacy I-### mapping active; upgrade the plan at the next revision." : "";
	if (isDelegated(executor)) {
		return {
			status: "executing",
			planPath,
			itemCount: items.length,
			message: `Execution approved and delegated to ${executorLabel(executor)}. ${planTasks.tasks.length} task(s) run in wave order on worker sessions that report progress on their own; do NOT implement the tasks yourself and do not call plans_update_task. Press Down with an empty editor to watch the workers. The execution reviewer verifies every check once all tasks are terminal.${legacyPlan ? " Legacy I-### mapping active; upgrade the plan at the next revision." : ""}`,
		};
	}
	return {
		status: "executing",
		planPath,
		itemCount: items.length,
		message: `${autoNote}Execution approved. ${planTasks.tasks.length} task(s) queued in wave order; report progress with the plans_update_task tool (status + evidence); the execution reviewer verifies every check before the run completes.${legacyNote}`,
	};
}

/** The user command may resume an approved execution; the tool always asks. */
export async function executeCommand(ctx: ExtensionContext, planPathArg?: string): Promise<HandoffOutcome> {
	const activeExecution = getExecution();
	const planPath = planPathArg ? path.resolve(ctx.cwd, planPathArg.replace(/^@/, "")) : activeExecution?.planPath;
	if (activeExecution && planPath && path.resolve(activeExecution.planPath) === path.resolve(planPath)) {
		// v0.9.3: the resume is async because a review-pause grant re-opens the
		// budget picker; the message below is produced AFTER that menu resolves.
		const resumed = await resumeActiveExecution(ctx);
		// v0.8 phase-aware response: a verifying run continues its review loop
		// (this tool is also the ONLY budget-granting surface at a review pause).
		const statusText = activeExecution.review?.inFlight
			? "Execution review in progress (status verifying); the reviewer round runs in the overlay."
			: (getExecution()?.stall.paused ?? false)
				? "Execution review paused — run /plans-execute and pick a round budget to continue."
				: resumed.grantedBudget !== undefined
					? `Review budget granted (${resumed.grantedBudget === "unlimited" ? "unlimited" : `${resumed.grantedBudget} rounds`}); the review resumes now.`
					: "Execution resumed; task progress preserved.";
		const declined = resumed.budgetDeclined === true;
		return {
			status: "executing",
			planPath,
			itemCount: activeExecution.items.length,
			message: declined
				? "Review budget unchanged — the run stays paused. Call /plans-execute again and pick a round count to continue."
				: resumed.resumed ? statusText : "This plan is already executing.",
		};
	}
	return executeHandoff(ctx, planPathArg);
}

export function registerExecutePlanTool(ext: ExtensionAPI): void {
	ext.registerTool({
		name: "execute_plan",
		label: "Execute Plan",
		description:
			"Execution handoff for an accepted plan. Asks the user for explicit approval (never auto-completed), then asks where the plan runs (the current session, or one or several delegated worker subagents on a model and effort the user picks — when delegated, the workers report progress themselves and the main session must not implement the tasks), then enters task-tree execution mode: every task's progress is reported via the plans_update_task tool (status + evidence), the task dashboard tracks the tree (Ctrl+Shift+T expands it), and an independent execution reviewer verifies the verification checks before the run completes. Legacy I-### plans parse through the compatibility mapping with an upgrade notice. When several runs with plans exist, a run-picker form selects the target run first. Only call after the user chose 'Execute this plan now' at the handoff question.",
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
