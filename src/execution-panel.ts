import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckItem } from "./plan.ts";

/** SGR runs plus OSC hyperlinks: escaped bytes, no display columns. */
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Code points rendered as two terminal columns (East-Asian Wide/Fullwidth). */
function isWideCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals/symbols
		(codePoint >= 0x3041 && codePoint <= 0x33ff) || // Hiragana…CJK compatibility
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Ext A
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
		(codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Ext-A
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) || // vertical forms
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK compat forms
		(codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) || // fullwidth signs
		(codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji pictographs
		(codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK Ext B…plan 3
	);
}

/** Zero-advance code points: combining marks, selectors, joiners, controls. */
function isZeroWidthCodePoint(codePoint: number): boolean {
	return (
		codePoint < 0x20 ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritics
		(codePoint >= 0x20d0 && codePoint <= 0x20f0) || // combining symbols
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
		(codePoint >= 0xe0100 && codePoint <= 0xe01ef) || // variation selectors ext
		codePoint === 0x200b || codePoint === 0x200d || codePoint === 0xfeff
	);
}

function codePointColumns(codePoint: number): number {
	if (isZeroWidthCodePoint(codePoint)) return 0;
	if (isWideCodePoint(codePoint)) return 2;
	return 1;
}

/** Displayed terminal columns of `text`, ignoring escape sequences. */
export function visibleWidth(text: string): number {
	let total = 0;
	for (const ch of text.replace(ANSI_PATTERN, "")) {
		total += codePointColumns(ch.codePointAt(0) ?? 0);
	}
	return total;
}

/**
 * Truncate styled text to fit within `width` terminal columns.
 *
 * Reserves one safety column against host/TUI measurement differences so a
 * truncated line can never re-trigger the renderer's width assertion.
 */
export function truncateAnsi(text: string, width: number): string {
	if (width <= 0) return "";
	const cap = width - 1;
	if (cap < 1) return visibleWidth(text) <= width ? text : "";
	const total = visibleWidth(text);
	if (total <= cap) return text;
	const budget = cap - 1; // keep room for the trailing ellipsis
	let out = "";
	let used = 0;
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\x1b") {
			const rest = text.slice(i);
			const sgr = rest.match(/^\x1b\[[0-9;]*[A-Za-z]/);
			if (sgr) {
				out += sgr[0];
				i += sgr[0].length;
				continue;
			}
			const osc = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
			if (osc) {
				i += osc[0].length;
				continue;
			}
		}
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;
		const ch = String.fromCodePoint(codePoint);
		const columns = codePointColumns(codePoint);
		if (used + columns > budget) break;
		used += columns;
		out += ch;
		i += ch.length;
	}
	return `${out}…\x1b[0m`;
}

export interface RepoSnapshot {
	added: number;
	removed: number;
	files: number;
}

export interface ItemDiffSummary extends RepoSnapshot {
	paths: string[];
	shared?: boolean;
}

export interface ExecutionPanelItemState {
	summary?: ItemDiffSummary;
}

export interface ExecutionPanelState {
	expanded: boolean;
	baseline: RepoSnapshot | null;
	lastSnapshot: RepoSnapshot | null;
	touchedPaths: string[];
	itemSummaries: Record<string, ExecutionPanelItemState>;
}

export interface ExecutionPanelExecutionLike {
	planPath: string;
	items: CheckItem[];
	panel?: ExecutionPanelState;
}

interface ThemeLike {
	fg(color: string, text: string): string;
	strikethrough(text: string): string;
}

interface WidgetLike {
	render(width: number): string[];
	invalidate(): void;
}

const WIDGET_ID = "pi-plans-execution";
const PANEL_STATE_ENTRY = "pi-plans-exec-panel";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error) {
		return "";
	}
	return String(result.stdout ?? "").trim();
}

function normalizePath(cwd: string, raw: string): string {
	const trimmed = raw.trim().replace(/[\u0000]+/g, "");
	if (!trimmed) return "";
	if (trimmed.startsWith("-") || trimmed === "." || trimmed === "..") return "";
	const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
	const relative = path.relative(cwd, absolute);
	const safe = relative.startsWith("..") ? path.basename(absolute) : relative;
	return safe.split(path.sep).join("/");
}

