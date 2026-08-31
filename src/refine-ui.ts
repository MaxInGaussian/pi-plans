import type { ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { SubagentProgressEvent, SubagentResult } from "./subagent.ts";
import {
	matchesEscape as localMatchesEscape,
	truncateToWidth as localTruncateToWidth,
	visibleWidth as localVisibleWidth,
	wrapTextWithAnsi as localWrapTextWithAnsi,
} from "./refine-ui-helpers.ts";

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

function truncateToWidth(text: string, width: number, ellipsis?: string): string {
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

function handleEscape(data: string): boolean {
	try {
		return _piTui ? _piTui.matchesKey(data, "escape") : localMatchesEscape(data);
	} catch {
		return localMatchesEscape(data);
	}
}
import {
	applyRefineProgress,
	applyRefineResult,
	statusLabel,
	type RefineLaneState,
	type RefineOverlayRole,
} from "./refine-ui-state.ts";

export type { RefineLaneState, RefineLaneStatus, RefineOverlayRole } from "./refine-ui-state.ts";

const OVERLAY_MIN_WIDTH = 44;
const OVERLAY_MAX_WIDTH = 96;
const OVERLAY_MIN_HEIGHT = 18;
const OVERLAY_MAX_HEIGHT = 32;
const OVERLAY_HEIGHT_RATIO = 0.78;
const CHROME_LINES = 5; // top + title + (header rule + footer rule + hints)

export function getTerminalRowCount(): number {
	const raw = (process.stdout as { rows?: number }).rows;
	return typeof raw === "number" && raw > 0 ? raw : 30;
}

export function pickOverlayHeight(): number {
	const rows = getTerminalRowCount();
	const target = Math.max(OVERLAY_MIN_HEIGHT, Math.floor(rows * OVERLAY_HEIGHT_RATIO));
	return Math.min(OVERLAY_MAX_HEIGHT, target);
}

export function pickOverlayWidth(width: number): number {
	const target = Math.max(OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, Math.floor(width * 0.78)));
	return Math.max(OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, target));
}

/**
 * Break a free-form assistant/tool detail blob into sentence-sized lines so the
 * overlay stays readable even when the model streams raw fragments.
 */
export function chunkDetailForOverlay(text: string, innerWidth: number, maxLines = 6): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [];
	const boundary = /(?<=[.!?])\s+/;
	const sentences = normalized.split(boundary).map((sentence) => sentence.trim()).filter(Boolean);
	if (sentences.length === 0) return [normalized];
	const lines: string[] = [];
	const usable = Math.max(8, innerWidth);
	for (const sentence of sentences) {
		for (const wrapped of wrapTextWithAnsi(sentence, usable)) {
			lines.push(wrapped);
			if (lines.length >= maxLines) return lines;
		}
	}
	return lines;
}

function borderColor(theme: Theme): ThemeColor {
	return "borderAccent";
}

function renderRow(theme: Theme, content: string, innerWidth: number): string {
	const truncated = truncateToWidth(content, innerWidth, "...");
	const width = visibleWidth(truncated);
	const filler = innerWidth > width ? " ".repeat(innerWidth - width) : "";
	return `${theme.fg(borderColor(theme), "│")}${truncated}${filler}${theme.fg(borderColor(theme), "│")}`;
}

function renderHorizontalRule(theme: Theme, innerWidth: number): string {
	return theme.fg(borderColor(theme), `├${"─".repeat(innerWidth)}┤`);
}

function renderBorderLine(theme: Theme, innerWidth: number, edge: "top" | "bottom"): string {
	const side = edge === "top" ? "┌" : "└";
	const right = edge === "top" ? "┐" : "┘";
	return theme.fg(borderColor(theme), `${side}${"─".repeat(innerWidth)}${right}`);
}

function fitLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "...") : line;
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

export class RefineOverlayComponent implements Component {
	private readonly theme: Theme;
	private readonly role: RefineOverlayRole;
	private readonly lanes: RefineLaneState[];
	private readonly onCancel: () => void;

	constructor(theme: Theme, role: RefineOverlayRole, lanes: RefineLaneState[], onCancel: () => void) {
		this.theme = theme;
		this.role = role;
		this.lanes = lanes;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		if (handleEscape(data)) this.onCancel();
	}

