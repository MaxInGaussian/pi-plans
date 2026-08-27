/**
 * Plan-execution loop: the tracked execution mode for accepted plans.
 *
 * When the user approves the execution handoff, the extension switches into
 * execution mode: every agent turn is injected with the remaining verifier
 * checklist, assistant messages are scanned for [DONE:VC-xxx] markers, and the
 * below-editor panel tracks progress until every item passes.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	attachPanelBaseline,
	clearExecutionPanel,
	completeCompletedItems,
	createExecutionPanelState,
	executionPanelFromEntryData,
	refreshExecutionPanel,
	snapshotPanelState,
	toggleExpanded,
	type ExecutionPanelExecutionLike,
	type ExecutionPanelState,
	type ItemDiffSummary,
} from "./execution-panel.ts";
import { getRun, readActive, setRunStatus, utcNow } from "./state.ts";
import { latestPlanVersion, scanDoneMarkers, type CheckItem } from "./plan.ts";

export interface ExecState extends ExecutionPanelExecutionLike {
	startedAt: string;
	panel?: ExecutionPanelState;
	usage: { inToks: number; outToks: number };
}

let execution: ExecState | null = null;

// Set when the user toggles the panel while a turn is streaming; consumed by
// index.ts on turn_end so view state converges without touching the live run.
let pendingPanelSync = false;

export function consumePendingPanelSync(): boolean {
	const pending = pendingPanelSync;
	pendingPanelSync = false;
	return pending;
}

export function getExecution(): ExecState | null {
	return execution;
}

export function executionProgress(): { done: number; total: number } | null {
	if (!execution) return null;
	return {
		done: execution.items.filter((item) => item.done).length,
		total: execution.items.length,
	};
}

function formatElapsed(startedAt: string): string {
	const total = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
	const h = String(Math.floor(total / 3600)).padStart(2, "0");
	const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
	const sec = String(total % 60).padStart(2, "0");
	return `${h}:${m}:${sec}`;
}

function formatToks(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function updateStatusWidget(ctx: ExtensionContext): void {
	const progress = executionProgress();
	if (progress && execution) {
		// Progress lives in the bottom status bar — the same layer as the ⛔/⌛
		// paused indicator — so both execution states read from one place.
		const tail = execution.panel?.expanded ? "/plans-list hide" : "/plans-list details";
		const line = `⌛ plans ${progress.done}/${progress.total}: spent ${formatElapsed(execution.startedAt)} · ${formatToks(execution.usage.inToks)} in-toks · ${formatToks(execution.usage.outToks)} out-toks · ${tail}`;
		ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("accent", line));
		return;
	}
	const active = readActive(ctx.cwd);
	if (active) {
		// Idle indicator depends on the run's lifecycle, not just its existence:
		// done reads as finished, abandoned as closed, stopped/accepted as paused.
		const status = getRun(ctx.cwd, active.run_id)?.status;
		if (status === "done") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("success", `🎯 plans: ${active.run_id} (done)`));
			return;
		}
		if (status === "abandoned") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("error", `🚫 plans: ${active.run_id}`));
			return;
		}
		if (status === "stopped") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("warning", `⛔ plans: ${active.run_id}`));
			return;
		}
		if (status === "accepted") {
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("warning", `⌛ plans: ${active.run_id}`));
			return;
		}
		if (status === "planning") {
			// Planning phase: 💬 while still in Q&A, 📝 once a PLAN draft exists
			// — kept until execution starts (then ⌛ takes over).
			const emoji = latestPlanVersion(active.artifact_dir) ? "📝" : "💬";
			ctx.ui.setStatus("pi-plans", ctx.ui.theme.fg("muted", `${emoji} plans: ${active.run_id}`));
			return;
		}
		// unknown status: no indicator.
	}
	ctx.ui.setStatus("pi-plans", undefined);
}

function persist(pi: ExtensionAPI): void {
	if (!execution) return;
	pi.appendEntry("pi-plans-exec", {
		planPath: execution.planPath,
		items: execution.items,
		startedAt: execution.startedAt,
		usage: execution.usage,
		panel: snapshotPanelState(execution),
	});
}

export function syncExecutionPanel(ctx: ExtensionContext): void {
	if (!execution) {
		clearExecutionPanel(ctx);
		return;
	}
	refreshExecutionPanel(ctx, execution);
}

export function startExecution(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	planPath: string,
	items: CheckItem[],
): void {
	execution = { planPath, items, startedAt: utcNow(), panel: createExecutionPanelState(), usage: { inToks: 0, outToks: 0 } };
	attachPanelBaseline(execution, ctx.cwd);
	consumePendingPanelSync(); // fresh run: drop any stale deferral from a previous one
	persist(pi);
	const active = readActive(ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "executing");
		} catch {
			/* status bookkeeping is best-effort */
		}
	}
	pi.sendMessage(
		{
			customType: "pi-plans-exec-start",
			content: `**pi-plans: executing** \`${planPath}\` — ${items.length} verifier item(s). Progress appears in the bottom status bar; mark verified items with \`[DONE:VC-xxx]\`.`,
			display: true,
		},
		{ triggerTurn: false },
	);
	updateStatusWidget(ctx);
	syncExecutionPanel(ctx);
}

