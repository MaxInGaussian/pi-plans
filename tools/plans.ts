/**
 * `plans` tool — the state CLI for the pi-plans workflow, exposed as one
 * typed tool.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	initState,
	loadConfig,
	normalizeWorkdir,
	recordDecision,
	recordRef,
	recordSubagent,
	resolveStateRootOrNull,
	setArtifactRoot,
	setLanguage,
	setRunStatus,
	setRole,
	showConfig,
	startRun,
	StateError,
	VALID_RUN_STATUSES,
} from "../src/state.ts";

const PlansParams = Type.Object({
	action: StringEnum(
		[
			"init",
			"show",
			"set-language",
			"set-artifact-root",
			"set-role",
			"start-run",
			"set-status",
			"record-decision",
			"record-ref",
			"record-subagent",
		] as const,
		{ description: "State command to run" },
	),
	workdir: Type.Optional(
		Type.String({ description: "Target workspace directory. Default: current working directory." }),
	),
	topic: Type.Optional(Type.String({ description: "start-run: short topic slug for the run" })),
	skill: Type.Optional(Type.String({ description: "start-run: skill name starting the run" })),
	requestText: Type.Optional(Type.String({ description: "start-run: original user request text" })),
	tag: Type.Optional(Type.String({ description: "set-language: BCP47 tag, e.g. zh-Hans, en" })),
	languageSource: Type.Optional(StringEnum(["user", "auto"] as const)),
	artifactRoot: Type.Optional(Type.String({ description: "set-artifact-root: planning docs root, e.g. ./docs/pi-plans" })),
	artifactRootSource: Type.Optional(StringEnum(["user", "auto"] as const)),
	role: Type.Optional(StringEnum(["reviewer", "criticizer"] as const)),
	mode: Type.Optional(StringEnum(["delegated-subagent", "current-session"] as const)),
	modelSelector: Type.Optional(
		Type.String({ description: "set-role: exact provider/model selector, or 'inherit' to reset to inherited" }),
	),
	confirmed: Type.Optional(
		Type.Boolean({ description: "set-role: stamp confirmed_at=now (used by the first-use confirmation flow)" }),
	),
	resetConfirmation: Type.Optional(Type.Boolean({ description: "set-role: clear confirmed_at to re-ask" })),
	runId: Type.Optional(Type.String()),
	status: Type.Optional(
		StringEnum(
			["planning", "accepted", "executing", "stopped", "abandoned", "done"] as const,
			{ description: "set-status: run lifecycle status" },
		),
	),
	decision: Type.Optional(
		Type.Object({
			question: Type.String(),
			options: Type.Array(Type.String()),
			answer: Type.String(),
			answerSource: StringEnum(["user", "auto-complete"] as const),
			artifact: Type.Optional(Type.String()),
		}),
	),
	ref: Type.Optional(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			kind: Type.String(),
			retrieval: Type.String(),
			localPath: Type.Optional(Type.String()),
			coverage: Type.Optional(Type.String()),
			gaps: Type.Optional(Type.String()),
		}),
	),
	subagent: Type.Optional(
		Type.Object({
			role: StringEnum(["reviewer", "criticizer"] as const),
			name: Type.String(),
			model: Type.Optional(Type.String()),
			sessionDir: Type.Optional(Type.String()),
		}),
	),
});

export function registerPlansTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "plans",
		label: "Plans",
		description:
			"Manage pi-plans planning state in the target workspace: init/show config, set language and planning docs root plus reviewer/criticizer roles, start planning runs, record decisions/refs/subagents, and update run status. State lives in .git/pi_plans/ inside the resolved git common dir. Actions: init, show, set-language, set-artifact-root, set-role, start-run, set-status, record-decision, record-ref, record-subagent.",
		promptSnippet: "Manage pi-plans planning state, runs, and ledgers",
		parameters: PlansParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);
			try {
				let result: unknown;
				switch (params.action) {
					case "init": {
						const ensured = initState(workdir);
						result = { config: ensured.config, stateRoot: ensured.stateRoot, notices: ensured.notices };
						break;
					}
					case "show": {
						const config = showConfig(workdir);
						const stateRoot = resolveStateRootOrNull(workdir);
						result = { config, stateRoot };
						break;
					}
					case "set-language": {
						if (!params.tag || !params.languageSource) {
							throw new StateError("set-language requires tag and languageSource");
						}
						const updated = setLanguage(workdir, params.tag, params.languageSource);
						result = { config: updated.config, stateRoot: updated.stateRoot, notices: updated.notices };
						break;
					}
					case "set-artifact-root": {
						if (!params.artifactRoot || !params.artifactRootSource) {
							throw new StateError("set-artifact-root requires artifactRoot and artifactRootSource");
						}
						const updated = setArtifactRoot(workdir, params.artifactRoot, params.artifactRootSource);
						result = { config: updated.config, stateRoot: updated.stateRoot, notices: updated.notices };
						break;
					}
					case "set-role": {
						if (!params.role) throw new StateError("set-role requires role");
						const updated = setRole(workdir, {
							role: params.role,
							mode: params.mode,
							modelSelector: params.modelSelector,
							confirmed: params.confirmed,
							resetConfirmation: params.resetConfirmation,
						});
						result = { config: updated.config, stateRoot: updated.stateRoot, notices: updated.notices };
						break;
					}
					case "start-run": {
						if (!params.topic || !params.skill || !params.requestText) {
							throw new StateError("start-run requires topic, skill, and requestText");
						}
						result = startRun(workdir, {
							topic: params.topic,
							skill: params.skill,
							requestText: params.requestText,
						});
						break;
					}
					case "set-status": {
						if (!params.runId || !params.status) throw new StateError("set-status requires runId and status");
						result = setRunStatus(workdir, params.runId, params.status);
						break;
					}
					case "record-decision": {
						if (!params.runId || !params.decision) {
							throw new StateError("record-decision requires runId and decision");
						}
						result = recordDecision(workdir, params.runId, params.decision);
						break;
					}
					case "record-ref": {
						if (!params.runId || !params.ref) throw new StateError("record-ref requires runId and ref");
						result = recordRef(workdir, params.runId, params.ref);
						break;
					}
					case "record-subagent": {
						if (!params.runId || !params.subagent) {
							throw new StateError("record-subagent requires runId and subagent");
						}
						result = recordSubagent(workdir, params.runId, params.subagent);
						break;
					}
				}
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				// Surface state errors as tool errors so the model sees the guidance.
				throw new Error(`pi-plans ${params.action} failed: ${(error as Error).message}`);
			}
		},
	});
}
