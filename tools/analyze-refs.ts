/**
 * `analyze_refs` tool — plan-with-refs per-reference analysis via read-only Pi
 * subagents with isolated context. One lane per reference (cwd = the ref's own
 * directory), reusing the reviewer model confirmation from the GLOBAL config
 * (`~/.pi/pi-plans/config.json`) and the concurrent overlay (title "Refs").
 * analyze_refs is spawn-only by nature, so the reviewer MODE is deliberately
 * not consulted here (Q-4=B): a current-session reviewer still gets spawned
 * ref-analyst lanes, with a one-time notice in the result. Batches are capped
 * at three concurrent lanes; larger ref sets run as sequential batches.
 *
 * Recording is best-effort: spawns land in `subagents.jsonl` (role
 * `ref-analyst`) only when an active planning run exists. Analysis output is
 * returned to the main agent, which owns REF_ANALYSIS.md and refs.jsonl.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
	StateError,
} from "../src/state.ts";
import { runFirstUseFlow, firstUseCancelledError, firstUseTextGuidance, availableModels, findModel, type RolePanelHost } from "../src/role-panels.ts";
import { roleModelLabel } from "../src/thinking-levels.ts";
import type { SubagentUsage } from "../src/subagent.ts";
import { resolveActiveRun } from "../src/run-context.ts";
import { buildRefAnalystTask, type RefAnalystTaskInput } from "../src/refine-prompts.ts";
import { runPiSubagent, stripFrontmatter } from "../src/subagent.ts";
import { RefineOverlayController, refineOverlayContext } from "../src/refine-ui.ts";
import { resolveUiLanguage } from "../src/ui-language.ts";

const BATCH_SIZE = 3;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const AnalyzeRefsParams = Type.Object({
	refs: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable ref id, e.g. ref-1; used in lane names and result sections" }),
			localPath: Type.String({ description: "Local directory of the downloaded reference (absolute or relative to workdir)" }),
			title: Type.Optional(Type.String({ description: "Reference title" })),
			url: Type.Optional(Type.String({ description: "Source URL" })),
			kind: Type.Optional(Type.String({ description: "Reference kind, e.g. project | article | paper | docs" })),
		}),
		{ description: "Downloaded references to analyze; each gets its own independent read-only subagent" },
	),
	context: Type.Optional(
		Type.String({ description: "Target repo context for adoptability judgments: user goals, repo evidence, constraints" }),
	),
	workdir: Type.Optional(Type.String({ description: "Target workspace; default current working directory" })),
});

function gateError(problem: "state" | "confirm", guidance?: string): StateError {
	if (problem === "state") {
		return new StateError("no pi-plans state found; run the plans tool (action: init) first");
	}
	return new StateError(
		guidance ??
			firstUseTextGuidance([], resolveGlobalConfigPath()),
	);
}

/** First-use model confirmation for the spawn-only ref-analyst path: native
 * panels in TUI, menus for hasUI non-TUI, embedded text guidance otherwise.
 * The reviewer MODE is not consulted (Q-4=B), but because analysis always
 * spawns, a confirmed CONCRETE model is required even when the stored mode
 * is current-session (model confirmation “as usual”). */
async function ensureRefAnalystModelReady(
	host: RolePanelHost,
	role: { mode: string; model_selector: string | null; thinking_level: string | null; confirmed_at: string | null },
): Promise<{ mode: string; model_selector: string | null; thinking_level: string | null; confirmed_at: string | null; name_prefix: string }> {
	if (role.confirmed_at !== null && role.model_selector !== null) return role as never;
	let outcome = await runFirstUseFlow(host, role.thinking_level);
	if (outcome.status === "confirmed" && outcome.model_selector !== null && availableModels(host).length > 0 && findModel(host, outcome.model_selector) === null) {
		// F-008: a manually entered selector that the registry does not know —
		// one re-pick, then let spawn-side errors surface precisely.
		outcome = await runFirstUseFlow(host, outcome.role.thinking_level);
	}
	if (outcome.status === "cancelled") throw firstUseCancelledError("analyze_refs");
	const guidance = firstUseTextGuidance(availableModels(host), resolveGlobalConfigPath());
	if (outcome.status === "unavailable") throw gateError("confirm", guidance);
	if (outcome.role.model_selector === null) throw gateError("confirm", guidance);
	return outcome.role;
}

interface AnalysisJob {
	input: RefAnalystTaskInput;
	name: string;
	laneId: string;
	dir: string;
	missing: string | null;
}