export function toggleExecutionPanelView(pi: ExtensionAPI, ctx: ExtensionContext): boolean | null {
	if (!execution) return null;
	const expanded = toggleExpanded(execution);
	// While a turn is streaming keep this zero-side-effect: flipping the flag is
	// pure memory; persisting and re-rendering here would write to the session
	// file and force a TUI relayout under the running agent. The next turn_end
	// consumes the pending marker and brings the view in line.
	const idle = typeof ctx.isIdle !== "function" || ctx.isIdle();
	if (idle) {
		persist(pi);
		syncExecutionPanel(ctx);
	} else {
		pendingPanelSync = true;
	}
	return expanded;
}

export function recordTouchedPaths(_workdir: string, paths: string[]): void {
	if (!execution || !paths.length) return;
	const panel = execution.panel ?? createExecutionPanelState();
	execution.panel = panel;
	const merged = new Set(panel.touchedPaths);
	for (const raw of paths) {
		const normalized = raw.trim().replace(/[\u0000]+/g, "");
		if (!normalized) continue;
		merged.add(normalized);
	}
	panel.touchedPaths = [...merged];
}

export function recordExecutionCompletion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	completedIds: string[],
	usage?: { input: number; output: number },
): ItemDiffSummary | null {
	if (!execution) return null;
	if (usage) {
		execution.usage.inToks += usage.input;
		execution.usage.outToks += usage.output;
	}
	const summary = completeCompletedItems(execution, ctx.cwd, completedIds);
	persist(pi);
	syncExecutionPanel(ctx);
	return summary;
}

export function stopExecution(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
	if (!execution) return;
	clearExecutionPanel(ctx);
	execution = null;
	pi.appendEntry("pi-plans-exec-cleared", { reason });
	pi.sendMessage(
		{
			customType: "pi-plans-exec-stop",
			content: `**pi-plans: execution stopped** — ${reason}`,
			display: true,
		},
		{ triggerTurn: false },
	);
	const active = readActive(ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "stopped");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
}

/** Apply [DONE:VC-xxx] markers from an assistant message. Returns changed ids. */
export function applyDoneMarkers(text: string): string[] {
	if (!execution) return [];
	const changed: string[] = [];
	for (const id of scanDoneMarkers(text)) {
		const item = execution.items.find((candidate) => candidate.id === id && !candidate.done);
		if (item) {
			item.done = true;
			changed.push(id);
		}
	}
	return changed;
}

export function isExecutionComplete(): boolean {
	return execution !== null && execution.items.length > 0 && execution.items.every((item) => item.done);
}

