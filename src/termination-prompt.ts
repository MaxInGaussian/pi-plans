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
