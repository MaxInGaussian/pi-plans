/**
 * Fixed tasks' status panel model — single source of truth for the execution
 * phase UI. Pure functions only (no TUI imports): the same derived model
 * feeds (1) the aboveEditor `╭─ pi-plans ─ <topic> ──╮` widget, (2) the
 * status-bar summary line, and (3) the execution injection text, so the panel
 * always shows exactly what the agent is told (D-014, R-011).
 *
 * Row-count discipline (D-004/D-023): the panel renders a FIXED number of
 * lines at every width — 7 rows at >= MIN_PANEL_WIDTH columns, a 3-line badge
 * below it — so the terminal buffer height never changes and pi-tui never
 * clears the scrollback (pi-goal-x scroll-repro lesson). Line content is
 * always truncated per the component's width.
 */

import type { ImplDisplayState } from "./plan.ts";
import { resolveImplStatuses, shortImplDescription, type CheckItem, type ImplItem } from "./plan.ts";
import { truncateToWidth, visibleWidth } from "./refine-ui-helpers.ts";

/** Widget key under which the panel is registered/cleared. */
export const PANEL_WIDGET_KEY = "pi-plans";

/** Full panel row count (box top+bottom + 5 content lines). */
export const PANEL_ROW_COUNT = 7;
/** Minimal terminal width for the full 7-row panel; below this a 3-line badge is rendered. */
export const MIN_PANEL_WIDTH = 30;
/** Badge row count below MIN_PANEL_WIDTH. */
export const BADGE_ROW_COUNT = 3;

export interface GoalWaitPanel {
	paused: boolean;
	pausedReason?: string;
	noProgressRounds: number;
	waitRounds: number;
}

export interface PanelModel {
	/** Run topic (stable run-level slug; D-018). */
	topic: string;
	/** Execution phase displayed in the header content line. */
	phase: string;
	/** Extra phase annotation, e.g. "⏸ paused". */
	phaseNote?: string;
	vcDone: number;
	vcTotal: number;
	/** Implementation items not yet vc-passed. */
	remainingI: number;
	totalI: number;
	/** Resolved current I (marker-backed or inferred; inferred is display-only). */
	currentI?: string;
	/** Short one-line description of the current I (display-only). */
	currentIText?: string;
	currentState?: ImplDisplayState;
	currentInferred: boolean;
	/** Human action line shown to the user and injected to the agent. */
	nextAction: string;
	goalWait?: GoalWaitPanel;
}

/**
 * Derive the next human action from execution state. `waiting` is an explicit
 * approximation signal for "a subprocess is pending" (callers pass
 * `goalWait.waitRounds > 0 && !goalWait.paused`, matching the exec loop's
 * `/waiting for/` backoff heuristic; F-008).
 */
export function deriveNextAction(
	execution: {
		items: CheckItem[];
		implItems?: ImplItem[];
		implStatus?: Record<string, ImplMarkerStateLike>;
		currentI?: string;
		goalWait?: { paused?: boolean; pausedReason?: string; noProgressRounds?: number; waitRounds?: number } | null;
	},
	waiting: boolean,
	statuses: Record<string, ImplDisplayState>,
	remainingItems: CheckItem[],
	currentId?: string,
): string {
	const goalWait = execution.goalWait;
	if (goalWait?.paused) {
		return `paused ${goalWait.pausedReason ? `(${goalWait.pausedReason})` : ""}— send a message or /plans-execute to resume`;
	}
	if (waiting && remainingItems.some((item) => !item.done)) {
		return "waiting for a subprocess result — poll with backoff 5s → 10s → 20s → 40s → 80s";
	}
	const implItems = execution.implItems;
	if (implItems && implItems.length > 0) {
		// Same current-I resolution as the panel model: marker-backed currentI
		// wins (execution focus), otherwise the first non-vc-passed item.
		// Inferred-only fallbacks are display guidance, never a state write.
		const current =
			implItems.find((item) => item.id === currentId && statuses[item.id] !== "vc-passed") ??
			implItems.find((item) => statuses[item.id] !== "vc-passed");
		if (current) {
			const state = statuses[current.id];
			const verb = state === "implemented" || state === "validating" ? "Verify" : "Implement";
			return `${verb} ${current.id} — ${shortImplDescription(current.text)}`;
		}
		// All impl markers passed even though VCs remain (marker drift): fall
		// back to the verifier list.
	}
	const next = remainingItems.find((item) => !item.done);
	if (next) return `Verify ${next.id} — ${shortImplDescription(next.text)}`;
	return "Report completion — no verifier checklist items remain";
}

type ImplMarkerStateLike = "implemented" | "validating";

