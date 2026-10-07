/**
 * Execution reviewer (v0.8): when every task
 * reaches a terminal state, an independent read-only subagent verifies the
 * plan's verification checks against the worktree. Failed checks roll their
 * covered tasks back to pending (exclusively inside the review flow). The
 * loop is bounded by the per-run review budget (v0.9.3: `ReviewBudget` in
 * ./review-budget.ts, chosen right before round 1 and stored in the run
 * checkpoint); exhaustion pauses the run for the user in every mode
 * (fail-closed, never a hang and never a silent stop) — only an explicit
 * /plans-execute confirmation grants a fresh budget.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { auditableChecks, flattenTaskViews, skippedPassCheckIds, type TaskView } from "./tasks.ts";
import { normalizeTaskId, type CheckItem } from "./plan.ts";
import { messaging } from "./messaging.ts";

/** Legacy fixed cap (v0.8–v0.9.2): the review-round budget is now a per-run
 * choice (`ReviewBudget` in ./review-budget.ts, default 3, pickable 1/2/3/5/
 * unlimited). This constant survives ONLY for checkpoints and tests written
 * against the old fixed budget — a pre-feature checkpoint that already spent
 * rounds keeps the 5-round bound (`LEGACY_REVIEW_MAX_ROUNDS`). It no longer
 * gates any round.
 * @deprecated use `resolveStoredBudget` / `budgetExhausted` from ./review-budget.ts */
export const REVIEW_MAX_ROUNDS = 5;

/** Legacy alias for one release: checkpoints and old builds still know this name. */
export const AUDIT_MAX_ROUNDS = REVIEW_MAX_ROUNDS;

export interface AuditOutcome {
	round: number;
	passed: string[];
	failed: string[];
	/** Checks whose report carried no readable verdict, or whose evidence was
	 * inconclusive. Never treated as `failed`: see src/exec.ts. */
	undeterminable: string[];
	/** Severity-graded implementation findings from this round (v0.9). Absent
	 * on legacy shapes means "no findings reported"; the parse boundary always
	 * sets a concrete array so hand-written construction sites cannot silently
	 * drop them. */
	findings?: ReviewFinding[];
	report: string;
}

/** Severity vocabulary for implementation findings; mirrors the plan
 * priority words. `malformed` marks a bullet the grammar parser could not
 * read — it is recorded and displayed but never drives a rollback. */
export type FindingSeverity = "high" | "medium" | "low" | "malformed";

export interface ReviewFinding {
	/** Stable id, normalized uppercase (`F-001`). Reused verbatim across
	 * rounds while the problem persists; absence from the newest round's
	 * report is the resolution signal. */
	id: string;
	severity: FindingSeverity;
	/** Task ids owning the defect (normalized), `[]` when unmapped. */
	taskIds: string[];
	/** Required for unmapped high findings: the runner appends this as a new
	 * plan task mechanically, so it must be a self-contained imperative title. */
	proposedTask?: string;
	note: string;
	evidence: string;
	/** Original bullet, for degraded records and round reports. */
	raw: string;
}

/** Parse the verdict lines of an audit report against the checks that are
 * still pending. A pending check with no readable verdict is
 * `undeterminable`, never `failed` — the caller must be able to tell "the
 * work is wrong" apart from "I could not read the answer". */
export interface ParsedAudit {
	passed: string[];
	failed: string[];
	undeterminable: string[];
	findings: ReviewFinding[];
}

/** One finding bullet's field-capture helper: lazily up to the next
 * `; <known-field>:` boundary or the end of the line, so free text in one
 * field cannot swallow the next. */
function captureField(line: string, field: string): string | undefined {
	const m = line.match(new RegExp(`${field}:\\s*(.*?)(?=;\\s*(?:severity|tasks|proposed-task|note|evidence):|$)`, "i"));
	return m ? m[1].trim().replace(/^[*_`~]+|[*_`~]+$/g, "") : undefined;
}

/** Parse the findings bullets of a review report. Degrade, never crash, never
 * roll back: a bullet with an F-### id but unreadable fields is recorded with
 * severity "malformed" (visible, non-blocking), exactly like the verdict
 * parser's emphasis tolerance — a strict grammar once silently discarded
 * verdicts and fail-closed rolled correct work back. */
