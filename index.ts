/**
 * pi-plans — human-in-the-loop planning for the Pi coding agent.
 *
 * Researched, refined Markdown plans before any code changes. The six
 * planning skills are contributed via resources_discover; the extension
 * provides the supporting machinery:
 *
 *   - `plans` tool      — workspace state (config, runs, ledgers) in .git/pi-plans/
 *   - `ask_choice` tool — the choice-prompt contract (Other / Auto-complete rules)
 *   - `refine` tool     — reviewer rounds (findings + questions) via read-only pi subagents
 *   - `execute_plan`    — execution handoff into the tracked execution loop
 *   - write guard       — planning runs may only write planning artifacts
 *   - execution loop    — task-tree injection, plans_update_task tracking, dashboard, audit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	consumePlanningCompactionResumeGuard,
	consumePrePlanCompactPending,
	drainExecutionFlush,
	executionContextMessage,
	filterExecutionResumeMessages,
	filterGoalWaitMessages,
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
	PLANNING_PREPLAN_COMPACT_HINT,
	sendPrePlanCompactResume,
	registerExecutionTurnHandlers,
	refreshPlanningCompactionCooldown,
	requestPlanningCompaction,
	restoreFromSession,
	stopExecution,
	toggleDashboardExpanded,
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
import { lintPlanIntoNotices } from "./src/state.ts";
import { registerQueryInterviewHooks } from "./src/query-hook.ts";
import { registerCodeGraphTool } from "./tools/code-graph.ts";
import { registerGraphAwareFileTools } from "./tools/graph-aware-file-tools.ts";
import {
	initGraphCommand,
	applyGraphCommand,
	graphStatusCommand,
	updateGraphCommand,
	graphDriftCommand,
	enableGraphCommand,
	disableGraphCommand,
	watchGraphCommand,
	unwatchGraphCommand,
	setDisableWatcherHook,
} from "./src/code-graph/commands.ts";
import { restartWatcherIfEnabled, stopGraphWatcher, disableWatcher } from "./src/code-graph/watch.ts";
import { latestPlanVersion, nextPlanVersionPath } from "./src/plan.ts";
import { latestHugePlan, nextHugePlanPath, parseHugePlanPath } from "./src/huge-plan.ts";
import { configPiPlansCommand } from "./src/config-command.ts";
import { hugeChrome, resolveUiLanguage } from "./src/ui-language.ts";
import { resumePlansCommand } from "./src/resume-command.ts";
import { terminatePlanCommand } from "./src/terminate-command.ts";
import { getRun, listRuns, loadConfig, readActive, recordDecision, resolveStateRootOrNull, setRunStatus } from "./src/state.ts";
import { boundRunId, resolveActiveRun, restoreRunBindingFromSession } from "./src/run-context.ts";
import { abandonCandidates, resolveCommandRun } from "./src/run-picker.ts";
import { applyPlanWritten, loadCheckpoint, mutateCheckpoint, planIdentityOf } from "./src/workflow-state.ts";
import { registerAskChoiceTool } from "./tools/ask-choice.ts";
import { executeCommand, registerExecutePlanTool } from "./tools/execute-plan.ts";
import { registerTaskStatusTool } from "./src/task-tool.ts";
import { flattenTaskViews, taskIsTerminal, taskProgress } from "./src/tasks.ts";
import { hugeRunSummary, registerPlansTool } from "./tools/plans.ts";
import { registerRefineTool } from "./tools/refine.ts";
import { registerAnalyzeRefsTool } from "./tools/analyze-refs.ts";
import { messaging, setMessagingApi } from "./src/messaging.ts";
import { stalenessLine } from "./src/staleness.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));

/** The plan file a write/edit should be attributed to: the legacy latest
 * `PLAN_vN.md`, or the newest round of a huge stream (`PLAN_overall_vN.md`,
 * `PLAN_vX.Y.Z_vN.md`). Older rounds of a huge stream never re-stamp the
 * checkpoint, so a historical rewrite cannot move the run's plan identity. */
