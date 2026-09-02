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
 *   - execution loop    — checklist injection, [DONE:VC-xxx] tracking, progress status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	consumePlanningCompactionResumeGuard,
	drainExecutionFlush,
	executionContextMessage,
	filterExecutionResumeMessages,
	filterPlanningResumeMessages,
	getExecution,
	handleExecutionBeforeCompact,
	handleExecutionCompact,
	handleExecutionCompactFailed,
	handleExecutionTurnCompaction,
	handlePlanningBeforeCompact,
	handlePlanningCompact,
	handlePlanningCompactFailed,
	noteCompactionEnded,
	noteCompactionStarted,
	PLANNING_PLAN_WRITTEN_CUSTOM_TYPE,
	registerExecutionTurnHandlers,
	refreshPlanningCompactionCooldown,
	requestPlanningCompaction,
	restoreFromSession,
	stopExecution,
	updateStatusWidget,
	shouldTriggerPlanningCompaction,
} from "./src/exec.ts";
import {
	autoCompleteStatus,
	disableAutoComplete,
	markPlanWritten,
	registerAutoCompleteTurnHandlers,
	restoreAutoCompleteFromSession,
} from "./src/autocomplete.ts";
import { planningWriteBlockReason } from "./src/guard.ts";
import { registerQueryInterviewHooks } from "./src/query-hook.ts";
import { registerCodeGraphTool } from "./tools/code-graph.ts";
import {
	initGraphCommand,
	applyGraphCommand,
	graphStatusCommand,
	updateGraphCommand,
	graphDriftCommand,
	enableGraphCommand,
	disableGraphCommand,
} from "./src/code-graph/commands.ts";
import { latestPlanVersion, nextPlanVersionPath } from "./src/plan.ts";
import { getRun, loadConfig, readActive, recordDecision, resolveStateRootOrNull, setRunStatus } from "./src/state.ts";
import { registerAskChoiceTool } from "./tools/ask-choice.ts";
import { executeHandoff, registerExecutePlanTool } from "./tools/execute-plan.ts";
import { registerPlansTool } from "./tools/plans.ts";
import { registerRefineTool } from "./tools/refine.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));

// When THIS copy of the extension was imported into the running pi process.
// /plans compares it against the newest source-file mtime so a stale instance
// (code on disk newer than the loaded copy) is immediately visible.
const extensionLoadedAt = new Date();

function extensionStalenessLine(): string {
	try {
		const dirs = [baseDir, path.join(baseDir, "src"), path.join(baseDir, "tools")];
		const stack: string[] = [...dirs];
		let newest = 0;
		while (stack.length) {
			const dir = stack.pop()!;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) stack.push(full);
				else if (entry.isFile() && entry.name.endsWith(".ts")) {
					const mtime = fs.statSync(full).mtimeMs;
					if (mtime > newest) newest = mtime;
				}
			}
		}
		if (newest > extensionLoadedAt.getTime() + 2000) {
			return `⚠ extension code on disk is newer than the loaded copy (loaded ${extensionLoadedAt.toISOString()}); run /reload to pick it up`;
		}
		return `Extension loaded: ${extensionLoadedAt.toISOString()} (up to date)`;
	} catch {
		return `Extension loaded: ${extensionLoadedAt.toISOString()}`;
	}
}

function hasActivePlanningWorkflow(ctx: Parameters<typeof updateStatusWidget>[0]): boolean {
	if (getExecution()) return true;
	const active = readActive(ctx.cwd);
	if (!active) return false;
	const status = getRun(ctx.cwd, active.run_id)?.status;
	return status === "planning" || status === "accepted" || status === "executing";
}