export function parseFindings(report: string, knownTaskIds?: Set<string>): ReviewFinding[] {
	const findings: ReviewFinding[] = [];
	const seen = new Set<string>();
	for (const match of report.matchAll(/^\s*[-*]\s+`?(F-\d+)`?\b/gim)) {
		const id = match[1].toUpperCase();
		if (seen.has(id)) continue; // conflicting duplicates resolve to the first
		seen.add(id);
		// The bullet regex's leading \s* may swallow the preceding newline, so
		// slice(index) can start mid-whitespace; strip it before taking the line.
		const line = match.input!.slice(match.index!).replace(/^[\s]+/, "").split(/\n/)[0];
		const severityRaw = captureField(line, "severity")?.toLowerCase();
		const tasksRaw = captureField(line, "tasks");
		const taskIds = (tasksRaw ?? "")
			.split(/[,,，、]/)
			.map((token) => normalizeTaskId(token.trim()))
			.filter((t): t is string => t !== null)
			.filter((t) => !knownTaskIds || knownTaskIds.has(t));
		const severity: FindingSeverity =
			severityRaw === "high" || severityRaw === "medium" || severityRaw === "low" ? severityRaw : "malformed";
		if (severity === "malformed" || !tasksRaw) {
			// Unreadable severity, or the grammar's mandatory tasks field missing:
			// degrade to a recorded non-blocking entry.
			findings.push({ id, severity: "malformed", taskIds: [], note: captureField(line, "note") ?? line.trim(), evidence: captureField(line, "evidence") ?? "", raw: line.trim() });
			continue;
		}
		findings.push({
			id,
			severity,
			taskIds,
			proposedTask: captureField(line, "proposed-task") || undefined,
			note: captureField(line, "note") ?? "",
			evidence: captureField(line, "evidence") ?? "",
			raw: line.trim(),
		});
	}
	return findings;
}

/** Checks this round must judge: auditable (covering at least one task) and
 * not already done. The brief and the coverage self-check both use this, so a
 * well-formed round-2 report that omits an already-done check is not mistaken
 * for a contract violation. */
export function auditablePendingChecks(checklist: CheckItem[], tasks: TaskView[]): CheckItem[] {
	return auditableChecks(checklist, tasks).filter((item) => !item.done);
}

// ---------------------------------------------------------------------------
// Multi-reviewer rounds: lanes, directions, merge
// ---------------------------------------------------------------------------

/** A complementary direction one reviewer digs into beyond its VC share. */
export interface ReviewDirection {
	/** Short slug; becomes the fleet lane id and the report section title. */
	id: string;
	direction: string;
}

/** Largest number of parallel reviewers one round may use. */
export const MAX_REVIEWERS = 3;

/** Fixed aspects used when the executor suggested no (or too few) directions. */
export const BACKUP_REVIEW_ASPECTS: readonly ReviewDirection[] = [
	{
		id: "correctness-vs-plan",
		direction:
			"Does the implementation actually do what each task and the plan's intent say? Trace the main flows through the changed code and look for wrong behavior, missed requirements, edge cases and regressions in neighbouring code.",
	},
	{
		id: "tests-and-evidence",
		direction:
			"Do the tests and recorded evidence really prove the verification checks? Look for assertions that cannot fail, untested branches and error paths, fixtures that mask the defect, and claims in task evidence that the code does not back up.",
	},
	{
		id: "integration-and-risk",
		direction:
			"What can the change break outside the files it touched? Check callers and consumers, configuration and compatibility, failure and degraded modes, concurrency and ordering, security and permissions, and leftover debug or half-finished code.",
	},
];

/** Directions for `count` reviewers: valid executor suggestions first (in the
 * order given, ids unique), topped up from the back-up aspects. One reviewer
 * keeps today's undirected brief, so the result is empty. */
export function resolveReviewerDirections(count: number, suggested: readonly ReviewDirection[] | undefined): ReviewDirection[] {
	if (count <= 1) return [];
	const chosen: ReviewDirection[] = [];
	const used = new Set<string>();
	for (const entry of suggested ?? []) {
		if (chosen.length >= count) break;
		if (!entry || used.has(entry.id)) continue;
		used.add(entry.id);
		chosen.push({ id: entry.id, direction: entry.direction });
	}
	for (const aspect of BACKUP_REVIEW_ASPECTS) {
		if (chosen.length >= count) break;
		if (used.has(aspect.id)) continue;
		used.add(aspect.id);
		chosen.push({ ...aspect });
	}
	return chosen;
}

