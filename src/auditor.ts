/**
 * Execution reviewer (v0.8): when every task
 * reaches a terminal state, an independent read-only subagent verifies the
 * plan's verification checks against the worktree. Failed checks roll their
 * covered tasks back to pending (exclusively inside the review flow). The
 * loop is bounded at REVIEW_MAX_ROUNDS committed rounds; exhaustion pauses
 * the run for the user in every mode (fail-closed, never a hang and never a
 * silent stop) — only an explicit /plans-execute confirmation grants a fresh
 * budget.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { auditableChecks, skippedPassCheckIds, type TaskView } from "./tasks.ts";
import type { CheckItem } from "./plan.ts";
import { messaging } from "./messaging.ts";

/** Budget cap: committed rounds per user-granted budget. Discarded (fingerprint-changed) attempts do not count. */
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
	report: string;
}

/** Parse the verdict lines of an audit report against the checks that are
 * still pending. A pending check with no readable verdict is
 * `undeterminable`, never `failed` — the caller must be able to tell "the
 * work is wrong" apart from "I could not read the answer". */
export interface ParsedAudit {
	passed: string[];
	failed: string[];
	undeterminable: string[];
}

/** Checks this round must judge: auditable (covering at least one task) and
 * not already done. The brief and the coverage self-check both use this, so a
 * well-formed round-2 report that omits an already-done check is not mistaken
 * for a contract violation. */
export function auditablePendingChecks(checklist: CheckItem[], tasks: TaskView[]): CheckItem[] {
	return auditableChecks(checklist, tasks).filter((item) => !item.done);
}

/** Build the audit brief for the read-only subagent. Exported for tests. */
export function buildAuditTask(planPath: string, checklist: CheckItem[], tasks: TaskView[], round: number): string {
	const checks = auditablePendingChecks(checklist, tasks)
		.map((check) => `- \`${check.id}\`: ${check.text}`)
		.join("\n");
	return `Goal: verify that the implemented worktree satisfies the accepted plan's verification checks.

Target plan: ${planPath} (audit round ${round})

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, ls, and targeted commands (bash is not granted — rely on the read tools) before judging each check. Tests may be referenced from their recorded evidence; do not re-run them.

Checks to verify (only these; checks covering no task and checks already satisfied in an earlier round are excluded):

${checks}

Output: Markdown with exactly one section per check, in the order above:

- \`VC-###\` — verdict: pass | fail | undeterminable; evidence: <repo path/command proving it>; note: <one line>.

Emit every listed check exactly once. \`undeterminable\` is a legitimate answer: use it whenever the evidence is missing, unreadable, ambiguous, or beyond your read-only reach. Report \`fail\` only when you can point at the specific thing that breaks the condition — never report \`fail\` for want of evidence.`;
}

/** Parse the audit subagent's verdict lines. Exported for tests. */
export function parseAuditReport(report: string, pendingVcIds: string[]): ParsedAudit {
	const passed: string[] = [];
	const failed: string[] = [];
	const known = new Set(pendingVcIds.map((id) => id.toUpperCase()));
	// The auditor writes Markdown, so a verdict may carry emphasis
	// (`**pass**`, `*pass*`, `_pass_`, `` `pass` ``). Requiring a bare token
	// silently discarded such verdicts, and the caller's fail-closed rule then
	// marked every check failed and rolled the whole run back -- reporting
	// correct work as failure. Tolerate the markers; \b keeps `passed` and
	// `passing` from matching.
	for (const match of report.matchAll(/`?(VC-\d+)`?[^\n]*?verdict:\s*[*_`~]*\s*(pass|fail|undeterminable)\b/gi)) {
		const id = match[1].toUpperCase();
		if (!known.has(id)) continue;
		const verdict = match[2].toLowerCase();
		if (verdict === "pass") passed.push(id);
		else if (verdict === "fail") failed.push(id);
	}
	// A check with conflicting verdicts resolves to fail: the reader saw both.
	for (const id of [...new Set(passed)]) if (failed.includes(id)) passed.splice(passed.indexOf(id), 1);
	const undecided = new Set(known);
	for (const id of [...passed, ...failed]) undecided.delete(id);
	return { passed: [...new Set(passed)], failed: [...new Set(failed)], undeterminable: [...undecided] };
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
		model?: string;
		thinkingLevel?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		onProgress?: (event: import("./subagent.ts").SubagentProgressEvent) => void;
	},
): Promise<AuditRoundResult> {
	const { runPiSubagent } = await import("./subagent.ts");
	const pending = auditablePendingChecks(opts.checklist, opts.tasks);
	const task = buildAuditTask(opts.planPath, opts.checklist, opts.tasks, opts.round);
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
	const parsed = parseAuditReport(result.output, pending.map((item) => item.id));
	messaging().appendEntry("pi-plans-audit", {
		planPath: opts.planPath,
		round: opts.round,
		passed: parsed.passed,
		failed: parsed.failed,
		undeterminable: parsed.undeterminable,
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
