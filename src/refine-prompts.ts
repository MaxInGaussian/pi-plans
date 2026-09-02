export interface RefinePromptInput {
	planText: string;
	planPath: string;
	focus?: string;
	context?: string;
	lens?: string | null;
}

export interface ReviewerLane {
	id: string;
	lens: string | null;
}

export const REVIEWER_LENSES: readonly ReviewerLane[] = [
	{ id: "correctness", lens: "requirements fit and correctness of claims against the repository" },
	{ id: "ordering", lens: "architecture, sequencing, and dependency ordering" },
	{ id: "verification", lens: "verification rigor, risks, and evidence gaps" },
] as const;

function buildSharedHeader(role: "reviewer" | "criticizer", opts: RefinePromptInput): string {
	const lensLine = role === "reviewer" && opts.lens ? `\nReview lens: ${opts.lens}.` : "";
	const focusLine = opts.focus ? `\n\nSpecific concerns from the main agent: ${opts.focus}` : "";
	const contextLine = opts.context ? `\n\nContext: ${opts.context}` : "";
	return `Goal: ${role === "reviewer" ? "review the plan against the repository" : "stress-test the plan's assumptions"}.

Target: ${opts.planPath}

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, and ls before judging the plan.${lensLine}${focusLine}${contextLine}`;
}

/** Shared header for the post-execution implementation review: the
 * accepted plan is the contract, the IMPLEMENTATION in the worktree is
 * under review. Findings must anchor to the plan's goals/acceptance
 * criteria and explicitly assess delivery maturity. */
function buildImplementationSharedHeader(role: "reviewer" | "criticizer", opts: RefinePromptInput): string {
	const lensLine = role === "reviewer" && opts.lens ? `\nReview lens: ${opts.lens}.` : "";
	const focusLine = opts.focus ? `\n\nSpecific concerns from the main agent: ${opts.focus}` : "";
	const contextLine = opts.context ? `\n\nContext: ${opts.context}` : "";
	return `Goal: ${role === "reviewer" ? "review the implemented result in the worktree against the plan" : "stress-test the implemented result's assumptions"}.

Target: ${opts.planPath} (the accepted plan; the IMPLEMENTATION in the worktree is under review)

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, and ls before judging the implementation. Judge the implementation against the plan's goals, verifier checklist, and acceptance criteria. Explicitly assess delivery maturity: did the executor ship a minimal MVP only, or refine for long-term growth (no stopgaps, long-term architectural decisions, missing tests, technical debt, production readiness)? Calibrate severity accordingly. Out-of-scope improvement ideas are low severity by default and must not be forced into findings.${lensLine}${focusLine}${contextLine}`;
}

export function reviewerLanes(count: number): ReviewerLane[] {
	if (count === 3) return [...REVIEWER_LENSES];
	if (count === 2) return [...REVIEWER_LENSES.slice(0, 2)];
	return [{ id: "general", lens: null }];
}

export function buildReviewerTask(opts: RefinePromptInput): string {
	return `${buildSharedHeader("reviewer", opts)}

Success criteria: return evidence-backed findings or explicitly say the plan holds up.

Output: Markdown, highest severity first. For each finding use this shape:
- \`F-###\` — severity: high | medium | low; affected plan IDs (e.g. R-001, I-003); evidence: repo path/command or external source that proves it; impact; recommended fix; suggested disposition (accept | reject | needs-discussion).

Surface at most five high-priority findings; list lower-severity findings after them. If the plan holds up, say so explicitly and list what you checked.

Plan file: ${opts.planPath}

---8<--- PLAN CONTENT ---8<---
${opts.planText}
---8<--- END PLAN CONTENT ---8<---`;
}

export function buildCriticizerTask(opts: RefinePromptInput): string {
	return `${buildSharedHeader("criticizer", opts)}

Success criteria: return concrete, answerable questions only; never rewrite the plan.

Output: Markdown in exactly this shape:
1. A summary of your core criticism in at most three sentences, highlighting the single most important point.
2. Then at most five adaptive questions, numbered, each with one line of why it matters. Questions must be answerable by a user with repo access — never rhetorical. Stop earlier if the plan genuinely holds.

Plan file: ${opts.planPath}

---8<--- PLAN CONTENT ---8<---
${opts.planText}
---8<--- END PLAN CONTENT ---8<---`;
}

export function buildImplementationReviewerTask(opts: RefinePromptInput): string {
	return `${buildImplementationSharedHeader("reviewer", opts)}

Success criteria: return evidence-backed findings or explicitly say the implementation holds up.

Output: Markdown, highest severity first. For each finding use this shape:
- \`F-###\` — severity: high | medium | low; affected plan IDs (e.g. R-001, I-003) or files; evidence: repo path/command that proves it; impact; recommended fix; suggested disposition (accept | reject | needs-discussion).

Surface at most five high-priority findings; list lower-severity findings after them. If the implementation holds up, say so explicitly and list what you checked.

Plan file: ${opts.planPath}

---8<--- PLAN CONTENT ---8<---
${opts.planText}
---8<--- END PLAN CONTENT ---8<---`;
}

export function buildImplementationCriticizerTask(opts: RefinePromptInput): string {
	return `${buildImplementationSharedHeader("criticizer", opts)}

Success criteria: return concrete, answerable questions only; never rewrite the plan or the implementation.

Output: Markdown in exactly this shape:
1. A summary of your core criticism in at most three sentences, highlighting the single most important point.
2. Then at most five adaptive questions, numbered, each with one line of why it matters. Questions must be answerable by a user with repo access — never rhetorical. Stop earlier if the implementation genuinely holds.

Plan file: ${opts.planPath}

---8<--- PLAN CONTENT ---8<---
${opts.planText}
---8<--- END PLAN CONTENT ---8<---`;
}