function planForWrite(artifactDir: string, rawPath: string): { path: string; version: number } | null {
	const resolved = path.resolve(rawPath);
	const legacy = latestPlanVersion(artifactDir);
	if (legacy && path.resolve(legacy.path) === resolved) return legacy;
	const parsed = parseHugePlanPath(resolved);
	if (!parsed) return null;
	const latestOfStream = latestHugePlan(artifactDir, parsed.stream);
	if (!latestOfStream || path.resolve(latestOfStream.path) !== resolved) return null;
	return { path: resolved, version: parsed.round };
}

/** plan-huge: stream id of the run's current version, or null. */
function currentHugeStream(workdir: string, runId: string): string | null {
	const load = loadCheckpoint(workdir, runId);
	if (load.status !== "ok" || !load.checkpoint.huge) return null;
	const huge = load.checkpoint.huge;
	return huge.versions[huge.currentIndex]?.label ?? null;
}

// When THIS copy of the extension was imported into the running pi process.
// /plans compares it against the newest source-file mtime so a stale instance
// (code on disk newer than the loaded copy) is immediately visible.
const extensionLoadedAt = new Date();

// The probe itself lives in src/staleness.ts so the execution reviewer can ask
// the same question when it cannot read a verdict (see exec.ts) without
// importing index.ts, which already imports exec.ts.
function extensionStalenessLine(): string {
	return stalenessLine(baseDir, extensionLoadedAt);
}

function hasActivePlanningWorkflow(ctx: Parameters<typeof updateStatusWidget>[0]): boolean {
	if (getExecution()) return true;
	const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
	if (!active) return false;
	const status = getRun(ctx.cwd, active.run_id)?.status;
	return status === "planning" || status === "accepted" || status === "executing" || status === "verifying";
}

