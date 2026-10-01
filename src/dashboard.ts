/**
 * Task dashboard (v0.6.1): the execution-phase UI. A compact aboveEditor
 * widget shows the current task, wave, progress bar, and verification-check
 * state; Ctrl+Shift+T toggles an expanded tree view with per-task markers
 * (✓ complete, ▸ current, ~ skipped, · pending). Pure model + render
 * functions shared by the widget, the status line, and the expanded view so
 * all three never disagree. Width-adaptive: narrow terminals get compact
 * rows, wide terminals get full titles and file lists.
 *
 * Hard invariant: every returned line is at most `width` *display columns*.
 * The widget host measures each line with its own `visibleWidth` and throws an
 * uncaughtException (killing the whole TUI session) when a line is wider than
 * the terminal, so all width math here is column-based via the shared helpers
 * — never `.length`, `padEnd`, or `slice`, which count UTF-16 units and
 * undercount CJK (one CJK char = one unit but two columns).
 */

import type { CheckItem } from "./plan.ts";
import { REVIEW_MAX_ROUNDS } from "./auditor.ts";
import { truncateToWidth, visibleWidth } from "./refine-ui-helpers.ts";
import {
	allTasksTerminal,
	currentTask,
	flattenTaskViews,
	maxWave,
	taskIsTerminal,
	taskProgress,
	type TaskView,
} from "./tasks.ts";

export const DASHBOARD_WIDGET_KEY = "pi-plans-dashboard";

export interface DashboardModel {
	topic: string;
	tasks: TaskView[];
	checklist: CheckItem[];
	paused: boolean;
	pausedReason?: string;
	/** Audit round counter; null = audit not yet started. */
	auditRounds: number | null;
	auditFailed: string[];
	/** Checks whose verdict the auditor could not be read for. Neither passed
	 * nor failed: shown so the run does not read as finished. */
	auditUndeterminable: string[];
	/** v0.8: true while an execution-review round is in flight. The panel must
	 * never render `audit complete ✓` while this is set — the round-1 mis-cue
	 * showed the tick for the whole duration of a running audit. */
	reviewRunning: boolean;
	startedAt: string;
	usage: { inToks: number; outToks: number };
}

/** Tree marker for one task row. A rolled-back task is `pending` but still
 * carries the evidence of its previous attempt, so it gets its own marker
 * rather than reading as untouched work. */
export function taskMarker(task: TaskView, currentId: string | null): string {
	if (taskIsTerminal(task)) return task.status === "skipped" ? "~" : "✓";
	if (task.id === currentId) return "▸";
	return task.evidence === undefined ? "·" : "↺";
}

/** Truncate to at most `max` display columns, ellipsis when clipped. */
function clip(text: string, max: number): string {
	return max <= 0 ? "" : truncateToWidth(text, max);
}

/** Pad with `fill` out to exactly `width` display columns; never widens. */
function padToWidth(text: string, width: number, fill = " "): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + fill.repeat(gap) : text;
}

/**
 * One bordered row of exactly `width` display columns: left border, fitted
 * body, filler, right border. Every compact row goes through here so the box
 * can never be `width + 1` columns wide (the old `padEnd().slice(0, width) +
 * border` shape was one column over on every row).
 */
function boxRow(left: string, body: string, fill: string, width: number, right = left): string {
	const inner = Math.max(0, width - 2);
	return left + padToWidth(clip(body, inner), inner, fill) + right;
}

/** Last-resort clamp so no rendered line can ever exceed the terminal width. */
function clampLines(lines: string[], width: number): string[] {
	if (width <= 0) return [];
	return lines.map((line) => truncateToWidth(line, width));
}

/** Minimal structural subset of the pi Theme the widget needs. */
export interface DashboardTheme {
	fg(color: string, text: string): string;
}

/** Brand label opening the title row. */
const BRAND = "π-plans";

/** `HH:MM:SS` since the run started. */
export function formatElapsed(startedAt: string): string {
	const started = Date.parse(startedAt);
	if (Number.isNaN(started)) return "00:00:00";
	const total = Math.max(0, Math.floor((Date.now() - started) / 1000));
	const h = String(Math.floor(total / 3600)).padStart(2, "0");
	const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
	const sec = String(total % 60).padStart(2, "0");
	return `${h}:${m}:${sec}`;
}

/**
 * Title row: `┌─ π-plans: <plan> ───┐`, brand in the accent colour, the rest
 * muted. Colours are emitted as *sequential* balanced spans rather than nested:
 * a theme `fg()` closes with the default-foreground reset, so wrapping a muted
 * span around an accent one would leave everything after it unstyled.
 */
function titleRow(topic: string, width: number, theme?: DashboardTheme): string {
	const inner = Math.max(0, width - 2);
	const prefix = "─ ";
	const sep = ": ";
	const used = prefix.length + BRAND.length + sep.length;
	const name = clip(topic, Math.max(0, inner - used));
	const fill = "─".repeat(Math.max(0, inner - used - visibleWidth(name)));
	const rest = `${sep}${name}${fill}┐`;
	if (!theme) return `┌${prefix}${BRAND}${rest}`;
	// The left corner rides in the first muted span so the whole border is one colour.
	return theme.fg("muted", `┌${prefix}`) + theme.fg("accent", BRAND) + theme.fg("muted", rest);
}

