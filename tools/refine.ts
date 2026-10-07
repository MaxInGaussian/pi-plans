/**
 * `refine` tool — reviewer refinement rounds via read-only Pi subagents
 * with isolated context.
 *
 * Enforces the reviewer role gates: the mode question stays agent-mediated
 * (ask_choice), while first-use model confirmation pops native panels in
 * TUI (v0.7.0): a /model-style searchable panel, then a /thinking-style
 * effort panel, persisted to the GLOBAL reviewer config. Esc cancels the
 * whole gate with a dedicated error (details.cancelled) — do not re-ask.
 * The reviewer output carries findings AND questions (Q-###); the caller
 * must ask every question with ask_choice before revising the plan.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadConfig,
	normalizeWorkdir,
	readActive,
	recordSubagent,
	resolveEffectiveReviewer,
	resolveGlobalConfigPath,
	resolveStateRootOrNull,
	reviewerReady,
	StateError,
} from "../src/state.ts";
import { runFirstUseFlow, firstUseCancelledError, firstUseTextGuidance, availableModels, findModel, type FirstUseOutcome, type RolePanelHost } from "../src/role-panels.ts";
import { roleModelLabel } from "../src/thinking-levels.ts";
import { uiLanguageFromTag, type UiLanguage } from "../src/ui-language.ts";
import type { SubagentUsage } from "../src/subagent.ts";
import { resolveActiveRun } from "../src/run-context.ts";
import {
	loadCheckpoint,
	readReviewOutput,
	recordLaneOutcome,
	reusableLaneOutputs,
	startReviewRound,
} from "../src/workflow-state.ts";
import { buildReviewerTask, reviewerLanes } from "../src/refine-prompts.ts";
import { graphBlockForRefiner } from "../src/code-graph/prompts.ts";
import { stripFrontmatter } from "../src/subagent.ts";
import { agentHostOf, runAgentSession } from "../src/agent-session.ts";
import { openFleetGroup } from "../src/fleet-run.ts";
import { buildCodeGraphTool } from "./code-graph.ts";
import { matchesTerminalKey } from "../src/terminal-keys.ts";
import { toggleDashboardExpanded } from "../src/exec.ts";


const RefineParams = Type.Object({
	planPath: Type.String({ description: "Path to the PLAN_vN.md to review (absolute or relative to workdir)" }),
	focus: Type.Optional(Type.String({ description: "Specific concerns to direct the pass at" })),
	reviewers: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 3,
			description: "Number of independent reviewer subagents (big plans: 3 for the concurrent round).",
		}),
	),
	context: Type.Optional(
		Type.String({ description: "Context for the subagents: user goals, repo evidence, constraints, open questions" }),
	),
	resumeRoundId: Type.Optional(
		Type.String({
			description:
				'Round id to resume. Lanes already complete for this round in the run checkpoint are reused from their persisted outputs; only pending/failed/missing lanes run. Never reuse a round id across plan versions.',
		}),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

function roleGateError(problem: "mode" | "confirm", guidance?: string): StateError {
	if (problem === "mode") {
		return new StateError(
			`The reviewer role mode is missing or invalid. Ask the role-setting question with ask_choice first: 1. Delegated subagent (recommended; read-only in-process subagent with isolated context) 2. Current session (run the pass yourself in this session) 3. Other 4. Auto-complete — then persist with the plans tool (set-role). The reviewer role lives in the global config (${resolveGlobalConfigPath()}).`,
		);
	}
	return new StateError(
		guidance ??
			firstUseTextGuidance([], resolveGlobalConfigPath()),
	);
}

/** First-use gate shared by the delegated spawn path: pop panels (TUI) or
 * menus (hasUI non-TUI), persist on completion, cancel cleanly on Esc.
 * Returns the role to use for THIS invocation, or throws. */