/** Split `items` into `parts` balanced contiguous chunks (sizes differ by at
 * most one, larger chunks first, order preserved). */
export function splitEvenly<T>(items: readonly T[], parts: number): T[][] {
	const count = Math.max(1, Math.floor(parts));
	const base = Math.floor(items.length / count);
	const extra = items.length % count;
	const chunks: T[][] = [];
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const size = base + (i < extra ? 1 : 0);
		chunks.push(items.slice(offset, offset + size));
		offset += size;
	}
	return chunks;
}

/** One reviewer of a multi-reviewer round. */
export interface AuditLane {
	/** Fleet lane id (the direction id). */
	id: string;
	index: number;
	total: number;
	direction: ReviewDirection;
	/** Directions of the other reviewers of this round. */
	others: ReviewDirection[];
	/** This reviewer's share of the pending checks. */
	checks: CheckItem[];
	/** First finding number this reviewer may use for brand-new findings;
	 * ranges are disjoint across reviewers so merged ids never collide. */
	findingIdStart: number;
}

/**
 * Plan the lanes of a round: the pending checks are divided evenly, one lane per
 * reviewer, never more lanes than checks (a reviewer with nothing to verify
 * would only duplicate another's findings). With no pending check (the round is
 * owed only by unresolved findings) every reviewer runs as a findings-only lane.
 * One reviewer → no lanes (the unchanged single-reviewer path).
 */
export function planReviewLanes(
	pending: CheckItem[],
	count: number,
	suggested: readonly ReviewDirection[] | undefined,
	priorFindings: ReviewFinding[] = [],
): AuditLane[] {
	const wanted = Math.max(1, Math.min(MAX_REVIEWERS, Math.floor(count)));
	if (wanted <= 1) return [];
	const total = pending.length > 0 ? Math.min(wanted, pending.length) : wanted;
	if (total <= 1) return [];
	const directions = resolveReviewerDirections(total, suggested);
	const shares = splitEvenly(pending, total);
	const maxPrior = priorFindings.reduce((max, finding) => {
		const match = /^F-(\d+)$/.exec(finding.id);
		return match ? Math.max(max, Number(match[1])) : max;
	}, 0);
	const base = maxPrior === 0 ? 0 : Math.ceil(maxPrior / 100) * 100;
	return directions.map((direction, index) => ({
		id: direction.id,
		index,
		total,
		direction,
		others: directions.filter((_, other) => other !== index),
		checks: shares[index] ?? [],
		findingIdStart: base + index * 100 + 1,
	}));
}

function findingId(n: number): string {
	return `F-${String(n).padStart(3, "0")}`;
}

function laneBlock(lane: AuditLane): string {
	const others = lane.others.map((entry) => `- ${entry.id}: ${entry.direction}`).join("\n");
	return `

You are reviewer ${lane.index + 1} of ${lane.total} in a parallel review round. The pending verification checks are divided evenly between the reviewers: verify only your share (listed below). Every reviewer also looks for defects and improvements beyond the checks, each along its own direction.

Your direction (${lane.direction.id}): ${lane.direction.direction}
Go deeper here than a generic review would. Do not pad the report with generic coverage of other aspects, but if you stumble on a high-severity problem outside your direction, report it briefly.

The other reviewers cover different directions — do not duplicate them:
${others}

Finding ids: number brand-new findings from ${findingId(lane.findingIdStart)} upward (${findingId(lane.findingIdStart)}, ${findingId(lane.findingIdStart + 1)}, …); the other reviewers use disjoint ranges. A listed unresolved finding keeps its id.`;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 3, medium: 2, low: 1, malformed: 0 };

/** One finished lane, as the merge consumes it. */
export interface LaneRun {
	lane: AuditLane;
	ok: boolean;
	cancelled?: boolean;
	output: string;
	error?: string;
}

/**
 * Merge the lane reports of one round into a single outcome, so everything
 * downstream (rollback, findings, budget) sees exactly one round.
 *  - any cancelled lane → the whole round is cancelled (nothing committed);
 *  - every lane failed → `null` (the spawn-failed path);
 *  - a failed lane makes only ITS checks undeterminable;
 *  - findings reported by several lanes under one id collapse to one entry
 *    (highest severity, task ids united).
 */
