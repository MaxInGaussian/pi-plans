/**
 * `plans` tool — the state CLI for the pi-plans workflow, exposed as one
 * typed tool.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeDrift } from "../src/code-graph/commands.ts";
import { gitAddAllAndCommit } from "../src/code-graph/git.ts";
import { loadGraphRuntime } from "../src/code-graph/runtime.ts";
import { resolveCanonicalWorktree } from "../src/code-graph/paths.ts";
import { Store } from "../src/code-graph/store.ts";
import {
	initState,
	loadConfig,
	normalizeWorkdir,
	recordDecision,
	recordRef,
	recordSubagent,
	resolveStateRootOrNull,
	setArtifactRoot,
	setGraphEnabled,
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
			"set-graph-enabled",
			"set-role",
			"start-run",
			"set-status",
			"final-commit",
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
	enabled: Type.Optional(Type.Boolean({ description: "set-graph-enabled: enable/disable the code graph" })),
	message: Type.Optional(Type.String({ description: "final-commit: commit message body" })),
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

// Module-level reference so the start-run action can append a session entry
// (pi-plans-run-start) at the moment the planning run begins. The ExtensionAPI
// itself is not in scope for `startRun`, mirroring `setCurrentApi` in
// tools/execute-plan.ts.
let runStartAppender: ((runId: string, artifactDir: string) => void) | null = null;

export function setRunStartAppender(appender: ((runId: string, artifactDir: string) => void) | null): void {
	runStartAppender = appender;
}

/** plans action final-commit: gate on code-graph drift (zero pending +
 *  invariants (a)/(b) clean), then `git add -A` and commit the plan delivery.
 *  A clean tree is a safe no-op. Returns a machine-readable result. */
export async function finalCommit(
	workdir: string,
	message: string,
): Promise<{
	ok: boolean;
	committed: string | null;
	noop: boolean;
	reason?: string;
	drift?: unknown;
}> {
	const paths = resolveCanonicalWorktree(workdir);
	const runtime = await loadGraphRuntime();
	if (!runtime.status.sqliteAvailable) {
		throw new StateError("final-commit requires node:sqlite (code graph unavailable)");
	}
	const store = new Store(
		{ dbPath: paths.codeGraphDb, worktreeRoot: paths.worktreeRoot, gitCommonDir: paths.gitCommonDir },
		runtime.runtime.sqlite,
	);
	try {
		let drift: ReturnType<typeof computeDrift> | null = null;
		try {
			drift = computeDrift(store, paths.worktreeRoot);
		} catch {
			drift = null; // graph never initialized: fall through to plain commit
		}
		if (drift && (drift.pending.length > 0 || !drift.ok)) {
			return {
				ok: false,
				committed: null,
				noop: false,
				reason: `graph drift dirty: ${drift.recommendation}`,
				drift,
			};
		}
		const head = gitAddAllAndCommit(paths.worktreeRoot, message);
		if (!head) {
			return { ok: true, committed: null, noop: true, reason: "nothing to commit — tree already clean" };
		}
		return { ok: true, committed: head, noop: false };
	} finally {
		store.close();
	}
}

export function registerPlansTool(pi: ExtensionAPI): void {
	setRunStartAppender((runId, artifactDir) => {
		pi.appendEntry("pi-plans-run-start", { runId, artifactDir });
	});
	pi.registerTool({
		name: "plans",
		label: "Plans",
		description:
			"Manage pi-plans planning state in the target workspace: init/show config, set language and planning docs root plus reviewer/criticizer roles and the code-graph enabled flag, start planning runs, record decisions/refs/subagents, and update run status. State lives in .git/pi_plans/ inside the resolved git common dir. Actions: init, show, set-language, set-artifact-root, set-graph-enabled, set-role, start-run, set-status, final-commit, record-decision, record-ref, record-subagent.",
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
						if (ensured.config.graph_enabled === null) {
							result = {
								...(result as Record<string, unknown>),
								hint: "graph_enabled is null (never asked). Ask the user once via ask_choice whether to enable the code graph (recommended: yes for repos with an initialized graph; see references/state-and-config.md), then persist with plans (action: set-graph-enabled, enabled: true|false). This question does not count against the planning-question limit.",
							};
						}
						break;
					}
					case "show": {
						const config = showConfig(workdir);
						const stateRoot = resolveStateRootOrNull(workdir);
						result = { config, stateRoot };
						if (config.graph_enabled === null) {
							result = {
								...(result as Record<string, unknown>),
								hint: "graph_enabled is null (never asked). Ask the user once via ask_choice, then persist with plans (action: set-graph-enabled, enabled: true|false).",
							};
						}
						break;
					}
					case "set-graph-enabled": {
						if (typeof params.enabled !== "boolean") {
							throw new StateError("set-graph-enabled requires enabled (boolean)");
						}
						const updated = setGraphEnabled(workdir, params.enabled);
						result = { config: updated.config, stateRoot: updated.stateRoot, notices: updated.notices };
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
							onStart: (run) => {
								runStartAppender?.(run.run_id, run.artifact_dir);
							},
						});
						break;
					}
					case "set-status": {
						if (!params.runId || !params.status) throw new StateError("set-status requires runId and status");
						result = setRunStatus(workdir, params.runId, params.status);
						break;
					}
					case "final-commit": {
						if (!params.message) throw new StateError("final-commit requires message");
						result = await finalCommit(workdir, params.message);
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
