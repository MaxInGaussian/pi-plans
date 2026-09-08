/**
 * `refine` tool — reviewer/criticizer refinement rounds via read-only Pi
 * subagents with isolated context.
 *
 * Enforces the role-confirmation gate: refuses to spawn while a
 * role's mode is invalid or its model was never confirmed, telling the caller
 * exactly which ask_choice question to ask first.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, normalizeWorkdir, readActive, recordSubagent, resolveStateRootOrNull, StateError, type RoleConfig } from "../src/state.ts";
import { resolveActiveRun } from "../src/run-context.ts";
import {
	loadCheckpoint,
	readReviewOutput,
	recordLaneOutcome,
	reusableLaneOutputs,
	startReviewRound,
} from "../src/workflow-state.ts";
import { buildCriticizerTask, buildImplementationCriticizerTask, buildImplementationReviewerTask, buildReviewerTask, reviewerLanes } from "../src/refine-prompts.ts";
import { graphBlockForRefiner } from "../src/code-graph/prompts.ts";
import { runPiSubagent, stripFrontmatter } from "../src/subagent.ts";
import { RefineOverlayController, refineOverlayContext } from "../src/refine-ui.ts";


const RefineParams = Type.Object({
	role: StringEnum(["reviewer", "criticizer"] as const, { description: "Refinement role to run" }),
	planPath: Type.String({ description: "Path to the PLAN_vN.md to review (absolute or relative to workdir)" }),
	target: Type.Optional(
		StringEnum(["plan", "implementation"] as const, {
			description:
				'Review target: "plan" (default) reviews the plan text; "implementation" reviews the implemented worktree against the plan\'s goals and acceptance criteria (post-execution amelioration).',
		}),
	),
	focus: Type.Optional(Type.String({ description: "Specific concerns to direct the pass at" })),
	reviewers: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 3,
			description: "Number of independent reviewer subagents (big plans: 3 for the concurrent round). Criticizer is always 1.",
		}),
	),
	context: Type.Optional(
		Type.String({ description: "Context for the subagents: user goals, repo evidence, constraints, open questions" }),
	),
	resumeRoundId: Type.Optional(
		Type.String({
			description:
				'Round id to resume (I-004). Lanes already complete for this round in the run checkpoint are reused from their persisted outputs; only pending/failed/missing lanes run. Never reuse a round id across plan versions.',
		}),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

function roleGateError(role: string, roleConfig: RoleConfig | undefined, problem: "mode" | "confirm"): StateError {
	if (problem === "mode") {
		return new StateError(
			`The ${role} role mode is missing or invalid in .git/pi_plans/config.json. Ask the role-setting question with ask_choice first: 1. Delegated subagent (recommended; read-only pi subprocess with isolated context) 2. Current session (run the pass yourself in this session) 3. Other 4. Auto-complete — then persist with the plans tool (set-role).`,
		);
	}
	return new StateError(
		`The ${role} model was never confirmed (confirmed_at is null). Ask the model-confirmation question with ask_choice: 1. Inherit the main agent's model (recommended) 2. Choose a model (list options from the /model picker; persist the exact provider/model selector) 3. Other 4. Auto-complete — then persist with the plans tool (set-role, confirmed: true, modelSelector: the selector or 'inherit').`,
	);
}

function setupRefinementExecution(
	ctx: ExtensionContext,
	parentSignal: AbortSignal | undefined,
	role: "reviewer" | "criticizer",
	lanes: Array<{ id: string; label?: string }>,
	modelLabel?: string,
) {
	const controller = new AbortController();
	const relayAbort = () => controller.abort();
	if (parentSignal?.aborted) controller.abort();
	else parentSignal?.addEventListener("abort", relayAbort, { once: true });

	const overlay = ctx.mode === "tui" ? new RefineOverlayController(role, lanes, relayAbort) : undefined;
	overlay?.open(refineOverlayContext(ctx), modelLabel);

	return {
		signal: controller.signal,
		overlay,
		async close() {
			await overlay?.close();
			parentSignal?.removeEventListener("abort", relayAbort);
		},
	};
}

export function registerRefineTool(pi: ExtensionAPI, baseDir: string): void {
	const agentsDir = path.join(baseDir, "agents");

	const loadAgentPrompt = (role: "reviewer" | "criticizer"): string => {
		const file = path.join(agentsDir, `${role}.md`);
		return stripFrontmatter(fs.readFileSync(file, "utf8"));
	};

	pi.registerTool({
		name: "refine",
		label: "Refine",
		description:
			"Run a reviewer or criticizer refinement round on a PLAN_vN.md (target=\"plan\", default) or on the implemented worktree (target=\"implementation\", post-execution amelioration) via read-only Pi subagents. Reviewer: findings with IDs, severity, evidence, impact, fix, disposition. Criticizer: up to five adaptive questions. Use reviewers: 3 for the big-plan concurrent reviewer round. Refuses to spawn until the role's mode and model are confirmed in .git/pi_plans/config.json (ask via ask_choice, persist via the plans tool).",
		promptSnippet: "Run reviewer/criticizer plan-refinement rounds",
		parameters: RefineParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);

			// Read config read-only; state must already exist.
			const root = resolveStateRootOrNull(workdir);
			if (root === null || !fs.existsSync(path.join(root, "config.json"))) {
				throw new StateError("no pi-plans state found; run the plans tool (action: init) first");
			}
			const config = loadConfig(root);
			const roleConfig = config[params.role] as RoleConfig | undefined;
			if (!roleConfig || (roleConfig.mode !== "delegated-subagent" && roleConfig.mode !== "current-session")) {
				throw roleGateError(params.role, roleConfig, "mode");
			}
			if (roleConfig.confirmed_at === null) {
				throw roleGateError(params.role, roleConfig, "confirm");
			}

			// Resolve and read the plan.
			const planPath = path.resolve(workdir, params.planPath.replace(/^@/, ""));
			if (!fs.existsSync(planPath)) throw new StateError(`plan file not found: ${planPath}`);
			const planText = fs.readFileSync(planPath, "utf8");

			// Record spawns against the active run when one exists.
			const active = resolveActiveRun(ctx.sessionManager, workdir);
			const record = (name: string, model?: string | null) => {
				if (!active) return;
				try {
					recordSubagent(workdir, active.run_id, { role: params.role, name, model: model ?? null });
				} catch {
					/* best-effort */
				}
			};

			const target = params.target ?? "plan";
			// I-004: durable round bookkeeping. Rounds start (or resume) in the
			// checkpoint BEFORE any lane spawns; successful outputs are persisted
			// BEFORE the tool result returns (C-007).
			const checkpointLoad = active ? loadCheckpoint(workdir, active.run_id) : null;
			const useCheckpoint = checkpointLoad?.status === "ok" ? checkpointLoad.checkpoint : null;
			const roundId =
				params.resumeRoundId ?? `${target}-${params.role}-r${Date.now().toString(36)}`;
			const roundReviewerCount = params.role === "reviewer" ? Math.min(3, Math.max(1, params.reviewers ?? 1)) : 1;
			// F-001 (implementation review): the spec MUST carry lanes —
			// reviewerLanes(count) for reviewer rounds, one lane for criticizer.
			const roundLanes =
				params.role === "reviewer"
					? reviewerLanes(roundReviewerCount).map((lane) => ({ laneId: lane.id, lens: lane.lens ?? undefined }))
					: [{ laneId: "criticizer" }];
			const roundSpec = {
				roundId,
				role: params.role,
				target,
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
			const pickTask = (role: "reviewer" | "criticizer", lens: string | null): string => {
				if (role === "reviewer") {
					return target === "implementation"
						? buildImplementationReviewerTask({ planText, planPath, lens, focus: params.focus, context: params.context })
						: buildReviewerTask({ planText, planPath, lens, focus: params.focus, context: params.context });
				}
				return target === "implementation"
					? buildImplementationCriticizerTask({ planText, planPath, focus: params.focus, context: params.context })
					: buildCriticizerTask({ planText, planPath, focus: params.focus, context: params.context });
			};

			const systemPrompt = loadAgentPrompt(params.role);
			const graphEnabled = config.graph_enabled === true;
			const subagentTools = graphEnabled ? ["read", "grep", "find", "ls", "code_graph"] : undefined;
			const graphPrompt = graphBlockForRefiner(graphEnabled);
			const inheritModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const model = roleConfig.model_selector ?? inheritModel;
			const modelLabel = model ?? "inherit";

			if (roleConfig.mode === "current-session") {
				const task = pickTask(params.role, null);
				return {
					content: [
						{
							type: "text",
							text: `Role mode is current-session: perform the read-only ${params.role} pass yourself, in this session, following this brief. Do not spawn anything.\n\n${task}`,
						},
					],
					details: { mode: "current-session", role: params.role, planPath, target },
				};
			}

			if (params.role === "criticizer") {
				const laneId = "criticizer";
				const persisted = reusable[laneId];
				if (persisted) {
					return {
						content: [
							{
								type: "text",
								text: `${readReviewOutput(workdir, active!.run_id, persisted)}\n\n---\nReused the persisted criticizer result for round ${roundId} (no re-run). Ask each criticizer question with ask_choice (one call per question, in the configured language), record every answer, then revise the plan only after every question has an answer.`,
							},
						],
						details: { mode: "delegated-subagent", role: params.role, planPath, target, roundId, reused: true },
					};
				}
				const name = `${roleConfig.name_prefix}-criticizer-${Date.now().toString(36)}`;
				const execution = setupRefinementExecution(ctx, signal, "criticizer", [{ id: name, label: "criticizer" }], modelLabel);
				try {
					const result = await runPiSubagent({
						systemPrompt: `${systemPrompt}\n\n${graphPrompt}`,
						task: pickTask("criticizer", null),
						cwd: workdir,
						model,
						tools: subagentTools,
						signal: execution.signal,
						onProgress: (event) => execution.overlay?.update(name, event),
					});
					execution.overlay?.complete(name, result);
					record(name, result.ok ? result.model ?? model : null);
					persistOutcome(laneId, result.ok ? { ok: true, output: result.output } : { ok: false, error: result.errorMessage });
					if (!result.ok) {
						throw new Error(
							`criticizer subagent failed: ${result.errorMessage ?? "unknown error"}${result.stderr ? `\nstderr: ${result.stderr.slice(0, 2000)}` : ""}`,
						);
					}
					return {
						content: [
							{
								type: "text",
								text: `${result.output}\n\n---\nAsk each criticizer question with ask_choice (one call per question, in the configured language, with a stable questionId per question), record every answer, then revise the plan only after every question has an answer. After the revision, record the boundary: plans record-checkpoint (checkpoint: { transition: "review-consolidated", roundId: "${roundId}" }).`,
							},
						],
						details: { mode: "delegated-subagent", role: params.role, planPath, target, roundId, model: result.model ?? model },
					};
				} finally {
					await execution.close();
				}
			}

			const count = Math.min(3, Math.max(1, params.reviewers ?? 1));
			const lanes = reviewerLanes(count);
			const jobs = lanes.map((lane) => {
				const name = `${roleConfig.name_prefix}-${active?.run_id ?? "adhoc"}-${lane.id}`;
				const task = pickTask("reviewer", lane.lens);
				return { lane, name, task };
			});

			// Per-plan amelioration round counter (post-execution loop auditability).
			const roundsSlot = ctx.sessionManager as unknown as { __ameliorateRounds?: Map<string, number> };
			const nextRound = (planPath: string): number => {
				roundsSlot.__ameliorateRounds ??= new Map();
				const round = (roundsSlot.__ameliorateRounds.get(planPath) ?? 0) + 1;
				roundsSlot.__ameliorateRounds.set(planPath, round);
				return round;
			};

			// Lane-level resume (F-007): completed lanes are reused from their
			// persisted outputs; only pending/failed/missing lanes spawn.
			const runnableJobs = jobs.filter((job) => reusable[job.lane.id] === undefined);
			const execution = setupRefinementExecution(
				ctx,
				signal,
				"reviewer",
				runnableJobs.map((job) => ({ id: job.lane.id, label: job.lane.id })),
				modelLabel,
			);
			try {
				const results = await Promise.all(
					runnableJobs.map(async (job) => {
						try {
							const result = await runPiSubagent({
								systemPrompt: `${systemPrompt}\n\n${graphPrompt}`,
								task: job.task,
								cwd: workdir,
								model,
								tools: subagentTools,
								signal: execution.signal,
								onProgress: (event) => execution.overlay?.update(job.lane.id, event),
							});
							execution.overlay?.complete(job.lane.id, result);
							record(job.name, result.ok ? result.model ?? model : null);
							// Persist BEFORE returning (C-007): a crash after this point
							// still leaves the lane reusable.
							persistOutcome(job.lane.id, result.ok ? { ok: true, output: result.output } : { ok: false, error: result.errorMessage });
							if (target === "implementation" && result.ok) {
								try {
									pi.appendEntry("pi-plans-ameliorate", {
										planPath,
										phase: "round",
										currentRound: nextRound(planPath),
										lane: job.lane.id,
									});
								} catch {
									/* appendEntry is best-effort; audit trail survives in subagents.jsonl */
								}
							}
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
							execution.overlay?.complete(job.lane.id, result);
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
						`all reviewer subagents failed: ${first?.result.errorMessage ?? "unknown error"}${first?.result.stderr ? `\nstderr: ${first.result.stderr.slice(0, 2000)}` : ""}${model ? `\nIf the model selector "${model}" is unavailable, reset the confirmation (plans set-role --reset-confirmation) and re-ask the model-confirmation question.` : ""}`,
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
							text: `${text}\n\n---\nConsolidate: merge and dedupe findings into PLAN_vN_reviewer_comments.md${count === 3 ? " (one consolidated file; keep each finding's source reviewer, severity, evidence, and disposition)" : ""}, accept or reject each finding on repo/reference evidence, surface at most five high-priority findings to the user, then immediately ask the next refinement-mode question with ask_choice. Then record the boundary: plans record-checkpoint (checkpoint: { transition: "review-consolidated", roundId: "${roundId}", dispositionArtifact: "<comments file, run-dir relative>" }).${target === "implementation" ? ' When the whole round is disposed, also record (checkpoint: { transition: "implementation-round-finished" }); when the termination condition is met, close with (checkpoint: { transition: "completed", evidence: "<why the condition is satisfied>" }).' : ""}`,
						},
					],
					details: {
						mode: "delegated-subagent",
						role: "reviewer",
						planPath,
						roundId,
						reusedLanes: Object.keys(reusable),
						reviewers: count,
						model,
						outputs: results.map(({ job, result }) => ({ name: job.name, lane: job.lane.id, lens: job.lane.lens, ok: result.ok, output: result.output, stderr: result.stderr, turns: result.turns })),
					},
				};
			} finally {
				await execution.close();
			}
		},

		renderCall(args, theme) {
			const count = args.role === "reviewer" ? args.reviewers ?? 1 : 1;
			let text =
				theme.fg("toolTitle", theme.bold("refine ")) +
				theme.fg("accent", args.role) +
				theme.fg("muted", count > 1 ? ` ×${count}` : "");
			const short = args.planPath ? args.planPath.split("/").pop() : "";
			if (short) text += theme.fg("dim", ` ${short}`);
			if (args.target === "implementation") text += theme.fg("dim", "  (implementation)");
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