/**
 * Progress row: `Tasks 3/10 · Verification checks 1/6 · 00:04:12 ███░░░░░░░░`.
 * The bar, then the elapsed time, then the counts are dropped in that order
 * when the terminal is too narrow to hold them, so the counts always survive.
 */
function progressRow(
	model: DashboardModel,
	done: number,
	total: number,
	vcDone: number,
	width: number,
	narrow: boolean,
): string {
	const inner = Math.max(0, width - 2);
	const counts = `Tasks ${done}/${total} · Verification checks ${vcDone}/${model.checklist.length}`;
	const elapsed = ` · ${formatElapsed(model.startedAt)}`;
	const bar = ` ${progressBar(done, total, narrow ? 8 : 12)}`;
	let body = ` ${counts}${elapsed}${bar}`;
	if (visibleWidth(body) > inner) body = ` ${counts}${elapsed}`;
	if (visibleWidth(body) > inner) body = ` ${counts}`;
	return boxRow("│", body, " ", width);
}

/** Compact widget lines (aboveEditor). Adapts to width: <64 narrow. */
export function renderDashboardLines(model: DashboardModel, width: number, theme?: DashboardTheme): string[] {
	const p = taskProgress(model.tasks);
	const cur = currentTask(model.tasks);
	const vcDone = model.checklist.filter((item) => item.done).length;
	const narrow = width < 64;
	const lines: string[] = [];
	const inner = Math.max(0, width - 2);
	lines.push(titleRow(model.topic, width, theme));
	lines.push(progressRow(model, p.done, p.total, vcDone, width, narrow));
	if (model.paused) {
		lines.push(boxRow("│", ` ⏸ ${clip(model.pausedReason ?? "paused", inner - 3)}`, " ", width));
	} else if (cur) {
		const waveLine = narrow ? `▸ ${cur.id} (w${cur.wave})` : `▸ ${cur.id} (wave ${cur.wave}/${maxWave(model.tasks)}): ${cur.title}`;
		lines.push(boxRow("│", ` ${clip(waveLine, inner - 2)}`, " ", width));
		if (!narrow && cur.files.length > 0) {
			lines.push(boxRow("│", `   ${clip(cur.files.join(", "), inner - 4)}`, " ", width));
		}
	} else if (allTasksTerminal(model.tasks)) {
		// v0.8 mis-cue guard: `audit complete ✓` ONLY when nothing is running
		// and nothing is owed. A running or owed review shows its round number
		// instead — the panel must look alive, never finished-then-silent.
		const owed = model.checklist.some((item) => !item.done);
		const nextRound = (model.auditRounds ?? 0) + 1;
		const auditLine = model.reviewRunning
			? `review: round ${nextRound}/${REVIEW_MAX_ROUNDS} running — read-only reviewer verifying`
			: model.auditFailed.length > 0
				? `audit: ${model.auditFailed.length} check(s) failed — rollback pending`
				: model.auditUndeterminable.length > 0
					? `audit: ${model.auditUndeterminable.length} check(s) undeterminable — verdict unreadable`
					: owed
						? `review: round ${nextRound}/${REVIEW_MAX_ROUNDS} — verdict pending`
						: model.auditRounds !== null
							? "audit complete ✓"
							: "all tasks terminal — audit pending";
		lines.push(boxRow("│", ` ${clip(auditLine, inner - 2)}`, " ", width));
	}
	if (!narrow && model.auditFailed.length > 0) {
		lines.push(boxRow("│", ` ✗ ${clip(model.auditFailed.join(", "), inner - 3)}`, " ", width));
	}
	if (!narrow && model.auditUndeterminable.length > 0) {
		lines.push(boxRow("│", ` ? ${clip(model.auditUndeterminable.join(", "), inner - 3)}`, " ", width));
	}
	// Rolled-back work keeps the evidence of the attempt that was rolled back.
	// The tree view shows it per row; the compact panel has room for a summary
	// and must show it too, otherwise the retention is invisible outside the
	// expanded view. Capped at two rows to protect the fixed panel height.
	for (const rolled of flattenTaskViews(model.tasks)
		.filter((task) => task.status === "pending" && task.evidence !== undefined)
		.slice(0, 2)) {
		lines.push(boxRow("│", ` ↺ ${rolled.id} ${clip(rolled.evidence!, inner - 6)}`, " ", width));
	}
	lines.push(boxRow("└", "─ Ctrl+Shift+T tree", "─", width, "┘"));
	// The title row carries its own colours; every other row is muted.
	const painted = theme ? lines.map((line, i) => (i === 0 ? line : theme.fg("muted", line))) : lines;
	return clampLines(painted, width);
}

