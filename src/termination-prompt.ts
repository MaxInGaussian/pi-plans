/**
 * Single source of truth for the post-execution implementation-review
 * termination question. Consumed by BOTH the goal-running continuation prompt
 * (src/exec.ts AMELIORATION_PROMPT_TEXT) and the ask_choice trailing branch
 * (tools/ask-choice.ts). Pure constants only — no runtime imports, no
 * execution-loop coupling.
 */

export const TERMINATION_QUESTION = "How should the implementation-review loop terminate?";

export const TERMINATION_OPTIONS = [
	"goal wait: continue until no unpassed VCs remain (auto-continue each round)",
	"until no high-severity finding (hard cap 5 rounds)",
	"1 round",
	"2 rounds",
	"3 rounds",
] as const;

/** "1. <option>  2. <option> …" — recommended (goal wait) first. */
export function renderTerminationOptions(): string {
	return TERMINATION_OPTIONS.map((option, index) => `${index + 1}. ${option}`).join("  ");
}

/** Stable question id for the termination question so cross-session resume
 * can deduplicate it and link the answer to the checkpoint (I-004). */
export const TERMINATION_QUESTION_ID = "termination-condition";

/** Instruction appended wherever the termination question is requested.
 * Persistence is deferred: BOTH config answers (termination + reviewer count)
 * land in ONE combined record-checkpoint (D-5 crash window stays a single
 * transaction boundary). */
export const TERMINATION_RECORDING_INSTRUCTIONS =
	'Ask it with ask_choice using questionId: "termination-condition" (autoComplete: false). Do not persist yet: after the reviewer-count question is also answered, persist BOTH together in one plans record-checkpoint (checkpoint: { transition: "implementation-review-configured", terminationCondition: "<the chosen option>", reviewerCount: <chosen integer> }).';

/** Skill levels whose implementation-review rounds default to 3 concurrent
 * reviewers; every other skill (and unknown/absent skills) defaults to 1. */
const THREE_REVIEWER_SKILLS = new Set(["plan-big", "plan-with-refs"]);

/** Default concurrent reviewers for implementation-review rounds, derived
 * from the run's skill (D-1). */
export function defaultImplReviewers(skill: string | undefined): 1 | 3 {
	return skill !== undefined && THREE_REVIEWER_SKILLS.has(skill) ? 3 : 1;
}

/** The per-run reviewer-count configuration question asked alongside the
 * termination condition (D-2). Stable question id so crash recovery can
 * rebuild answered config from the decisions ledger (D-5). */
export const IMPL_REVIEWER_COUNT_QUESTION =
	"How many concurrent reviewers should each implementation-review round use?";
export const IMPL_REVIEWER_COUNT_QUESTION_ID = "impl-review-reviewer-count";

/** Pure-digit option labels with the recommended flag rendered as ★ by the
 * ask_choice UI — no "(recommended)" text inside labels, so the chosen label
 * IS the integer (D-6). Recommended first. */
export function implReviewerCountOptions(
	defaultCount: 1 | 3,
): { label: string; recommended: boolean }[] {
	const recommended = String(defaultCount);
	const rest = ["1", "2", "3"].filter((label) => label !== recommended);
	return [{ label: recommended, recommended: true }, ...rest.map((label) => ({ label, recommended: false }))];
}

/** Skill-aware instruction line for the reviewer-count question, composed
 * into the goal-running continuation (src/exec.ts) and the ask_choice
 * trailing branch (tools/ask-choice.ts). Digit labels, recommended first
 * (D-6), combined persistence with the termination answer (D-5). */
export function implReviewerCountPromptLine(skill: string | undefined): string {
	const countDefault = defaultImplReviewers(skill);
	const options = implReviewerCountOptions(countDefault)
		.map((option) => `${option.label}${option.recommended ? " (recommended)" : ""}`)
		.join("  ");
	return `Then ask the reviewer-count question as a second single-question ask_choice (autoComplete: false, allowOther: false, questionId: "${IMPL_REVIEWER_COUNT_QUESTION_ID}", options: ${options}): "${IMPL_REVIEWER_COUNT_QUESTION}" (default follows the run's skill: plan-big / plan-with-refs → 3, others → 1). After BOTH answers, persist them together in ONE call: plans record-checkpoint (checkpoint: { transition: "implementation-review-configured", terminationCondition: "<termination answer>", reviewerCount: <chosen integer> }). Afterwards run each implementation-review round with refine (role reviewer, target implementation, reviewers: <configured reviewerCount>; if omitted, the refine tool falls back to this configured value).`;
}
