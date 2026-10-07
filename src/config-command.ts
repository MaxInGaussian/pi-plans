import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	readActive,
	showStateView,
	setRole,
	type PlansConfig,
	utcNow,
	VALID_ROLE_MODES,
	updateConfig,
	type GlobalRoleConfig,
} from "./state.ts";
import { DEFAULT_LEVEL_SENTINEL } from "./thinking-levels.ts";
import { effortItems, runFirstUseFlow, type RolePanelHost } from "./role-panels.ts";
import { refreshUiLanguage } from "./exec.ts";

interface ModelLike {
	provider?: unknown;
	id?: unknown;
}

export interface ConfigCommandContext {
	cwd: string;
	hasUI: boolean;
	mode?: string;
	model?: unknown;
	scopedModels?: Array<{ model?: unknown }>;
	modelRegistry?: {
		getAvailable?: () => unknown[];
		find?: (provider: string, id: string) => unknown;
	};
	ui: Pick<ExtensionContext["ui"], "notify" | "select" | "input"> &
		Partial<Pick<ExtensionContext["ui"], "custom">>;
}

type ChoiceResult<T> =
	| { cancelled: false; value: T }
	| { cancelled: true; reason: "user" | "invalid" };

interface MenuOption<T> {
	label: string;
	value?: T;
	parse?: (input: string) => T | null;
	prompt?: string;
	errorMessage?: string;
}

function cancelled<T>(reason: "user" | "invalid" = "user"): ChoiceResult<T> {
	return { cancelled: true, reason };
}

export function modelSelectorOf(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const model = value as ModelLike;
	if (typeof model.provider !== "string" || typeof model.id !== "string") return null;
	if (!model.provider || !model.id) return null;
	return `${model.provider}/${model.id}`;
}

/**
 * Merge the session-visible model selectors (ctx.model + ctx.scopedModels +
 * the model registry), deduped, EXCLUDING `currentSelector` — the result is a
 * switch-target list (v0.6.0 delegated-execution model picker reuses this).
 */
export function collectModelSelectors(ctx: ConfigCommandContext, currentSelector: string | null): string[] {
	const selectors: string[] = [];
	const push = (selector: string | null): void => {
		if (!selector) return;
		if (selectors.includes(selector)) return;
		if (selector === currentSelector) return;
		selectors.push(selector);
	};

	push(modelSelectorOf(ctx.model));
	for (const entry of ctx.scopedModels ?? []) {
		push(modelSelectorOf(entry?.model));
	}
	for (const entry of ctx.modelRegistry?.getAvailable?.() ?? []) {
		push(modelSelectorOf(entry));
	}
	return selectors;
}

function parseLanguageTag(input: string): string | null {
	const value = input.trim();
	if (!value) return null;
	return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value) ? value : null;
}

function parseArtifactRoot(input: string): string | null {
	const value = input.trim();
	return value ? value : null;
}

function parseRefsRoot(input: string): string | null {
	const value = input.trim();
	return value ? value : null;
}

function parseModelSelector(input: string): string | null {
	const value = input.trim();
	if (!value) return null;
	if (value.includes(" ")) return null;
	const parts = value.split("/");
	return parts.length === 2 && parts[0] && parts[1] ? value : null;
}

function selectIndex(labels: string[], selected: string): number {
	let index = labels.indexOf(selected);
	if (index >= 0) return index;
	const normalized = selected.replace(/^\d+\.\s*/, "");
	return labels.findIndex((label) => label.replace(/^\d+\.\s*/, "") === normalized);
}

async function promptMenu<T>(ctx: ConfigCommandContext, question: string, options: Array<MenuOption<T>>): Promise<ChoiceResult<T>> {
	const labels = options.map((option, index) => `${index + 1}. ${option.label}`);
	const selected = await ctx.ui.select(question, labels);
	if (selected === undefined) return cancelled("user");
	const index = selectIndex(labels, selected);
	if (index < 0) return cancelled("invalid");
	const option = options[index];
	if (!option) return cancelled("invalid");
	if (option.parse) {
		const raw = await ctx.ui.input(option.prompt ?? `${question} ${option.label}`);
		if (raw === undefined) return cancelled("user");
		const parsed = option.parse(raw);
		if (parsed === null) {
			ctx.ui.notify(option.errorMessage ?? "Invalid input.", "error");
			return cancelled("invalid");
		}
		return { cancelled: false, value: parsed };
	}
	if (!Object.prototype.hasOwnProperty.call(option, "value")) return cancelled("invalid");
	return { cancelled: false, value: option.value as T };
}

