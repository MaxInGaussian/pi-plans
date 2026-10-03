/**
 * Execution-review budget (v0.9.3).
 *
 * The post-execution review loop used to be bounded by a fixed constant
 * (`REVIEW_MAX_ROUNDS = 5`) and always paused at the cap. The budget is now a
 * per-run choice, resolved exactly once — right before round 1, when every
 * task is terminal — and stored in the run checkpoint (never in the plan
 * file). Pickable values are 1 / 2 / 3 / 5 / unlimited.
 *
 * Semantics (see references/pi-planning-workflow.md):
 * - numeric budget: `audit.rounds >= budget` is exhausted;
 * - unlimited: no round cap, but two safety valves stop it — three consecutive
 *   committed rounds with an identical outcome signature (no progress), and a
 *   run-cumulative hard cap of `UNLIMITED_HARD_CAP` committed rounds, lifted by
 *   another `UNLIMITED_HARD_CAP` on every explicit `/plans-execute` grant that
 *   lands on `unlimited`;
 * - exhaustion pauses fail-closed (any mode) unless every verification check is
 *   already satisfied, in which case the run completes even with unresolved
 *   high findings (they are recorded and disclosed);
 * - only `/plans-execute` lifts a review pause; it re-opens the picker with the
 *   current value preselected.
 */

import { Container, SelectList, Spacer, Text, getKeybindings } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { REVIEW_MAX_ROUNDS } from "./auditor.ts";
import { reviewBudgetChrome, type ReviewBudgetChrome, type UiLanguage } from "./ui-language.ts";

/** A committed-round budget: a positive round count or the unlimited mode. */
export type ReviewBudget = number | "unlimited";

/** Fallback when no budget was chosen (no UI, headless, auto-approve, RPC). */
export const DEFAULT_REVIEW_BUDGET = 3;

/** Legacy fixed cap: a checkpoint written before this feature that already
 * spent rounds keeps its 5-round bound instead of being cut to the new
 * default mid-flight. */
export const LEGACY_REVIEW_MAX_ROUNDS = REVIEW_MAX_ROUNDS;

/** Run-cumulative hard cap for the unlimited budget (per grant window). */
export const UNLIMITED_HARD_CAP = 50;

/** Consecutive identical outcomes before the no-progress valve pauses. */
export const NO_PROGRESS_MAX_STREAK = 3;

/** Values the picker offers, in display order. */
export const REVIEW_BUDGET_CHOICES: readonly ReviewBudget[] = [1, 2, 3, 5, "unlimited"];

// ---------------------------------------------------------------------------
// Pause reasons (single source of truth, shared with the resume surface)
// ---------------------------------------------------------------------------

/** Budget exhaustion (numeric budget or the unlimited hard cap). */
export const REVIEW_CAP_PAUSE_PREFIX = "execution review exhausted";
/** v0.7 protocol value — dual-matched so checkpoints written by older builds
 * keep their cap pause recognized on restore. */
export const LEGACY_AUDIT_CAP_PAUSE_PREFIX = "completion audit exhausted";
/** Unlimited-mode no-progress valve. */
export const REVIEW_NO_PROGRESS_PAUSE_PREFIX = "execution review stalled";

/** True for every review-loop pause — the pauses that ONLY `/plans-execute`
 * lifts (ordinary input and session restores never do). Shared by
 * `src/exec.ts` and `src/resume-command.ts` so the two surfaces cannot drift
 * (round-1 F-007). */
export function isReviewPauseReason(reason: string | undefined | null): boolean {
	if (!reason) return false;
	return (
		reason.startsWith(REVIEW_CAP_PAUSE_PREFIX) ||
		reason.startsWith(LEGACY_AUDIT_CAP_PAUSE_PREFIX) ||
		reason.startsWith(REVIEW_NO_PROGRESS_PAUSE_PREFIX)
	);
}