export function mergeLaneRuns(round: number, runs: LaneRun[], knownTaskIds?: Set<string>): AuditRoundResult {
	if (runs.some((run) => run.cancelled)) return { cancelled: true };
	if (runs.length > 0 && runs.every((run) => !run.ok)) return null;
	const passed: string[] = [];
	const failed: string[] = [];
	const undeterminable: string[] = [];
	const byId = new Map<string, ReviewFinding>();
	const sections: string[] = [];
	for (const run of runs) {
		const heading = `## Reviewer ${run.lane.index + 1}/${run.lane.total} — ${run.lane.direction.id}${run.lane.checks.length ? ` (${run.lane.checks.map((check) => check.id).join(", ")})` : ""}`;
		if (!run.ok) {
			undeterminable.push(...run.lane.checks.map((check) => check.id));
			sections.push(`${heading}\n\n(this reviewer failed to run: ${run.error ?? "unknown error"} — its checks are undeterminable)`);
			continue;
		}
		const parsed = parseAuditReport(run.output, run.lane.checks.map((check) => check.id), knownTaskIds);
		passed.push(...parsed.passed);
		failed.push(...parsed.failed);
		undeterminable.push(...parsed.undeterminable);
		for (const finding of parsed.findings) {
			const existing = byId.get(finding.id);
			if (!existing) {
				byId.set(finding.id, finding);
				continue;
			}
			const winner = SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity] ? finding : existing;
			byId.set(finding.id, { ...winner, taskIds: [...new Set([...existing.taskIds, ...finding.taskIds])], proposedTask: winner.proposedTask ?? existing.proposedTask ?? finding.proposedTask });
		}
		sections.push(`${heading}\n\n${run.output.trim()}`);
	}
	const report = runs.length === 1 ? (runs[0]!.ok ? runs[0]!.output : sections[0]!) : sections.join("\n\n");
	// A check with conflicting verdicts across lanes resolves to fail (cannot
	// happen with disjoint shares; defensive for a lane naming a foreign check).
	const failedSet = new Set(failed);
	return applyAuditOutcome(round, {
		passed: [...new Set(passed)].filter((id) => !failedSet.has(id)),
		failed: [...failedSet],
		undeterminable: [...new Set(undeterminable)].filter((id) => !failedSet.has(id) && !passed.includes(id)),
		findings: [...byId.values()],
	}, report);
}

/** Build the audit brief for the read-only subagent. Exported for tests. */
export function buildAuditTask(
	planPath: string,
	checklist: CheckItem[],
	tasks: TaskView[],
	round: number,
	priorFindings: ReviewFinding[] = [],
	/** v0.10: per-finding disposition resolved by the caller (`fixed …` /
	 * `deferred: <reason>` / `repair claimed — still reported` / `unresolved`),
	 * so the reviewer sees how the executor answered the previous round. */
	dispositions?: ReadonlyMap<string, string>,
	/** Multi-reviewer rounds: this reviewer's share of the checks and its
	 * assigned direction. Absent = the single reviewer judges every check. */
	lane?: AuditLane,
): string {
	const checkList = lane ? lane.checks : auditablePendingChecks(checklist, tasks);
	const checks = checkList.length > 0
		? checkList.map((check) => `- \`${check.id}\`: ${check.text}`).join("\n")
		: "(none — the other reviewers verify the checks; you report implementation findings only, and section 1 is the single line `- none.`)";
	const taskList = flattenTaskViews(tasks)
		.map((t) => `- \`${t.id}\`: ${t.title} (${t.status})`)
		.join("\n");
	const prior = priorFindings.length
			? `Unresolved findings from earlier rounds (reuse these exact ids while the problem persists; a problem is resolved only by no longer reporting it):

${priorFindings.map((f) => `- \`${f.id}\` — severity: ${f.severity}; tasks: ${f.taskIds.join(", ") || "none"}; note: ${f.note}${dispositions?.get(f.id) ? `; disposition: ${dispositions.get(f.id)}` : ""}`).join("\n")}`
			: "(none — this is the first round with findings in scope)";
	return `Goal: verify that the implemented worktree satisfies the accepted plan's verification checks, and report implementation findings that drive the fix loop.