export function completeExecution(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!execution) return;
	const summary = execution.items.map((item) => `- ✅ \`${item.id}\` ${item.text.split(";")[0]}`).join("\n");
	const planPath = execution.planPath;
	clearExecutionPanel(ctx);
	execution = null;
	pi.appendEntry("pi-plans-exec-cleared", { reason: "complete" });
	pi.sendMessage(
		{
			customType: "pi-plans-complete",
			content: `**Plan complete!** ✅ \`${planPath}\`\n\n${summary}`,
			display: true,
		},
		{ triggerTurn: false },
	);
	const active = readActive(ctx.cwd);
	if (active) {
		try {
			setRunStatus(ctx.cwd, active.run_id, "done");
		} catch {
			/* best-effort */
		}
	}
	updateStatusWidget(ctx);
}

/** Injection text for before_agent_start while executing. */
export function executionContextMessage(): string | null {
	if (!execution) return null;
	const remaining = execution.items.filter((item) => !item.done);
	const list =
		remaining.map((item) => `- \`${item.id}\` ${item.text}`).join("\n") || "(none — report completion now)";
	return `[PI-PLANS EXECUTION — write access enabled]
Implement the accepted plan at ${execution.planPath} (${execution.items.length - remaining.length}/${execution.items.length} verifier items done).

Remaining verifier items:
${list}

Execution rules:
- Implement implementation items in dependency order; grow the change in layers — smallest end-to-end slice first, then stack each new capability on top of what already works.
- Simplest implementation that fully meets the item: no speculative abstractions, configuration, or indirection; keep components modular with clearly separated concerns.
- Architectural decisions are for the long term: no stopgaps. Do not add backward-compatibility layers, fallbacks, or migrations — remove the obsolete paths this change obsoletes.
- Prefer established, well-maintained libraries when they reduce complexity or improve reliability; before writing your own implementation or adding a package, check the project's existing dependencies (docs and types) — never reimplement common functionality without a clear reason.
- MINIMUM tests: trivial one-liners get no test; non-trivial logic gets exactly one minimal check; reuse the repo's test runner when one exists; when unsure, skip and emit \`[test skipped: <name>, add when <trigger>]\`.
- After verifying an item's pass condition with its stated evidence, include \`[DONE:VC-xxx]\` in your reply.
- When every item is done, report a completion summary.`;
}

interface SessionEntry {
	type: string;
	customType?: string;
	data?: ExecState;
	message?: { role: string; content: Array<{ type: string; text?: string }> };
}

/**
 * Rebuild execution state from the session on start/resume. Finds the last
 * pi-plans-exec snapshot, then re-scans assistant messages after it for
 * [DONE:VC-xxx] markers so progress survives restarts.
 */
export function restoreFromSession(pi: ExtensionAPI, ctx: ExtensionContext, entries: SessionEntry[]): void {
	let snapshotIndex = -1;
	let snapshot: ExecState | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "pi-plans-exec" && entry.data) {
			snapshot = entry.data;
			snapshotIndex = i;
			break;
		}
		if (entry.type === "custom" && entry.customType === "pi-plans-exec-cleared") {
			// Execution was explicitly stopped or completed after the last snapshot.
			execution = null;
			syncExecutionPanel(ctx);
			updateStatusWidget(ctx);
			return;
		}
	}
	if (!snapshot) {
		execution = null;
		syncExecutionPanel(ctx);
		updateStatusWidget(ctx);
		return;
	}
	// Ignore stale plans whose file vanished.
	if (!fs.existsSync(snapshot.planPath)) {
		execution = null;
		syncExecutionPanel(ctx);
		updateStatusWidget(ctx);
		return;
	}
	execution = {
		...snapshot,
		items: snapshot.items.map((item) => ({ ...item })),
		usage: snapshot.usage ?? { inToks: 0, outToks: 0 },
		panel: executionPanelFromEntryData(snapshot.panel) ?? createExecutionPanelState(),
	};
	for (let i = snapshotIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "pi-plans-exec-cleared") {
			execution = null;
			syncExecutionPanel(ctx);
			break;
		}
		const message = entry.message;
		if (message && message.role === "assistant") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			applyDoneMarkers(text);
		}
	}
	if (execution) {
		persist(pi); // refresh snapshot so the next resume has less to rescan
		if (isExecutionComplete()) completeExecution(pi, ctx);
	}
	syncExecutionPanel(ctx);
	updateStatusWidget(ctx);
}
