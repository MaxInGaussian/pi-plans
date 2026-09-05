import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, readActive, resolveStateRootOrNull, showConfig, type PlansConfig, utcNow, VALID_ROLE_MODES, updateConfig } from "./state.ts";

interface ModelLike {
	provider?: unknown;
	id?: unknown;
}

interface ConfigCommandContext {
	cwd: string;
	hasUI: boolean;
	model?: unknown;
	scopedModels?: Array<{ model?: unknown }>;
	modelRegistry?: {
		getAvailable?: () => unknown[];
	};
	ui: Pick<ExtensionContext["ui"], "notify" | "select" | "input">;
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

function modelSelectorOf(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const model = value as ModelLike;
	if (typeof model.provider !== "string" || typeof model.id !== "string") return null;
	if (!model.provider || !model.id) return null;
	return `${model.provider}/${model.id}`;
}

function collectModelSelectors(ctx: ConfigCommandContext, currentSelector: string | null): string[] {
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
	for (const root of ["./docs/pi-plans", "./.git/pi_plans/plans"]) {
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

async function promptRoleMode(ctx: ConfigCommandContext, role: "reviewer" | "criticizer", current: string): Promise<ChoiceResult<string>> {
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
	return promptMenu(ctx, `${role[0].toUpperCase()}${role.slice(1)} mode?`, options);
}

async function promptRoleModel(
	ctx: ConfigCommandContext,
	role: "reviewer" | "criticizer",
	currentSelector: string | null,
): Promise<ChoiceResult<string | null>> {
	const currentLiveSelector = modelSelectorOf(ctx.model);
	const options: Array<MenuOption<string | null>> = [
		{
			label: currentSelector
				? `Keep current default (${currentSelector})`
				: currentLiveSelector
					? `Keep current default (inherit live model: ${currentLiveSelector})`
					: "Keep current default (inherit)",
			value: currentSelector,
		},
	];
	if (currentLiveSelector && currentLiveSelector !== currentSelector) {
		options.push({ label: `Use current session model (${currentLiveSelector})`, value: currentLiveSelector });
	}
	for (const selector of collectModelSelectors(ctx, currentSelector)) {
		if (selector === currentLiveSelector) continue;
		options.push({ label: `Use available model (${selector})`, value: selector });
	}
	options.push({
		label: "Other...",
		parse: parseModelSelector,
		prompt: `${role[0].toUpperCase()}${role.slice(1)} model selector:`,
		errorMessage: "Model selector must be an exact provider/model string.",
	});
	return promptMenu(ctx, `${role[0].toUpperCase()}${role.slice(1)} model?`, options);
}

function currentConfig(workdir: string): PlansConfig {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (!stateRoot) return structuredClone(DEFAULT_CONFIG);
	return showConfig(workdir);
}

function summarizeConfig(config: PlansConfig): string[] {
	return [
		"pi-plans config updated.",
		`Language: ${config.language.tag ?? "(unset)"}`,
		`Artifact root: ${config.artifact_root}`,
		`Code graph: ${config.graph_enabled === true ? "enabled" : config.graph_enabled === false ? "disabled" : "unset"}`,
		`Reviewer: ${config.reviewer.mode} / ${config.reviewer.model_selector ?? "inherit"}`,
		`Criticizer: ${config.criticizer.mode} / ${config.criticizer.model_selector ?? "inherit"}`,
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

		const language = await promptLanguage(ctx, current.language.tag);
		if (language.cancelled) {
			if (language.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const artifactRoot = await promptArtifactRoot(ctx, current.artifact_root);
		if (artifactRoot.cancelled) {
			if (artifactRoot.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const graphEnabled = await promptGraphEnabled(ctx, current.graph_enabled);
		if (graphEnabled.cancelled) {
			if (graphEnabled.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const reviewerMode = await promptRoleMode(ctx, "reviewer", current.reviewer.mode);
		if (reviewerMode.cancelled) {
			if (reviewerMode.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const reviewerModel = await promptRoleModel(ctx, "reviewer", current.reviewer.model_selector);
		if (reviewerModel.cancelled) {
			if (reviewerModel.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const criticizerMode = await promptRoleMode(ctx, "criticizer", current.criticizer.mode);
		if (criticizerMode.cancelled) {
			if (criticizerMode.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const criticizerModel = await promptRoleModel(ctx, "criticizer", current.criticizer.model_selector);
		if (criticizerModel.cancelled) {
			if (criticizerModel.reason === "user") {
				ctx.ui.notify("Configuration wizard cancelled. No changes were written.", "warning");
			}
			return;
		}

		const updated = updateConfig(workdir, (config) => {
			const now = utcNow();
			config.language = { tag: language.value, source: "user", updated_at: now };
			config.artifact_root = artifactRoot.value;
			config.artifact_root_source = "user";
			config.artifact_root_updated_at = now;
			config.graph_enabled = graphEnabled.value;
			config.graph_enabled_updated_at = now;
			config.reviewer = {
				...config.reviewer,
				mode: reviewerMode.value,
				model_selector: reviewerModel.value,
				confirmed_at: now,
			};
			config.criticizer = {
				...config.criticizer,
				mode: criticizerMode.value,
				model_selector: criticizerModel.value,
				confirmed_at: now,
			};
			return config;
		});

		const active = readActive(workdir);
		const lines = summarizeConfig(updated.config);
		if (active) {
			lines.push(`Active run left unchanged: ${active.run_id}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(`Failed to update pi-plans config: ${(error as Error).message}`, "error");
	}
}