Target plan: ${planPath} (review round ${round})${lane ? laneBlock(lane) : ""}

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, ls, and targeted commands (bash is not granted — rely on the read tools) before judging each check. Tests may be referenced from their recorded evidence; do not re-run them.

Checks to verify (only these${lane ? "; the other reviewers verify the remaining checks, so emit no verdict for any check not listed here" : ""}; checks covering no task and checks already satisfied in an earlier round are excluded):

${checks}

Plan tasks (the only ids valid in a finding's tasks field):

${taskList}

${prior}

Output: exactly two sections, in this order.

1. Verification verdicts — one section per check, in the order above:

- \`VC-###\` — verdict: pass | fail | undeterminable; evidence: <repo path/command proving it>; note: <one line>.

Emit every listed check exactly once. \`undeterminable\` is a legitimate answer: use it whenever the evidence is missing, unreadable, ambiguous, or beyond your read-only reach. Report \`fail\` only when you can point at the specific thing that breaks the condition — never report \`fail\` for want of evidence.

2. Implementation findings — one bullet per defect anywhere in the implemented change (not only what the checks cover), exact line grammar:

- \`F-###\` — severity: high | medium | low; tasks: Task-N, Task-M | none; proposed-task: <imperative one-line title>; note: <one line>; evidence: <repo path or quoted excerpt>

\`high\` wakes the executor for a fix round, and so do \`medium\`/\`low\`: each reported finding gets a repair task (a \`medium\` may reopen its mapped tasks) and the run wakes the executor for one non-high repair cycle per version before any left-over finding is disclosed. When no existing task owns the defect use \`tasks: none\` and (required for high) a self-contained \`proposed-task:\` title. If nothing is worth reporting, emit exactly \`- none.\` under the findings heading.`;
}

/** Parse the audit subagent's verdict lines. Exported for tests. */
export function parseAuditReport(report: string, pendingVcIds: string[], knownTaskIds?: Set<string>): ParsedAudit {
	const passed: string[] = [];
	const failed: string[] = [];
	const known = new Set(pendingVcIds.map((id) => id.toUpperCase()));
	// The reviewer writes Markdown, so a verdict may carry emphasis
	// (`**pass**`, `*pass*`, `_pass_`, `` `pass` ``). Requiring a bare token
	// silently discarded such verdicts, and the caller's fail-closed rule then
	// marked every check failed and rolled the whole run back -- reporting
	// correct work as failure. Tolerate the markers; \b keeps `passed` and
	// `passing` from matching.
	// v0.9: finding bullets (F-###) are excluded from verdict scanning — a
	// finding's note may cite a VC id, and that must never register a verdict.
	// v0.9.1 (F-011): the contract promises "one section per check" and an
	// equally literal reading puts the id in a `### VC-###` heading with the
	// verdict on a line of its own below it. The old same-line-only scan
	// parsed such reports to ZERO verdicts and burned whole budgets as
	// undeterminable. The scan is now section-aware: a line that NAMES a
	// known check at a heading/bullet start opens that check's section, and a
	// bare `verdict:` token attributes to the nearest open section; an
	// id-and-verdict pair on one line stays direct.
	const record = (id: string, verdict: string): void => {
		if (verdict === "pass") passed.push(id);
		else if (verdict === "fail") failed.push(id);
	};
	const verdictToken = /verdict:\s*[*_`~]*\s*(pass|fail|undeterminable)\b/i;
	let current: string | null = null;
	for (const line of report.split(/\n/)) {
		if (/^\s*[-*]\s+`?F-\d+`?\b/i.test(line)) continue; // finding bullet
		const sectionId = line.match(/^\s*(?:#{1,6}\s+|[-*]\s+)?`?(VC-\d+)`?\b/i);
		if (sectionId) {
			const id = sectionId[1].toUpperCase();
			if (known.has(id)) current = id;
		}
		const direct = line.match(/`?(VC-\d+)`?[^\n]*?verdict:\s*[*_`~]*\s*(pass|fail|undeterminable)\b/i);
		if (direct) {
			const id = direct[1].toUpperCase();
			if (known.has(id)) record(id, direct[2].toLowerCase());
			continue;
		}
		const bare = line.match(verdictToken);
		if (bare && current) record(current, bare[1].toLowerCase());
	}
	// A check with conflicting verdicts resolves to fail: the reader saw both.
	for (const id of [...new Set(passed)]) if (failed.includes(id)) passed.splice(passed.indexOf(id), 1);
	const undecided = new Set(known);
	for (const id of [...passed, ...failed]) undecided.delete(id);
	return { passed: [...new Set(passed)], failed: [...new Set(failed)], undeterminable: [...undecided], findings: parseFindings(report, knownTaskIds) };
}

