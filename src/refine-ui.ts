import type { ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { SubagentProgressEvent, SubagentResult } from "./subagent.ts";
import {
	matchesEscape as localMatchesEscape,
	truncateToWidth as localTruncateToWidth,
	visibleWidth as localVisibleWidth,
	wrapTextWithAnsi as localWrapTextWithAnsi,
} from "./refine-ui-helpers.ts";
import {
	applyRefineProgress,
	applyRefineResult,
	statusLabel,
	type RefineLaneState,
	type RefineTranscriptEntry,
	type RefineTranscriptEntryType,
	type RefineOverlayRole,
} from "./refine-ui-state.ts";

let _piTui: typeof import("@earendil-works/pi-tui") | undefined;
let _piTuiAttempted = false;

async function loadPiTui(): Promise<typeof import("@earendil-works/pi-tui") | undefined> {
	if (_piTuiAttempted) return _piTui;
	_piTuiAttempted = true;
	try {
		_piTui = await import("@earendil-works/pi-tui");
	} catch {
		_piTui = undefined;
	}
	return _piTui;
}

void loadPiTui();

function truncateToWidth(text: string, width: number, ellipsis = ""): string {
	try {
		return _piTui ? _piTui.truncateToWidth(text, width, ellipsis) : localTruncateToWidth(text, width, ellipsis);
	} catch {
		return localTruncateToWidth(text, width, ellipsis);
	}
}

function visibleWidth(text: string): number {
	try {
		return _piTui ? _piTui.visibleWidth(text) : localVisibleWidth(text);
	} catch {
		return localVisibleWidth(text);
	}
}

function wrapTextWithAnsi(text: string, width: number): string[] {
	try {
		return _piTui ? _piTui.wrapTextWithAnsi(text, width) : localWrapTextWithAnsi(text, width);
	} catch {
		return localWrapTextWithAnsi(text, width);
	}
}

type RefineKey = "escape" | "tab" | "shift+tab" | "up" | "down" | "pageUp" | "pageDown";

function fallbackKey(data: string, key: RefineKey): boolean {
	const sequences: Record<RefineKey, string[]> = {
		escape: ["\x1b", "\x1b\x1b"],
		tab: ["\t"],
		"shift+tab": ["\x1b[Z"],
		up: ["\x1b[A", "\x1bOA"],
		down: ["\x1b[B", "\x1bOB"],
		pageUp: ["\x1b[5~"],
		pageDown: ["\x1b[6~"],
	};
	return sequences[key].includes(data);
}

function matchesKey(data: string, key: RefineKey): boolean {
	try {
		return _piTui ? _piTui.matchesKey(data, key) : fallbackKey(data, key);
	} catch {
		return fallbackKey(data, key);
	}
}

function handleEscape(data: string): boolean {
	try {
		return _piTui ? _piTui.matchesKey(data, "escape") : localMatchesEscape(data);
	} catch {
		return localMatchesEscape(data);
	}
}

export type { RefineLaneState, RefineLaneStatus, RefineOverlayRole, RefineTranscriptEntry, RefineTranscriptEntryType } from "./refine-ui-state.ts";

const OVERLAY_MIN_WIDTH = 72;
const OVERLAY_MIN_HEIGHT = 18;
const OVERLAY_MAX_HEIGHT = 32;
const OVERLAY_HEIGHT_RATIO = 0.78;
const OVERLAY_CHROME_LINES = 3; // top border + title/summary row + bottom border

export function getTerminalRowCount(): number {
	const raw = (process.stdout as { rows?: number }).rows;
	return typeof raw === "number" && raw > 0 ? raw : 30;
}

export function pickOverlayHeight(): number {
	const rows = getTerminalRowCount();
	const target = Math.max(OVERLAY_MIN_HEIGHT, Math.floor(rows * OVERLAY_HEIGHT_RATIO));
	return Math.min(OVERLAY_MAX_HEIGHT, target);
}

/** The overlay manager resolves the 78%/72-column size; render accepts its resolved width. */
export function pickOverlayWidth(width: number): number {
	return Math.max(24, width);
}

function borderColor(theme: Theme, selected = false): ThemeColor {
	return selected ? "borderAccent" : "border";
}

function renderRow(theme: Theme, content: string, innerWidth: number, selected = false): string {
	const truncated = truncateToWidth(content, innerWidth, "");
	const width = visibleWidth(truncated);
	const filler = innerWidth > width ? " ".repeat(innerWidth - width) : "";
	return `${theme.fg(borderColor(theme, selected), "│")}${truncated}${filler}${theme.fg(borderColor(theme, selected), "│")}`;
}

function renderBorderLine(theme: Theme, innerWidth: number, edge: "top" | "bottom", selected = false): string {
	const left = edge === "top" ? "┌" : "└";
	const right = edge === "top" ? "┐" : "┘";
	return theme.fg(borderColor(theme, selected), `${left}${"─".repeat(innerWidth)}${right}`);
}

function fitLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
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
	return sourceLines.flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
}

