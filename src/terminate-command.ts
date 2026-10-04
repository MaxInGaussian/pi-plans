/**
 * `/plans-terminate` (v0.9.4) — the user-authorized end of a run.
 *
 * The explicit "I have seen enough rounds, nothing big remains, close it"
 * path. Distinct from its neighbours: `/plans-stop` stops execution and
 * records `stopped` (resumable), `/plans-abandon` voids a planning run, and
 * `completeExecution` is the automatic convergence path. This command ends
 * the run as `done` and discloses what was never verified.
 *
 * Disclosure contract (decisions Q1–Q5 in the planning run):
 *  - no hard gate; fewer than three committed rounds only adds a warning;
 *  - unresolved high findings are allowed but listed one by one;
 *  - unverified checks and open tasks are left untouched and disclosed;
 *  - the confirm dialog is the only gate, and its body stays bounded — the
 *    complete list ships in the disclosure message that precedes it;
 *  - the dialog is a snapshot boundary: the summary is re-read after the
 *    confirm, an in-flight round that committed meanwhile is never overwritten
 *    (see `terminateExecution`), a new high forces a second confirmation, and
 *    a loop that converged meanwhile is reported instead of being ignored.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExecution, terminateExecution, terminationSummary, type TerminationSummary } from "./exec.ts";
import { messaging } from "./messaging.ts";
import { resolveUiLanguage, terminationChrome, type UiLanguage, type TerminationChrome } from "./ui-language.ts";

/** Confirm-body ids per line before switching to the "… +N more" pointer. */
const CONFIRM_ID_LIMIT = 6;

/** Full disclosure, shown (and kept in the transcript) before the confirm. */
function disclosureMessage(summary: TerminationSummary, chrome: TerminationChrome): string {
	const ids = (list: string[]): string => (list.length > 0 ? `: ${list.join(", ")}` : "");
	const lines = [
		chrome.disclosureHeading,
		`${chrome.unverifiedLabel(summary.unverifiedVcIds.length)}${ids(summary.unverifiedVcIds)}`,
		`${chrome.openTasksLabel(summary.openTaskIds.length)}${ids(summary.openTaskIds)}`,
		`${chrome.highsLabel(summary.highFindings.length)}${ids(summary.highFindings)}`,
		`${chrome.residualLabel(summary.residualFindings.length)}${ids(summary.residualFindings)}`,
	];
	if (summary.fewRounds) lines.push(chrome.fewRoundsNote(summary.committedRounds));
	if (summary.abortedRound) {
		lines.push(chrome.abortedRoundLabel(summary.abortedRound.budgetRound, summary.abortedRound.attempt));
	}
	return lines.join("\n");
}

/** Bounded confirm body: at most four lines, never a full id dump. */
function confirmBody(summary: TerminationSummary, chrome: TerminationChrome): string {
	const capped = (list: string[]): string => {
		if (list.length === 0) return "";
		const shown = list.slice(0, CONFIRM_ID_LIMIT).join(", ");
		return list.length > CONFIRM_ID_LIMIT ? `: ${shown} ${chrome.partialIds(list.length - CONFIRM_ID_LIMIT)}` : `: ${shown}`;
	};
	return [
		chrome.confirmBody(summary.committedRounds, summary.budgetLabel),
		`${chrome.unverifiedLabel(summary.unverifiedVcIds.length)}${capped(summary.unverifiedVcIds)}`,
		`${chrome.highsLabel(summary.highFindings.length)}${capped(summary.highFindings)}`,
		summary.fewRounds
			? chrome.fewRoundsNote(summary.committedRounds)
			: `${chrome.openTasksLabel(summary.openTaskIds.length)}${capped(summary.openTaskIds)}`,
	].join("\n");
}

/**
 * Handler for the `/plans-terminate` command. Interactive-only (the confirm
 * is the gate; headless hosts resolve `confirm` to false, so refusing up front
 * matches `/update-plan`). Any state change happens inside `terminateExecution`
 * and only after the user confirmed.
 */
export async function terminatePlanCommand(ctx: ExtensionContext): Promise<void> {
	const workspaceLang: UiLanguage = resolveUiLanguage(ctx.cwd);
	if (!ctx.hasUI) {
		ctx.ui.notify(terminationChrome(workspaceLang).requiresInteractive, "warning");
		return;
	}
	const execution = getExecution();
	if (!execution) {
		ctx.ui.notify(terminationChrome(workspaceLang).noExecution, "info");
		return;
	}
	const chrome = terminationChrome(execution.uiLanguage ?? workspaceLang);
	const summary = terminationSummary(execution);
	// The full list is never dropped: it ships as a visible message first, so
	// the bounded confirm body can point back at it.
	messaging().sendMessage(
		{ customType: "pi-plans-terminate-preview", content: disclosureMessage(summary, chrome), display: true },
		{ triggerTurn: false },
	);
	const approved = await ctx.ui.confirm(chrome.confirmTitle, confirmBody(summary, chrome));
	if (!approved) {
		ctx.ui.notify(chrome.cancelledNotice, "info");
		return;
	}
	// The dialog can stay open for minutes: re-read the loop instead of acting on
	// the pre-confirm snapshot. If it converged (or another session stopped it)
	// there is nothing left to terminate, and the user must hear that.
	const live = getExecution();
	if (!live) {
		ctx.ui.notify(chrome.noExecution, "info");
		return;
	}
	let current = terminationSummary(live);
	// A high that appeared while the dialog was open invalidates the approval
	// (the user confirmed a state without it) — re-disclose and ask again.
	const newHighs = current.highFindings.filter((id) => !summary.highFindings.includes(id));
	if (newHighs.length > 0) {
		messaging().sendMessage(
			{ customType: "pi-plans-terminate-preview", content: disclosureMessage(current, chrome), display: true },
			{ triggerTurn: false },
		);
		const reconfirmed = await ctx.ui.confirm(chrome.confirmTitle, confirmBody(current, chrome));
		if (!reconfirmed) {
			ctx.ui.notify(chrome.cancelledNotice, "info");
			return;
		}
		current = terminationSummary(getExecution() ?? live);
	}
	const terminated = await terminateExecution(ctx, current);
	if (!terminated) ctx.ui.notify(chrome.noExecution, "info");
}