/** Backwards-compatible alias for the pre-v0.9.3 predicate. */
export const isReviewCapPause = isReviewPauseReason;

// ---------------------------------------------------------------------------
// Budget arithmetic (pure)
// ---------------------------------------------------------------------------

export function formatReviewBudget(budget: ReviewBudget | undefined): string {
	if (budget === undefined) return "?";
	return budget === "unlimited" ? "∞" : String(budget);
}

/** The counts that bound an unlimited budget: committed rounds across the
 * whole run (never reset) and the extension the user explicitly granted. */
export interface ReviewBudgetCounters {
	reviewRoundsTotal: number;
	reviewCapExtension: number;
}

/** Resolve the stored budget at load time: an explicitly stored value wins; a
 * checkpoint that predates the feature and already spent rounds keeps the
 * legacy 5-round bound; anything else is still undecided (the picker runs
 * before round 1). */
export function resolveStoredBudget(stored: ReviewBudget | undefined, auditRounds: number): ReviewBudget | undefined {
	if (stored !== undefined) return stored;
	return auditRounds > 0 ? LEGACY_REVIEW_MAX_ROUNDS : undefined;
}

/** True when no further committed round may start under this budget. */
export function budgetExhausted(
	budget: ReviewBudget,
	committedRounds: number,
	counters: ReviewBudgetCounters,
): boolean {
	if (budget === "unlimited") {
		return counters.reviewRoundsTotal >= UNLIMITED_HARD_CAP + counters.reviewCapExtension;
	}
	return committedRounds >= budget;
}

/** Remaining rounds under an unlimited budget; Infinity for a numeric budget
 * that is not exhausted. Display-only. */
export function unlimitedHardCapCeiling(counters: ReviewBudgetCounters): number {
	return UNLIMITED_HARD_CAP + counters.reviewCapExtension;
}

// ---------------------------------------------------------------------------
// No-progress valve (unlimited mode)
// ---------------------------------------------------------------------------

export interface NoProgressState {
	/** Canonical signature of the last committed round's outcome. */
	key: string;
	/** Consecutive committed rounds carrying that same signature. */
	streak: number;
}

/** Outcome signature: the sorted failed checks, undeterminable checks, and
 * high-finding ids of one committed round. Computed from the POST-
 * classification triple inside `commitReviewOutcome` (round-1 F-002), so a
 * spawn-failure round (`outcome === null`) and a discard synthesis carry a
 * concrete signature too — the valve must catch the case where the reviewer
 * never produces a report. */
export function noProgressSignature(
	failed: readonly string[],
	undeterminable: readonly string[],
	highFindingIds: readonly string[],
): string {
	const norm = (ids: readonly string[]): string => [...new Set(ids)].sort().join(",");
	return `${norm(failed)}|${norm(undeterminable)}|${norm(highFindingIds)}`;
}

export function bumpNoProgress(previous: NoProgressState | undefined, signature: string): NoProgressState {
	if (previous && previous.key === signature) return { key: signature, streak: previous.streak + 1 };
	return { key: signature, streak: 1 };
}

export function noProgressTripped(state: NoProgressState | undefined): boolean {
	return state !== undefined && state.streak >= NO_PROGRESS_MAX_STREAK;
}

// ---------------------------------------------------------------------------
// Picker panel
// ---------------------------------------------------------------------------

/** Narrow structural view of ExtensionContext the picker needs. */
export interface ReviewBudgetPanelHost {
	mode?: string | undefined;
	hasUI?: boolean;
	ui?: {
		custom?: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options?: Record<string, unknown>) => Promise<unknown>;
		select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
	};
}

/**
 * True when some native surface can actually ask the question.
 *
 * `ExtensionUIContext.select` is a REQUIRED SDK method and therefore present on
 * every context — including `json`/`print` sessions where it cannot ask
 * anything. `hasUI` ("true in TUI and RPC modes") is the availability signal:
 * without it a headless session takes the panel path, and every at-pause grant
 * would be "declined" forever, leaving the run permanently paused
 * (round-1 F-001). UI-less sessions fall back to the default budget instead.
 */