export function registerAnalyzeRefsTool(ext: ExtensionAPI, baseDir: string): void {
	const agentPrompt = stripFrontmatter(fs.readFileSync(path.join(baseDir, "agents", "ref-analyst.md"), "utf8"));

	ext.registerTool({
		name: "analyze_refs",
		label: "Analyze Refs",
		description:
			"plan-with-refs: analyze downloaded references via independent read-only Pi subagents — one lane per reference (cwd = the ref directory), reusing the reviewer model confirmation from the global config and the concurrent overlay. Batches of at most 3 lanes run sequentially; results are structured per-reference sections for REF_ANALYSIS.md. Recording into subagents.jsonl is best-effort (active run only); refs.jsonl stays owned by the main agent via the plans record-ref action. The reviewer mode is not consulted (spawn-only); first use pops native model/effort panels in TUI.",
		promptSnippet: "Analyze plan-with-refs references with per-ref read-only subagents",
		parameters: AnalyzeRefsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const workdir = normalizeWorkdir(params.workdir ?? ctx.cwd);

			// Read config read-only; state must already exist (same precondition as refine).
			const root = resolveStateRootOrNull(workdir);
			if (root === null || !fs.existsSync(path.join(root, "config.json"))) {
				throw gateError("state");
			}
			const config = loadConfig(root);

			// F-005: cheap validations BEFORE any first-use panel.
			if (params.refs.length === 0) {
				throw new StateError("analyze_refs requires at least one reference");
			}

			// Effective reviewer from the global config (mode NOT consulted —
			// analyze_refs is spawn-only, Q-4=B; a notice surfaces when the stored
			// mode is current-session so the switch is never silent).
			const { reviewer: initialReviewer } = resolveEffectiveReviewer(root);
			const modeIgnoredNotice =
				initialReviewer.mode === "current-session"
					? `note: the reviewer mode is ${initialReviewer.mode}, but analyze_refs always spawns read-only subagents; the mode is ignored here and unchanged.`
					: null;
			const reviewer = await ensureRefAnalystModelReady(ctx as unknown as RolePanelHost, initialReviewer);

			// Resolve refs and validate directories up front; missing ones become
			// FAILED sections instead of aborting the whole batch.
			const active = resolveActiveRun(ctx.sessionManager, workdir);
			const jobs: AnalysisJob[] = params.refs.map((ref, index) => {
				const dir = path.resolve(workdir, ref.localPath.replace(/^@/, ""));
				const missing = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? null : `reference directory not found: ${dir}`;
				return {
					input: { refId: ref.id, localPath: dir, title: ref.title, url: ref.url, kind: ref.kind, context: params.context },
					name: `pi-plans-refs-${active?.run_id ?? "adhoc"}-ref-${index + 1}`,
					laneId: `ref-${index + 1}`,
					dir,
					missing,
				};
			});
			if (jobs.length === 0) {
				throw new StateError("analyze_refs requires at least one reference");
			}

			const model = reviewer.model_selector ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			const modelLabel = roleModelLabel(model ?? "inherit", reviewer.thinking_level);
			let languageTag: string | null = null;
			if (active) {
				try {
					const run = JSON.parse(fs.readFileSync(path.join(root, "runs", active.run_id, "run.json"), "utf8")) as { language_tag?: string | null };
					languageTag = run.language_tag ?? null;
				} catch {
					languageTag = null; // best-effort: corrupt/missing run.json must not fail the call
				}
			}

			const record = (name: string, okModel?: string | null, usage?: SubagentUsage) => {
				if (!active) return;
				try {
					recordSubagent(workdir, active.run_id, {
						role: "ref-analyst",
						name,
						model: okModel ?? model ?? null,
						thinking_level: reviewer.thinking_level,
						// I-010: meter subagent token/cost for benchmark accounting.
						usage: usage
							? { input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, cost: usage.cost }
							: null,
					});
				} catch {
					/* best-effort: audit survives in the tool result */
				}
			};

			const runJob = async (job: AnalysisJob, overlay: RefineOverlayController | undefined, relay: AbortController) => {
				if (job.missing) {
					return { ok: false as const, output: "", model: undefined, errorMessage: job.missing, stderr: "", turns: 0 };
				}
				try {
					const result = await runPiSubagent({
						systemPrompt: agentPrompt,
						task: buildRefAnalystTask({ ...job.input, languageTag }),
						cwd: job.dir,
						model,
						thinkingLevel: reviewer.thinking_level ?? undefined,
						tools: READ_ONLY_TOOLS,
						signal: relay.signal,
						onProgress: (event) => overlay?.update(job.laneId, event),
					});
					overlay?.complete(job.laneId, result);
					record(job.name, result.ok ? result.model ?? model : null, result.usage);
					return result;
				} catch (error) {
					record(job.name, null);
					const message = error instanceof Error ? error.message : String(error);
					const result = { ok: false as const, output: "", model: model ?? undefined, errorMessage: message, stderr: "", turns: 0 };
					overlay?.complete(job.laneId, result);
					return result;
				}
			};

			const sections: string[] = [];
			const outputs: Array<{ name: string; lane: string; refId: string; ok: boolean; output: string; errorMessage?: string; turns: number }> = [];
			let failures = 0;

			// Sequential batches of at most BATCH_SIZE lanes; each batch gets its
			// own overlay with the same lifecycle as a single refine round.
			for (let start = 0; start < jobs.length; start += BATCH_SIZE) {
				const batch = jobs.slice(start, start + BATCH_SIZE);
				const controller = new AbortController();
				const relayAbort = () => controller.abort();
				if (signal?.aborted) controller.abort();
				else signal?.addEventListener("abort", relayAbort, { once: true });

				const overlay =
					ctx.mode === "tui"
						? new RefineOverlayController("refs", batch.map((job) => ({ id: job.laneId, label: job.laneId })), relayAbort, resolveUiLanguage(workdir))
						: undefined;
				overlay?.open(refineOverlayContext(ctx), modelLabel);
				try {
					const results = await Promise.all(batch.map((job) => runJob(job, overlay, controller)));
					for (let i = 0; i < batch.length; i += 1) {
						const job = batch[i]!;
						const result = results[i]!;
						const title = `${job.name} — ${job.input.title ?? job.input.refId}`;
						if (!result.ok) {
							failures += 1;
							sections.push(`### ${title} — FAILED\n${result.errorMessage ?? "unknown error"}`);
						} else {
							sections.push(`### ${title}\n${result.output}`);
						}
						outputs.push({
							name: job.name,
							lane: job.laneId,
							refId: job.input.refId,
							ok: result.ok,
							output: result.output,
							errorMessage: result.errorMessage,
							turns: result.turns,
						});
					}
				} finally {
					await overlay?.close();
					signal?.removeEventListener("abort", relayAbort);
				}
			}

			if (failures === jobs.length) {
				throw new Error(
					`all reference analysis subagents failed (${failures}/${jobs.length})${model ? `\nIf the model selector "${model}" is unavailable, reset the reviewer confirmation (plans set-role, role=reviewer, resetConfirmation: true) — the next analyze_refs opens the native model panel to re-confirm.` : ""}`,
				);
			}

			const combined = sections.join("\n\n---\n\n");
			// v0.8.1: no head-truncation — the full combined analysis flows into the
		// tool result (and REF_ANALYSIS.md) verbatim; the previous 2000-line/
		// 50KB cap silently dropped the tail of large reference analyses.
			const text = combined;

			return {
				content: [
					{
						type: "text",
						text: `${modeIgnoredNotice ? `${modeIgnoredNotice}\n\n` : ""}${text}\n\n---\nPersist: paste each reference's analysis into REF_ANALYSIS.md, call the plans tool (record-ref) per reference with coverage and gaps filled from the analysis, then ask at least three ref-specific adoption questions per reference with ask_choice before using its ideas in PLAN_v1.md.`,
					},
				],
				details: {
					mode: "delegated-subagent",
					role: "ref-analyst",
					reviewerGates: { mode: initialReviewer.mode, modeIgnored: modeIgnoredNotice !== null, model, thinkingLevel: reviewer.thinking_level },
					batches: Math.ceil(jobs.length / BATCH_SIZE),
					model,
					outputs,
				},
			};
		},

		renderCall(args, theme) {
			const count = args.refs?.length ?? 0;
			let text = theme.fg("toolTitle", theme.bold("analyze_refs ")) + theme.fg("accent", `${count} ref${count === 1 ? "" : "s"}`);
			const first = args.refs?.[0]?.localPath;
			if (first) text += theme.fg("dim", `  ${first.split("/").pop() ?? first}${count > 1 ? ` +${count - 1}` : ""}`);
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
