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
import { buildCriticizerTask, buildReviewerTask, reviewerLanes } from "../src/refine-prompts.ts";
import { runPiSubagent, stripFrontmatter } from "../src/subagent.ts";

const RefineParams = Type.Object({
	role: StringEnum(["reviewer", "criticizer"] as const, { description: "Refinement role to run" }),
	planPath: Type.String({ description: "Path to the PLAN_vN.md to review (absolute or relative to workdir)" }),
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
			"Run a reviewer or criticizer refinement round on a PLAN_vN.md via read-only Pi subagents. Reviewer: findings with IDs, severity, evidence, impact, fix, disposition. Criticizer: up to five adaptive questions. Use reviewers: 3 for the big-plan concurrent reviewer round. Refuses to spawn until the role's mode and model are confirmed in .git/pi_plans/config.json (ask via ask_choice, persist via the plans tool).",
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
			const active = readActive(workdir);
			const record = (name: string, model?: string | null) => {
				if (!active) return;
				try {
					recordSubagent(workdir, active.run_id, { role: params.role, name, model: model ?? null });
				} catch {
					/* best-effort */
				}
			};

			const systemPrompt = loadAgentPrompt(params.role);
			const inheritModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const model = roleConfig.model_selector ?? inheritModel;

			if (roleConfig.mode === "current-session") {
				const task =
					params.role === "reviewer"
						? buildReviewerTask({ planText, planPath, lens: null, focus: params.focus, context: params.context })
						: buildCriticizerTask({ planText, planPath, focus: params.focus, context: params.context });
				return {
					content: [
						{
							type: "text",
							text: `Role mode is current-session: perform the read-only ${params.role} pass yourself, in this session, following this brief. Do not spawn anything.\n\n${task}`,
						},
					],
					details: { mode: "current-session", role: params.role, planPath },
				};
			}

			if (params.role === "criticizer") {
				const name = `${roleConfig.name_prefix}-criticizer-${Date.now().toString(36)}`;
				const result = await runPiSubagent({
					systemPrompt,
					task: buildCriticizerTask({ planText, planPath, focus: params.focus, context: params.context }),
					cwd: workdir,
					model,
					signal,
				});
				record(name, result.ok ? result.model ?? model : null);
				if (!result.ok) {
					throw new Error(
						`criticizer subagent failed: ${result.errorMessage ?? "unknown error"}${result.stderr ? `\nstderr: ${result.stderr.slice(0, 2000)}` : ""}`,
					);
				}
				return {
					content: [
						{
							type: "text",
							text: `${result.output}\n\n---\nAsk each criticizer question with ask_choice (one call per question, in the configured language), record every answer, then revise the plan only after every question has an answer.`,
						},
					],
					details: { mode: "delegated-subagent", role: params.role, planPath, model: result.model ?? model },
				};
			}

			// Reviewer round: 1 by default, 3 for the big-plan concurrent round.
			const count = Math.min(3, Math.max(1, params.reviewers ?? 1));
			const lanes = reviewerLanes(count);
			const jobs = lanes.map((lane) => {
				const name = `${roleConfig.name_prefix}-${active?.run_id ?? "adhoc"}-${lane.id}`;
				const task = buildReviewerTask({ planText, planPath, lens: lane.lens, focus: params.focus, context: params.context });
				return { lane, name, task };
			});

			const results = await Promise.all(
				jobs.map(async (job) => {
					try {
						const result = await runPiSubagent({ systemPrompt, task: job.task, cwd: workdir, model, signal });
						record(job.name, result.ok ? result.model ?? model : null);
						return { job, result };
					} catch (error) {
						record(job.name, null);
						const message = error instanceof Error ? error.message : String(error);
						return {
							job,
							result: { ok: false, output: "", model: model ?? undefined, errorMessage: message, stderr: "", turns: 0 },
						};
					}
				}),
			);

			const sections: string[] = [];
			let failures = 0;
			for (const { job, result } of results) {
				const title = job.lane.lens ? `${job.name} — ${job.lane.lens}` : job.name;
				if (!result.ok) {
					failures += 1;
					sections.push(`### ${title} — FAILED\n${result.errorMessage ?? "unknown error"}`);
					continue;
				}
				sections.push(`### ${title}\n${result.output}`);
			}
			if (failures === results.length) {
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
						text: `${text}\n\n---\nConsolidate: merge and dedupe findings into PLAN_vN_reviewer_comments.md${count === 3 ? " (one consolidated file; keep each finding's source reviewer, severity, evidence, and disposition)" : ""}, accept or reject each finding on repo/reference evidence, surface at most five high-priority findings to the user, then immediately ask the next refinement-mode question with ask_choice.`,
					},
				],
				details: {
					mode: "delegated-subagent",
					role: "reviewer",
					planPath,
					reviewers: count,
					model,
					outputs: results.map(({ job, result }) => ({ name: job.name, lane: job.lane.id, lens: job.lane.lens, ok: result.ok, output: result.output, stderr: result.stderr, turns: result.turns })),
				},
			};
		},

		renderCall(args, theme) {
			const count = args.role === "reviewer" ? args.reviewers ?? 1 : 1;
			let text =
				theme.fg("toolTitle", theme.bold("refine ")) +
				theme.fg("accent", args.role) +
				theme.fg("muted", count > 1 ? ` ×${count}` : "");
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