function buildTranscriptLines(entries: RefineTranscriptEntry[], theme: Theme, width: number): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		lines.push(entryBadge(entry, theme));
		const body = wrapTranscriptText(entry.text, Math.max(1, width - 2));
		for (const line of body) {
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

function summaryFor(role: RefineOverlayRole, lanes: RefineLaneState[]): string {
	const complete = lanes.filter((lane) => lane.status === "complete").length;
	const terminal = lanes.filter((lane) => ["complete", "failed", "cancelled"].includes(lane.status)).length;
	const running = lanes.filter((lane) => lane.status === "running").length;
	const title = role === "reviewer" ? "Reviewer" : "Criticizer";
	const state = terminal === lanes.length ? "done" : running > 0 ? `${running} running` : "queued";
	return `${title} · ${complete}/${lanes.length} done · ${state}`;
}

export class RefineOverlayComponent implements Component {
	private readonly theme: Theme;
	private readonly role: RefineOverlayRole;
	private readonly lanes: RefineLaneState[];
	private readonly onCancel: () => void;
	private readonly tui?: TUI;
	private selectedLane = 0;
	private disposed = false;

	constructor(theme: Theme, role: RefineOverlayRole, lanes: RefineLaneState[], onCancel: () => void, tui?: TUI) {
		this.theme = theme;
		this.role = role;
		this.lanes = lanes;
		this.onCancel = onCancel;
		this.tui = tui;
		this.tui?.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (handleEscape(data)) {
			this.onCancel();
			return;
		}
		if (this.lanes.length > 1 && matchesKey(data, "tab")) {
			this.selectedLane = (this.selectedLane + 1) % this.lanes.length;
			this.tui?.requestRender();
			return;
		}
		if (this.lanes.length > 1 && matchesKey(data, "shift+tab")) {
			this.selectedLane = (this.selectedLane - 1 + this.lanes.length) % this.lanes.length;
			this.tui?.requestRender();
			return;
		}
		const lane = this.lanes[this.selectedLane];
		if (!lane) return;
		const viewport = Math.max(1, lane.viewportHeight ?? 1);
		if (matchesKey(data, "up")) lane.scrollOffset -= 1;
		else if (matchesKey(data, "down")) lane.scrollOffset += 1;
		else if (matchesKey(data, "pageUp")) lane.scrollOffset -= Math.max(1, viewport - 1);
		else if (matchesKey(data, "pageDown")) lane.scrollOffset += Math.max(1, viewport - 1);
		else {
			const mouse = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
			if (!mouse || (Number(mouse[1]) & 64) !== 64) return;
			lane.scrollOffset += (Number(mouse[1]) & 1) === 0 ? -3 : 3;
		}
		lane.followTranscript = false;
		this.tui?.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.tui?.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
	}

	render(width: number): string[] {
		const dialogWidth = pickOverlayWidth(width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const dialogHeight = pickOverlayHeight();
		const laneCount = Math.max(1, this.lanes.length);
		const paneHeight = Math.max(3, Math.floor((dialogHeight - OVERLAY_CHROME_LINES) / laneCount));
		const title = summaryFor(this.role, this.lanes);
		const lines: string[] = [renderBorderLine(this.theme, innerWidth, "top")];
		lines.push(renderRow(this.theme, this.theme.fg("accent", this.theme.bold(title)), innerWidth, true));

		if (this.lanes.length === 0) {
			lines.push(renderRow(this.theme, this.theme.fg("dim", "No active lanes"), innerWidth));
		} else {
			for (let index = 0; index < this.lanes.length; index++) {
				lines.push(...this.renderPane(this.lanes[index]!, innerWidth, paneHeight, index === this.selectedLane));
			}
		}
		lines.push(renderBorderLine(this.theme, innerWidth, "bottom"));
		return lines.map((line) => fitLine(line, width));
	}

	private renderPane(lane: RefineLaneState, innerWidth: number, paneHeight: number, selected: boolean): string[] {
		const transcriptWidth = Math.max(1, innerWidth - 2);
		const transcriptLines = buildTranscriptLines(lane.transcript, this.theme, transcriptWidth);
		const viewportHeight = Math.max(1, paneHeight - 3);
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
		const status = this.theme.fg(laneColor(lane.status), statusLabel(lane.status));
		const phase = lane.phase ? this.theme.fg("muted", ` · ${lane.phase}`) : "";
		const marker = selected ? "▸ " : "  ";
		const header = `${marker}${this.theme.fg("accent", this.theme.bold(lane.label))} ${status}${phase}${this.theme.fg("dim", scrollCount)}`;
		const visible = transcriptLines.slice(lane.scrollOffset, lane.scrollOffset + viewportHeight);
		const lines = [renderBorderLine(this.theme, innerWidth, "top", selected), renderRow(this.theme, header, innerWidth, selected)];
		for (const line of visible) lines.push(renderRow(this.theme, line, innerWidth, selected));
		for (let i = visible.length; i < viewportHeight; i++) lines.push(renderRow(this.theme, "", innerWidth, selected));
		lines.push(renderBorderLine(this.theme, innerWidth, "bottom", selected));
		return lines;
	}

	invalidate(): void {}
}

export interface RefineOverlayContext {
	ui: ExtensionContext["ui"];
	hasUI: boolean;
}

/** Owns the public overlay and exposes progress updates without owning child processes. */
export class RefineOverlayController {
	readonly lanes: RefineLaneState[];
	private readonly role: RefineOverlayRole;
	private readonly onCancel: () => void;
	private handle: OverlayHandle | undefined;
	private done: ((result: undefined) => void) | undefined;
	private component: RefineOverlayComponent | undefined;
	private overlayPromise: Promise<void> | undefined;
	private tui: TUI | undefined;
	private closed = false;
	private finished = false;

	constructor(role: RefineOverlayRole, laneIds: Array<{ id: string; label?: string }>, onCancel: () => void) {
		this.role = role;
		this.onCancel = onCancel;
		this.lanes = laneIds.map((lane) => ({
			id: lane.id,
			label: lane.label ?? lane.id,
			status: "queued",
			phase: "queued",
			detail: "",
			transcript: [],
			currentTurnIndex: 0,
			scrollOffset: 0,
			followTranscript: true,
			viewportHeight: 1,
		}));
	}

	open(ctx: RefineOverlayContext): void {
		if (!ctx.hasUI || this.overlayPromise) return;

		this.overlayPromise = ctx.ui
			.custom<void>(
				(_tui, theme, _keybindings, done) => {
					this.tui = _tui;
					this.done = done;
					this.component = new RefineOverlayComponent(theme, this.role, this.lanes, () => this.cancel(), _tui);
					if (this.closed) done(undefined);
					return this.component;
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
					onHandle: (handle) => {
						this.handle = handle;
						handle.focus();
						if (this.closed) handle.hide();
					},
				},
			)
			.then(() => undefined)
			.catch(() => undefined);
	}

	update(laneId: string, event: SubagentProgressEvent): void {
		if (this.closed) return;
		const lane = this.lanes.find((candidate) => candidate.id === laneId);
		if (!lane) return;
		applyRefineProgress(lane, event);
		this.tui?.requestRender();
	}

	complete(laneId: string, result: SubagentResult): void {
		if (this.closed) return;
		const lane = this.lanes.find((candidate) => candidate.id === laneId);
		if (lane) {
			applyRefineResult(lane, result);
			this.tui?.requestRender();
		}
	}

	markFinished(): void {
		if (this.closed) return;
		this.finished = true;
		this.tui?.requestRender();
	}

	cancel(): void {
		// Esc only closes the overlay; the refiner child keeps running to natural
		// completion and its result still flows through the tool result path.
		void this.close();
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.component?.dispose();
			if (this.done) this.done(undefined);
			else this.handle?.hide();
			this.component = undefined;
			this.tui = undefined;
		}
		await this.overlayPromise;
	}

	isClosed(): boolean {
		return this.closed;
	}

	isFinished(): boolean {
		return this.finished;
	}
}

export function refineOverlayContext(ctx: ExtensionContext | ExtensionCommandContext): RefineOverlayContext {
	return { ui: ctx.ui, hasUI: ctx.hasUI };
}
