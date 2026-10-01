/**
 * `plans` tool — the state CLI for the pi-plans workflow, exposed as one
 * typed tool.
 */

import { bindRun, boundRunId, resolveActiveRun } from "../src/run-context.ts";
import { lintPlanIntoNotices } from "../src/state.ts";
import { getExecution, markPrePlanCompactPending, refreshUiLanguage } from "../src/exec.ts";
import { loadVccSettings, scaffoldVccSettings } from "../src/compaction.ts";
import {
	applyPlanWritten,
	applyReviewConsolidated,
	createCheckpoint,
	mutateCheckpoint,
	planIdentityOf,
	type WorkflowCheckpoint,
} from "../src/workflow-state.ts";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeDrift, toDbKey } from "../src/code-graph/commands.ts";
import { buildParsersFromRuntime, reindexRelativePaths } from "../src/code-graph/freshness.ts";
import { gitStatusPorcelain } from "../src/code-graph/git.ts";
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
	setRefsRoot,
	setRunStatus,
	setRole,
	showStateView,
	startRun,
	StateError,
	VALID_RUN_STATUSES,
} from "../src/state.ts";
import { messaging } from "../src/messaging.ts";

const PlansParams = Type.Object({
	action: StringEnum(
		[
			"init",
			"show",
			"set-language",
			"set-artifact-root",
			"set-refs-root",
			"set-graph-enabled",
			"set-role",
			"start-run",
			"set-status",
			"final-commit",
			"record-decision",
			"record-ref",
			"record-subagent",
			"record-checkpoint",
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
	artifactRoot: Type.Optional(Type.String({ description: "set-artifact-root: planning docs root, e.g. ./.git/pi-plans/plans" })),
	artifactRootSource: Type.Optional(StringEnum(["user", "auto"] as const)),
	refsRoot: Type.Optional(Type.String({ description: "set-refs-root: reference downloads root, e.g. .git/pi-plans/refs" })),
	refsRootSource: Type.Optional(StringEnum(["user", "auto"] as const)),
	enabled: Type.Optional(Type.Boolean({ description: "set-graph-enabled: enable/disable the code graph" })),
	message: Type.Optional(Type.String({ description: "final-commit: commit message body" })),
	role: Type.Optional(StringEnum(["reviewer"] as const)),
	mode: Type.Optional(StringEnum(["delegated-subagent", "current-session"] as const)),
	modelSelector: Type.Optional(
		Type.String({ description: "set-role: exact provider/model selector; 'inherit' resets BOTH the selector and the confirmation" }),
	),
	thinkingLevel: Type.Optional(
		StringEnum(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
			description:
				"set-role: reviewer subagent thinking level in the GLOBAL config; 'default' (null) omits --thinking so the child pi resolves its own default chain; changing modelSelector without this resets the level",
		}),
	),
	confirmed: Type.Optional(
		Type.Boolean({ description: "set-role: stamp confirmed_at=now; requires an exact selector for delegated-subagent" }),
	),
	resetConfirmation: Type.Optional(Type.Boolean({ description: "set-role: clear confirmed_at to re-ask" })),
	runId: Type.Optional(Type.String()),
	status: Type.Optional(
		StringEnum(
			["planning", "accepted", "executing", "verifying", "stopped", "abandoned", "done"] as const,
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
			role: StringEnum(["reviewer", "ref-analyst"] as const),
			name: Type.String(),
			model: Type.Optional(Type.String()),
			sessionDir: Type.Optional(Type.String()),
		}),
	),
	checkpoint: Type.Optional(
		Type.Object({
			/** Whitelisted semantic transition (I-003). State-machine validated; approval cannot be forged here. */
			transition: StringEnum(["plan-written", "review-consolidated"] as const),
			/** plan-written: absolute or workdir-relative PLAN_vN.md path. */
			planPath: Type.Optional(Type.String()),
			/** review-consolidated: round id + optional disposition artifact (run-dir relative). */
			roundId: Type.Optional(Type.String()),
			dispositionArtifact: Type.Optional(Type.String()),
		}),
	),
});

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
		// Freshness trigger 2 (plan R-006): snapshot the dirty set before the
		// commit so the graph can catch up to the new HEAD right after it.
		let dirtyPaths: string[] = [];
		try {
			dirtyPaths = gitStatusPorcelain(paths.worktreeRoot)
				.filter((e) => !e.status.includes("D"))
				.map((e) => toDbKey(e.path))
				.filter((key) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(key));
		} catch {
			dirtyPaths = [];
		}
		const head = gitAddAllAndCommit(paths.worktreeRoot, message);
		if (!head) {
			return { ok: true, committed: null, noop: true, reason: "nothing to commit — tree already clean" };
		}
		if (dirtyPaths.length > 0) {
			try {
				const parsers = await buildParsersFromRuntime(runtime.runtime);
				await reindexRelativePaths({ store, paths, parsers }, dirtyPaths);
			} catch {
				/* freshness is best-effort; /update-graph remains the fallback */
			}
		}
		return { ok: true, committed: head, noop: false };
	} finally {
		store.close();
	}
}