function extractPathsFromBash(command: string, cwd: string): string[] {
	const values = new Set<string>();
	for (const token of command.split(/\s+/)) {
		const cleaned = token.replace(/^["'`(<[{]+|["'`)>}\],;]+$/g, "");
		if (!cleaned || cleaned.startsWith("-") || cleaned === "." || cleaned === "..") continue;
		const looksLikePath =
			cleaned.includes("/") ||
			cleaned.startsWith(".") ||
			cleaned.startsWith("~") ||
			/^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(cleaned);
		if (!looksLikePath) continue;
		const normalized = normalizePath(cwd, cleaned);
		if (normalized) values.add(normalized);
	}
	return [...values];
}

function parseNumstat(output: string, workdir: string): RepoSnapshot {
	let added = 0;
	let removed = 0;
	let files = 0;
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const add = Number(parts[0] === "-" ? 0 : parts[0]);
		const del = Number(parts[1] === "-" ? 0 : parts[1]);
		const filePath = normalizePath(workdir, parts.slice(2).join("\t"));
		if (!filePath) continue;
		added += Number.isFinite(add) ? add : 0;
		removed += Number.isFinite(del) ? del : 0;
		files += 1;
	}
	return { added, removed, files };
}

export function captureRepoSnapshot(workdir: string): RepoSnapshot {
	const tracked = parseNumstat(runGit(workdir, ["diff", "--numstat", "--find-renames=0", "HEAD", "--", "."]), workdir);
	const untracked = runGit(workdir, ["ls-files", "-o", "--exclude-standard"]);
	let untrackedAdded = 0;
	let untrackedFiles = 0;
	if (untracked) {
		for (const raw of untracked.split("\n")) {
			const filePath = normalizePath(workdir, raw);
			if (!filePath) continue;
			const stats = parseNumstat(runGit(workdir, ["diff", "--numstat", "--no-index", "/dev/null", filePath]), workdir);
			untrackedAdded += stats.added;
			untrackedFiles += stats.files || 1;
		}
	}
	return {
		added: tracked.added + untrackedAdded,
		removed: tracked.removed,
		files: tracked.files + untrackedFiles,
	};
}

export function subtractSnapshots(previous: RepoSnapshot, current: RepoSnapshot): RepoSnapshot {
	return {
		added: current.added - previous.added,
		removed: current.removed - previous.removed,
		files: current.files - previous.files,
	};
}

export function createExecutionPanelState(): ExecutionPanelState {
	return {
		expanded: false,
		baseline: null,
		lastSnapshot: null,
		touchedPaths: [],
		itemSummaries: {},
	};
}

export function cloneExecutionPanelState(state: ExecutionPanelState): ExecutionPanelState {
	return {
		expanded: state.expanded,
		baseline: state.baseline ? { ...state.baseline } : null,
		lastSnapshot: state.lastSnapshot ? { ...state.lastSnapshot } : null,
		touchedPaths: [...state.touchedPaths],
		itemSummaries: Object.fromEntries(
			Object.entries(state.itemSummaries).map(([id, item]) => [
				id,
				item.summary
					? {
						summary: {
							added: item.summary.added,
							removed: item.summary.removed,
							files: item.summary.files,
							paths: [...item.summary.paths],
							shared: item.summary.shared,
						},
					}
					: {},
			]),
		),
	};
}

export function ensurePanelState(execution: ExecutionPanelExecutionLike): ExecutionPanelState {
	if (!execution.panel) {
		execution.panel = createExecutionPanelState();
	}
	return execution.panel;
}

export function attachPanelBaseline(execution: ExecutionPanelExecutionLike, workdir: string): ExecutionPanelState {
	const panel = ensurePanelState(execution);
	const snapshot = captureRepoSnapshot(workdir);
	panel.baseline = snapshot;
	panel.lastSnapshot = snapshot;
	panel.touchedPaths = [];
	panel.itemSummaries = {};
	return panel;
}

export function restorePanelState(raw: unknown): ExecutionPanelState | null {
	if (!raw || typeof raw !== "object") return null;
	const candidate = raw as Partial<ExecutionPanelState>;
	return {
		expanded: Boolean(candidate.expanded),
		baseline: candidate.baseline && typeof candidate.baseline.added === "number" ? { ...candidate.baseline } : null,
		lastSnapshot:
			candidate.lastSnapshot && typeof candidate.lastSnapshot.added === "number"
				? { ...candidate.lastSnapshot }
				: null,
		touchedPaths: Array.isArray(candidate.touchedPaths)
			? candidate.touchedPaths.map((item) => String(item)).filter(Boolean)
			: [],
		itemSummaries:
			candidate.itemSummaries && typeof candidate.itemSummaries === "object"
				? Object.fromEntries(
						Object.entries(candidate.itemSummaries).map(([id, item]) => {
							const summary = (item as ExecutionPanelItemState | undefined)?.summary;
							return [
								id,
								summary
									? {
										summary: {
											added: summary.added ?? 0,
											removed: summary.removed ?? 0,
											files: summary.files ?? 0,
											paths: Array.isArray(summary.paths) ? summary.paths.map((pathValue) => String(pathValue)) : [],
											shared: summary.shared,
										},
									}
								: {},
							];
						}),
					)
				: {},
	};
}

export function snapshotPanelState(execution: ExecutionPanelExecutionLike): ExecutionPanelState {
	return cloneExecutionPanelState(ensurePanelState(execution));
}

export function setExpanded(execution: ExecutionPanelExecutionLike, expanded: boolean): void {
	ensurePanelState(execution).expanded = expanded;
}

export function toggleExpanded(execution: ExecutionPanelExecutionLike): boolean {
	const panel = ensurePanelState(execution);
	panel.expanded = !panel.expanded;
	return panel.expanded;
}

export function recordTouchedPaths(execution: ExecutionPanelExecutionLike, paths: string[]): void {
	if (!paths.length) return;
	const panel = ensurePanelState(execution);
	const merged = new Set(panel.touchedPaths);
	for (const raw of paths) {
		const normalized = raw.trim().replace(/[\\/]+/g, "/").replace(/[\u0000]+/g, "");
		if (normalized && normalized !== "." && normalized !== "..") merged.add(normalized);
	}
	panel.touchedPaths = [...merged];
}

export function completeCompletedItems(
	execution: ExecutionPanelExecutionLike,
	workdir: string,
	completedIds: string[],
): ItemDiffSummary | null {
	if (!completedIds.length) return null;
	const panel = ensurePanelState(execution);
	const current = captureRepoSnapshot(workdir);
	const previous = panel.lastSnapshot ?? panel.baseline ?? current;
	const delta = subtractSnapshots(previous, current);
	const summary: ItemDiffSummary = {
		added: delta.added,
		removed: delta.removed,
		files: delta.files,
		paths: [...new Set(panel.touchedPaths)],
		shared: completedIds.length > 1,
	};
	for (const id of completedIds) {
		panel.itemSummaries[id] = { summary };
	}
	panel.lastSnapshot = current;
	panel.touchedPaths = [];
	return summary;
}

export function clearPanelState(execution: ExecutionPanelExecutionLike): void {
	execution.panel = createExecutionPanelState();
}

function formatSummaryLine(summary: ItemDiffSummary, theme: ThemeLike, width: number): string {
	const plus = theme.fg("success", `+${Math.max(summary.added, 0)}`);
	const minus = theme.fg("error", `-${Math.max(summary.removed, 0)}`);
	const files = theme.fg("muted", `${Math.max(summary.files, 0)} file${Math.max(summary.files, 0) === 1 ? "" : "s"}`);
	const marker = summary.shared ? theme.fg("dim", " shared") : "";
	return truncateAnsi(`    ${plus} ${minus} ${files}${marker}`, width);
}

function formatPathLine(paths: string[], theme: ThemeLike, width: number): string | null {
	if (!paths.length) return null;
	return truncateAnsi(`      ${theme.fg("dim", paths.join(", "))}`, width);
}

function renderItemLines(item: CheckItem, summary: ItemDiffSummary | undefined, theme: ThemeLike, width: number): string[] {
	const done = item.done;
	const checkbox = done ? theme.fg("success", "☑ ") : theme.fg("muted", "☐ ");
	const text = done ? theme.strikethrough(item.text) : item.text;
	const lines = [truncateAnsi(`${checkbox}${text}`, width)];
	if (summary) {
		lines.push(formatSummaryLine(summary, theme, width));
		const pathLine = formatPathLine(summary.paths, theme, width);
		if (pathLine) lines.push(pathLine);
	}
	return lines;
}

function renderPanelLines(execution: ExecutionPanelExecutionLike, theme: ThemeLike, width: number): string[] {
	// Expanded detail view only: the count/hint live in the bottom status bar,
	// so the panel below the editor never repeats them.
	const panel = ensurePanelState(execution);
	if (!panel.expanded) return [""];
	const lines: string[] = [];
	for (const item of execution.items) {
		const summary = panel.itemSummaries[item.id]?.summary;
		lines.push(...renderItemLines(item, summary, theme, width));
	}
	return lines.length ? lines : [""];
}

interface WidgetThemeSource {
	theme: ThemeLike | null;
}

let renderCacheWidth: number | null = null;
let renderCacheLines: string[] | null = null;

function invalidateRenderCache(): void {
	renderCacheWidth = null;
	renderCacheLines = null;
}

class ExecutionPanelWidget implements WidgetLike {
	private readonly source: WidgetThemeSource;

	constructor(source: WidgetThemeSource) {
		this.source = source;
	}

	invalidate(): void {
		invalidateRenderCache();
	}

	render(width: number): string[] {
		if (renderCacheWidth === width && renderCacheLines) return renderCacheLines;
		const execution = panelRef.current;
		const theme = this.source.theme ?? ({ fg: (_c: string, t: string) => t, strikethrough: (t: string) => t } as ThemeLike);
		renderCacheLines = execution ? renderPanelLines(execution, theme, width) : [""];
		renderCacheWidth = width;
		return renderCacheLines;
	}
}

// One live widget instance per session: refreshing invalidates its cache
// instead of tearing down and re-registering the whole widget (which forced
// a full TUI relayout mid-stream). Registration is tied to the host `ctx.ui`
// instance so replacement hosts (extension reload, tests) register afresh.
let panelRef: { current: ExecutionPanelExecutionLike | null } = { current: null };
const themeSource: WidgetThemeSource = { theme: null };
let registeredUi: unknown = null;

export function refreshExecutionPanel(ctx: ExtensionContext, execution: ExecutionPanelExecutionLike | null): void {
	if (!execution || !execution.items.length) {
		clearExecutionPanel(ctx);
		return;
	}
	if (!execution.panel?.expanded) {
		// Collapsed: the bottom status bar carries the count; no panel widget.
		clearExecutionPanel(ctx);
		return;
	}
	panelRef.current = execution;
	invalidateRenderCache(); // next render always reflects the latest state
	if (registeredUi === ctx.ui) {
		// Same host, same widget slot: nothing to re-register.
		return;
	}
	registeredUi = ctx.ui;
	ctx.ui.setWidget(
		WIDGET_ID,
		(_tui, theme) => {
			themeSource.theme = theme as ThemeLike;
			return new ExecutionPanelWidget(themeSource);
		},
		{ placement: "belowEditor" },
	);
}

export function clearExecutionPanel(ctx: ExtensionContext): void {
	panelRef.current = null;
	registeredUi = null;
	invalidateRenderCache();
	ctx.ui.setWidget(WIDGET_ID, undefined);
}

export function executionPanelEntryData(execution: ExecutionPanelExecutionLike): unknown {
	const panel = execution.panel ?? createExecutionPanelState();
	return {
		expanded: panel.expanded,
		baseline: panel.baseline,
		lastSnapshot: panel.lastSnapshot,
		touchedPaths: [...panel.touchedPaths],
		itemSummaries: panel.itemSummaries,
	};
}

export function executionPanelFromEntryData(data: unknown): ExecutionPanelState | null {
	return restorePanelState(data);
}
