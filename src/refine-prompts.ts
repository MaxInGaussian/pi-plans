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

function buildSharedHeader(opts: RefinePromptInput): string {
	const lensLine = opts.lens ? `\nReview lens: ${opts.lens}.` : "";
	const focusLine = opts.focus ? `\n\nSpecific concerns from the main agent: ${opts.focus}` : "";
	const contextLine = opts.context ? `\n\nContext: ${opts.context}` : "";
	return `Goal: review the plan against the repository and surface what needs the user's judgment.

Target: ${opts.planPath}

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, and ls before judging the plan.${lensLine}${focusLine}${contextLine}`;
}

export function reviewerLanes(count: number): ReviewerLane[] {
	if (count === 3) return [...REVIEWER_LENSES];
	if (count === 2) return [...REVIEWER_LENSES.slice(0, 2)];
	return [{ id: "general", lens: null }];
}

export function buildReviewerTask(opts: RefinePromptInput): string {
	return `${buildSharedHeader(opts)}

Success criteria: return evidence-backed findings, plus the questions only the user can settle. If the plan holds up, say so explicitly and list what you checked.

Output: Markdown with exactly two top-level parts, in this order.

## Findings

Highest severity first. For each finding use this shape:
- \`F-###\` — severity: high | medium | low; affected plan IDs (e.g. R-001, I-003); evidence: repo path/command or external source that proves it; impact; recommended fix; suggested disposition (accept | reject | needs-discussion).

Surface at most five high-priority findings; list lower-severity findings after them. Write "None." when there are none.

## Questions

At most five numbered questions (\`Q-1\`, \`Q-2\`, …) covering everything that needs the user's decision before the plan can be safely revised — hidden trade-offs, undetermined semantics, accept/reject calls on findings marked needs-discussion. Each question gets one line of why it matters, phrased so a user with repo access can answer it concretely. Never rhetorical; never questions the repository itself already answers. Stop earlier if nothing genuinely needs the user.

Plan file: ${opts.planPath}

---8<--- PLAN CONTENT ---8<---
${opts.planText}
---8<--- END PLAN CONTENT ---8<---`;
}

export interface RefAnalystTaskInput {
	refId: string;
	localPath: string;
	title?: string;
	url?: string;
	kind?: string;
	context?: string;
	languageTag?: string | null;
}

const REF_ANALYST_SECTIONS = [
	"Overview",
	"Key Mechanisms And Design Tradeoffs",
	"Adoptable Ideas For The Target Repo",
	"Pitfalls And Anti-Patterns",
	"Evidence Citations",
	"Coverage",
	"Evidence Gaps",
] as const;

export function refAnalystSections(): readonly string[] {
	return REF_ANALYST_SECTIONS;
}

/** Task brief for the plan-with-refs per-reference analysis subagent. */
export function buildRefAnalystTask(opts: RefAnalystTaskInput): string {
	const titleLine = opts.title ? `\nTitle: ${opts.title}` : "";
	const urlLine = opts.url ? `\nURL: ${opts.url}` : "";
	const kindLine = opts.kind ? `\nKind: ${opts.kind}` : "";
	const contextLine = opts.context ? `\n\nTarget repo context: ${opts.context}` : "";
	const languageLine = opts.languageTag
		? `\n\nWrite all prose in the language with BCP47 tag "${opts.languageTag}". Keep file paths, identifiers, and code snippets verbatim.`
		: "";
	const template = REF_ANALYST_SECTIONS.map((section) => `## ${section}`).join("\n\n(empty)\n\n");
	return `Goal: deep-read this downloaded reference and extract what the target repository should adopt from it.

Reference id: ${opts.refId}${titleLine}${urlLine}${kindLine}
Local path (your working directory): ${opts.localPath}

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents. Stay inside the reference directory.

Evidence: inspect the reference with read, grep, find, and ls before judging it. Cite evidence for every claim in the medium's format — code: <relative-path>:<line>; papers: section/theorem/table numbers with a short quote; blogs/docs: the heading or quoted passage. Quote only what you verified. Medium-aware deep-read: repos go through entry points, core modules, tests, and configuration; papers through claims, method, limitations, and experiments; blogs/docs through technique, measurements, and caveats. Theoretical grounding counts — an algorithm, a formal property, or a measured tradeoff is as adoptable as an implementation pattern.${contextLine}${languageLine}

Success criteria: a structured analysis the main agent can paste into REF_ANALYSIS.md and turn into adoption questions.

Output: Markdown with exactly these seven top-level sections, in this order:

${template}

Section contracts:
- Overview: what the reference is, its scope, maturity, and license (when discoverable).
- Key Mechanisms And Design Tradeoffs: the mechanisms that make it work and the tradeoffs they embody.
- Adoptable Ideas For The Target Repo: concrete, portable ideas ranked by expected value; name the target-repo surface each would touch.
- Pitfalls And Anti-Patterns: what to avoid when borrowing; failure modes the reference itself documents or exhibits.
- Evidence Citations: the evidence references backing the claims above (file:line for code; section/theorem/table + quote for papers; heading/quote for blogs and docs).
- Coverage: which parts of the reference you actually read versus skipped.
- Evidence Gaps: what you could not determine from the reference alone.`;
}