async function promptLanguage(ctx: ConfigCommandContext, current: string | null): Promise<ChoiceResult<string>> {
	const options: Array<MenuOption<string>> = [];
	if (current) {
		options.push({ label: `Keep current (${current})`, value: current });
	} else {
		options.push({ label: "zh-Hans", value: "zh-Hans" });
	}
	for (const tag of ["zh-Hans", "en", "zh-Hant"]) {
		if (tag === current) continue;
		if (options.some((option) => option.value === tag)) continue;
		options.push({ label: tag, value: tag });
	}
	options.push({
		label: "Other...",
		parse: parseLanguageTag,
		prompt: "Language tag:",
		errorMessage: "Invalid language tag.",
	});
	return promptMenu(ctx, "Language?", options);
}

async function promptArtifactRoot(ctx: ConfigCommandContext, current: string): Promise<ChoiceResult<string>> {
	const options: Array<MenuOption<string>> = [{ label: `Keep current (${current})`, value: current }];
	for (const root of ["./.git/pi-plans/plans", "./docs/pi-plans"]) {
		if (root === current) continue;
		options.push({ label: root, value: root });
	}
	options.push({
		label: "Other...",
		parse: parseArtifactRoot,
		prompt: "Artifact root:",
		errorMessage: "Artifact root cannot be empty.",
	});
	return promptMenu(ctx, "Artifact root?", options);
}

async function promptRefsRoot(ctx: ConfigCommandContext, current: string | null): Promise<ChoiceResult<string>> {
	const options: Array<MenuOption<string>> = [];
	if (current) {
		options.push({ label: `Keep current (${current})`, value: current });
	}
	for (const root of [".git/pi-plans/refs", "./refs", "~/.cache/pi-plans/refs"]) {
		if (root === current) continue;
		options.push({ label: root, value: root });
	}
	options.push({
		label: "Other...",
		parse: parseRefsRoot,
		prompt: "Refs root:",
		errorMessage: "Refs root cannot be empty.",
	});
	return promptMenu(ctx, "Refs root (plan-with-refs downloads)?", options);
}

async function promptGraphEnabled(ctx: ConfigCommandContext, current: boolean | null): Promise<ChoiceResult<boolean>> {
	const options: Array<MenuOption<boolean>> = [];
	if (current === true) {
		options.push({ label: "Keep enabled", value: true });
		options.push({ label: "Disable code graph", value: false });
	} else if (current === false) {
		options.push({ label: "Keep disabled", value: false });
		options.push({ label: "Enable code graph", value: true });
	} else {
		options.push({ label: "Enable code graph", value: true });
		options.push({ label: "Disable code graph", value: false });
	}
	return promptMenu(ctx, "Code graph?", options);
}

async function promptRoleMode(ctx: ConfigCommandContext, current: string): Promise<ChoiceResult<string>> {
	if (!VALID_ROLE_MODES.has(current)) {
		current = "delegated-subagent";
	}
	const options: Array<MenuOption<string>> =
		current === "delegated-subagent"
			? [
				{ label: "Keep delegated-subagent", value: "delegated-subagent" },
				{ label: "Switch to current-session", value: "current-session" },
			]
			: [
				{ label: "Keep current-session", value: "current-session" },
				{ label: "Switch to delegated-subagent", value: "delegated-subagent" },
			];
	return promptMenu(ctx, "Reviewer mode?", options);
}