function progressBar(done: number, total: number, width = 12): string {
	if (total <= 0) return "";
	const filled = Math.round((done / total) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function deriveDashboardModel(
	topic: string,
	tasks: TaskView[],
	checklist: CheckItem[],
	extra?: { paused?: boolean; pausedReason?: string; auditRounds?: number | null; auditFailed?: string[]; auditUndeterminable?: string[]; reviewRunning?: boolean; startedAt?: string; usage?: { inToks: number; outToks: number } },
): DashboardModel {
	return {
		topic,
		tasks,
		checklist,
		paused: extra?.paused ?? false,
		pausedReason: extra?.pausedReason,
		auditRounds: extra?.auditRounds ?? null,
		auditFailed: extra?.auditFailed ?? [],
		auditUndeterminable: extra?.auditUndeterminable ?? [],
		reviewRunning: extra?.reviewRunning ?? false,
		startedAt: extra?.startedAt ?? new Date().toISOString(),
		usage: extra?.usage ?? { inToks: 0, outToks: 0 },
	};
}

/** Status-bar summary line (single line, language-neutral symbols). */
export function formatDashboardSummaryLine(model: DashboardModel): string {
	const p = taskProgress(model.tasks);
	const vcDone = model.checklist.filter((item) => item.done).length;
	const cur = currentTask(model.tasks);
	const wave = cur ? ` · wave ${cur.wave}` : "";
	const audit = model.auditRounds !== null ? ` · audit r${model.auditRounds}` : "";
	const pause = model.paused ? " · ⏸ paused" : "";
	return `plans: ${model.topic} ▸ tasks ${p.done}/${p.total} · VC ${vcDone}/${model.checklist.length}${wave}${audit}${pause}`;
}

/** Expanded tree view lines (Ctrl+Shift+T overlay). Wide layout from 96 cols. */
export function renderDashboardTreeLines(model: DashboardModel, width: number, theme?: DashboardTheme): string[] {
	const p = taskProgress(model.tasks);
	const vcDone = model.checklist.filter((item) => item.done).length;
	const cur = currentTask(model.tasks);
	const wide = width >= 96;
	const lines: string[] = [];
	lines.push(`${model.topic} — task tree (${p.done}/${p.total} done · VC ${vcDone}/${model.checklist.length})${model.paused ? " · ⏸ paused" : ""}`);
	const row = (task: TaskView, depth: number): void => {
		const indent = "  ".repeat(depth);
		const marker = taskMarker(task, cur?.id ?? null);
		const title = wide ? task.title : clip(task.title, 48);
		let line = `${indent}${marker} ${task.id}: ${title}`;
		if (wide && task.files.length > 0) line += `  [${task.files.join(", ")}]`;
		if (wide && task.deps.length > 0) line += `  (deps: ${task.deps.join(", ")})`;
		if (task.status === "skipped" && task.skipReason) line += `  ~${task.skipReason}`;
		if (task.status === "complete" && task.evidence) line += `  ✓${clip(task.evidence, 40)}`;
		// Rolled-back work keeps its evidence, and that evidence is the only
		// record of what the previous attempt did.
		if (task.status === "pending" && task.evidence) line += `  ↺${clip(task.evidence, 40)}`;
		lines.push(line);
		for (const child of task.children) row(child, depth + 1);
	};	for (const task of model.tasks) row(task, 0);
	lines.push("");
	lines.push("Verification checks:");
	for (const item of model.checklist) {
		const mark = model.auditFailed.includes(item.id) ? "✗" : item.done ? "☑" : "☐";
		lines.push(`  ${mark} ${item.id}${wide ? ` ${clip(item.text.split(";")[1] ?? item.text, Math.min(80, width))}` : ""}`);
	}
	if (model.reviewRunning) {
		lines.push("");
		lines.push(`Execution review: round ${(model.auditRounds ?? 0) + 1}/${REVIEW_MAX_ROUNDS} running`);
	} else if (model.auditRounds !== null) {
		lines.push("");
		const verdict = model.auditFailed.length > 0
			? ` — failed: ${model.auditFailed.join(", ")}`
			: model.auditUndeterminable.length > 0
				? ` — undeterminable: ${model.auditUndeterminable.join(", ")}`
				: " — passed ✓";
		lines.push(`Execution review: round ${model.auditRounds}${verdict}`);
	}
	const painted = theme ? lines.map((line) => theme.fg("muted", line)) : lines;
	return clampLines(painted, width);
}

/** Flat open-task summary for injections: current wave first. */
export function openTaskSummary(tasks: TaskView[]): string {
	const cur = currentTask(tasks);
	if (!cur) return "(none — all tasks terminal)";
	const open = flattenTaskViews(tasks).filter((task) => !taskIsTerminal(task));
	const currentWave = cur.wave;
	const inWave = open.filter((task) => task.wave === currentWave).map((task) => task.id);
	const later = open.filter((task) => task.wave > currentWave).map((task) => task.id);
	const parts = [`current wave ${currentWave}: ${inWave.join(", ") || "(none)"}`];
	if (later.length > 0) parts.push(`later waves: ${later.join(", ")}`);
	return parts.join(" · ");
}
