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

/** Instruction appended wherever the termination question is requested. */
export const TERMINATION_RECORDING_INSTRUCTIONS =
	'Ask it with ask_choice using questionId: "termination-condition" (autoComplete: false). After the user answers, persist the loop configuration: plans record-checkpoint (checkpoint: { transition: "implementation-review-configured", terminationCondition: "<the chosen option>" }).';
