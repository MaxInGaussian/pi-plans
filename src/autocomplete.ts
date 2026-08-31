/** Run-scoped Auto-complete state and planning-turn continuation. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRun, readActive } from "./state.ts";

export const AUTOCOMPLETE_ENTRY = "pi-plans-autocomplete";
const AUTOCOMPLETE_CONTINUE = "Continue the current planning workflow. Raise the next relevant question with ask_choice; do not stop after an auto-completed answer.";

type SessionEntry = { type: string; customType?: string; data?: unknown };

type AutoCompleteState = {
	runId: string;
	enabled: boolean;
	pendingFollowUp: boolean;
	askChoiceCount: number;
	autoChoiceCount: number;
	planWritten: boolean;
};

type SessionWithAutoComplete = ExtensionContext["sessionManager"] & {
	__piPlansAutoComplete?: AutoCompleteState;
};

let api: ExtensionAPI | null = null;

export function setAutoCompleteApi(next: ExtensionAPI | null): void {
	api = next;
}

function sessionState(ctx: ExtensionContext): AutoCompleteState | undefined {
	return (ctx.sessionManager as SessionWithAutoComplete).__piPlansAutoComplete;
}

function activePlanningRun(ctx: ExtensionContext): { runId: string } | null {
	const active = readActive(ctx.cwd);
	if (!active) return null;
	const run = getRun(ctx.cwd, active.run_id);
	return run?.status === "planning" ? { runId: run.run_id } : null;
}

function appendState(runId: string, enabled: boolean, reason?: string): void {
	if (!api) return;
	api.appendEntry(AUTOCOMPLETE_ENTRY, { runId, enabled, ...(reason ? { reason } : {}) });
}

export function enableAutoComplete(ctx: ExtensionContext): boolean {
	const run = activePlanningRun(ctx);
	if (!run) return false;
	const current = sessionState(ctx);
	if (current?.enabled && current.runId === run.runId) return true;
	(ctx.sessionManager as SessionWithAutoComplete).__piPlansAutoComplete = {
		runId: run.runId,
		enabled: true,
		pendingFollowUp: false,
		askChoiceCount: 0,
		autoChoiceCount: 0,
		planWritten: false,
	};
	appendState(run.runId, true);
	return true;
}

export function disableAutoComplete(ctx: ExtensionContext, reason = "disabled"): boolean {
	const state = sessionState(ctx);
	const run = activePlanningRun(ctx);
	const runId = state?.runId ?? run?.runId;
	if (!runId && !state?.enabled) return false;
	if (state) state.enabled = false;
	if (runId) appendState(runId, false, reason);
	return true;
}

export function isAutoCompleteEnabled(ctx: ExtensionContext): boolean {
	const state = sessionState(ctx);
	const run = activePlanningRun(ctx);
	return !!state?.enabled && !!run && state.runId === run.runId;
}

/** Record every ask_choice call for this turn; autoChoice marks a recommendation selected by the mode. */
export function recordAskChoice(ctx: ExtensionContext, autoChoice: boolean): void {
	const state = sessionState(ctx);
	if (!state) return;
	state.askChoiceCount += 1;
	if (autoChoice) state.autoChoiceCount += 1;
}

export function markPlanWritten(ctx: ExtensionContext): void {
	const state = sessionState(ctx);
	if (state) state.planWritten = true;
}

export function resetAutoCompleteTurn(ctx: ExtensionContext): void {
	const state = sessionState(ctx);
	if (!state) return;
	state.pendingFollowUp = false;
	state.askChoiceCount = 0;
	state.autoChoiceCount = 0;
	state.planWritten = false;
}

export function shouldContinueAutoComplete(ctx: ExtensionContext): boolean {
	const state = sessionState(ctx);
	return isAutoCompleteEnabled(ctx)
		&& !!state
		&& state.autoChoiceCount > 0
		&& state.askChoiceCount === state.autoChoiceCount
		&& !state.planWritten
		&& !state.pendingFollowUp;
}

export async function continueAutoComplete(ctx: ExtensionContext): Promise<boolean> {
	if (!api || !shouldContinueAutoComplete(ctx)) return false;
	const state = sessionState(ctx);
	if (!state) return false;
	state.pendingFollowUp = true;
	try {
		await api.sendUserMessage(AUTOCOMPLETE_CONTINUE, { deliverAs: "followUp" });
		return true;
	} catch {
		state.pendingFollowUp = false;
		return false;
	}
}

export function registerAutoCompleteTurnHandlers(pi: ExtensionAPI): void {
	setAutoCompleteApi(pi);
	pi.on("turn_start", async (_event, ctx) => {
		resetAutoCompleteTurn(ctx);
	});
	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as { role?: string } | undefined;
		if (message?.role === "assistant") await continueAutoComplete(ctx);
	});
}

export function restoreAutoCompleteFromSession(ctx: ExtensionContext, entries: SessionEntry[]): void {
	const session = ctx.sessionManager as SessionWithAutoComplete;
	delete session.__piPlansAutoComplete;
	let restored: { runId: string; enabled: boolean } | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== AUTOCOMPLETE_ENTRY || !entry.data) continue;
		const data = entry.data as { runId?: unknown; enabled?: unknown };
		if (typeof data.runId === "string" && typeof data.enabled === "boolean") {
			restored = { runId: data.runId, enabled: data.enabled };
			break;
		}
	}
	const active = activePlanningRun(ctx);
	if (!restored || !restored.enabled || !active || restored.runId !== active.runId) return;
	session.__piPlansAutoComplete = {
		runId: active.runId,
		enabled: true,
		pendingFollowUp: false,
		askChoiceCount: 0,
		autoChoiceCount: 0,
		planWritten: false,
	};
}

export function autoCompleteStatus(ctx: ExtensionContext): "enabled" | "disabled" {
	return isAutoCompleteEnabled(ctx) ? "enabled" : "disabled";
}