export default function piPlansExtension(pi: ExtensionAPI): void {
	registerPlansTool(pi);
	registerAskChoiceTool(pi);
	registerRefineTool(pi, baseDir);
	registerExecutePlanTool(pi);
	registerQueryInterviewHooks(pi, hasActivePlanningWorkflow);
	registerCodeGraphTool(pi);

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
		if (getExecution()) return;
		const rawPath = String((event.input as { path?: string }).path ?? "");
		if (!rawPath) return;
		const reason = planningWriteBlockReason({ workdir: ctx.cwd, toolName: event.toolName, rawPath });
		if (reason) return { block: true, reason };
		// Allowed write: if it lands exactly on the run's latest plan file, drop a
		// marker entry so planning-phase compaction can anchor its cut point there.
		if (event.toolName === "write" || event.toolName === "edit") {
			const active = readActive(ctx.cwd);
			if (active) {
				const latest = latestPlanVersion(active.artifact_dir);
				if (latest && path.resolve(ctx.cwd, rawPath) === path.resolve(ctx.cwd, latest.path)) {
					pi.appendEntry(PLANNING_PLAN_WRITTEN_CUSTOM_TYPE, {
						runId: active.run_id,
						planPath: latest.path,
					});
					markPlanWritten(ctx);
				}
			}
		}
		return;
	});

	// Bidirectional code-graph reminder hook: separate from the planning guard
	// above (which early-returns during execution). Fires only when the graph
	// is enabled and an execution is active. Reminders are best-effort notifies.
	pi.on("tool_call", async (event, ctx) => {
		if (!getExecution()) return;
		const stateRoot = resolveStateRootOrNull(ctx.cwd);
		if (!stateRoot) return;
		let graphEnabled = false;
		try {
			graphEnabled = loadConfig(stateRoot).graph_enabled === true;
		} catch {
			return;
		}
		if (!graphEnabled) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			ctx.ui?.notify?.("code-graph: source edited directly — run /update-graph to sync the graph, or use code_graph mutations + /apply-graph for DB-first edits", "info");
			return;
		}
		if (event.toolName === "code_graph") {
			const action = String((event.input as { action?: string }).action ?? "");
			if (action === "update-function" || action === "update-file" || action === "delete-file") {
				ctx.ui?.notify?.("code-graph: mutation staged — run /apply-graph to materialize, then /graph-drift to verify", "info");
			}
		}
	});

	pi.on("context", (event) => {
		const filteredExecution = filterExecutionResumeMessages(event.messages as Array<{ customType?: string }>);
		const messages = filterPlanningResumeMessages(filteredExecution);
		if (messages.length !== event.messages.length) {
			return { messages };
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		noteCompactionStarted(ctx, event.customInstructions);
		const executionResult = await handleExecutionBeforeCompact(pi, ctx, event);
		if (executionResult) return executionResult;
		return handlePlanningBeforeCompact(pi, ctx, event);
	});
	pi.on("session_compact", async (event, ctx) => {
		handleExecutionCompact(pi, ctx, event);
		handlePlanningCompact(pi, ctx, event);
		noteCompactionEnded(ctx, event.customInstructions);
	});
	pi.on("session_compact_failed", async (event, ctx) => {
		handleExecutionCompactFailed(pi, ctx, event);
		handlePlanningCompactFailed(pi, ctx, event);
		noteCompactionEnded(ctx, event.customInstructions);
	});

	// Flush points for deferred execution-loop writes: primary drain when the
	// agent run fully settles, backstop drain at the next run's start (covers
	// continuation paths that might not emit agent_settled), plus the forced
	// synchronous flush inside stop/complete.
	pi.on("agent_settled", async (_event, ctx) => {
		drainExecutionFlush(pi, ctx);
	});

	// -----------------------------------------------------------------------
	// Execution loop: inject remaining checklist each turn, track markers.
	// -----------------------------------------------------------------------
	pi.on("before_agent_start", async (_event, ctx) => {
		drainExecutionFlush(pi, ctx);
		const content = executionContextMessage();
		if (!content) {
			if (!getExecution() && shouldTriggerPlanningCompaction(ctx)) {
				requestPlanningCompaction(ctx);
			}
			return;
		}
		return {
			message: {
				customType: "pi-plans-exec-context",
				content,
				display: false,
			},
		};
	});

	registerExecutionTurnHandlers(pi, async (ctx) => {
		if (getExecution()) {
			handleExecutionTurnCompaction(ctx);
		} else {
			refreshPlanningCompactionCooldown(ctx);
			if (consumePlanningCompactionResumeGuard(ctx)) {
				updateStatusWidget(ctx);
				return;
			}
			if (shouldTriggerPlanningCompaction(ctx)) {
				requestPlanningCompaction(ctx);
			}
		}
		// A completed turn is the safe point for status updates.
		updateStatusWidget(ctx);
	});
	registerAutoCompleteTurnHandlers(pi);

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("init-graph", {
		description: "Index the worktree into .git/pi_plans/code_graph.db (Node SQLite + Tree-sitter).",
		handler: async (args, ctx) => {
			await initGraphCommand(args, ctx);
		},
	});

	pi.registerCommand("apply-graph", {
		description: "Apply code_graph.db changes back to source. Refuses during active planning/accepted run.",
		handler: async (args, ctx) => {
			await applyGraphCommand(args, ctx);
		},
	});

	pi.registerCommand("graph-status", {
		description: "Show code graph counts (functions, files, edges).",
		handler: async (args, ctx) => {
			await graphStatusCommand(args, ctx);
		},
	});

	pi.registerCommand("update-graph", {
		description: "Incrementally reindex working-tree changes (git status porcelain, incl. untracked/renames) into code_graph.db. Flags: --dry-run, --base <commit>.",
		handler: async (args, ctx) => {
			await updateGraphCommand(args, ctx);
		},
	});

	pi.registerCommand("graph-drift", {
		description: "Check DB↔source convergence (hash/pending, uncommitted coverage, snapshot). Flags: --json, --commit-aware.",
		handler: async (args, ctx) => {
			await graphDriftCommand(args, ctx);
		},
	});

	pi.registerCommand("enable-graph", {
		description: "Enable the code graph: agents prefer graph reads and DB-first edits.",
		handler: async (_args, ctx) => {
			await enableGraphCommand(_args, ctx);
		},
	});

	pi.registerCommand("disable-graph", {
		description: "Disable the code graph (refuses while DB/source drift is dirty).",
		handler: async (_args, ctx) => {
			await disableGraphCommand(_args, ctx);
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
			lines.push(`Auto-complete: ${autoCompleteStatus(ctx)}`);
			lines.push(extensionStalenessLine());
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("plans-autocomplete-stop", {
		description: "Stop Auto-complete for the active planning run",
		handler: async (_args, ctx) => {
			const stopped = disableAutoComplete(ctx, "stopped by user");
			ctx.ui.notify(stopped ? "Auto-complete stopped." : "Auto-complete is not active.", stopped ? "info" : "warning");
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
			disableAutoComplete(ctx, "plan update");

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
				await stopExecution(pi, ctx, "interrupted by /update-plan");
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
			await stopExecution(pi, ctx, "stopped by user via /plans-stop");
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
			// Abandon must end execution first so the planning model is restored.
			disableAutoComplete(ctx, "run abandoned");
			if (getExecution()) {
				await stopExecution(pi, ctx, "run abandoned via /plans-abandon");
			}
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
		await restoreFromSession(pi, ctx, ctx.sessionManager.getEntries() as unknown as Parameters<typeof restoreFromSession>[2]);
		restoreAutoCompleteFromSession(ctx, ctx.sessionManager.getEntries() as unknown as Parameters<typeof restoreAutoCompleteFromSession>[1]);
	});
}
