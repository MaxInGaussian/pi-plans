/**
 * Thin thinking-level adapter over pi-ai's exported helpers.
 *
 * pi-ai already owns the level domain rules (`getSupportedThinkingLevels`:
 * non-reasoning models only support "off"; a null mapping disables a level;
 * xhigh/max appear only when explicitly mapped). Re-implementing them here
 * would drift — this module only adds the pi-plans "default" sentinel and
 * the stored-level resolution used by the reviewer spawn path (F-012).
 *
 * Semantics (decision 4 / F-009): `thinking_level: null` in the global
 * reviewer config means DEFAULT — the child pi gets NO --thinking flag and
 * resolves its own default chain (per-model settings → defaultThinkingLevel
 * → medium, then model clamping). That is deliberately distinct from the
 * explicit "off" level.
 */

import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { GlobalRoleConfig, ThinkingLevelValue } from "./global-state.ts";

/** Panel/label sentinel for `thinking_level: null` (omit --thinking). */
export const DEFAULT_LEVEL_SENTINEL = "default";

/** Levels a model actually supports, via pi-ai (single source of truth). */
export function levelsForModel(model: Pick<Model<any>, "reasoning" | "thinkingLevelMap">): ModelThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}

/** True when the stored level is supported by the model (spawn passes it
 * through verbatim; unsupported stored levels are clamped by the child). */
export function isLevelSupported(
	model: Pick<Model<any>, "reasoning" | "thinkingLevelMap">,
	level: string | null,
): boolean {
	if (level === null) return true; // default: no flag, always valid
	return levelsForModel(model).includes(level as ModelThinkingLevel);
}

/** Resolve the CLI argument for the stored level: null → omit the flag. */
export function spawnThinkingFlag(level: ThinkingLevelValue | null): string | null {
	return level ?? null;
}

/** Display label for the reviewer overlay and subagents ledger. */
export function roleModelLabel(modelSelector: string, thinkingLevel: ThinkingLevelValue | null): string {
	return `${modelSelector}:${thinkingLevel ?? DEFAULT_LEVEL_SENTINEL}`;
}

/** Human-facing one-liner for the default row / docs (F-009): the default
 * is the child pi's own chain, NOT the current session's level. */
export const DEFAULT_LEVEL_DESCRIPTION =
	"no --thinking flag: the child pi resolves its default (per-model settings → defaultThinkingLevel → medium)";

/** Spawn-view of a confirmed reviewer role: concrete model + optional level. */
export interface ResolvedReviewerSpawn {
	modelSelector: string;
	thinkingLevel: ThinkingLevelValue | null;
	label: string;
}

export function resolveReviewerSpawn(role: Pick<GlobalRoleConfig, "model_selector" | "thinking_level">): ResolvedReviewerSpawn {
	const modelSelector = role.model_selector ?? "";
	return {
		modelSelector,
		thinkingLevel: role.thinking_level ?? null,
		label: modelSelector ? roleModelLabel(modelSelector, role.thinking_level ?? null) : "unconfirmed",
	};
}