export function reviewBudgetPanelAvailable(host: ReviewBudgetPanelHost): boolean {
	if (host.hasUI !== true) return false;
	const ui = host.ui;
	if (!ui) return false;
	if (typeof ui.select === "function") return true;
	return host.mode === "tui" && typeof ui.custom === "function";
}

interface BudgetItem {
	label: string;
	value: ReviewBudget;
}

const BUDGET_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

const BUDGET_OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: {
		width: "78%",
		minWidth: 60,
		maxHeight: "78%",
		anchor: "top-center",
		margin: { top: 1, left: 2, right: 2 },
	},
};

/** TUI panel: one selectable row per budget value. */
class BudgetPanelComponent extends Container {
	private readonly selectList: SelectList;

	constructor(
		items: BudgetItem[],
		preselect: ReviewBudget | undefined,
		chrome: ReviewBudgetChrome,
		onSelect: (budget: ReviewBudget) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(chrome.panelTitle, 0, 0));
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), BUDGET_LAYOUT);
		const index = items.findIndex((item) => item.value === preselect);
		if (index !== -1) this.selectList.setSelectedIndex(index);
		this.selectList.onSelect = (item) => onSelect((item as BudgetItem).value);
		this.selectList.onCancel = () => onCancel();
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(chrome.panelHint, 0, 0));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (!isNav) return; // unknown keys are ignored, never a silent cancel
		this.selectList.handleInput(keyData);
	}
}

/**
 * Ask for the execution-review budget. Returns the picked value, or `null`
 * when the question could not be answered — panel Esc/cancel, `ui.custom`
 * unavailable (RPC), a select menu cancelled, or no UI at all. Callers decide
 * what `null` means: the FIRST resolution falls back to
 * `DEFAULT_REVIEW_BUDGET` with a visible note; the at-pause grant keeps the
 * run paused (Esc never silently grants rounds).
 */
export async function askReviewBudget(
	host: ReviewBudgetPanelHost,
	lang: UiLanguage | undefined,
	current?: ReviewBudget,
): Promise<ReviewBudget | null> {
	const chrome = reviewBudgetChrome(lang ?? "en");
	if (!reviewBudgetPanelAvailable(host)) return null;
	const items: BudgetItem[] = REVIEW_BUDGET_CHOICES.map((value) => ({ label: budgetItemLabel(value, chrome), value }));
	if (host.mode === "tui" && typeof host.ui?.custom === "function") {
		try {
			const picked = await host.ui.custom<ReviewBudget | null>((_tui, _theme, _kb, done) => {
				let settled = false;
				const finish = (value: ReviewBudget | null): void => {
					if (settled) return;
					settled = true;
					done(value);
				};
				return new BudgetPanelComponent(items, current, chrome, (budget) => finish(budget), () => finish(null));
			}, BUDGET_OVERLAY_OPTIONS as never);
			if (picked === "unlimited" || typeof picked === "number") return picked;
			if (picked === null) return null; // Esc on the panel
			// undefined: no TUI surface (RPC custom()) — fall through to menus.
		} catch {
			/* construction failure: fall through to menus */
		}
	}
	if (typeof host.ui?.select === "function") {
		const labels = items.map((item) => item.label);
		const title = current === undefined ? chrome.panelTitle : `${chrome.panelTitle} ${chrome.currentSuffix(formatReviewBudget(current))}`;
		const picked = await host.ui.select(title, labels);
		if (typeof picked === "string") {
			const index = labels.indexOf(picked);
			if (index >= 0) return items[index]!.value;
		}
	}
	return null;
}

function budgetItemLabel(budget: ReviewBudget, chrome: ReviewBudgetChrome): string {
	return budget === "unlimited" ? chrome.unlimitedOption : chrome.roundsOption(budget);
}
