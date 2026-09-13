/**
 * I-004: benchmark/automation auto-approve mode (`PI_PLANS_AUTO_APPROVE=1`).
 *
 * PLAN_v3 semantics (D-019), deliberately narrower than Auto-complete:
 * - Whitelist = plan lifecycle only: planning/refinement ask_choice questions,
 *   the execution handoff, and the termination question. Implemented as
 *   "every pi-plans question EXCEPT external-state changes".
 * - External-state questions (publish, deploy, merge, push, credential use,
 *   install waivers, payment, ...) are HARD-REJECTED with a visible error
 *   even when the env is set — the benchmark switch must never become a
 *   safety-boundary bypass.
 * - The env short-circuits BEFORE any UI dispatch (TUI panel, RPC UI events),
 *   so unattended harnesses never need UI-event plumbing.
 * - Every auto answer is annotated with an `[auto-approve]` prefix so run
 *   logs/archives can be audited for accidental env leakage.
 * - The env is expected to be injected per-process by an evaluation runner
 *   only; it must not be exported in host shells (checked by bench V-004).
 */

export const AUTO_APPROVE_ENV = "PI_PLANS_AUTO_APPROVE";

/** Read per-call so tests can toggle the env freely. */
export function isAutoApproveEnabled(): boolean {
	return process.env[AUTO_APPROVE_ENV] === "1";
}

/** D-019 blocklist: conservative; a false positive fails visibly (the caller
 * must answer interactively) while a false negative would silently bypass a
 * safety gate. Word-boundary anchored where short words could over-match.
 * NOTE: package *installation inside a disposable benchmark container* is
 * plan-lifecycle (the criticizer legitimately asks about installing deps);
 * only externally-visible state (publish/deploy/merge/push/credentials/...)
 * is hard-rejected. Install-permission waivers are still caught via
 * "waiver". */
const EXTERNAL_STATE_PATTERN = new RegExp(
	[
		"publish",
		"deploy",
		"\\bmerge\\b",
		"\\bpush\\b",
		"credential",
		"\\bsecret\\b",
		"api[- ]?key",
		"password",
		"payment",
		"billing",
		"waiver",
		// F-005: product default config language is zh-Hans — English-only
		// keywords would let Chinese external-state questions slip through.
		"发布",
		"部署",
		"合并到",
		"推送到",
		"推送至",
		"凭据",
		"密钥",
		"密码",
		"支付",
		"账单",
	].join("|"),
	"i",
);

export interface AutoApprovableQuestion {
	question: string;
	purpose?: string;
	questionId?: string;
	optionLabels: string[];
}

/** True when the question asks for an external-state change and must therefore
 * be refused even under `PI_PLANS_AUTO_APPROVE=1` (D-019 hard-reject). */
export function isExternalStateQuestion(input: AutoApprovableQuestion): boolean {
	const haystack = [
		input.question ?? "",
		input.purpose ?? "",
		input.questionId ?? "",
		...(input.optionLabels ?? []),
	].join("\n");
	return EXTERNAL_STATE_PATTERN.test(haystack);
}

/** Guard for the auto-approve path: throws (fail closed, visibly) when the
 * question is an external-state change. */
export function assertAutoApprovable(input: AutoApprovableQuestion): void {
	if (isExternalStateQuestion(input)) {
		throw new Error(
			`[auto-approve] refused: this question looks like an external-state change (publish/deploy/merge/push/credential/...) and must never be auto-approved. Stop and wait for the user.`,
		);
	}
}