/** Whitelisted, state-machine-validated checkpoint transitions (I-003). */
export function recordCheckpointTransition(
	ctx: { sessionManager: unknown },
	workdir: string,
	runIdArg: string | undefined,
	checkpoint: {
		transition: "plan-written" | "review-consolidated";
		planPath?: string;
		roundId?: string;
		dispositionArtifact?: string;
	},
): WorkflowCheckpoint {
	const runId =
		runIdArg ??
		boundRunId(ctx.sessionManager, workdir) ??
		resolveActiveRun(ctx.sessionManager, workdir)?.run_id ??
		null;
	if (!runId) throw new StateError("record-checkpoint requires runId (or an active/bound run)");
	switch (checkpoint.transition) {
		case "plan-written": {
			if (!checkpoint.planPath) throw new StateError("plan-written requires planPath");
			const planPath = path.isAbsolute(checkpoint.planPath)
				? checkpoint.planPath
				: path.resolve(workdir, checkpoint.planPath.replace(/^@/, ""));
			const identity = planIdentityOf(planPath, 1);
			const cp = mutateCheckpoint(workdir, runId, (inner) => applyPlanWritten(inner, identity));
			lintPlanIntoNotices(workdir, runId, planPath);
			return cp;
		}
		case "review-consolidated": {
			if (!checkpoint.roundId) throw new StateError("review-consolidated requires roundId");
			return mutateCheckpoint(workdir, runId, (cp) =>
				applyReviewConsolidated(cp, checkpoint.roundId!, checkpoint.dispositionArtifact),
			);
		}
	}
}

export function registerPlansTool(ext: ExtensionAPI): void {
	ext.registerTool({
		name: "plans",
		label: "Plans",
		description:
			"Manage pi-plans planning state in the target workspace: init/show config, set language and planning docs root plus the reviewer role and the code-graph enabled flag, start planning runs, record decisions/refs/subagents, and update run status. Multiple concurrent runs per workdir are supported (registry-derived from runs/; sessions bind to their run). State lives in .git/pi-plans/ inside the resolved git common dir. Actions: init, show, set-language, set-artifact-root, set-refs-root, set-graph-enabled, set-role, start-run, set-status, final-commit, record-decision, record-ref, record-subagent.",
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
						const view = showStateView(workdir);
						result = {
							config: view.config,
							stateRoot: view.stateRoot,
							reviewer: view.reviewer,
							globalConfigPath: view.globalConfigPath,
							notices: view.notices,
						};
						if (view.config.graph_enabled === null) {
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
						// D-008 (issue #3): an executing run must switch chrome language
						// immediately, not at the next restart.
						refreshUiLanguage(ctx);
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
					case "set-refs-root": {
						if (!params.refsRoot || !params.refsRootSource) {
							throw new StateError("set-refs-root requires refsRoot and refsRootSource");
						}
						const updated = setRefsRoot(workdir, params.refsRoot, params.refsRootSource);
						result = { config: updated.config, stateRoot: updated.stateRoot, notices: updated.notices };
						break;
					}
					case "set-role": {
						if (!params.role) throw new StateError("set-role requires role");
						const updated = setRole(workdir, {
							role: params.role,
							mode: params.mode,
							modelSelector: params.modelSelector,
							thinkingLevel: params.thinkingLevel,
							confirmed: params.confirmed,
							resetConfirmation: params.resetConfirmation,
						});
						result = {
							global: updated.global,
							globalRoot: updated.globalRoot,
							notices: updated.notices,
							config: updated.config,
							stateRoot: updated.stateRoot,
						};
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
							// Append the run-start session entry with this call's ctx —
							// never a registration-time capture (stale after session
							// replacement).
							onStart: (run) => {
								messaging().appendEntry("pi-plans-run-start", { runId: run.run_id, artifactDir: run.artifact_dir });
							},
						});
						// I-002: attribute this session's work to the run it started.
						bindRun(ctx.sessionManager, workdir, result.run.run_id);
						// I-003: durable cross-session state starts with the run.
						createCheckpoint(workdir, {
							runId: result.run.run_id,
							originWorkdir: workdir,
							workdir,
						});
						// Pre-plan compaction: mark the session so the plans tool_result
						// hook compacts once with the VCC planning path before the first
						// planning question. Opportunistic: never blocks run creation.
						try {
							const prePlanStateRoot = resolveStateRootOrNull(workdir);
							if (prePlanStateRoot && !getExecution()) {
								scaffoldVccSettings(prePlanStateRoot);
								if (loadVccSettings(prePlanStateRoot).prePlanCompact) {
									markPrePlanCompactPending(ctx, result.run.run_id);
								}
							}
						} catch {
							// best-effort: pre-plan compaction is an optimization only
						}
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
					case "record-checkpoint": {
						if (!params.checkpoint) throw new StateError("record-checkpoint requires checkpoint");
						result = recordCheckpointTransition(ctx, workdir, params.runId, params.checkpoint);
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