/** Pure decision core: classify a parsed report into the audit outcome. It
 * touches neither the checklist nor the task tree — the caller owns writing
 * `done` and computing the rollback set, so there is exactly one authority for
 * both. Exported for tests. */
export function applyAuditOutcome(round: number, parsed: ParsedAudit, report: string): AuditOutcome {
	return {
		round,
		passed: parsed.passed,
		failed: parsed.failed,
		undeterminable: parsed.undeterminable,
		findings: parsed.findings,
		report,
	};
}

/** Skipped-pass checks (all covered tasks skipped) pass without audit. */
export function presolvedCheckIds(checklist: CheckItem[], tasks: TaskView[]): string[] {
	return skippedPassCheckIds(checklist, tasks);
}

/** Spawn the audit subagent and classify its report. Returns `{ cancelled: true }`
 * when the child was aborted (session shutdown, stop, restore, tree switch) —
 * such a round burns no budget and sends no wake; `null` when the subagent
 * itself failed to run (treated as an all-undeterminable committed round; the
 * caller counts it against the round cap). */
export type AuditRoundResult = AuditOutcome | { cancelled: true } | null;

export async function runCompletionAudit(
	ctx: ExtensionContext,
	opts: {
		planPath: string;
		checklist: CheckItem[];
		tasks: TaskView[];
		round: number;
		/** Unresolved findings from earlier committed rounds, injected into
		 * the brief so the reviewer reuses stable ids (v0.9). */
		priorFindings?: ReviewFinding[];
		/** v0.10: per-finding disposition text injected beside each prior
		 * finding, so a deliberate decline (`deferred: …`) is visible. */
		findingDispositions?: ReadonlyMap<string, string>;
		model?: string;
		thinkingLevel?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		onProgress?: (event: import("./subagent.ts").SubagentProgressEvent) => void;
		/** Multi-reviewer round (from `planReviewLanes`): one session per lane,
		 * run in parallel. Absent/empty = the single-reviewer path. */
		lanes?: AuditLane[];
		/** Progress of one lane's session (multi-reviewer rounds). */
		onLaneProgress?: (laneId: string, event: import("./subagent.ts").SubagentProgressEvent) => void;
		/** A lane's session finished (multi-reviewer rounds). */
		onLaneResult?: (laneId: string, result: import("./subagent.ts").SubagentResult) => void;
	},
): Promise<AuditRoundResult> {
	const { runAgentSession, agentHostOf } = await import("./agent-session.ts");
	const pending = auditablePendingChecks(opts.checklist, opts.tasks);
	// agents/auditor.md, not agents/reviewer.md: the reviewer prompt mandates a
	// plan-review shape (`## Findings` / `## Questions`, F-###) and never says
	// "verdict", so auditing under it produced reports this parser could not
	// read at all -- every check then fell through to fail-closed.
	// v0.8: a missing agent definition is a hard error — the silent inline
	// fallback once swapped in a minimal prompt that produced unparsable
	// reports and burned whole audit budgets as undeterminable.
	const agentPrompt = fs.readFileSync(new URL("../agents/execution-reviewer.md", import.meta.url), "utf8");
	const knownTaskIds = new Set(flattenTaskViews(opts.tasks).map((t) => t.id));
	const lanes = opts.lanes ?? [];
	const base = {
		systemPrompt: agentPrompt,
		cwd: ctx.cwd,
		host: agentHostOf(ctx),
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		timeoutMs: opts.timeoutMs,
		tools: ["read", "grep", "find", "ls"],
		signal: opts.signal,
	};

	if (lanes.length > 1) {
		const runs = await Promise.all(
			lanes.map(async (lane): Promise<LaneRun> => {
				const result = await runAgentSession({
					...base,
					task: buildAuditTask(opts.planPath, opts.checklist, opts.tasks, opts.round, opts.priorFindings ?? [], opts.findingDispositions, lane),
					onProgress: (event) => opts.onLaneProgress?.(lane.id, event),
				});
				try {
					opts.onLaneResult?.(lane.id, result);
				} catch {
					/* a display sink must not fail the round */
				}
				return { lane, ok: result.ok, cancelled: result.cancelled === true, output: result.output, error: result.errorMessage };
			}),
		);
		const merged = mergeLaneRuns(opts.round, runs, knownTaskIds);
		if (merged === null || "cancelled" in merged) return merged;
		messaging().appendEntry("pi-plans-audit", {
			planPath: opts.planPath,
			round: opts.round,
			reviewers: lanes.length,
			passed: merged.passed,
			failed: merged.failed,
			undeterminable: merged.undeterminable,
			highFindings: (merged.findings ?? []).filter((f) => f.severity === "high").map((f) => f.id),
		});
		return merged;
	}

	const result = await runAgentSession({
		...base,
		task: buildAuditTask(opts.planPath, opts.checklist, opts.tasks, opts.round, opts.priorFindings ?? [], opts.findingDispositions),
		onProgress: opts.onProgress,
	});
	if (!result.ok) {
		if (result.cancelled === true) return { cancelled: true };
		return null;
	}
	const parsed = parseAuditReport(result.output, pending.map((item) => item.id), knownTaskIds);
	messaging().appendEntry("pi-plans-audit", {
		planPath: opts.planPath,
		round: opts.round,
		passed: parsed.passed,
		failed: parsed.failed,
		undeterminable: parsed.undeterminable,
		highFindings: parsed.findings.filter((f) => f.severity === "high").map((f) => f.id),
	});
	return applyAuditOutcome(opts.round, parsed, result.output);
}

