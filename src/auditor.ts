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

/** Build the audit brief for the read-only subagent. Exported for tests. */
export function buildAuditTask(
	planPath: string,
	checklist: CheckItem[],
	tasks: TaskView[],
	round: number,
	priorFindings: ReviewFinding[] = [],
): string {
	const checks = auditablePendingChecks(checklist, tasks)
		.map((check) => `- \`${check.id}\`: ${check.text}`)
		.join("\n");
	const taskList = flattenTaskViews(tasks)
		.map((t) => `- \`${t.id}\`: ${t.title} (${t.status})`)
		.join("\n");
	const prior = priorFindings.length
			? `Unresolved findings from earlier rounds (reuse these exact ids while the problem persists; a problem is resolved only by no longer reporting it):

${priorFindings.map((f) => `- \`${f.id}\` — severity: ${f.severity}; tasks: ${f.taskIds.join(", ") || "none"}; note: ${f.note}`).join("\n")}`
			: "(none — this is the first round with findings in scope)";
	return `Goal: verify that the implemented worktree satisfies the accepted plan's verification checks, and report implementation findings that drive the fix loop.

Target plan: ${planPath} (review round ${round})

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, ls, and targeted commands (bash is not granted — rely on the read tools) before judging each check. Tests may be referenced from their recorded evidence; do not re-run them.

Checks to verify (only these; checks covering no task and checks already satisfied in an earlier round are excluded):

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

\`high\` wakes the executor for a fix round; \`medium\`/\`low\` are recorded. When no existing task owns the defect use \`tasks: none\` and (required for high) a self-contained \`proposed-task:\` title. If nothing is worth reporting, emit exactly \`- none.\` under the findings heading.`;
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
		model?: string;
		thinkingLevel?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		onProgress?: (event: import("./subagent.ts").SubagentProgressEvent) => void;
	},
): Promise<AuditRoundResult> {
	const { runPiSubagent } = await import("./subagent.ts");
	const pending = auditablePendingChecks(opts.checklist, opts.tasks);
	const task = buildAuditTask(opts.planPath, opts.checklist, opts.tasks, opts.round, opts.priorFindings ?? []);
	// agents/auditor.md, not agents/reviewer.md: the reviewer prompt mandates a
	// plan-review shape (`## Findings` / `## Questions`, F-###) and never says
	// "verdict", so auditing under it produced reports this parser could not
	// read at all -- every check then fell through to fail-closed.
	// v0.8: a missing agent definition is a hard error — the silent inline
	// fallback once swapped in a minimal prompt that produced unparsable
	// reports and burned whole audit budgets as undeterminable.
	const agentPrompt = fs.readFileSync(new URL("../agents/execution-reviewer.md", import.meta.url), "utf8");
	const result = await runPiSubagent({
		systemPrompt: agentPrompt,
		task,
		cwd: ctx.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		timeoutMs: opts.timeoutMs,
		tools: ["read", "grep", "find", "ls"],
		signal: opts.signal,
		onProgress: opts.onProgress,
	});
	if (!result.ok) {
		if (result.cancelled === true) return { cancelled: true };
		return null;
	}
	const parsed = parseAuditReport(result.output, pending.map((item) => item.id), new Set(flattenTaskViews(opts.tasks).map((t) => t.id)));
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
		const dir = path.join(runDir, "execution-review");
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