async function ensureReviewerReady(
	toolName: string,
	host: RolePanelHost,
	role: { mode: string; model_selector: string | null; thinking_level: string | null; confirmed_at: string | null },
): Promise<{ mode: string; model_selector: string | null; thinking_level: string | null; confirmed_at: string | null; name_prefix: string }> {
	if (role.mode === "current-session" || reviewerReady(role as never)) return role as never;
	let outcome: FirstUseOutcome = await runFirstUseFlow(host, role.thinking_level);
	if (outcome.status === "confirmed") {
		// F-008: validate the freshly chosen selector against the registry when
		// one is present, so a typo'd manual entry fails here, not at spawn.
		// (v0.8.1 field-drift fix: the outcome's top-level field is camelCase
		// `modelSelector` — reading snake_case `model_selector` yielded
		// undefined, passed the old `!== null` guard, and crashed findModel
		// with "Cannot read properties of undefined (reading 'indexOf')"
		// right after the first-use panel confirmed.)
		if (availableModels(host).length > 0 && findModel(host, outcome.modelSelector) === null) {
			outcome = await runFirstUseFlow(host, outcome.role.thinking_level);
		}
	}
	if (outcome.status === "cancelled") throw firstUseCancelledError(toolName);
	if (outcome.status === "unavailable") {
		throw roleGateError("confirm", firstUseTextGuidance(availableModels(host), resolveGlobalConfigPath()));
	}
	if (outcome.role.model_selector === null) throw roleGateError("confirm", firstUseTextGuidance(availableModels(host), resolveGlobalConfigPath()));
	return outcome.role;
}

function setupRefinementExecution(
	ctx: ExtensionContext,
	parentSignal: AbortSignal | undefined,
	groupId: string,
	lanes: Array<{ id: string; label?: string }>,
	modelLabel?: string,
	lang: UiLanguage = "en",
) {
	return openFleetGroup(ctx, {
		role: "reviewer",
		groupId,
		lanes,
		modelLabel,
		lang,
		signal: parentSignal,
		// pi-tui has no key bubbling: forward the dashboard toggle so
		// Ctrl+Shift+T keeps working while an agent overlay holds focus.
		onUnhandledKey: (data) => {
			if (matchesTerminalKey(data, "ctrl+shift+t")) toggleDashboardExpanded(ctx);
		},
	});
}

