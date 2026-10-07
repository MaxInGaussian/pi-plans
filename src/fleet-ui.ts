/**
 * Delegated-agent UI: a bulleted list above the editor plus a detail overlay
 * for one agent.
 *
 * The list is browsed with the keyboard while the editor is empty: `↓`
 * focuses it, `↑/↓` pick an agent, `Enter` opens that agent's overlay, `Esc`
 * (or `↑` past the first row) hands focus back. Every other key leaves the
 * list and reaches the editor untouched.
 */

import type { ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { fleet as sharedFleet, workedMs, type AgentFleet, type FleetEntry } from "./agent-fleet.ts";
import { getPiTui, matchesTerminalKey } from "./terminal-keys.ts";
import { fleetChrome, type UiLanguage } from "./ui-language.ts";
import {
	truncateToWidth as localTruncateToWidth,
	visibleWidth as localVisibleWidth,
	wrapTextWithAnsi as localWrapTextWithAnsi,
} from "./refine-ui-helpers.ts";
import { statusLabel, type RefineLaneState, type RefineTranscriptEntry } from "./refine-ui-state.ts";

function truncateToWidth(text: string, width: number, ellipsis = ""): string {
	try {
		const tui = getPiTui();
		return tui ? tui.truncateToWidth(text, width, ellipsis) : localTruncateToWidth(text, width, ellipsis);
	} catch {
		return localTruncateToWidth(text, width, ellipsis);
	}
}

function visibleWidth(text: string): number {
	try {
		const tui = getPiTui();
		return tui ? tui.visibleWidth(text) : localVisibleWidth(text);
	} catch {
		return localVisibleWidth(text);
	}
}

function wrapTextWithAnsi(text: string, width: number): string[] {
	try {
		const tui = getPiTui();
		return tui ? tui.wrapTextWithAnsi(text, width) : localWrapTextWithAnsi(text, width);
	} catch {
		return localWrapTextWithAnsi(text, width);
	}
}

function fitLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

/** Escape — plus the legacy double-ESC burst the fallback historically accepted. */
function isEscape(data: string): boolean {
	return matchesTerminalKey(data, "escape") || data === "\x1b\x1b";
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function laneColor(status: RefineLaneState["status"]): ThemeColor {
	switch (status) {
		case "complete": return "success";
		case "failed": return "error";
		case "cancelled": return "warning";
		case "running": return "accent";
		case "queued": return "muted";
	}
}

function isFinished(entry: FleetEntry): boolean {
	return entry.lane.status === "complete" || entry.lane.status === "failed" || entry.lane.status === "cancelled";
}

function entryColor(entry: FleetEntry): ThemeColor {
	return entry.idle ? "muted" : laneColor(entry.lane.status);
}

function entryStatus(entry: FleetEntry, lang: UiLanguage): string {
	const chrome = fleetChrome(lang);
	if (entry.idle) return chrome.idle;
	switch (entry.lane.status) {
		case "queued": return chrome.queued;
		case "running": return chrome.running;
		case "complete": return chrome.done;
		default: return statusLabel(entry.lane.status);
	}
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface FleetListView {
	entries: FleetEntry[];
	/** Index of the highlighted row; null while the list is not focused. */
	selected: number | null;
	now: number;
	lang: UiLanguage;
	theme: Theme;
	width: number;
	/** Hard cap on rendered lines (default 12). */
	maxLines?: number;
}

/** Bulleted list of agents. Pure: every line fits `width` display columns. */
export function renderFleetLines(view: FleetListView): string[] {
	const { entries, selected, now, lang, theme, width } = view;
	if (entries.length === 0) return [];
	const chrome = fleetChrome(lang);
	const maxLines = Math.max(4, view.maxLines ?? 12);
	const running = entries.filter((entry) => entry.lane.status === "running" && !entry.idle).length;
	const queued = entries.filter((entry) => entry.lane.status === "queued").length;
	const done = entries.filter((entry) => entry.lane.status === "complete").length;
	const failed = entries.filter((entry) => entry.lane.status === "failed").length;
	const cancelled = entries.filter((entry) => entry.lane.status === "cancelled").length;
	const counts = [
		running > 0 ? `${running} ${chrome.running}` : "",
		queued > 0 ? `${queued} ${chrome.queued}` : "",
		done > 0 || failed + cancelled === 0 ? `${done} ${chrome.done}` : "",
		failed > 0 ? `${failed} ${chrome.failed}` : "",
		cancelled > 0 ? `${cancelled} ${chrome.cancelled}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const header = `${theme.fg("accent", theme.bold(`${chrome.title} (${entries.length})`))}${theme.fg("dim", ` · ${counts}`)}`;
	// Everything has finished and nobody is browsing: collapse to one summary
	// line. The finished agents stay reachable — ↓ expands the list again.
	if (selected === null && entries.every((entry) => !entry.idle && isFinished(entry))) {
		return [fitLine(`${header}${theme.fg("dim", ` · ${chrome.browseHint}`)}`, width)];
	}
	const lines: string[] = [header];

	const rowBudget = maxLines - 2; // header + hint
	let start = 0;
	let visibleRows = entries.length;
	if (entries.length > rowBudget) {
		visibleRows = rowBudget - 1; // leave one line for "+N more"
		const anchor = selected ?? 0;
		start = Math.min(Math.max(0, anchor - visibleRows + 1), entries.length - visibleRows);
	}
	for (let index = start; index < start + visibleRows; index++) {
		const entry = entries[index]!;
		const isSelected = selected === index;
		const color = entryColor(entry);
		const bullet = isSelected ? theme.fg("accent", "▸") : theme.fg(color, "•");
		const label = isSelected ? theme.fg("accent", theme.bold(entry.label)) : theme.bold(entry.label);
		const phase = entry.lane.status === "running" && !entry.idle && entry.lane.phase ? theme.fg("muted", ` · ${entry.lane.phase}`) : "";
		const tools = entry.toolCalls > 0 ? ` · ${entry.toolCalls} ${chrome.tools}` : "";
		const worked = workedMs(entry, now);
		const elapsed = worked > 0 || entry.workingSince !== undefined ? ` · ${formatElapsed(worked)}` : "";
		const note = entry.note ? ` · ${entry.note}` : "";
		lines.push(`${bullet} ${label} ${theme.fg(color, entryStatus(entry, lang))}${phase}${theme.fg("dim", `${tools}${elapsed}${note}`)}`);
	}
	if (visibleRows < entries.length) lines.push(theme.fg("dim", `  ${chrome.more.replace("{n}", String(entries.length - visibleRows))}`));
	lines.push(theme.fg("dim", selected === null ? chrome.browseHint : chrome.listHint));
	return lines.map((line) => fitLine(line, width));
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

const OVERLAY_MIN_WIDTH = 72;
const OVERLAY_MIN_HEIGHT = 18;
const OVERLAY_MAX_HEIGHT = 32;
const OVERLAY_HEIGHT_RATIO = 0.78;
const STREAMING_PREVIEW_LINES = 3;
const OVERLAY_CHROME_LINES = 5; // top border + title row + status row + footer row + bottom border

export function getTerminalRowCount(): number {
	const raw = (process.stdout as { rows?: number }).rows;
	return typeof raw === "number" && raw > 0 ? raw : 30;
}

export function pickOverlayHeight(): number {
	const target = Math.max(OVERLAY_MIN_HEIGHT, Math.floor(getTerminalRowCount() * OVERLAY_HEIGHT_RATIO));
	return Math.min(OVERLAY_MAX_HEIGHT, target);
}

function borderColor(selected = false): ThemeColor {
	return selected ? "borderAccent" : "border";
}

function renderRow(theme: Theme, content: string, innerWidth: number): string {
	const truncated = truncateToWidth(content, innerWidth, "");
	const width = visibleWidth(truncated);
	const filler = innerWidth > width ? " ".repeat(innerWidth - width) : "";
	return `${theme.fg(borderColor(true), "│")}${truncated}${filler}${theme.fg(borderColor(true), "│")}`;
}

function renderBorderLine(theme: Theme, innerWidth: number, edge: "top" | "bottom"): string {
	const left = edge === "top" ? "┌" : "└";
	const right = edge === "top" ? "┐" : "┘";
	return theme.fg(borderColor(true), `${left}${"─".repeat(innerWidth)}${right}`);
}

function entryBadge(entry: RefineTranscriptEntry, theme: Theme): string {
	const streaming = entry.streaming ? theme.fg("warning", " ▍") : "";
	switch (entry.type) {
		case "assistant-text":
			return theme.fg("accent", theme.bold(" assistant ")) + streaming;
		case "thinking":
			return theme.fg("warning", theme.bold(" thinking ")) + streaming;
		case "tool-call":
			return theme.fg("accent", theme.bold(` tool ${entry.toolName ?? "call"} `)) + streaming;
		case "tool-result":
			return theme.fg(entry.isError ? "error" : "success", theme.bold(` ${entry.isError ? "error" : "result"} ${entry.toolName ?? ""} `)) + streaming;
		case "diagnostic":
			return theme.fg("error", theme.bold(" diagnostic "));
	}
}

function wrapTranscriptText(text: string, width: number): string[] {
	const sourceLines = text.replace(/\r\n/g, "\n").split("\n");
	return sourceLines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}

function previewTranscriptText(entry: RefineTranscriptEntry, width: number): { lines: string[]; truncated: boolean } {
	const lines = wrapTranscriptText(entry.text, Math.max(1, width));
	if (!entry.streaming || entry.type === "thinking" || lines.length <= STREAMING_PREVIEW_LINES) {
		return { lines, truncated: false };
	}
	return { lines: lines.slice(-STREAMING_PREVIEW_LINES), truncated: true };
}

function buildTranscriptLines(entries: RefineTranscriptEntry[], theme: Theme, width: number): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		lines.push(entryBadge(entry, theme));
		const preview = previewTranscriptText(entry, Math.max(1, width - 2));
		if (preview.truncated) lines.push(`  ${theme.fg("dim", "…")}`);
		for (const line of preview.lines) {
			const styled = entry.type === "thinking"
				? theme.fg("warning", line)
				: entry.type === "tool-result" && entry.isError
					? theme.fg("error", line)
					: entry.type === "diagnostic"
						? theme.fg("error", line)
						: theme.fg("dim", line);
			lines.push(`  ${styled}`);
		}
	}
	return lines;
}

export interface SubagentOverlayOptions {
	theme: Theme;
	fleet: AgentFleet;
	entryId: string;
	onClose: () => void;
	tui?: TUI;
	lang?: UiLanguage;
	/** pi-tui routes input only to the focused component, so an open overlay
	 * would swallow global shortcuts; unhandled keys are forwarded here. */
	onUnhandledKey?: (data: string) => void;
}

/** Detail view of ONE agent: scrollable live transcript. */
export class SubagentOverlay implements Component {
	private readonly opts: SubagentOverlayOptions;
	private readonly lang: UiLanguage;
	private entryId: string;
	private disposed = false;
	private stopArmed = false;
	private readonly unsubscribe: () => void;

	constructor(opts: SubagentOverlayOptions) {
		this.opts = opts;
		this.lang = opts.lang ?? "en";
		this.entryId = opts.entryId;
		this.opts.tui?.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
		this.unsubscribe = opts.fleet.subscribe(() => this.opts.tui?.requestRender());
	}

	private current(): FleetEntry | undefined {
		return this.opts.fleet.get(this.entryId);
	}

	private cycle(step: number): void {
		const entries = this.opts.fleet.list();
		if (entries.length < 2) return;
		const index = Math.max(0, entries.findIndex((entry) => entry.id === this.entryId));
		this.entryId = entries[(index + step + entries.length) % entries.length]!.id;
		this.stopArmed = false;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (isEscape(data)) {
			this.opts.onClose();
			return;
		}
		if (matchesTerminalKey(data, "tab")) {
			this.cycle(1);
			this.opts.tui?.requestRender();
			return;
		}
		if (matchesTerminalKey(data, "shift+tab")) {
			this.cycle(-1);
			this.opts.tui?.requestRender();
			return;
		}
		const entry = this.current();
		if (!entry) {
			this.opts.onUnhandledKey?.(data);
			return;
		}
		if (data === "x" && entry.abort && entry.lane.status !== "complete" && entry.lane.status !== "failed" && entry.lane.status !== "cancelled") {
			if (this.stopArmed) {
				this.stopArmed = false;
				entry.abort();
			} else {
				this.stopArmed = true;
			}
			this.opts.tui?.requestRender();
			return;
		}
		this.stopArmed = false;
		const lane = entry.lane;
		const viewport = Math.max(1, lane.viewportHeight ?? 1);
		if (matchesTerminalKey(data, "up")) lane.scrollOffset -= 1;
		else if (matchesTerminalKey(data, "down")) lane.scrollOffset += 1;
		else if (matchesTerminalKey(data, "pageUp")) lane.scrollOffset -= Math.max(1, viewport - 1);
		else if (matchesTerminalKey(data, "pageDown")) lane.scrollOffset += Math.max(1, viewport - 1);
		else {
			const mouse = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
			if (!mouse || (Number(mouse[1]) & 64) !== 64) {
				this.opts.onUnhandledKey?.(data);
				return;
			}
			lane.scrollOffset += (Number(mouse[1]) & 1) === 0 ? -3 : 3;
		}
		lane.followTranscript = false;
		this.opts.tui?.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.opts.tui?.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
	}

	render(width: number): string[] {
		const theme = this.opts.theme;
		const chrome = fleetChrome(this.lang);
		const innerWidth = Math.max(22, width - 2);
		const dialogHeight = pickOverlayHeight();
		const entry = this.current();
		const lines: string[] = [renderBorderLine(theme, innerWidth, "top")];
		const viewportHeight = Math.max(1, dialogHeight - OVERLAY_CHROME_LINES);

		if (!entry) {
			lines.push(renderRow(theme, theme.fg("dim", chrome.noAgents), innerWidth));
			for (let i = 1; i < viewportHeight + 2; i++) lines.push(renderRow(theme, "", innerWidth));
		} else {
			const lane = entry.lane;
			const all = this.opts.fleet.list();
			const position = all.length > 1 ? ` (${all.findIndex((candidate) => candidate.id === entry.id) + 1}/${all.length})` : "";
			const model = entry.modelLabel ? theme.fg("dim", ` · ${entry.modelLabel}`) : "";
			lines.push(renderRow(theme, `${theme.fg("accent", theme.bold(entry.label))}${theme.fg("dim", position)}${model}`, innerWidth));

			const transcriptLines = buildTranscriptLines(lane.transcript, theme, Math.max(1, innerWidth - 2));
			lane.viewportHeight = viewportHeight;
			const maxScroll = Math.max(0, transcriptLines.length - viewportHeight);
			if (lane.followTranscript) lane.scrollOffset = maxScroll;
			else {
				lane.scrollOffset = Math.max(0, Math.min(lane.scrollOffset, maxScroll));
				if (lane.scrollOffset >= maxScroll) lane.followTranscript = true;
			}
			const hiddenAbove = lane.scrollOffset;
			const hiddenBelow = Math.max(0, maxScroll - lane.scrollOffset);
			const scrollCount = hiddenAbove || hiddenBelow ? ` ↑${hiddenAbove} ↓${hiddenBelow}` : "";
			const status = theme.fg(entryColor(entry), entryStatus(entry, this.lang));
			const phase = lane.phase && !entry.idle ? theme.fg("muted", ` · ${lane.phase}`) : "";
			const tools = entry.toolCalls > 0 ? ` · ${entry.toolCalls} ${chrome.tools}` : "";
			const note = entry.note ? ` · ${entry.note}` : "";
			lines.push(renderRow(theme, `${status}${phase}${theme.fg("dim", `${tools}${note}${scrollCount}`)}`, innerWidth));
			const visible = transcriptLines.slice(lane.scrollOffset, lane.scrollOffset + viewportHeight);
			for (const line of visible) lines.push(renderRow(theme, line, innerWidth));
			for (let i = visible.length; i < viewportHeight; i++) lines.push(renderRow(theme, "", innerWidth));
		}

		const parts = [chrome.close, chrome.scroll, chrome.page];
		if (this.opts.fleet.list().length > 1) parts.push(chrome.switchAgent);
		if (entry?.abort) parts.push(this.stopArmed ? chrome.stopArmed : chrome.stop);
		if (entry?.role === "auditor") parts.push(chrome.reopen);
		lines.push(renderRow(theme, theme.fg("dim", parts.join(" · ")), innerWidth));
		lines.push(renderBorderLine(theme, innerWidth, "bottom"));
		return lines.map((line) => fitLine(line, width));
	}

	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Controller: widget + key handling + overlay lifecycle
// ---------------------------------------------------------------------------

export const FLEET_WIDGET_KEY = "pi-plans-fleet";

/** The slice of an extension context the controller needs. */
export interface FleetUiHost {
	ui: ExtensionContext["ui"];
	hasUI: boolean;
	mode?: string;
}

export function fleetUiHost(ctx: ExtensionContext | ExtensionCommandContext): FleetUiHost {
	return { ui: ctx.ui, hasUI: ctx.hasUI, mode: ctx.mode };
}

export interface FleetUiAttachOptions {
	lang?: UiLanguage;
	onUnhandledKey?: (data: string) => void;
}

/** The prompt editor: pi-tui's `Editor`, or anything with its `getText()` API
 * (a second copy of the module would defeat `instanceof`). */
function isEditorLike(component: unknown, EditorClass: (new (...args: never[]) => unknown) | undefined): boolean {
	if (EditorClass && component instanceof EditorClass) return true;
	return typeof (component as { getText?: unknown } | null)?.getText === "function";
}

export class FleetUiController {
	private readonly fleet: AgentFleet;
	private ui: FleetUiHost["ui"] | undefined;
	private tui: TUI | undefined;
	private theme: Theme | undefined;
	private widgetShown = false;
	private focused = false;
	private selectedId: string | undefined;
	private overlayOpen = false;
	private overlayClose: (() => void) | undefined;
	private lang: UiLanguage = "en";
	private onUnhandledKey: ((data: string) => void) | undefined;
	private unsubscribeFleet: (() => void) | undefined;
	private unsubscribeInput: (() => void) | undefined;

	constructor(agentFleet: AgentFleet = sharedFleet) {
		this.fleet = agentFleet;
	}

	/** Idempotent per ui object. Only TUI sessions get the list. */
	attach(host: FleetUiHost, options: FleetUiAttachOptions = {}): void {
		if (host.mode !== "tui" || !host.hasUI) return;
		if (options.lang) this.lang = options.lang;
		if (options.onUnhandledKey) this.onUnhandledKey = options.onUnhandledKey;
		if (this.ui === host.ui) {
			this.sync();
			return;
		}
		this.detach();
		this.ui = host.ui;
		this.unsubscribeFleet = this.fleet.subscribe(() => this.sync());
		try {
			this.unsubscribeInput = host.ui.onTerminalInput((data) => this.handleKey(data));
		} catch {
			this.unsubscribeInput = undefined;
		}
		this.sync();
	}

	detach(): void {
		this.unsubscribeFleet?.();
		this.unsubscribeInput?.();
		this.unsubscribeFleet = undefined;
		this.unsubscribeInput = undefined;
		this.overlayClose?.();
		if (this.ui && this.widgetShown) {
			try {
				this.ui.setWidget(FLEET_WIDGET_KEY, undefined);
			} catch {
				/* ui already gone */
			}
		}
		this.widgetShown = false;
		this.focused = false;
		this.ui = undefined;
		this.tui = undefined;
	}

	isFocused(): boolean {
		return this.focused;
	}

	selected(): string | undefined {
		return this.selectedId;
	}

	private selectedIndex(entries: FleetEntry[]): number | null {
		if (!this.focused) return null;
		const index = entries.findIndex((entry) => entry.id === this.selectedId);
		return index >= 0 ? index : 0;
	}

	private sync(): void {
		const ui = this.ui;
		if (!ui) return;
		const entries = this.fleet.list();
		try {
			if (entries.length > 0 && !this.widgetShown) {
				ui.setWidget(
					FLEET_WIDGET_KEY,
					(tui, theme) => {
						this.tui = tui;
						this.theme = theme;
						return {
							render: (width: number) => {
								const current = this.fleet.list();
								return renderFleetLines({ entries: current, selected: this.selectedIndex(current), now: Date.now(), lang: this.lang, theme, width });
							},
							invalidate() {},
						};
					},
					{ placement: "aboveEditor" },
				);
				this.widgetShown = true;
			} else if (entries.length === 0 && this.widgetShown) {
				ui.setWidget(FLEET_WIDGET_KEY, undefined);
				this.widgetShown = false;
				this.focused = false;
			}
		} catch {
			/* a stale ui must not break progress reporting */
		}
		if (this.focused && !entries.some((entry) => entry.id === this.selectedId)) this.selectedId = entries[0]?.id;
		this.tui?.requestRender();
	}

	/** Raw-input hook (`ui.onTerminalInput`). Consumes only list navigation. */
	handleKey(data: string): { consume?: boolean } | undefined {
		const ui = this.ui;
		if (!ui || this.overlayOpen) return undefined;
		const pi = getPiTui();
		try {
			if (pi?.isKeyRelease?.(data)) return undefined;
		} catch {
			/* fall through */
		}
		const entries = this.fleet.list();
		if (entries.length === 0) return undefined;
		// Only act while the editor owns focus; select dialogs and other
		// overlays must keep their own arrow keys.
		const focusedComponent = this.tui?.getFocusedComponent?.();
		if (focusedComponent && !isEditorLike(focusedComponent, pi?.Editor)) return undefined;

		if (!this.focused) {
			if (!matchesTerminalKey(data, "down")) return undefined;
			let text = "";
			try {
				text = ui.getEditorText?.() ?? "";
			} catch {
				return undefined;
			}
			if (text !== "") return undefined;
			this.focused = true;
			if (!entries.some((entry) => entry.id === this.selectedId)) this.selectedId = entries[0]!.id;
			this.tui?.requestRender();
			return { consume: true };
		}

		const index = Math.max(0, entries.findIndex((entry) => entry.id === this.selectedId));
		if (matchesTerminalKey(data, "down")) {
			this.selectedId = entries[Math.min(entries.length - 1, index + 1)]!.id;
		} else if (matchesTerminalKey(data, "up")) {
			if (index === 0) this.focused = false;
			else this.selectedId = entries[index - 1]!.id;
		} else if (matchesTerminalKey(data, "enter")) {
			this.openOverlay(this.selectedId);
			return { consume: true };
		} else if (isEscape(data)) {
			this.focused = false;
		} else {
			// Any other key leaves the list and is typed into the editor as usual.
			this.focused = false;
			this.tui?.requestRender();
			return undefined;
		}
		this.tui?.requestRender();
		return { consume: true };
	}

	/** Open the detail overlay for one agent (default: the selected one). */
	openOverlay(entryId?: string): void {
		const ui = this.ui;
		if (!ui || this.overlayOpen) return;
		const id = entryId ?? this.selectedId ?? this.fleet.list()[0]?.id;
		if (!id || !this.fleet.get(id)) return;
		this.overlayOpen = true;
		this.selectedId = id;
		void ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					this.overlayClose = () => done(undefined);
					return new SubagentOverlay({
						theme,
						fleet: this.fleet,
						entryId: id,
						onClose: () => done(undefined),
						tui,
						lang: this.lang,
						onUnhandledKey: this.onUnhandledKey,
					});
				},
				{
					overlay: true,
					overlayOptions: {
						width: "78%",
						minWidth: OVERLAY_MIN_WIDTH,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => handle.focus(),
				},
			)
			.catch(() => undefined)
			.finally(() => {
				this.overlayOpen = false;
				this.overlayClose = undefined;
				this.tui?.requestRender();
			});
	}

	/** Reopen the newest agent of a role (Ctrl+Shift+R for the execution review). */
	openLatest(role: FleetEntry["role"]): boolean {
		const match = [...this.fleet.list()].reverse().find((entry) => entry.role === role);
		if (!match) return false;
		this.openOverlay(match.id);
		return true;
	}

	/** Test hook. */
	isOverlayOpen(): boolean {
		return this.overlayOpen;
	}
}

/** Process-wide controller bound to the shared fleet. */
export const fleetUi = new FleetUiController();