async function promptRoleModelEntry(
	ctx: ConfigCommandContext,
	role: GlobalRoleConfig,
): Promise<ChoiceResult<"keep" | "change">> {
	const level = role.thinking_level ?? DEFAULT_LEVEL_SENTINEL;
	const keepLabel =
		role.model_selector !== null && role.confirmed_at !== null
			? `Keep current (${role.model_selector} · ${level})`
			: "Keep current (unconfirmed; first refine will ask)";
	const options: Array<MenuOption<"keep" | "change">> = [
		{ label: keepLabel, value: "keep" },
		{ label: "Choose model & thinking level…", value: "change" },
	];
	return promptMenu(ctx, "Reviewer model?", options);
}

/** Change flow (Q-3=A): TUI pops the native panels via runFirstUseFlow
 * (which persists to the global config on completion); other UI modes use
 * menus (model list → effort list). Esc anywhere keeps the current role —
 * the wizard continues instead of discarding earlier answers (F-011). */
async function changeReviewerRole(
	ctx: ConfigCommandContext,
	role: GlobalRoleConfig,
): Promise<{ role: GlobalRoleConfig; changed: boolean; error?: string }> {
	const host = ctx as unknown as RolePanelHost;
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		const outcome = await runFirstUseFlow(host, role.thinking_level);
		if (outcome.status === "confirmed") return { role: outcome.role, changed: true };
		if (outcome.status === "cancelled") {
			ctx.ui.notify("Reviewer change cancelled — keeping the current role.", "warning");
			return { role, changed: false };
		}
		return { role, changed: false, error: "native panels unavailable in this session" };
	}
	// Menus: model list (live model first, then scoped/registry), then effort.
	const currentSelector = role.model_selector;
	const selectors: string[] = [];
	const live = modelSelectorOf(ctx.model);
	if (live) selectors.push(live);
	for (const selector of collectModelSelectors(ctx, currentSelector)) {
		if (selector === live) continue;
		selectors.push(selector);
	}
	const modelLabels = [...selectors.map((selector) => `Use ${selector}`), "Other..."];
	const picked = await ctx.ui.select("Reviewer model?", modelLabels);
	if (picked === undefined) {
		ctx.ui.notify("Reviewer change cancelled — keeping the current role.", "warning");
		return { role, changed: false };
	}
	let selector: string | null = null;
	if (picked === "Other...") {
		const raw = await ctx.ui.input("Reviewer model selector:");
		if (raw === undefined) {
			ctx.ui.notify("Reviewer change cancelled — keeping the current role.", "warning");
			return { role, changed: false };
		}
		selector = parseModelSelector(raw);
		if (selector === null) {
			ctx.ui.notify("Model selector must be an exact provider/model string.", "error");
			return { role, changed: false, error: "invalid model selector" };
		}
	} else {
		selector = picked.replace(/^Use /, "");
	}
	// Effort menu: default sentinel + the chosen model's supported levels.
	const found =
		typeof ctx.modelRegistry?.find === "function"
			? ((ctx.modelRegistry.find(selector.split("/")[0]!, selector.split("/")[1]!) as never) ?? null)
			: null;
	const items = found ? effortItems(found, role.thinking_level) : [{ value: DEFAULT_LEVEL_SENTINEL, label: DEFAULT_LEVEL_SENTINEL, description: "no explicit level" }];
	const levelLabels = items.map((item) => `${item.label} — ${item.description}`);
	const levelPicked = await ctx.ui.select("Reviewer thinking level? (first row = default: no explicit level)", levelLabels);
	const levelValue = levelPicked === undefined ? DEFAULT_LEVEL_SENTINEL : items[levelLabels.indexOf(levelPicked)]?.value ?? DEFAULT_LEVEL_SENTINEL;
	try {
		const applied = setRole(ctx.cwd, {
			role: "reviewer",
			modelSelector: selector,
			thinkingLevel: levelValue,
			confirmed: true,
		});
		return { role: applied.global.reviewer, changed: true };
	} catch (error) {
		return { role, changed: false, error: (error as Error).message };
	}
}

interface WizardCurrent {
	config: PlansConfig;
	reviewer: GlobalRoleConfig;
}

function currentConfig(workdir: string): WizardCurrent {
	const view = showStateView(workdir);
	return { config: view.config, reviewer: view.reviewer };
}