/** Persist one review-round attempt under `<run-dir>/execution-review/`.
 * The attempt index (not the budget round) names the file, so a discarded
 * attempt's evidence survives its re-run: round-<budgetRound>-attempt-<k>.md.
 * These files are the only cross-session record of what a round saw — the
 * in-flight marker itself is memory-only. Best-effort: an unwritable run dir
 * must never fail the loop itself. */
export function writeReviewRoundReport(
	runDir: string,
	entry: {
		/** plan-huge: version label — reports land in a version subdirectory. */
		versionSegment?: string;
		budgetRound: number;
		attempt: number;
		outcome: "passed" | "failed" | "undeterminable" | "discarded" | "spawn-failed" | "cancelled";
		passed: string[];
		failed: string[];
		undeterminable: string[];
		/** v0.9 findings from this round; recorded in the round report so the
		 * file stays the full evidence record. */
		findings?: ReviewFinding[];
		discardedReason?: string;
		fingerprintCaptured?: string;
		fingerprintFound?: string;
		coveredTaskIds: string[];
		report: string;
	},
): string | null {
	try {
		const dir = entry.versionSegment
			? path.join(runDir, "execution-review", entry.versionSegment)
			: path.join(runDir, "execution-review");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `round-${entry.budgetRound}-attempt-${entry.attempt}.md`);
		const lines = [
			`# Execution review round ${entry.budgetRound} (attempt ${entry.attempt})`,
			"",
			`- outcome: ${entry.outcome}`,
			`- passed: ${entry.passed.join(", ") || "(none)"}`,
			`- failed: ${entry.failed.join(", ") || "(none)"}`,
			`- undeterminable: ${entry.undeterminable.join(", ") || "(none)"}`,
			`- high findings: ${entry.findings?.filter((f) => f.severity === "high").map((f) => f.id).join(", ") || "(none)"}`,
			...(entry.findings?.length ? [`- findings: ${entry.findings.map((f) => `${f.id} (${f.severity}${f.proposedTask ? "; proposed: " + f.proposedTask : ""})`).join(" | ")}`] : []),
			...(entry.discardedReason ? [`- discarded: ${entry.discardedReason}`] : []),
			`- fingerprint (captured): ${entry.fingerprintCaptured ?? "(n/a)"}`,
			`- fingerprint (at resolve): ${entry.fingerprintFound ?? "(n/a)"}`,
			`- covered tasks: ${entry.coveredTaskIds.join(", ") || "(none)"}`,
			"",
			"## Report",
			"",
			entry.report,
			"",
		];
		fs.writeFileSync(file, lines.join("\n"), "utf8");
		return file;
	} catch {
		return null;
	}
}