	render(width: number): string[] {
		const dialogWidth = pickOverlayWidth(width);
		const innerWidth = Math.max(8, dialogWidth - 2);
		const title = this.role === "reviewer" ? "Reviewer" : "Criticizer";

		// Build lane rows (label + status + detail sentence chunk)
		const laneRows: string[] = [];
		for (const lane of this.lanes) {
			const status = this.theme.fg(laneColor(lane.status), statusLabel(lane.status));
			const phase = lane.phase ? this.theme.fg("muted", ` · ${lane.phase}`) : "";
			laneRows.push(this.theme.fg("accent", `▸ ${lane.label}:`) + ` ${status}${phase}`);
			for (const chunk of chunkDetailForOverlay(lane.detail, innerWidth - 4, 4)) {
				laneRows.push(this.theme.fg("dim", `    ${chunk}`));
			}
		}

		const runningCount = this.lanes.filter((lane) => lane.status === "running").length;
		const summary = `${this.lanes.length} lane${this.lanes.length === 1 ? "" : "s"}` +
			(runningCount > 0 ? ` · ${runningCount} running` : "") +
			(this.lanes.every((lane) => lane.status === "complete") ? " · all done" : "");

		const hint = "Esc cancel · ↑/↓ lanes scroll when more lines than viewport";

		// Compose chrome + body, then enforce viewport height.
		const body = [
			this.theme.fg("accent", this.theme.bold(title)),
			this.theme.fg("dim", "Independent read-only refinement in progress"),
			...laneRows,
		];
		if (body.length === 0) body.push(this.theme.fg("dim", "(no active lanes)"));

		const dialogHeight = pickOverlayHeight();
		const available = Math.max(8, dialogHeight - CHROME_LINES);
		const visibleBody = body.slice(Math.max(0, body.length - available));
		const hiddenAbove = Math.max(0, body.length - visibleBody.length);
		const summaryText = hiddenAbove > 0
			? `${summary} · ↑${hiddenAbove}`
			: summary;

		const lines: string[] = [renderBorderLine(this.theme, innerWidth, "top")];
		lines.push(renderRow(this.theme, this.theme.fg("accent", this.theme.bold(title)), innerWidth));
		lines.push(renderRow(this.theme, this.theme.fg("dim", summaryText), innerWidth));
		lines.push(renderHorizontalRule(this.theme, innerWidth));
		for (const row of visibleBody) lines.push(renderRow(this.theme, row, innerWidth));
		lines.push(renderHorizontalRule(this.theme, innerWidth));
		lines.push(renderRow(this.theme, this.theme.fg("dim", hint), innerWidth));
		lines.push(renderBorderLine(this.theme, innerWidth, "bottom"));

		return lines.map((line) => fitLine(line, width));
	}

	invalidate(): void {}
}

export interface RefineOverlayContext {
	ui: ExtensionContext["ui"];
	hasUI: boolean;
}

/**
 * Owns a one-shot overlay. Child processes remain owned by the caller; the
 * controller only receives progress and supplies a single cancellation hook.
 */
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

	constructor(role: RefineOverlayRole, laneIds: Array<{ id: string; label?: string }>, onCancel: () => void) {
		this.role = role;
		this.onCancel = onCancel;
		this.lanes = laneIds.map((lane) => ({
			id: lane.id,
			label: lane.label ?? lane.id,
			status: "queued",
			phase: "queued",
			detail: "",
		}));
	}

	open(ctx: RefineOverlayContext): void {
		if (!ctx.hasUI || this.overlayPromise) return;

		this.overlayPromise = ctx.ui
			.custom<void>(
				(_tui, theme, _keybindings, done) => {
					this.tui = _tui;
					this.done = done;
					this.component = new RefineOverlayComponent(theme, this.role, this.lanes, () => this.cancel());
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

	cancel(): void {
		if (this.closed) return;
		this.onCancel();
		void this.close();
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			if (this.done) this.done(undefined);
			else this.handle?.hide();
			this.component = undefined;
		}
		await this.overlayPromise;
	}

	isClosed(): boolean {
		return this.closed;
	}
}

export function refineOverlayContext(ctx: ExtensionContext | ExtensionCommandContext): RefineOverlayContext {
	return { ui: ctx.ui, hasUI: ctx.hasUI };
}