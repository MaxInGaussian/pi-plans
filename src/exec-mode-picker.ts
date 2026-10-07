/**
 * Execution-mode chooser, asked at the execution handoff: run on the current
 * session (same model), or on one or several delegated subagents whose model
 * and effort come from the same picker the reviewer uses.
 *
 * The previous choice is offered first (marked), so Enter repeats it. The
 * result is remembered globally as a non-binding default and stored per run
 * by the caller.
 */

import { pickModelAndEffort, type RolePanelHost } from "./role-panels.ts";
import {
	CURRENT_SESSION_EXECUTOR,
	MAX_EXECUTOR_WORKERS,
	isDelegated,
	type ExecutorChoice,
} from "./executor-config.ts";
import { execModeChrome, type UiLanguage } from "./ui-language.ts";
import { rememberLastExecutor } from "./global-state.ts";

export type ExecModeOutcome = { status: "chosen"; choice: ExecutorChoice } | { status: "cancelled" };

type ModeKey = "current" | "one" | "several";

function modeKeyOf(choice: ExecutorChoice | null | undefined): ModeKey | null {
	if (!choice) return null;
	if (!isDelegated(choice)) return "current";
	return choice.workers > 1 ? "several" : "one";
}

function parseSelector(selector: string | null | undefined): { provider: string; id: string } | null {
	if (!selector) return null;
	const index = selector.indexOf("/");
	return index > 0 ? { provider: selector.slice(0, index), id: selector.slice(index + 1) } : null;
}

export interface ExecModeHost extends RolePanelHost {
	ui: RolePanelHost["ui"] & { select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined> };
}

/**
 * Ask where the plan should run. Callers skip this for headless and
 * auto-approved handoffs (those always use the current session).
 */
export async function askExecutionMode(
	host: ExecModeHost,
	options: { lang?: UiLanguage; last?: ExecutorChoice | null; remember?: boolean } = {},
): Promise<ExecModeOutcome> {
	const chrome = execModeChrome(options.lang ?? "en");
	const select = host.ui.select;
	if (typeof select !== "function") return { status: "chosen", choice: { ...CURRENT_SESSION_EXECUTOR } };

	const modelLabel = host.model ? `${host.model.provider}/${host.model.id}` : "session model";
	const labels: Record<ModeKey, string> = {
		current: chrome.currentSession.replace("{model}", modelLabel),
		one: chrome.oneWorker,
		several: chrome.severalWorkers,
	};
	const lastKey = modeKeyOf(options.last);
	const order: ModeKey[] = ["current", "one", "several"];
	if (lastKey) order.splice(order.indexOf(lastKey), 1), order.unshift(lastKey);
	const rows = order.map((key) => (key === lastKey ? `${labels[key]}${chrome.lastUsed}` : labels[key]));
	const picked = await select.call(host.ui, chrome.title, rows);
	if (picked === undefined) return { status: "cancelled" };
	const key = order[rows.indexOf(picked)];
	if (key === undefined) return { status: "cancelled" };

	if (key === "current") return finish({ ...CURRENT_SESSION_EXECUTOR }, options.remember);

	let workers = 1;
	if (key === "several") {
		const counts = Array.from({ length: MAX_EXECUTOR_WORKERS - 1 }, (_, index) => String(index + 2));
		const lastCount = options.last && isDelegated(options.last) && options.last.workers > 1 ? String(options.last.workers) : null;
		const rowsCount = lastCount ? [lastCount, ...counts.filter((count) => count !== lastCount)] : counts;
		const pickedCount = await select.call(host.ui, chrome.countTitle.replace("{max}", String(MAX_EXECUTOR_WORKERS)), rowsCount);
		if (pickedCount === undefined) return { status: "cancelled" };
		workers = Number(pickedCount);
		if (!Number.isInteger(workers) || workers < 2 || workers > MAX_EXECUTOR_WORKERS) return { status: "cancelled" };
	}

	const last = options.last && isDelegated(options.last) ? options.last : null;
	const outcome = await pickModelAndEffort(host, {
		storedLevel: last?.thinking_level ?? null,
		preselectModel: parseSelector(last?.model_selector),
		titles: {
			levelTitle: chrome.levelTitle,
			levelSubtitle: chrome.levelSubtitle,
			modelMenu: chrome.modelMenu,
			levelMenu: chrome.levelMenu,
		},
	});
	if (outcome.status === "cancelled") return { status: "cancelled" };
	if (outcome.status === "unavailable") {
		host.ui.notify?.(chrome.unavailable, "warning");
		return finish({ ...CURRENT_SESSION_EXECUTOR }, options.remember);
	}
	return finish({ mode: "delegated", workers, model_selector: outcome.modelSelector, thinking_level: outcome.thinkingLevel }, options.remember);
}

function finish(choice: ExecutorChoice, remember: boolean | undefined): ExecModeOutcome {
	if (remember !== false) {
		try {
			rememberLastExecutor(choice);
		} catch {
			/* a remembered default is a convenience, never a gate */
		}
	}
	return { status: "chosen", choice };
}
