/**
 * pi-plans — human-in-the-loop planning for the Pi coding agent.
 *
 * Researched, refined Markdown plans before any code changes. The five
 * planning skills are contributed via resources_discover; the extension
 * provides the supporting machinery:
 *
 *   - `plans` tool      — workspace state (config, runs, ledgers) in .git/pi_plans/
 *   - `ask_choice` tool — the choice-prompt contract (Other / Auto-complete rules)
 *   - `refine` tool     — reviewer/criticizer rounds via read-only pi subagents
 *   - `execute_plan`    — execution handoff into the tracked execution loop
 *   - write guard       — planning runs may only write planning artifacts
 *   - execution loop    — checklist injection, [DONE:VC-xxx] tracking, progress widget
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyDoneMarkers,
	completeExecution,
	consumePendingPanelSync,
	executionContextMessage,
	getExecution,
	isExecutionComplete,
	recordExecutionCompletion,
	recordTouchedPaths,
	restoreFromSession,
	stopExecution,
	syncExecutionPanel,
	toggleExecutionPanelView,
	updateStatusWidget,
} from "./src/exec.ts";
import { planningWriteBlockReason } from "./src/guard.ts";
import { latestPlanVersion, nextPlanVersionPath } from "./src/plan.ts";
import { getRun, readActive, recordDecision, resolveStateRootOrNull, setRunStatus } from "./src/state.ts";
import { registerAskChoiceTool } from "./tools/ask-choice.ts";
import { executeHandoff, registerExecutePlanTool } from "./tools/execute-plan.ts";
import { registerPlansTool } from "./tools/plans.ts";
import { registerRefineTool } from "./tools/refine.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));

function extractPathsFromBash(command: string): string[] {
	const values = new Set<string>();
	for (const token of command.split(/\s+/)) {
		const cleaned = token.replace(/^["'`(<[{]+|["'`)>}\],;]+$/g, "");
		if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.startsWith("-") || cleaned.includes("=") ) continue;
		const looksLikePath =
			cleaned.includes("/") ||
			cleaned.startsWith(".") ||
			cleaned.startsWith("~") ||
			/^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(cleaned);
		if (!looksLikePath) continue;
		values.add(cleaned);
	}
	return [...values];
}

export default function piPlansExtension(pi: ExtensionAPI): void {
	registerPlansTool(pi);
	registerAskChoiceTool(pi);
	registerRefineTool(pi, baseDir);
	registerExecutePlanTool(pi);

	// Contribute the router skill plus the five specialist planning skills.
	pi.on("resources_discover", () => ({
		skillPaths: [
			join(baseDir, "skills", "planning"),
			join(baseDir, "skills", "debug-and-plan"),
			join(baseDir, "skills", "plan-small"),
			join(baseDir, "skills", "plan-normal"),
			join(baseDir, "skills", "plan-big"),
			join(baseDir, "skills", "plan-with-refs"),
		],
	}));

	// Direct slash aliases: /plan-small etc. forward to the skill commands
	// (/skill:plan-small) so users can invoke skills without the prefix.
	for (const name of [
		"planning",
		"debug-and-plan",
		"plan-small",
		"plan-normal",
		"plan-big",
		"plan-with-refs",
	]) {
		pi.registerCommand(name, {
			description: `Run the ${name} planning skill (alias of /skill:${name})`,
			handler: async (args, ctx) => {
				const invocation = args.trim() ? `/skill:${name} ${args.trim()}` : `/skill:${name}`;
				try {
					pi.sendUserMessage(invocation, { expandPromptTemplates: true });
				} catch {
					ctx.ui.notify("Agent is busy; try again once the current turn finishes.", "error");
				}
			},
		});
	}

	// -----------------------------------------------------------------------
	// Planning write guard: while a planning run is active (and execution has
	// not been approved), edit/write may only target planning artifacts.
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		const execution = getExecution();
		if (execution) {
			if (event.toolName === "edit" || event.toolName === "write") {
				const rawPath = String((event.input as { path?: string }).path ?? "");
				if (rawPath) recordTouchedPaths(ctx.cwd, [rawPath]);
			}
			if (event.toolName === "bash") {
				const command = String((event.input as { command?: string }).command ?? "");
				if (command) recordTouchedPaths(ctx.cwd, extractPathsFromBash(command));
			}
			return;
		}
		const rawPath = String((event.input as { path?: string }).path ?? "");
		if (!rawPath) return;
		const reason = planningWriteBlockReason({ workdir: ctx.cwd, toolName: event.toolName, rawPath });
		if (!reason) return;
		return { block: true, reason };
	});

	// -----------------------------------------------------------------------
	// Execution loop: inject remaining checklist each turn, track markers.
	// -----------------------------------------------------------------------
	pi.on("before_agent_start", async () => {
		const content = executionContextMessage();
		if (!content) return;
		return {
			message: {
				customType: "pi-plans-exec-context",
				content,
				display: false,
			},
		};
	});

	// The turn_end projection does not carry usage; message_end delivers the
	// full assistant message, so we cache it there and consume it per turn.
	let lastAssistantUsage: { input: number; output: number } | null = null;
	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: { input?: number; output?: number } };
		if (message?.role === "assistant" && message.usage) {
			lastAssistantUsage = { input: message.usage.input ?? 0, output: message.usage.output ?? 0 };
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (!message || message.role !== "assistant") {
			updateStatusWidget(ctx);
			return;
		}
		const text = (message.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		const changedIds = applyDoneMarkers(text);
		if (changedIds.length > 0) {
			// Attribute this turn's token usage to the finished items.
			const projection = (event.message as { usage?: { input?: number; output?: number } }).usage;
			const raw = projection ?? lastAssistantUsage;
			lastAssistantUsage = null; // consumed: never re-attribute a stale turn
			const usage = raw ? { input: raw.input ?? 0, output: raw.output ?? 0 } : undefined;
			recordExecutionCompletion(pi, ctx, changedIds, usage);
		}
		if (getExecution() && isExecutionComplete()) {
			completeExecution(pi, ctx);
		}
		// A busy-toggle during the previous turn deferred its re-render; the
		// turn just ended, so this is the safe point to apply it.
		if (consumePendingPanelSync()) syncExecutionPanel(ctx);
		updateStatusWidget(ctx);
	});

	// -----------------------------------------------------------------------
	// Commands and shortcuts
	// -----------------------------------------------------------------------
	pi.registerShortcut("alt+o", {
		description: "Toggle pi-plans execution checklist widget",
		handler: async (ctx) => {
			const expanded = toggleExecutionPanelView(pi, ctx);
			if (expanded === null) {
				ctx.ui.notify("No execution in progress.", "info");
				return;
			}
			ctx.ui.notify(expanded ? "Execution checklist expanded." : "Execution checklist collapsed.", "info");
		},
	});

	pi.registerCommand("plans", {
		description: "Show pi-plans state: config, active run, and execution progress",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			const active = readActive(ctx.cwd);
			const run = active ? getRun(ctx.cwd, active.run_id) : null;
			if (!run) {
				lines.push("No active planning run.");
			} else {
				lines.push(`Active run: ${run.run_id}`);
				lines.push(`Skill: ${run.skill}  Status: ${run.status}`);
				lines.push(`Artifacts: ${run.artifact_dir}`);
				lines.push(`Language: ${run.language_tag ?? "(unset)"}`);
				lines.push(`State: ${resolveStateRootOrNull(ctx.cwd) ?? "(no repo)"}`);
			}
			const execution = getExecution();
			if (execution) {
				const done = execution.items.filter((item) => item.done).length;
				lines.push(`Execution: ${execution.planPath} — ${done}/${execution.items.length} verifier items done`);
				for (const item of execution.items) {
					lines.push(`  ${item.done ? "☑" : "☐"} ${item.id}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("plans-list", {
		description: "Toggle the pi-plans execution checklist widget",
		handler: async (_args, ctx) => {
			const expanded = toggleExecutionPanelView(pi, ctx);
			if (expanded === null) {
				ctx.ui.notify("No execution in progress.", "info");
				return;
			}
			ctx.ui.notify(expanded ? "Execution checklist expanded." : "Execution checklist collapsed.", "info");
		},
	});

	pi.registerCommand("plans-execute", {
		description: "Execute handoff: enter tracked execution mode for an accepted plan",
		handler: async (args, ctx) => {
			const planPath = args.trim() || undefined;
			const outcome = await executeHandoff(ctx, planPath);
			ctx.ui.notify(outcome.message, outcome.status === "error" ? "error" : "info");
		},
	});

	pi.registerCommand("update-plan", {
		description: "Interrupt-and-refine: stop execution (if any) and revise the current plan into its next version",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/update-plan requires an interactive session.", "error");
				return;
			}

			// Parse args: optional plan.md path first, remaining text is the refocus reason.
			let planArg: string | undefined;
			let focus = "";
			const trimmed = args.trim();
			if (trimmed) {
				const [first, ...rest] = trimmed.split(/\s+/);
				if (first && (/\.(md|markdown)$/i.test(first) || first.includes("/") || first.startsWith("@"))) {
					planArg = first;
					focus = rest.join(" ");
				} else {
					focus = trimmed;
				}
			}

			const active = readActive(ctx.cwd);
			const execution = getExecution();

			// Resolve the plan to revise: explicit arg > running execution > latest in artifact dir.
			let sourcePlanPath: string | null = planArg
				? path.resolve(ctx.cwd, planArg.replace(/^@/, ""))
				: null;
			if (!sourcePlanPath && execution) sourcePlanPath = execution.planPath;
			if (!sourcePlanPath && active) sourcePlanPath = latestPlanVersion(active.artifact_dir)?.path ?? null;
			if (!sourcePlanPath || !fs.existsSync(sourcePlanPath)) {
				ctx.ui.notify(
					sourcePlanPath ? `Plan file not found: ${sourcePlanPath}` : "No plan to update. Pass plan.md or start a run first.",
					"error",
				);
				return;
			}

			const artifactDir = active?.artifact_dir ?? path.dirname(sourcePlanPath);
			const next = nextPlanVersionPath(artifactDir);

			// Snapshot progress BEFORE stopping so the revision preserves finished work.
			const doneIds = execution ? execution.items.filter((item) => item.done).map((item) => item.id) : [];
			const pendingIds = execution ? execution.items.filter((item) => !item.done).map((item) => item.id) : [];

			if (execution) {
				const ok = await ctx.ui.confirm(
					"Stop execution to update the plan?",
					`${doneIds.length}/${execution.items.length} verifier item(s) already verified; their work stays. Remaining items return to planning.`,
				);
				if (!ok) return;
				stopExecution(pi, ctx, "interrupted by /update-plan");
			}

			// Return the run to planning so refinement rules and guards apply again.
			if (active) {
				const run = getRun(ctx.cwd, active.run_id);
				if (run && run.status !== "planning" && run.status !== "abandoned" && run.status !== "done") {
					try {
						setRunStatus(ctx.cwd, active.run_id, "planning");
					} catch {
						/* status bookkeeping is best-effort */
					}
				}
				try {
					recordDecision(ctx.cwd, active.run_id, {
						question: "/update-plan requested",
						options: ["stop execution and refine current plan"],
						answer: focus ? `refocus: ${focus}` : "stop execution and refine current plan",
						answer_source: "user",
						artifact: next.path,
					});
				} catch {
					/* best-effort audit trail */
				}
			}

			const run = active ? getRun(ctx.cwd, active.run_id) : null;
			const lines: string[] = [
				"[PI-PLANS UPDATE] Revise the accepted plan for user-directed changes.",
				"",
				`Current plan: ${sourcePlanPath}`,
				`Write the revised version as: ${next.path}`,
				`Update the Status header and Plan version fields; keep every stable ID (G/R/I/C/VC-###); never recycle IDs of completed items; append to the Revision Ledger.`,
			];
			if (run) lines.push(``, `Run: ${run.run_id} (skill: ${run.skill})`, `Original request: ${run.request_text}`);
			if (doneIds.length) {
				lines.push(`Already verified during execution (preserve their scope unless the user says otherwise): ${doneIds.join(", ")}`);
			}
			if (pendingIds.length) lines.push(`Not yet verified: ${pendingIds.join(", ")}`);
			lines.push(
				"Execution was interrupted on purpose — do not continue implementing until the revised plan is approved again.",
			);
			if (focus) lines.push(`User-reported problems / refocus: ${focus}`);
			lines.push(
				"",
				"Follow the original planning-skill contract for revisions: collect needed clarifications via ask_choice (one question at a time, recorded), apply evidence-based revisions only, then ask the next merged accept/execute question (autoComplete: false — ✓ Accept & execute now / Accept, don't execute yet / another round) and call execute_plan pointing at the new version on accept.",
			);

			await pi.sendUserMessage(lines.join("\n"));
		},
	});

	pi.registerCommand("plans-stop", {
		description: "Stop plan execution mode (plan artifacts are kept)",
		handler: async (_args, ctx) => {
			if (!getExecution()) {
				ctx.ui.notify("No execution in progress.", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Stop execution?", "Remaining verifier items will be left unfinished.");
			if (!ok) return;
			stopExecution(pi, ctx, "stopped by user via /plans-stop");
			ctx.ui.notify("Execution stopped.", "info");
		},
	});

	pi.registerCommand("plans-abandon", {
		description: "Abandon the active planning run (lifts the read-only guard; artifacts are kept)",
		handler: async (_args, ctx) => {
			const active = readActive(ctx.cwd);
			if (!active) {
				ctx.ui.notify("No active planning run.", "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Abandon planning run?",
				`${active.run_id}\nThe read-only guard lifts; committed artifacts stay in place.`,
			);
			if (!ok) return;
			try {
				setRunStatus(ctx.cwd, active.run_id, "abandoned");
				ctx.ui.notify(`Run ${active.run_id} abandoned.`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed: ${(error as Error).message}`, "error");
			}
			updateStatusWidget(ctx);
		},
	});

	// -----------------------------------------------------------------------
	// Session lifecycle
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		restoreFromSession(pi, ctx, ctx.sessionManager.getEntries() as unknown as Parameters<typeof restoreFromSession>[2]);
	});
}