function summarizeConfig(config: PlansConfig, reviewer: GlobalRoleConfig): string[] {
	const level = reviewer.thinking_level ?? DEFAULT_LEVEL_SENTINEL;
	const model = reviewer.model_selector ?? (reviewer.mode === "current-session" ? "(in-session)" : "(unconfirmed)");
	return [
		"pi-plans config updated.",
		`Language: ${config.language.tag ?? "(unset)"}`,
		`Artifact root: ${config.artifact_root}`,
		`Refs root: ${config.refs_root ?? "(unset)"}`,
		`Code graph: ${config.graph_enabled === true ? "enabled" : config.graph_enabled === false ? "disabled" : "unset"}`,
		`Reviewer (global): ${reviewer.mode} / ${model}${reviewer.mode === "current-session" ? "" : ` · ${level}`}`,
	];
}

export async function configPiPlansCommand(_args: string, ctx: ConfigCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/config-pi-plans requires an interactive session.", "error");
		return;
	}

	try {
		const workdir = ctx.cwd;
		const current = currentConfig(workdir);
		let reviewer = current.reviewer;
		const workspace = current.config;

		const language = await promptLanguage(ctx, workspace.language.tag);
		if (language.cancelled) {
			if (language.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const artifactRoot = await promptArtifactRoot(ctx, workspace.artifact_root);
		if (artifactRoot.cancelled) {
			if (artifactRoot.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const refsRoot = await promptRefsRoot(ctx, workspace.refs_root);
		if (refsRoot.cancelled) {
			if (refsRoot.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const graphEnabled = await promptGraphEnabled(ctx, workspace.graph_enabled);
		if (graphEnabled.cancelled) {
			if (graphEnabled.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const reviewerMode = await promptRoleMode(ctx, reviewer.mode);
		if (reviewerMode.cancelled) {
			if (reviewerMode.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}
		if (reviewerMode.value !== reviewer.mode) {
			// Mode lives in the global role: persist the switch immediately;
			// the model/thinking level stays untouched.
			try {
				const applied = setRole(workdir, { role: "reviewer", mode: reviewerMode.value });
				reviewer = applied.global.reviewer;
			} catch (error) {
				ctx.ui.notify(`Failed to switch the reviewer mode: ${(error as Error).message}`, "error");
			}
		}

		// Q-3=A: current-session never uses a spawned model — skip the model
		// step entirely (and never clear an existing selector).
		let reviewerError: string | undefined;
		if (reviewer.mode === "delegated-subagent") {
			const entry = await promptRoleModelEntry(ctx, reviewer);
			if (entry.cancelled) {
				if (entry.reason === "user") {
					ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
				}
				return;
			}
			if (entry.value === "change") {
				const changed = await changeReviewerRole(ctx, reviewer);
				reviewer = changed.role;
				reviewerError = changed.error;
			}
		}

		const updated = updateConfig(workdir, (config) => {
			const now = utcNow();
			config.language = { tag: language.value, source: "user", updated_at: now };
			config.artifact_root = artifactRoot.value;
			config.artifact_root_source = "user";
			config.artifact_root_updated_at = now;
			config.refs_root = refsRoot.value;
			config.refs_root_source = "user";
			config.refs_root_updated_at = now;
			config.graph_enabled = graphEnabled.value;
			config.graph_enabled_updated_at = now;
			// The reviewer role lives in the GLOBAL config since v0.7.0 — the
			// wizard only strips a legacy workspace key, never writes one.
			delete config.reviewer;
			return config;
		});

		// D-008 (issue #3): language changes must repaint the panel/status bar
		// immediately when an execution is live (no-op otherwise).
		refreshUiLanguage(ctx as unknown as ExtensionContext);

		// Display-only consumer (F-006): deliberately keeps the shared active
		// pointer — the wizard summarizes repo state, not session attribution.
		const active = readActive(workdir);
		const lines = summarizeConfig(updated.config, reviewer);
		if (reviewerError) {
			lines.push(`Reviewer change failed (${reviewerError}); the reviewer role is unchanged. Workspace settings above were still written.`);
		}
		if (active) {
			lines.push(`Active run left unchanged: ${active.run_id}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(`Failed to update pi-plans config: ${(error as Error).message}`, "error");
	}
}
