/**
 * First-use reviewer model/effort panels (v0.7.0).
 *
 * Replaces the old ask_choice-mediated model confirmation: in TUI the gate
 * pops a /model-style searchable panel (pi's exported
 * ModelSelectorComponent) followed by a /thinking-style effort panel (a thin
 * variant of pi's ThinkingSelectorComponent — the exported one cannot carry
 * the extra "Default" sentinel row). Sessions with a UI but no TUI (RPC,
 * ACP) get native ui.select menus over the same data; UI-less sessions keep
 * the agent-mediated text flow in the calling tools.
 *
 * The result is persisted to the GLOBAL reviewer config
 * (`~/.pi/pi-plans/config.json`, PI_PLANS_GLOBAL_DIR override) exactly once,
 * after BOTH panels complete — Esc on either panel cancels the whole gate
 * without writing anything (F-005).
 */

import {
	ModelSelectorComponent,
	getSelectListTheme,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Spacer, Text, fuzzyFilter, getKeybindings, matchesKey } from "@earendil-works/pi-tui";
import type { Component, TuiMouseDispatchResult, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_LEVEL_DESCRIPTION, DEFAULT_LEVEL_SENTINEL, levelsForModel } from "./thinking-levels.ts";
import { setGlobalRole, type GlobalRoleConfig } from "./global-state.ts";
import { truncateToWidth, visibleWidth } from "./refine-ui-helpers.ts";

// ---------------------------------------------------------------------------
// Host abstraction (structural — tools pass their ExtensionContext)
// ---------------------------------------------------------------------------

