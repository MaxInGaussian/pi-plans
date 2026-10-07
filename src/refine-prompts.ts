/** One reviewer's planner-written direction. The planner derives these from
 * the project and the plan so the reviewers complement each other. */
export interface ReviewerDirection {
	/** Short slug; becomes the lane id (fleet bullet, section title, checkpoint lane). */
	id: string;
	/** What this reviewer digs into, written for this project. */
	direction: string;
}

export interface RefinePromptInput {
	planText: string;
	planPath: string;
	focus?: string;
	context?: string;
	/** This reviewer's assigned direction; absent for a single general reviewer. */
	direction?: string | null;
	/** Directions assigned to the OTHER reviewers of the same round. */
	otherDirections?: ReviewerDirection[];
}

export interface ReviewerLane {
	id: string;
	/** The direction text, or null for the single general reviewer. */
	direction: string | null;
}

export const DIRECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DIRECTION_MIN_CHARS = 20;
export const DIRECTION_MAX_CHARS = 800;

/** The lane of a single reviewer that has no assigned direction. */
export const GENERAL_LANE: ReviewerLane = { id: "general", direction: null };

/** How to write directions; shown in the error when they are missing or invalid. */
export function directionsGuidance(count: number): string {
	return [
		`Pass \`directions\`: exactly ${count} entries of { id, direction } — one per reviewer, written by you for THIS project and plan.`,
		`- id: short slug (${DIRECTION_ID_RE.source}), unique, e.g. "migration-rollback".`,
		`- direction: ${DIRECTION_MIN_CHARS}-${DIRECTION_MAX_CHARS} characters. Name the concrete modules, flows or risks to dig into and why the planner or an executor could overlook them.`,
		"Choose the directions with the highest expected miss rate for this plan (hidden coupling and blast radius, migration/rollback and state transitions, concurrency and ordering, failure and degraded modes, security and permissions, performance cliffs, integration points, whether the verification checks really prove the claims, unstated assumptions in the user's answers). Make them complementary, not overlapping; drop any direction you cannot justify for this project.",
	].join("\n");
}

export type DirectionsCheck = { ok: true; directions: ReviewerDirection[] } | { ok: false; error: string };

/**
 * Validate the planner's directions for a round of `count` reviewers. With
 * more than one reviewer they are required (no generic fallback — tailoring is
 * the point); a single reviewer may take at most one optional direction.
 */
export function validateDirections(count: number, value: unknown): DirectionsCheck {
	const fail = (message: string): DirectionsCheck => ({ ok: false, error: count > 1 ? `${message}\n\n${directionsGuidance(count)}` : message });
	if (value === undefined || value === null) {
		return count > 1 ? fail(`reviewers: ${count} needs tailor-made directions, but none were given.`) : { ok: true, directions: [] };
	}
	if (!Array.isArray(value)) return fail("directions must be an array of { id, direction } objects.");
	if (count <= 1 && value.length > 1) return { ok: false, error: "reviewers: 1 takes at most one direction." };
	if (count > 1 && value.length !== count) return fail(`reviewers: ${count} needs exactly ${count} directions, got ${value.length}.`);
	const seen = new Set<string>();
	const directions: ReviewerDirection[] = [];
	for (const [index, raw] of value.entries()) {
		const entry = raw as { id?: unknown; direction?: unknown } | null;
		if (entry === null || typeof entry !== "object") return fail(`directions[${index}] must be an object { id, direction }.`);
		const id = typeof entry.id === "string" ? entry.id : "";
		if (!DIRECTION_ID_RE.test(id)) return fail(`directions[${index}].id ${JSON.stringify(entry.id)} is not a valid slug (${DIRECTION_ID_RE.source}).`);
		if (seen.has(id)) return fail(`directions[${index}].id "${id}" is used twice; ids must be unique.`);
		seen.add(id);
		const direction = typeof entry.direction === "string" ? entry.direction.trim() : "";
		if (direction.length < DIRECTION_MIN_CHARS || direction.length > DIRECTION_MAX_CHARS) {
			return fail(`directions[${index}].direction must be ${DIRECTION_MIN_CHARS}-${DIRECTION_MAX_CHARS} characters (got ${direction.length}).`);
		}
		directions.push({ id, direction });
	}
	return { ok: true, directions };
}

/** Lanes for a round: one per direction, or the single general lane. */
export function lanesFromDirections(directions: ReviewerDirection[]): ReviewerLane[] {
	return directions.length > 0 ? directions.map((entry) => ({ id: entry.id, direction: entry.direction })) : [{ ...GENERAL_LANE }];
}

function directionBlock(opts: RefinePromptInput): string {
	if (!opts.direction) return "";
	const others = opts.otherDirections ?? [];
	const othersText = others.length > 0
		? `\n\nOther reviewers in this round cover different directions — do not duplicate them:\n${others.map((entry) => `- ${entry.id}: ${entry.direction}`).join("\n")}`
		: "";
	return `\n\nYour assigned direction: ${opts.direction}\nGo deeper here than a generic review would: follow this direction through the repository until you can say what the plan, and an executor following it, would get wrong or overlook. Do not pad the report with generic coverage of other aspects, but if you stumble on a high-severity problem outside your direction, report it briefly.${othersText}`;
}

function buildSharedHeader(opts: RefinePromptInput): string {
	const focusLine = opts.focus ? `\n\nSpecific concerns from the main agent: ${opts.focus}` : "";
	const contextLine = opts.context ? `\n\nContext: ${opts.context}` : "";
	return `Goal: review the plan against the repository and surface what needs the user's judgment.

Target: ${opts.planPath}

Authority boundary: read-only analysis only. Do not edit, write, delete, commit, push, or spawn subagents.

Evidence: inspect the repository with read, grep, find, and ls before judging the plan.${directionBlock(opts)}${focusLine}${contextLine}`;
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