/**
 * Pure model derivation. `statuses` may be passed in to share one
 * resolveImplStatuses call across model + callers.
 */
export function derivePanelModel(
	execution: {
		items: CheckItem[];
		implItems?: ImplItem[];
		implStatus?: Record<string, ImplMarkerStateLike>;
		currentI?: string;
		goalWait?: { paused?: boolean; pausedReason?: string; noProgressRounds?: number; waitRounds?: number } | null;
	},
	topic: string,
	waiting: boolean,
): PanelModel {
	const items = execution.items;
	const vcDone = items.filter((item) => item.done).length;
	const vcTotal = items.length;
	const remainingItems = items.filter((item) => !item.done);
	const implItems = execution.implItems ?? [];
	const statuses = resolveImplStatuses(implItems.length ? implItems : [], items, execution.implStatus);

	let remainingI = 0;
	for (const id of Object.keys(statuses)) {
		if (statuses[id] !== "vc-passed") remainingI += 1;
	}

	// Current I: marker-backed currentI (only while still pending), else
	// display-only inference (first non-vc-passed); never persisted (D-014 /
	// pi-goal-x currentTaskId lesson).
	let currentI: string | undefined;
	let currentIText: string | undefined;
	let currentState: ImplDisplayState | undefined;
	let currentInferred = false;
	if (implItems.length > 0) {
		const markerCurrent = implItems.find((item) => item.id === execution.currentI && statuses[item.id] !== "vc-passed");
		const firstOpen = implItems.find((item) => statuses[item.id] !== "vc-passed");
		const currentImpl = markerCurrent ?? firstOpen;
		if (currentImpl) {
			currentI = currentImpl.id;
			currentIText = currentImpl.text;
			currentState = statuses[currentImpl.id];
			currentInferred = !markerCurrent;
		}
	}

	const nextAction = deriveNextAction(execution, waiting, statuses, remainingItems, currentI);

	const gw = execution.goalWait;
	const goalWait: GoalWaitPanel | undefined = gw
		? {
				paused: gw.paused === true,
				pausedReason: gw.pausedReason,
				noProgressRounds: gw.noProgressRounds ?? 0,
				waitRounds: gw.waitRounds ?? 0,
			}
		: undefined;

	let phase = "executing";
	let phaseNote: string | undefined;
	if (goalWait?.paused) {
		phase = "paused";
		phaseNote = goalWait.pausedReason;
	} else if (goalWait && (goalWait.noProgressRounds > 0 || goalWait.waitRounds > 0)) {
		phase = "goal-wait";
		phaseNote = `no progress ${goalWait.noProgressRounds}/3 · waiting ${goalWait.waitRounds}/6`;
	} else if (waiting) {
		phase = "goal-wait";
		phaseNote = `waiting for subprocess (round ${goalWait?.waitRounds ?? 0}/6)`;
	}

	return {
		topic,
		phase,
		phaseNote,
		vcDone,
		vcTotal,
		remainingI,
		totalI: Math.max(0, implItems.length),
		currentI,
		currentIText,
		currentState,
		currentInferred,
		nextAction,
		goalWait,
	};
}

// ---------------------------------------------------------------------------
// Rendering helpers (width-safe, ANSI-aware via visibleWidth/truncateToWidth).
// The panel is rendered by the widget factory's render(width) with the theme
// applied per line by the caller (F-004: never prebake ANSI).
// ---------------------------------------------------------------------------

function fit(text: string, budget: number): string {
	return visibleWidth(text) <= budget ? text : truncateToWidth(text, budget);
}

function pad(text: string, width: number): string {
	const used = visibleWidth(text);
	return used < width ? text + " ".repeat(width - used) : text;
}

function boxLine(left: string, body: string, fill: string, width: number, right = left): string {
	const bodyFit = fit(body, Math.max(0, width - 2));
	return left + bodyFit + fill.repeat(Math.max(0, width - 2 - visibleWidth(bodyFit))) + right;
}

const BORDER_LEFT = "╭";
const BORDER_RIGHT = "╮";
const BORDER_BOTTOM_LEFT = "╰";
const BORDER_BOTTOM_RIGHT = "╯";
const BORDER_V = "│";
const HORIZ = "─";

/** `╭─ pi-plans ─ <topic> ────╮` header line (pi-goal-x boxHeader style). */
export function renderPanelHeader(topic: string, width: number): string {
	const inner = `${HORIZ} pi-plans ${HORIZ} ${topic}`;
	return boxLine(BORDER_LEFT, inner, HORIZ, width, BORDER_RIGHT);
}

/** Content line with vertical borders; pads to the fixed width so the buffer
 *  content never shrinks the row (row-count stability is width-independent). */