/** Narrow structural view of ExtensionContext the panels need. */
export interface RolePanelHost {
	mode: string | undefined;
	hasUI: boolean;
	model?: { provider: string; id: string } | null;
	scopedModels?: ReadonlyArray<{ model: unknown; thinkingLevel?: string | undefined }> | null;
	modelRegistry?: unknown;
	ui: {
		custom?: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options?: Record<string, unknown>) => Promise<unknown>;
		select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

/**
 * ModelRuntime adapter (F-010, Q-5=A): PRIMARY path maps the public
 * ModelRegistry facade (getAvailable/find/getError/refresh — documented as
 * "facade exposed to extensions") onto the four runtime methods
 * ModelSelectorComponent uses. The private `(modelRegistry as any).runtime`
 * field is only a SECONDARY attempt; both failing yields null and callers
 * fall back to menus.
 */
export function adapterModelRuntime(host: RolePanelHost): ModelRuntime | null {
	const registry = host.modelRegistry as
		| {
				getAvailable?: unknown;
				find?: unknown;
				getError?: unknown;
				refresh?: unknown;
				runtime?: unknown;
		  }
		| undefined;
	if (
		registry &&
		typeof registry.getAvailable === "function" &&
		typeof registry.find === "function" &&
		typeof registry.getError === "function" &&
		typeof registry.refresh === "function"
	) {
		return {
			getAvailableSnapshot: () => (registry.getAvailable as () => Model[])(),
			getModel: (providerId: string, modelId: string) =>
				(registry.find as (provider: string, id: string) => Model | undefined)(providerId, modelId),
			getError: () => (registry.getError as () => string | undefined)(),
			refresh: (options?: unknown) => (registry.refresh as (options?: unknown) => Promise<unknown>)(options),
		} as unknown as ModelRuntime;
	}
	const runtime = registry?.runtime as ModelRuntime | undefined;
	if (runtime && typeof (runtime as { getAvailableSnapshot?: unknown }).getAvailableSnapshot === "function") {
		return runtime;
	}
	return null;
}

/** Models from the registry snapshot (menus + availability checks). */
export function availableModels(host: RolePanelHost): Model[] {
	const registry = host.modelRegistry as { getAvailable?: () => Model[] } | undefined;
	if (!registry || typeof registry.getAvailable !== "function") return [];
	try {
		return registry.getAvailable() ?? [];
	} catch {
		return [];
	}
}

/** Find a configured model by exact selector (F-008 pre-spawn check). */
export function findModel(host: RolePanelHost, selector: string): Model | null {
	const at = selector.indexOf("/");
	if (at <= 0) return null;
	const registry = host.modelRegistry as { find?: (provider: string, id: string) => Model | undefined } | undefined;
	if (!registry || typeof registry.find !== "function") return null;
	try {
		return registry.find(selector.slice(0, at), selector.slice(at + 1)) ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Effort panel (thin /thinking variant with a Default sentinel row)
// ---------------------------------------------------------------------------

const LEVEL_DESCRIPTIONS: Record<string, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const EFFORT_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

/** Minimal shape of pi's theme needed to paint a border. */
export type BorderColor = (text: string) => string;

const identityColor: BorderColor = (text) => text;

/** Build a border painter from the `theme` the ui.custom factory hands us.
 *  Falls back to plain text when the host passes no (or a partial) theme. */
export function borderColorFrom(theme: unknown): BorderColor {
	const fg = (theme as { fg?: (color: string, text: string) => string } | null | undefined)?.fg;
	if (typeof fg !== "function") return identityColor;
	return (text) => {
		try {
			return fg("border", text);
		} catch {
			return identityColor(text);
		}
	};
}

/** Strip ANSI, then report whether the line is nothing but a horizontal rule
 *  (the shape pi's DynamicBorder emits: `─` repeated across the width). */
function isRuleLine(line: string): boolean {
	// eslint-disable-next-line no-control-regex
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
	return plain.length > 0 && /^─+$/.test(plain);
}

/**
 * v0.7.1: wrap a panel in a FULL box (left/right rules included).
 *
 * pi's `DynamicBorder` — used by ModelSelectorComponent, ThinkingSelector and
 * our EffortPanelComponent — renders only a horizontal line, so the first-use
 * gate panels had top/bottom borders but no sides, while the reviewer panel
 * (the agent overlay) already drew a complete box. This wrapper makes the gate
 * panels consistent with the rest of pi-plans.
 *
 * The inner component's own rule lines are stripped, so the total line count is
 * unchanged and the overlay's `maxHeight` budget is unaffected.
 *
 * Focus, keyboard and mouse are forwarded to the inner component: the TUI only
 * sets `focused` on the component it mounts, so the wrapper must relay it for
 * the inner search Input to keep the hardware cursor (CURSOR_MARKER).
 */
export class BorderedPanel implements Component {
	private readonly inner: Component;
	private readonly color: BorderColor;

	constructor(inner: Component, color?: BorderColor) {
		this.inner = inner;
		this.color = color ?? identityColor;
	}

	/** The wrapped component (exposed for tests / unwrapping). */
	get content(): Component {
		return this.inner;
	}

	get focused(): boolean {
		return (this.inner as { focused?: boolean }).focused === true;
	}

	set focused(value: boolean) {
		(this.inner as { focused?: boolean }).focused = value;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		let lines = this.inner.render(innerWidth);
		// Drop the inner component's own top/bottom rules so we don't draw two.
		while (lines.length > 0 && isRuleLine(lines[0]!)) lines = lines.slice(1);
		while (lines.length > 0 && isRuleLine(lines[lines.length - 1]!)) lines = lines.slice(0, -1);
		const boxed = lines.map((line) => {
			const body = truncateToWidth(line, innerWidth, "");
			const filler = innerWidth > visibleWidth(body) ? " ".repeat(innerWidth - visibleWidth(body)) : "";
			return `${this.color("│")}${body}${filler}${this.color("│")}`;
		});
		return [
			this.color(`┌${"─".repeat(innerWidth)}┐`),
			...boxed,
			this.color(`└${"─".repeat(innerWidth)}┘`),
		];
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	/** Translate the box-local mouse event into the inner component's
	 *  coordinate space (one rule column on each side, one rule row on top). */
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const inner = this.inner as { handleMouse?: (e: TuiMouseEvent) => TuiMouseDispatchResult | undefined };
		if (!inner.handleMouse) return undefined;
		const innerY = event.y - 1;
		const innerHeight = Math.max(0, event.height - 2);
		if (innerY < 0 || innerY >= innerHeight) return undefined;
		return inner.handleMouse({
			...event,
			x: event.x - 1,
			y: innerY,
			width: Math.max(1, event.width - 2),
			height: innerHeight,
		} as TuiMouseEvent);
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	dispose(): void {
		(this.inner as { dispose?: () => void }).dispose?.();
	}
}

/** Wording of the pickers, so one flow can serve several roles. */
export interface PickTitles {
	levelTitle: string;
	levelSubtitle: string;
	modelMenu: string;
	levelMenu: string;
}

export const REVIEWER_TITLES: PickTitles = {
	levelTitle: "Reviewer Thinking Level",
	levelSubtitle: "Applies to spawned reviewer subagents only",
	modelMenu: "Reviewer model? (type Other… to enter an exact provider/model string)",
	levelMenu: "Reviewer thinking level? (first row = default: no explicit level)",
};

export interface EffortItem {
	value: string; // "default" or a concrete level
	label: string;
	description: string;
}

/** Panel items for a model: the Default sentinel first, then supported levels. */
export function effortItems(model: Pick<Model, "reasoning" | "thinkingLevelMap">, currentLevel: string | null): EffortItem[] {
	const levels = levelsForModel(model);
	const items: EffortItem[] = [
		{
			value: DEFAULT_LEVEL_SENTINEL,
			label: DEFAULT_LEVEL_SENTINEL,
			description: DEFAULT_LEVEL_DESCRIPTION,
		},
		...levels.map((level: ModelThinkingLevel) => ({
			value: level,
			label: level,
			description: LEVEL_DESCRIPTIONS[level] ?? "",
		})),
	];
	if (currentLevel && !items.some((item) => item.value === currentLevel)) {
		// Stored level not supported by the newly chosen model: still show it
		// (marked) so the user sees what was there and can change it.
		items.push({ value: currentLevel, label: currentLevel, description: `${currentLevel} (not supported by this model)` });
	}
	return items;
}

/**
 * /thinking-style panel with an extra leading Default row. Mirrors pi's
 * ThinkingSelectorComponent structure (filter Input + SelectList) minus the
 * Ctrl+S set-as-default affordance, which has no meaning for the reviewer role.
 *
 * v0.7.1: the surrounding box comes from BorderedPanel, so this component no
 * longer adds DynamicBorder children. That also removes a latent crash — a
 * no-arg DynamicBorder reads pi's global `theme`, which is undefined when the
 * extension is loaded through jiti (its own source warns about exactly this).
 * It must therefore always be mounted inside a BorderedPanel.
 */
export class EffortPanelComponent extends Container {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: EffortItem[];
	private onSelect: (value: string) => void;
	private onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(items: EffortItem[], preselect: string, onSelect: (value: string) => void, onCancel: () => void, titles: Pick<PickTitles, "levelTitle" | "levelSubtitle"> = REVIEWER_TITLES) {
		super();
		this.allItems = items;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.addChild(new Spacer(1));
		this.addChild(new Text(titles.levelTitle, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(titles.levelSubtitle, 0, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList(items, preselect);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text("  Enter to select · Esc to cancel (cancels the whole gate)", 0, 0));
	}

	private buildSelectList(items: EffortItem[], preselect: string): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), EFFORT_LAYOUT);
		const index = items.findIndex((item) => item.value === preselect);
		if (index !== -1) list.setSelectedIndex(index);
		list.onSelect = (item: EffortItem) => this.onSelect(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allItems;
		const selected = (this.selectList.getSelectedItem() as EffortItem | undefined)?.value;
		const newList = this.buildSelectList(filtered, selected);
		this.children[this.selectListChildIndex] = newList;
		this.selectList = newList;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (isNav) {
			this.selectList.handleInput(keyData);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}
}

// ---------------------------------------------------------------------------
// Panel + menu flows
// ---------------------------------------------------------------------------

export type FirstUseOutcome =
	| {
			status: "confirmed";
			modelSelector: string;
			model: Model | null;
			thinkingLevel: string | null;
			role: GlobalRoleConfig;
			notices: string[];
			via: "panel" | "menu";
	  }
	| { status: "cancelled"; via: "panel" | "menu" }
	| { status: "unavailable"; reason: "no-custom" | "no-runtime" | "no-models" | "no-select" };

const OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: {
		width: "78%",
		minWidth: 60,
		maxHeight: "78%",
		anchor: "top-center",
		margin: { top: 1, left: 2, right: 2 },
	},
};

/** /model-style searchable panel. Returns null when the host cannot show
 * overlays (RPC custom() returns undefined) — callers fall back to menus. */
async function pickModelViaPanel(host: RolePanelHost, preselect?: { provider: string; id: string } | null): Promise<Model | null | undefined> {
	if (typeof host.ui.custom !== "function") return undefined;
	const runtime = adapterModelRuntime(host);
	if (runtime === null) return undefined;
	const scoped = (host.scopedModels ?? []) as never;
	const initial = preselect ?? host.model;
	const currentModel = initial ? ({ ...initial } as never) : undefined;
	return (await host.ui.custom<Model | null>((tui, theme, _kb, done) => {
		let settled = false;
		const finish = (value: Model | null) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		const selector = new ModelSelectorComponent(
			tui as never,
			currentModel,
			runtime,
			scoped,
			(model) => finish(model as Model),
			() => {
				finish(null);
				(tui as { requestRender?: () => void }).requestRender?.();
			},
		);
		queueMicrotask(() => (tui as { requestRender?: () => void }).requestRender?.());
		// v0.7.1: pi's ModelSelectorComponent draws only a horizontal rule; wrap
		// it so the gate panel has a full box like the reviewer panel.
		return new BorderedPanel(selector, borderColorFrom(theme));
	}, OVERLAY_OPTIONS as never)) as Model | null | undefined;
}

/** /thinking-style effort panel. Assumes a real TUI (called after the model
 * panel succeeded). Returns "default" | level | null (Esc). */
async function pickLevelViaPanel(
	host: RolePanelHost,
	model: Model,
	currentLevel: string | null,
	titles: PickTitles = REVIEWER_TITLES,
): Promise<string | null | undefined> {
	const items = effortItems(model, currentLevel);
	return (await host.ui.custom<string | null>((_tui, theme, _kb, done) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		const panel = new EffortPanelComponent(items, currentLevel ?? DEFAULT_LEVEL_SENTINEL, (value) => finish(value), () => finish(null), titles);
		return new BorderedPanel(panel, borderColorFrom(theme));
	}, OVERLAY_OPTIONS as never)) as string | null | undefined;
}

/** Native menus for hasUI-but-not-TUI sessions (Q-2=A) — shared with the
 * TUI panel-construction fallback. */
async function pickModelViaMenu(host: RolePanelHost, title: string = REVIEWER_TITLES.modelMenu): Promise<string | undefined> {
	if (typeof host.ui.select !== "function") return undefined;
	const models = availableModels(host);
	if (models.length === 0) return undefined;
	const options = models.map((model) => `${model.provider}/${model.id}`);
	const picked = await host.ui.select(title, options);
	return typeof picked === "string" ? picked : undefined;
}

function selectorOf(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/** Resolve a selector to a Model for the effort step; menus may pick models
 * the registry no longer lists, so fall back to a bare selector object. */
function modelForEffort(host: RolePanelHost, selector: string): Model | null {
	return findModel(host, selector);
}

export interface PickOptions {
	/** Level preselected on the effort step (null = the "default" row). */
	storedLevel: string | null;
	/** Model highlighted first in the picker; defaults to the session's model. */
	preselectModel?: { provider: string; id: string } | null;
	titles?: PickTitles;
}

export type PickOutcome =
	| { status: "picked"; modelSelector: string; model: Model | null; thinkingLevel: string | null; via: "panel" | "menu" }
	| { status: "cancelled"; via: "panel" | "menu" }
	| { status: "unavailable"; reason: "no-custom" | "no-runtime" | "no-models" | "no-select" };

/**
 * The model-then-effort picker, with no persistence: panels in a TUI, native
 * menus in other UI sessions. Esc anywhere cancels the whole pick. Both the
 * reviewer first-use gate and the execution-model chooser run on this.
 */
export async function pickModelAndEffort(host: RolePanelHost, options: PickOptions): Promise<PickOutcome> {
	const titles = options.titles ?? REVIEWER_TITLES;
	const storedLevel = options.storedLevel;
	const tui = host.mode === "tui" && typeof host.ui.custom === "function";
	if (tui) {
		let picked: Model | null | undefined;
		try {
			picked = await pickModelViaPanel(host, options.preselectModel);
		} catch {
			// Construction/refresh failure (pi upgrade drift, F-010): fall back
			// to menus instead of failing the gate.
			picked = undefined;
		}
		if (picked === undefined) {
			// custom() unavailable (RPC) or runtime adapter failed — menu fallback.
		} else if (picked === null) {
			return { status: "cancelled", via: "panel" };
		} else {
			const level = await pickLevelViaPanel(host, picked, storedLevel, titles);
			if (level === undefined || level === null) return { status: "cancelled", via: "panel" };
			return { status: "picked", modelSelector: selectorOf(picked), model: picked, thinkingLevel: level === DEFAULT_LEVEL_SENTINEL ? null : level, via: "panel" };
		}
	}
	// Menus (hasUI non-TUI, or TUI panel fallback).
	if (!host.hasUI || typeof host.ui.select !== "function") {
		return { status: "unavailable", reason: tui ? "no-runtime" : "no-select" };
	}
	const models = availableModels(host);
	if (models.length === 0 && tui) return { status: "unavailable", reason: "no-models" };
	const selector = await pickModelViaMenu(host, titles.modelMenu);
	if (selector === undefined) return { status: "cancelled", via: "menu" };
	const model = modelForEffort(host, selector);
	if (model) {
		const items = effortItems(model, storedLevel);
		const labels = items.map((item) => `${item.label} — ${item.description}`);
		const picked = await host.ui.select(titles.levelMenu, labels);
		if (picked === undefined) return { status: "cancelled", via: "menu" };
		const index = labels.indexOf(picked);
		const value = index >= 0 ? items[index]!.value : DEFAULT_LEVEL_SENTINEL;
		return { status: "picked", modelSelector: selector, model, thinkingLevel: value === DEFAULT_LEVEL_SENTINEL ? null : value, via: "menu" };
	}
	// Selector not in the registry (manually entered): take it as-is with the
	// default level — spawn-side validation catches typos with a precise error.
	return { status: "picked", modelSelector: selector, model: null, thinkingLevel: null, via: "menu" };
}

/**
 * Run the first-use flow and, on full completion, persist the confirmed
 * role to the global config and return it. Esc anywhere cancels the whole
 * gate without persisting (F-005). The returned role is what the caller
 * must use for THIS invocation (never a stale pre-gate snapshot).
 */
export async function runFirstUseFlow(host: RolePanelHost, storedLevel: string | null): Promise<FirstUseOutcome> {
	const outcome = await pickModelAndEffort(host, { storedLevel });
	if (outcome.status !== "picked") return outcome;
	return confirmRole(outcome.modelSelector, outcome.thinkingLevel, outcome.model, outcome.via);
}

function confirmRole(modelSelector: string, thinkingLevel: string | null, model: Model | null, via: "panel" | "menu"): FirstUseOutcome {
	const applied = setGlobalRole({ modelSelector, thinkingLevel: thinkingLevel ?? "default", confirmed: true });
	return {
		status: "confirmed",
		modelSelector,
		model,
		thinkingLevel,
		role: applied.global.reviewer,
		notices: applied.notices,
		via,
	};
}

/** Esc-cancelled gate error (F-005): a dedicated message + details marker so
 * the agent does NOT re-ask via ask_choice or blindly retry. */
export function firstUseCancelledError(toolName: string): Error {
	const error = new Error(
		`The user closed the ${toolName} first-use reviewer model panel without completing it. Do NOT re-ask the model question with ask_choice and do NOT retry ${toolName} unless the user asks. The user can configure the reviewer at any time with /config-pi-plans.`,
	);
	(error as Error & { cancelled?: boolean }).cancelled = true;
	return error;
}

/** UI-less gate guidance (F-004): embedded model list + exact set-role call. */
export function firstUseTextGuidance(models: Model[], globalConfigPath: string): string {
	const sample = models
		.slice(0, 30)
		.map((model) => `${model.provider}/${model.id}`)
		.join(", ");
	return [
		"The reviewer model was never confirmed. This session has no interactive UI, so ask the model-confirmation question with ask_choice:",
		"1. Choose a model — available selectors include: " + (sample || "(none found via the model registry; ask the user for an exact provider/model string)"),
		"2. Other / 3. Auto-complete — choose a concrete provider/model selector (inherit is no longer supported).",
		`Then persist with the plans tool: set-role, role=reviewer, modelSelector=<provider/model>, confirmed: true (plus thinkingLevel: high|medium|…|default when the user wants a specific level). The reviewer role lives in the global config (${globalConfigPath}), shared across all workspaces; automation may also pre-write that file directly.`,
	].join("\n");
}