export function registerRefineTool(ext: ExtensionAPI, baseDir: string): void {
	const agentsDir = path.join(baseDir, "agents");

	const loadAgentPrompt = (): string => {
		const file = path.join(agentsDir, "reviewer.md");
		return stripFrontmatter(fs.readFileSync(file, "utf8"));
	};

	ext.registerTool({
		name: "refine",
		label: "Refine",
		description:
			"Run a reviewer refinement round on a PLAN_vN.md via read-only Pi subagents. Each reviewer returns findings (F-###, severity, evidence, impact, fix, disposition) AND questions (Q-1..Q-5) that only the user can settle — after the round you MUST ask every question with ask_choice (one call per question or a batched form, in the configured language, stable questionIds) and record the answers before revising the plan. Use reviewers: 3 for concurrent reviewer rounds (big-plan review). Refuses to spawn until the reviewer mode is set and, for delegated-subagent, a concrete model is confirmed: first use pops native model/effort panels in TUI (persisted to the global reviewer config) instead of an ask_choice question.",
		promptSnippet: "Run reviewer plan-refinement rounds",
		parameters: RefineParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);

			// Read config read-only; state must already exist.
			const root = resolveStateRootOrNull(workdir);
			if (root === null || !fs.existsSync(path.join(root, "config.json"))) {
				throw new StateError("no pi-plans state found; run the plans tool (action: init) first");
			}
			const config = loadConfig(root);

			// F-005: cheap validations BEFORE any first-use panel, so a bad planPath
			// never walks the user through two panels that would then be discarded.
			const planPath = path.resolve(workdir, params.planPath.replace(/^@/, ""));
			if (!fs.existsSync(planPath)) throw new StateError(`plan file not found: ${planPath}`);
			const planText = fs.readFileSync(planPath, "utf8");

			// Effective reviewer: global config first, legacy workspace block
			// second — resolved read-only, never written here (F-001).
			const { reviewer: initialRole } = resolveEffectiveReviewer(root);
			if (initialRole.mode !== "delegated-subagent" && initialRole.mode !== "current-session") {
				throw roleGateError("mode");
			}
			// Model/effort confirmation applies only to delegated-subagent
			// (decision 10); current-session runs in this session with its model.
			const roleConfig = await ensureReviewerReady("refine", ctx as unknown as RolePanelHost, initialRole);

			const overlayLang = uiLanguageFromTag(config.language.tag);
			// Record spawns against the active run when one exists.
			const active = resolveActiveRun(ctx.sessionManager, workdir);
			const record = (name: string, model?: string | null, usage?: SubagentUsage) => {
				if (!active) return;
				try {
					recordSubagent(workdir, active.run_id, {
						role: "reviewer",
						name,
						model: model ?? null,
						thinking_level: roleConfig.mode === "current-session" ? null : roleConfig.thinking_level,
						usage: usage
							? { input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, cost: usage.cost }
							: null,
					});
				} catch {
					/* best-effort */
				}
			};

			// Durable round bookkeeping. Rounds start (or resume) in the
			// checkpoint BEFORE any lane spawns; successful outputs are persisted
			// BEFORE the tool result returns.
			const checkpointLoad = active ? loadCheckpoint(workdir, active.run_id) : null;
			const useCheckpoint = checkpointLoad?.status === "ok" ? checkpointLoad.checkpoint : null;
			const roundId = params.resumeRoundId ?? `plan-reviewer-r${Date.now().toString(36)}`;
			const roundReviewerCount = Math.min(3, Math.max(1, params.reviewers ?? 1));
			const roundLanes = reviewerLanes(roundReviewerCount).map((lane) => ({ laneId: lane.id, lens: lane.lens ?? undefined }));
			const roundSpec = {
				roundId,
				role: "reviewer" as const,
				target: "plan" as const,
				reviewers: roundReviewerCount,
				planPath,
				focus: params.focus,
				context: params.context,
				lanes: roundLanes,
			};
			if (useCheckpoint) {
				startReviewRound(workdir, active!.run_id, roundSpec);
			}
			const reusable = useCheckpoint
				? Object.fromEntries(reusableLaneOutputs(useCheckpoint, roundId).map((entry) => [entry.laneId, entry.resultFile]))
				: {};
			const persistOutcome = (laneId: string, result: { ok: boolean; output?: string; error?: string }): void => {
				if (!active || !useCheckpoint) return;
				try {
					recordLaneOutcome(workdir, active.run_id, roundId, laneId, result);
				} catch {
					/* the subagents ledger still records the spawn; resume treats the lane as unfinished */
				}
			};
			const pickTask = (lens: string | null): string =>
				buildReviewerTask({ planText, planPath, lens, focus: params.focus, context: params.context });

			const systemPrompt = loadAgentPrompt();
			const graphEnabled = config.graph_enabled === true;
			const subagentTools = graphEnabled ? ["read", "grep", "find", "ls", "code_graph"] : undefined;
				// In-process sessions load no extensions: hand the reviewers a
				// read-only code_graph tool directly when the graph is on.
				const subagentCustomTools = graphEnabled ? [buildCodeGraphTool({ readOnly: true })] : undefined;
			const graphPrompt = graphBlockForRefiner(graphEnabled);
			const model = roleConfig.mode === "current-session" ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined) : roleConfig.model_selector ?? undefined;
			const modelLabel = roleModelLabel(model ?? "inherit", roleConfig.mode === "current-session" ? null : roleConfig.thinking_level);

			if (roleConfig.mode === "current-session") {
				const task = pickTask(null);
				return {
					content: [
						{
							type: "text",
							text: `Role mode is current-session: perform the read-only reviewer pass yourself, in this session, following this brief. Do not spawn anything. Then surface the findings and ask the Questions section with ask_choice before revising.\n\n${task}`,
						},
					],
					details: { mode: "current-session", planPath },
				};
			}

			const count = roundReviewerCount;
			const lanes = reviewerLanes(count);
			const jobs = lanes.map((lane) => {
				const name = `${roleConfig.name_prefix}-${active?.run_id ?? "adhoc"}-${lane.id}`;
				const task = pickTask(lane.lens);
				return { lane, name, task };
			});

			// Lane-level resume: completed lanes are reused from their
			// persisted outputs; only pending/failed/missing lanes spawn.
			const runnableJobs = jobs.filter((job) => reusable[job.lane.id] === undefined);
			const execution = setupRefinementExecution(
				ctx,
				signal,
				runnableJobs.map((job) => ({ id: job.lane.id, label: job.lane.id })),
				modelLabel,
				overlayLang,
			);
			try {
				const results = await Promise.all(
					runnableJobs.map(async (job) => {
						try {
							const result = await runAgentSession({
								systemPrompt: `${systemPrompt}\n\n${graphPrompt}`,
								task: job.task,
								cwd: workdir,
								host: agentHostOf(ctx),
								model,
								thinkingLevel: roleConfig.thinking_level ?? undefined,
								tools: subagentTools,
								customTools: subagentCustomTools,
								signal: execution.signalFor(job.lane.id),
								onProgress: (event) => execution.group.update(job.lane.id, event),
							});
							execution.group.complete(job.lane.id, result);
							record(job.name, result.ok ? result.model ?? model : null, result.usage);
							// Persist BEFORE returning: a crash after this point
							// still leaves the lane reusable.
							persistOutcome(job.lane.id, result.ok ? { ok: true, output: result.output } : { ok: false, error: result.errorMessage });
							return { job, result };
						} catch (error) {
							record(job.name, null);
							const message = error instanceof Error ? error.message : String(error);
							persistOutcome(job.lane.id, { ok: false, error: message });
							const result = {
								ok: false,
								output: "",
								model: model ?? undefined,
								errorMessage: message,
								stderr: "",
								turns: 0,
							};
							execution.group.complete(job.lane.id, result);
							return { job, result };
						}
					}),
				);

				const sections: string[] = [];
				let failures = 0;
				let reusedCount = 0;
				// Reused lanes first (stable order): outputs come from the persisted files.
				for (const job of jobs) {
					const persisted = reusable[job.lane.id];
					if (persisted === undefined) continue;
					reusedCount += 1;
					const title = job.lane.lens ? `${job.name} — ${job.lane.lens}` : job.name;
					sections.push(`### ${title} — REUSED (round ${roundId}, no re-run)\n${readReviewOutput(workdir, active!.run_id, persisted)}`);
				}
				for (const { job, result } of results) {
					const title = job.lane.lens ? `${job.name} — ${job.lane.lens}` : job.name;
					if (!result.ok) {
						failures += 1;
						sections.push(`### ${title} — FAILED\n${result.errorMessage ?? "unknown error"}`);
						continue;
					}
					sections.push(`### ${title}\n${result.output}`);
				}
				if (failures === results.length && reusedCount === 0) {
					const first = results[0];
					throw new Error(
						`all reviewer subagents failed: ${first?.result.errorMessage ?? "unknown error"}${first?.result.stderr ? `\nstderr: ${first.result.stderr.slice(0, 2000)}` : ""}${model ? `\nIf the model selector "${model}" is unavailable, reset the confirmation (plans set-role, role=reviewer, resetConfirmation: true) — the next refine opens the native model panel to re-confirm.` : ""}`,
					);
				}

				const combined = sections.join("\n\n---\n\n");
				const truncation = truncateHead(combined, { maxLines: 2000, maxBytes: 50 * 1024 });
				let text = truncation.content;
				if (truncation.truncated) text += `\n\n[Output truncated; full outputs remain in this tool result's details.]`;

				return {
					content: [
						{
							type: "text",
							text: `${text}\n\n---\nConsolidate: merge and dedupe findings into PLAN_vN_reviewer_comments.md${count > 1 ? " (one consolidated file; keep each finding's source reviewer, severity, evidence, and disposition)" : ""}, accept or reject each finding on repo/reference evidence, merge the Questions sections into one deduped list, surface at most five high-priority findings to the user — then ask EVERY consolidated question with ask_choice (batch them into one questions:[...] form or ask one per call, in the configured language, with stable questionIds), record every answer, and only then revise the plan. After the revision, record the boundary: plans record-checkpoint (checkpoint: { transition: "review-consolidated", roundId: "${roundId}", dispositionArtifact: "<comments file, run-dir relative>" }).`,
						},
					],
					details: {
						mode: "delegated-subagent",
						planPath,
						roundId,
						reusedLanes: Object.keys(reusable),
						reviewers: count,
						model,
						thinkingLevel: roleConfig.thinking_level,
						outputs: results.map(({ job, result }) => ({ name: job.name, lane: job.lane.id, lens: job.lane.lens, ok: result.ok, output: result.output, stderr: result.stderr, turns: result.turns })),
					},
				};
			} finally {
				execution.close();
			}
		},

		renderCall(args, theme) {
			const count = args.reviewers ?? 1;
			let text = theme.fg("toolTitle", theme.bold("refine ")) + theme.fg("accent", "reviewer") + theme.fg("muted", count > 1 ? ` ×${count}` : "");
			const short = args.planPath ? args.planPath.split("/").pop() : "";
			if (short) text += theme.fg("dim", ` ${short}`);
			if (args.focus) text += `\n${theme.fg("dim", `  focus: ${args.focus.slice(0, 80)}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			if (!expanded) {
				const firstLine = raw.split("\n").find((line) => line.trim()) ?? "(no output)";
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", firstLine.slice(0, 120)), 0, 0);
			}
			return new Text(raw, 0, 0);
		},
	});
}

export type { ExtensionContext };