export function renderPanelLine(content: string, width: number): string {
	return BORDER_V + pad(` ${fit(content, Math.max(0, width - 4))} `, width - 2) + BORDER_V;
}

export function renderPanelFooter(width: number): string {
	const note = ` [I-###:current] ▸ [I-###:implemented] ▸ [I-###:validating] `;
	return boxLine(BORDER_BOTTOM_LEFT, note, HORIZ, width, BORDER_BOTTOM_RIGHT);
}

/** Progress bar (10 cells) for the I items: filled = vc-passed count. */
export function renderProgressBar(done: number, total: number, width: number): string {
	const cells = Math.max(1, Math.min(10, Math.floor((width - 24) / 2)));
	const filled = total > 0 ? Math.round((done / total) * cells) : 0;
	return `${"█".repeat(Math.min(cells, filled))}${"░".repeat(Math.max(0, cells - filled))}`;
}

/**
 * Render the full panel as fixed rows. Mode selection:
 *  - width >= MIN_PANEL_WIDTH → PANEL_ROW_COUNT rows with three-level narrow
 *    degradation inside (D-023): @1 Next-action line keeps only verb + I-id,
 *    @2 goal-wait counts are dropped, @3 the current-I line keeps only its id.
 *  - width < MIN_PANEL_WIDTH → BADGE_ROW_COUNT rows (header + status + footer).
 * Returned array length is always PANEL_ROW_COUNT or BADGE_ROW_COUNT.
 */
export function renderPanelLines(model: PanelModel, width: number): string[] {
	const w = Math.max(4, Math.floor(width));
	if (w < MIN_PANEL_WIDTH) {
		const status = `${model.topic} · I ${model.totalI - model.remainingI}/${model.totalI} · VC ${model.vcDone}/${model.vcTotal}`;
		return [
			boxLine(BORDER_LEFT, ` pi-plans ${HORIZ} ${fit(model.topic, Math.max(4, w - 14))}`, HORIZ, w, BORDER_RIGHT),
			renderPanelLine(status, w),
			boxLine(BORDER_BOTTOM_LEFT, "", HORIZ, w, BORDER_BOTTOM_RIGHT),
		];
	}

	const statusLine =
		model.phase === "executing"
			? `phase: executing`
			: `phase: ${model.phase}${model.phaseNote ? ` · ${model.phaseNote}` : ""}`;

	// Narrow degradation level 1: drop goal-wait counts from the status line.
	const narrow1 = w < 40;
	const statusContent = narrow1 && model.goalWait && !model.goalWait.paused && model.goalWait.waitRounds === 0
		? `phase: ${model.phase}`
		: statusLine;

	const progressContent = `I items ${model.totalI - model.remainingI}/${model.totalI} · ${renderProgressBar(model.totalI - model.remainingI, model.totalI, w)} · VC ${model.vcDone}/${model.vcTotal}`;

	// Narrow degradation level 3: current-I line keeps only the id.
	const currentLabel =
		model.currentI === undefined
			? "(no implementation items)"
			: narrow1
				? `${model.currentI} ${model.currentInferred ? "(inferred)" : ""}`
				: `${model.currentI} ${model.currentState ?? ""}${model.currentInferred ? " (inferred)" : ""} — ${fit(model.currentIText ?? "", Math.max(4, w - 30))}`;

	// Narrow degradation level 1: Next-action keeps verb + id only.
	const nextLabel = narrow1 ? model.nextAction.replace(/— .*$/, "") : model.nextAction;

	const footerNote = `markers: [I-###:current] [I-###:implemented] [I-###:validating] [DONE:VC-###]`;

	return [
		renderPanelHeader(model.topic, w),
		renderPanelLine(statusContent, w),
		renderPanelLine(progressContent, w),
		renderPanelLine(currentLabel, w),
		renderPanelLine(`Next: ${nextLabel}`, w),
		renderPanelLine(footerNote, w),
		renderPanelFooter(w),
	];
}

/** Bottom status-bar summary line, derived from the same model (D-015). */
export function formatPanelSummaryLine(model: PanelModel): string {
	const i = model.totalI > 0 ? ` · I ${model.totalI - model.remainingI}/${model.totalI}` : "";
	const phase =
		model.phase === "executing" ? "exec" : model.phase === "paused" ? "goal-wait paused" : model.phase;
	const paused = model.goalWait?.paused ? ` (${model.goalWait.pausedReason ?? "paused"})` : "";
	return `plans: ${model.topic} ▸ ${phase}${paused}${i} · VC ${model.vcDone}/${model.vcTotal} · next: ${model.nextAction}`;
}