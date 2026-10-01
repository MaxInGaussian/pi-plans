/**
 * Completion auditor (v0.6.1): when every task reaches a terminal state, an
 * independent read-only subagent verifies the plan's verification checks
 * against the worktree. Failed checks roll their covered tasks back to
 * pending (exclusively inside the audit flow); three failed rounds pause the
 * run for the user — or terminate it as stopped under auto-approve/headless
 * so pipelines never hang.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { auditRollbackSet, auditableChecks, skippedPassCheckIds, type TaskView } from "./tasks.ts";
import type { CheckItem } from "./plan.ts";
import { messaging } from "./messaging.ts";

export const AUDIT_MAX_ROUNDS = 3;

export interface AuditOutcome {
	round: number;
	passed: string[];
	failed: string[];
	/** Rolled-back task ids (empty when the audit passed). */
	rolledBack: string[];
	report: string;
}

/** Build the audit brief for the read-only subagent. Exported for tests. */
export function buildAuditTask(planPath: string, checklist: CheckItem[], tasks: TaskView[], round: number): string {
	const checks = auditableChecks(checklist, tasks)
		.map((check) => `- \`${check.id}\`: ${check.text}`)
		.join("\n");
	return `Goal: verify that the implemented worktree satisfies the accepted plan's verification checks.

Target plan: ${planPath} (audit round ${round})

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, ls, and targeted commands (bash is not granted — rely on the read tools) before judging each check. Tests may be referenced from their recorded evidence; do not re-run them.

Checks to verify (only these; checks covering no task are excluded):

${checks}

Output: Markdown with exactly one section per check, in checklist order:

- \`VC-###\` — verdict: pass | fail; evidence: <repo path/command proving it>; note: <one line>.

Every check needs a verdict backed by evidence you actually inspected. If the evidence is inconclusive, verdict is fail with what is missing.`;
}

/** Parse the audit subagent's verdict lines. Exported for tests. */
export function parseAuditReport(report: string, checklist: CheckItem[]): { passed: string[]; failed: string[] } {
	const passed: string[] = [];
	const failed: string[] = [];
	const known = new Set(checklist.map((item) => item.id));
	// The reviewer agent writes Markdown, so a verdict may carry emphasis
	// (`**pass**`, `*pass*`, `_pass_`, `` `pass` ``). Requiring a bare token
	// silently discarded such verdicts, and the caller's fail-closed rule then
	// marked every check failed and rolled the whole run back -- reporting
	// correct work as failure. Tolerate the markers; \b keeps `passed` and
	// `passing` from matching.
	for (const match of report.matchAll(/`?(VC-\d+)`?[^\n]*?verdict:\s*[*_`~]*\s*(pass|fail)\b/gi)) {
		const id = match[1].toUpperCase();
		if (!known.has(id)) continue;
		(match[2].toLowerCase() === "pass" ? passed : failed).push(id);
	}
	// Dedupe, keep first occurrence order; a check with conflicting verdicts fails.
	for (const id of [...passed]) if (failed.includes(id)) passed.splice(passed.indexOf(id), 1);
	return { passed: [...new Set(passed)], failed: [...new Set(failed)] };
}

/** Pure decision core: given a parsed report, mutate the task tree with the
 * rollback set. Returns the outcome (rolled-back ids). Exported for tests. */
export function applyAuditOutcome(
	checklist: CheckItem[],
	tasks: TaskView[],
	round: number,
	passed: string[],
	failed: string[],
	report: string,
): AuditOutcome {
	for (const id of passed) {
		const item = checklist.find((candidate) => candidate.id === id);
		if (item) item.done = true;
	}
	const rolledBack: string[] = [];
	for (const id of failed) {
		rolledBack.push(...auditRollbackSet(tasks, checklist, id));
	}
	return { round, passed, failed, rolledBack, report };
}

/** Skipped-pass checks (all covered tasks skipped) pass without audit. */
export function presolvedCheckIds(checklist: CheckItem[], tasks: TaskView[]): string[] {
	return skippedPassCheckIds(checklist, tasks);
}

/** Spawn the audit subagent and apply its outcome. Returns null when the
 * audit subagent itself failed to run (treated as a failed round with an
 * empty rollback; the caller counts it against the round cap). */
export async function runCompletionAudit(
	ctx: ExtensionContext,
	opts: {
		planPath: string;
		checklist: CheckItem[];
		tasks: TaskView[];
		round: number;
		model?: string;
		signal?: AbortSignal;
	},
): Promise<AuditOutcome | null> {
	const { runPiSubagent } = await import("./subagent.ts");
	const task = buildAuditTask(opts.planPath, opts.checklist, opts.tasks, opts.round);
	let agentPrompt = "You are a read-only completion auditor for pi-plans.";
	try {
		agentPrompt = fs.readFileSync(new URL("../agents/reviewer.md", import.meta.url), "utf8");
	} catch {
		/* fall back to the inline prompt */
	}
	const result = await runPiSubagent({
		systemPrompt: `${agentPrompt}\n\nYou are acting as the completion auditor; the task brief below defines the output contract.`,
		task,
		cwd: ctx.cwd,
		model: opts.model,
		tools: ["read", "grep", "find", "ls"],
		signal: opts.signal,
	});
	if (!result.ok) return null;
	const { passed, failed } = parseAuditReport(result.output, opts.checklist);
	messaging().appendEntry("pi-plans-audit", { planPath: opts.planPath, round: opts.round, passed, failed });
	return applyAuditOutcome(opts.checklist, opts.tasks, opts.round, passed, failed, result.output);
}