export default function piPlansExtension(pi: ExtensionAPI): void {
	setMessagingApi(pi);
	registerPlansTool(pi);
	registerAskChoiceTool(pi);
	registerRefineTool(pi, baseDir);
	registerAnalyzeRefsTool(pi, baseDir);
	registerExecutePlanTool(pi);
	registerTaskStatusTool(pi);
	pi.registerShortcut("ctrl+shift+t", {
		description: "Expand/collapse the pi-plans task dashboard",
		handler: (ctx) => toggleDashboardExpanded(ctx),
	});
	// v0.8: reopen the in-flight execution-review overlay after ESC (the
	// controller is one-shot; the engine re-seeds a fresh one from its held
	// lane state). Inert when no round is in flight.
	pi.registerShortcut("ctrl+shift+r", {
		description: "Reopen the pi-plans execution-review overlay",
		handler: (ctx) => reopenReviewOverlay(ctx),
	});
	registerQueryInterviewHooks(pi, hasActivePlanningWorkflow);
	registerCodeGraphTool(pi);
	registerGraphAwareFileTools(pi);

	// Contribute the router skill plus the five specialist planning skills.
	// Watch-mode lifecycle (plan I-007, F-004): stop on every session
	// shutdown path (quit/reload/new/resume/fork), restart when the enabled
	// marker survives. The disable-graph hook stops watching too.
	setDisableWatcherHook(disableWatcher);
	try {
		pi.on("session_start", () => {
			void restartWatcherIfEnabled(process.cwd());
		});
		pi.on("session_shutdown", () => {
			stopGraphWatcher(process.cwd());
		});
	} catch {
		/* hosts without session events simply run watchers until unload */
	}

	pi.on("resources_discover", () => ({
		skillPaths: [
			join(baseDir, "skills", "planning"),
			join(baseDir, "skills", "debug-and-plan"),
			join(baseDir, "skills", "plan-small"),
			join(baseDir, "skills", "plan-normal"),
			join(baseDir, "skills", "plan-big"),
			join(baseDir, "skills", "plan-huge"),
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
		"plan-huge",
		"plan-with-refs",
	]) {
		pi.registerCommand(name, {
			description: `Run the ${name} planning skill (alias of /skill:${name})`,
			handler: async (args, ctx) => {
				const invocation = args.trim() ? `/skill:${name} ${args.trim()}` : `/skill:${name}`;
				try {
					messaging().sendUserMessage(invocation, { expandPromptTemplates: true });
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
		const reason = planningWriteBlockReason({
			workdir: ctx.cwd,
			toolName: event.toolName,
			rawPath,
			activeRunId: boundRunId(ctx.sessionManager, ctx.cwd),
		});
		if (reason) return { block: true, reason };
		// Allowed write: if it lands exactly on the run's latest plan file, drop a
		// marker entry so planning-phase compaction can anchor its cut point there.
		if (event.toolName === "write" || event.toolName === "edit") {
			const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
			if (active) {
				const written = planForWrite(active.artifact_dir, path.resolve(ctx.cwd, rawPath));
				if (written) {
					messaging().appendEntry(PLANNING_PLAN_WRITTEN_CUSTOM_TYPE, {
						runId: active.run_id,
						planPath: written.path,
					});
					markPlanWritten(ctx);
				}
			}
		}
		return;
	});

	// I-003: a successful write/edit that lands on the run's latest plan
	// records the plan identity in the run checkpoint (post-execution, so the
	// digest covers the NEW file bytes — unlike the pre-execution marker above).
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (getExecution()) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const rawPath = String((event.input as { path?: string }).path ?? "");
		if (!rawPath) return;
		const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
		if (!active) return;
		const written = planForWrite(active.artifact_dir, path.resolve(ctx.cwd, rawPath.replace(/^@/, "")));
		if (!written) return;
		try {
			const identity = planIdentityOf(written.path, written.version);
			mutateCheckpoint(ctx.cwd, active.run_id, (cp) => applyPlanWritten(cp, identity));
			lintPlanIntoNotices(ctx.cwd, active.run_id, written.path);
		} catch {
			/* best-effort; the model can also call plans record-checkpoint explicitly */
		}
	});

	// Pre-plan compaction: right after `plans start-run` creates a new planning
	// run, trigger one VCC compaction (PLANNING_PREPLAN_COMPACT_HINT routes it
	// through the planning session_before_compact path) so the new plan starts
	// on a lean context. ctx.compact() aborts the current agent operation
	// first, so it must fire here — after the tool result is appended, never
	// inside the tool execute stack. Pi's manual compaction never continues the
	// aborted turn, so resume planning exactly once on success AND failure.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "plans") return;
		if (!consumePrePlanCompactPending(ctx)) return;
		if (typeof ctx.compact !== "function") {
			sendPrePlanCompactResume(ctx);
			return;
		}
		let resumed = false;
		const resumeOnce = () => {
			if (resumed) return;
			resumed = true;
			sendPrePlanCompactResume(ctx);
		};
		ctx.compact({
			customInstructions: PLANNING_PREPLAN_COMPACT_HINT,
			onComplete: () => resumeOnce(),
			onError: () => {
				try {
					ctx.ui?.notify?.("pi-plans: pre-plan compaction skipped; continuing planning.", "info");
				} catch {
					/* notify is best-effort */
				}
				resumeOnce();
			},
		});
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
			ctx.ui?.notify?.("code-graph: source edited directly — run /update-graph to sync the graph, or use code_graph mutations + code_graph apply for DB-first edits", "info");
			return;
		}
		if (event.toolName === "code_graph") {
			const action = String((event.input as { action?: string }).action ?? "");
			if (action === "update-function" || action === "update-file" || action === "delete-file") {
				ctx.ui?.notify?.("code-graph: mutation staged — run code_graph apply to materialize (its result includes the post-apply drift summary)", "info");
			}
		}
	});

	pi.on("context", (event) => {
		const filteredExecution = filterExecutionResumeMessages(event.messages as Array<{ customType?: string }>);
		const messages = filterGoalWaitMessages(filterPlanningResumeMessages(filteredExecution));
		if (messages.length !== event.messages.length) {
			return { messages };
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		noteCompactionStarted(ctx, event.customInstructions);
		const executionResult = await handleExecutionBeforeCompact(ctx, event);
		if (executionResult) return executionResult;
		return handlePlanningBeforeCompact(ctx, event);
	});
	pi.on("session_compact", async (event, ctx) => {
		await handleExecutionCompact(ctx, event);
		await handlePlanningCompact(ctx, event);
		noteCompactionEnded(ctx, event.customInstructions);
	});
	pi.on("session_compact_failed", async (event, ctx) => {
		handleExecutionCompactFailed(ctx, event);
		handlePlanningCompactFailed(ctx, event);
		noteCompactionEnded(ctx, event.customInstructions);
	});

	// -----------------------------------------------------------------------
	// Execution loop: inject remaining checklist each turn, track markers.
	// -----------------------------------------------------------------------
	pi.on("before_agent_start", async (_event, ctx) => {
		drainExecutionFlush(ctx);
		const content = executionContextMessage(ctx);
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
		description: "Index the worktree into .git/pi-plans/code_graph.db. If a graph DB already exists, prompt to rebuild or sync changed paths via /update-graph; `--reindex` and non-interactive runs stay on the rebuild path.",
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
		description: "Incrementally reindex working-tree changes (git status porcelain, incl. untracked/renames) into code_graph.db. Also used by /init-graph when you choose the sync-changes branch. Flags: --dry-run, --base <commit>.",
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

	pi.registerCommand("watch-graph", {
		description: "Watch the worktree and incrementally reindex .ts/.tsx/.js/.jsx/.mjs/.cjs/.py changes (300ms debounce). Auto-restarts on session start after the first run; stops on session shutdown.",
		handler: async (_args, ctx) => {
			await watchGraphCommand(_args, ctx);
		},
	});

	pi.registerCommand("unwatch-graph", {
		description: "Stop the code-graph watcher for this worktree.",
		handler: async (_args, ctx) => {
			await unwatchGraphCommand(_args, ctx);
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
			// v0.6.0: list ALL runs (newest first, bound marked, cap 50) instead of
			// only the shared active one — multi-run workdirs stay legible.
			const runs = listRuns(ctx.cwd).slice(0, 50);
			const bound = boundRunId(ctx.sessionManager, ctx.cwd);
			if (runs.length === 0) {
				lines.push("No planning runs recorded in this workdir.");
			} else {
				lines.push(`Runs (${runs.length} shown, newest first):`);
				for (const run of runs) {
					lines.push(`  ${run.run_id === bound ? "★" : " "} ${run.topic} · ${run.status} · ${run.skill} · ${run.updated_at}`);
				}
			}
			const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
			const run = active ? getRun(ctx.cwd, active.run_id) : null;
			if (run) {
				lines.push(`Session run: ${run.run_id}`);
				lines.push(`Skill: ${run.skill}  Status: ${run.status}`);
				lines.push(`Artifacts: ${run.artifact_dir}`);
				lines.push(`Language: ${run.language_tag ?? "(unset)"}`);
				lines.push(`State: ${resolveStateRootOrNull(ctx.cwd) ?? "(no repo)"}`);
			}
			// One-time active.json deprecation note (v0.6.0 registry migration).
			if (fs.existsSync(path.join(resolveStateRootOrNull(ctx.cwd) ?? ".git/pi-plans", "active.json"))) {
				lines.push("Note: active.json is deprecated — the run registry now derives from runs/*/run.json; the legacy file is ignored.");
			}
			if (run) {
				// plan-huge (v0.9.5): the version tree — every version of the
				// overall plan with its status, round and deferral ledger.
				const summary = hugeRunSummary(ctx.cwd, run.run_id) as {
					position: string;
					currentVersion: string | null;
					versions: Array<{ label: string; status: string; round: number }>;
					deferred: { absorbed: number; dropped: number };
					refNotices: string[];
				} | null;
				if (summary) {
					const chrome = hugeChrome(resolveUiLanguage(ctx.cwd));
					lines.push(`Huge: ${summary.position} versions · current ${summary.currentVersion ?? "-"}`);
					for (const version of summary.versions) {
						lines.push(`  ${chrome.versionLine(version.label, chrome.statusLabel(version.status), version.round)}`);
					}
					lines.push(`  deferred: absorbed ${summary.deferred.absorbed} · dropped ${summary.deferred.dropped}`);
					for (const notice of summary.refNotices) lines.push(`  ⚠ ${notice}`);
				}
			}
			const execution = getExecution();
			if (execution) {
				const progress = taskProgress(execution.tasks);
				const vcDone = execution.items.filter((item) => item.done).length;
				lines.push(`Execution: ${execution.planPath} — tasks ${progress.done}/${progress.total} · VC ${vcDone}/${execution.items.length}`);
				for (const task of flattenTaskViews(execution.tasks)) {
					lines.push(`  ${taskIsTerminal(task) ? (task.status === "skipped" ? "~" : "☑") : "☐"} ${task.id}`);
				}
			}
			lines.push(`Auto-complete: ${autoCompleteStatus(ctx)}`);
			lines.push(extensionStalenessLine());
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("config-pi-plans", {
		description: "Re-ask and update pi-plans workspace config: language, artifact root, graph, and reviewer defaults",
		handler: async (args, ctx) => {
			await configPiPlansCommand(args, ctx);
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
			const outcome = await executeCommand(ctx, planPath);
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

			const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
			const execution = getExecution();
			disableAutoComplete(ctx, "plan update");

			// Resolve the plan to revise: explicit arg > running execution > latest in artifact dir.
			let sourcePlanPath: string | null = planArg
				? path.resolve(ctx.cwd, planArg.replace(/^@/, ""))
				: null;
			if (!sourcePlanPath && execution) sourcePlanPath = execution.planPath;
			if (!sourcePlanPath && active) {
				// plan-huge: revise the CURRENT version stream, not a legacy PLAN_vN.md.
				const stream = currentHugeStream(ctx.cwd, active.run_id);
				sourcePlanPath =
					(stream ? latestHugePlan(active.artifact_dir, stream)?.path : null) ??
					latestPlanVersion(active.artifact_dir)?.path ??
					null;
			}
			if (!sourcePlanPath || !fs.existsSync(sourcePlanPath)) {
				ctx.ui.notify(
					sourcePlanPath ? `Plan file not found: ${sourcePlanPath}` : "No plan to update. Pass plan.md or start a run first.",
					"error",
				);
				return;
			}

			const artifactDir = active?.artifact_dir ?? path.dirname(sourcePlanPath);
			// plan-huge: the revision advances the current version stream
			// (PLAN_vX.Y.Z_v(N+1).md); ordinary runs keep PLAN_v(N+1).md.
			const hugeStream = active ? currentHugeStream(ctx.cwd, active.run_id) : null;
			const next = hugeStream ? nextHugePlanPath(artifactDir, hugeStream) : nextPlanVersionPath(artifactDir);

			// Snapshot progress BEFORE stopping so the revision preserves finished work.
			const doneIds = execution ? execution.items.filter((item) => item.done).map((item) => item.id) : [];
			const pendingIds = execution ? execution.items.filter((item) => !item.done).map((item) => item.id) : [];

			if (execution) {
				const ok = await ctx.ui.confirm(
					"Stop execution to update the plan?",
					`${doneIds.length}/${execution.items.length} verifier item(s) already verified; their work stays. Remaining items return to planning.`,
				);
				if (!ok) return;
				await stopExecution(ctx, "interrupted by /update-plan");
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
				"Follow the original planning-skill contract for revisions: collect needed clarifications via ask_choice (batch related questions into one `questions: [...]` form, 2-8 items, recorded; scope/handoff stays single-question with autoComplete: false), apply evidence-based revisions only, then ask the next merged accept/execute question (autoComplete: false — ✓ Accept & execute now / Accept, don't execute yet / another round) and call execute_plan pointing at the new version on accept.",
			);

			await messaging().sendUserMessage(lines.join("\n"));
		},
	});

	pi.registerCommand("plans-stop", {
		description: "Stop plan execution mode (plan artifacts are kept)",
		handler: async (_args, ctx) => {
			if (!getExecution()) {
				ctx.ui.notify("No execution in progress.", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Stop execution?", "Open tasks will be left unfinished.");
			if (!ok) return;
			await stopExecution(ctx, "stopped by user via /plans-stop");
			ctx.ui.notify("Execution stopped.", "info");
		},
	});

	pi.registerCommand("plans-terminate", {
		description:
			"Terminate the current plan by user decision: records the run as done, discloses unverified checks and unresolved findings, and is not resumable (unlike /plans-stop, which stops and can be resumed, and /plans-abandon, which voids a planning run)",
		handler: async (_args, ctx) => {
			await terminatePlanCommand(ctx);
		},
	});

	pi.registerCommand("resume-plans", {
		description:
			"Resume the working plan in this repository: unfinished planning / reviewing / execution / implementation review, across sessions and linked worktrees, in the current session.",
		handler: async (_args, ctx) => {
			await resumePlansCommand(ctx, baseDir);
		},
	});

	pi.registerCommand("plans-abandon", {
		description: "Abandon the active planning run (lifts the read-only guard; artifacts are kept)",
		handler: async (_args, ctx) => {
			// v0.6.0 (R-3): pick the run to abandon when several candidates exist;
			// binding-first, single candidate stays direct (0.5.7 parity).
			const chosen = await resolveCommandRun(
				{ cwd: ctx.cwd, sessionManager: ctx.sessionManager, ui: ctx.ui },
				{ candidates: abandonCandidates(ctx.cwd), title: "Abandon which run?" },
			);
			if (!chosen) {
				ctx.ui.notify("No active planning run.", "info");
				return;
			}
			const active = resolveActiveRun(ctx.sessionManager, ctx.cwd);
			const abandoningBound = active?.run_id === chosen.run_id;
			const ok = await ctx.ui.confirm(
				"Abandon planning run?",
				`${chosen.run_id} (${chosen.topic} · ${chosen.status})\nThe read-only guard lifts; committed artifacts stay in place.`,
			);
			if (!ok) return;
			// Abandon must end execution first so the planning model is restored.
			disableAutoComplete(ctx, "run abandoned");
			if (abandoningBound && getExecution()) {
				await stopExecution(ctx, "run abandoned via /plans-abandon");
			}
			try {
				setRunStatus(ctx.cwd, chosen.run_id, "abandoned");
			ctx.ui.notify(`Run ${chosen.run_id} abandoned.`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed: ${(error as Error).message}`, "error");
			}
			updateStatusWidget(ctx);
		},
	});

	// -----------------------------------------------------------------------
	// Session lifecycle
	// -----------------------------------------------------------------------
	pi.on("session_tree", async (_event, ctx) => {
		await restoreFromSession(ctx, ctx.sessionManager.getBranch() as unknown as Parameters<typeof restoreFromSession>[1]);
		restoreRunBindingFromSession(
			ctx.sessionManager,
			ctx.cwd,
			ctx.sessionManager.getBranch() as unknown as Parameters<typeof restoreRunBindingFromSession>[2],
		);
	});
	pi.on("session_start", async (_event, ctx) => {
		await restoreFromSession(ctx, ctx.sessionManager.getBranch() as unknown as Parameters<typeof restoreFromSession>[1]);
		restoreAutoCompleteFromSession(ctx, ctx.sessionManager.getEntries() as unknown as Parameters<typeof restoreAutoCompleteFromSession>[1]);
		restoreRunBindingFromSession(
			ctx.sessionManager,
			ctx.cwd,
			ctx.sessionManager.getBranch() as unknown as Parameters<typeof restoreRunBindingFromSession>[2],
		);
	});
}

