/**
 * Global (user-level) pi-plans configuration.
 *
 * The reviewer role lives here as the single source of truth (v0.7.0): one
 * file, shared across every workspace, confirmed once. The file is
 * `~/.pi/pi-plans/config.json` — a standalone pi-plans file, NOT Pi's own
 * `~/.pi/agent/settings.json` — and its directory can be overridden with
 * `PI_PLANS_GLOBAL_DIR` (tests, CI, and bench containers rely on this).
 *
 * Workspace `.git/pi-plans/config.json` keeps a read-tolerated legacy
 * `reviewer` block (pre-0.7.0). It is honored read-only until the first
 * mutating state call migrates it (see `seedGlobalRoleFromLegacy`) and is
 * stripped from the workspace config on the next write.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseExecutorChoice, type ExecutorChoice } from "./executor-config.ts";

export class GlobalStateError extends Error {}

export const GLOBAL_DIR_ENV = "PI_PLANS_GLOBAL_DIR";

/** Test hook so tests can pin the clock (run-id dedup etc.). Shared with
 * state.ts via re-export so both modules stamp identical timestamps. */
export const testHooks: { now: () => Date } = { now: () => new Date() };

export function utcNow(): string {
	return testHooks.now().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type ThinkingLevelValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Valid stored thinking levels. `null` means "default": the spawned child
 * gets no `--thinking` flag and resolves its own default chain (per-model
 * settings → defaultThinkingLevel → medium). */
export const VALID_THINKING_LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export const VALID_ROLE_MODES = new Set(["delegated-subagent", "current-session"]);

export interface GlobalRoleConfig {
	mode: string;
	/** Exact `provider/model` selector. `null` = unconfirmed (delegated mode
	 * refuses to spawn until a concrete selector is confirmed; the inherit
	 * entry point was removed in v0.7.0). */
	model_selector: string | null;
	/** `null` = default (omit `--thinking`); "off" is an explicit level and
	 * deliberately distinct from null. */
	thinking_level: ThinkingLevelValue | null;
	name_prefix: string;
	confirmed_at: string | null;
}

export interface GlobalConfig {
	schema: 1;
	reviewer: GlobalRoleConfig;
	/** Non-binding: the last execution choice, preselected by the next
	 * handoff's picker. Never read as a decision. */
	executor_last?: ExecutorChoice;
}

export const DEFAULT_GLOBAL_ROLE: GlobalRoleConfig = {
	mode: "delegated-subagent",
	model_selector: null,
	thinking_level: null,
	name_prefix: "pi-plans-reviewer",
	confirmed_at: null,
};

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
	schema: 1,
	reviewer: structuredClone(DEFAULT_GLOBAL_ROLE),
};

/** Resolve the global config directory: `$PI_PLANS_GLOBAL_DIR` when set,
 * otherwise `~/.pi/pi-plans`. */
export function resolveGlobalDir(): string {
	const override = process.env[GLOBAL_DIR_ENV];
	if (override && override.trim() !== "") return path.resolve(override);
	return path.join(os.homedir(), ".pi", "pi-plans");
}

export function resolveGlobalConfigPath(): string {
	return path.join(resolveGlobalDir(), "config.json");
}

export interface GlobalLoadResult {
	config: GlobalConfig;
	/** Load-time diagnostics (corrupt file, invalid fields). */
	notices: string[];
	/** True when no global file exists yet (defaults returned). */
	fresh: boolean;
	/** True when the file exists but was unusable (never clobbered). */
	corrupt: boolean;
}

/** Normalize an unknown value into a GlobalRoleConfig, collecting
 * diagnostics. Invalid fields fall back to defaults; the file is never
 * rewritten by a read. */
export function normalizeGlobalRole(
	raw: unknown,
	notices: string[],
	label: string,
): GlobalRoleConfig {
	const role = structuredClone(DEFAULT_GLOBAL_ROLE);
	if (raw === null || raw === undefined || typeof raw !== "object") {
		notices.push(`${label}: missing reviewer block; using defaults`);
		return role;
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.mode === "string") {
		if (VALID_ROLE_MODES.has(record.mode)) {
			role.mode = record.mode;
		} else {
			notices.push(`${label}: invalid reviewer mode ${JSON.stringify(record.mode)}; using default`);
		}
	}
	if (record.model_selector === null) {
		role.model_selector = null;
	} else if (typeof record.model_selector === "string" && record.model_selector.trim() !== "") {
		role.model_selector = record.model_selector;
	} else if (record.model_selector !== undefined) {
		notices.push(`${label}: invalid model_selector; treating as unconfirmed`);
	}
	if (record.thinking_level === null || record.thinking_level === undefined) {
		role.thinking_level = null;
	} else if (typeof record.thinking_level === "string" && VALID_THINKING_LEVELS.has(record.thinking_level)) {
		role.thinking_level = record.thinking_level as ThinkingLevelValue;
	} else {
		notices.push(`${label}: invalid thinking_level ${JSON.stringify(record.thinking_level)}; using default`);
	}
	if (typeof record.name_prefix === "string" && record.name_prefix.trim() !== "") {
		role.name_prefix = record.name_prefix;
	}
	if (typeof record.confirmed_at === "string" && record.confirmed_at !== "") {
		role.confirmed_at = record.confirmed_at;
	}
	return role;
}

/** Read the global config. Never writes; a corrupt or wrong-schema file is
 * reported and left untouched (defaults are used for this call only). */
export function loadGlobalConfig(): GlobalLoadResult {
	const configPath = resolveGlobalConfigPath();
	if (!existsSync(configPath)) {
		return { config: structuredClone(DEFAULT_GLOBAL_CONFIG), notices: [], fresh: true, corrupt: false };
	}
	const notices: string[] = [];
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		notices.push(
			`global config is invalid JSON (${(error as Error).message}); using defaults and leaving ${configPath} untouched`,
		);
		return { config: structuredClone(DEFAULT_GLOBAL_CONFIG), notices, fresh: false, corrupt: true };
	}
	if (data === null || typeof data !== "object" || (data as Record<string, unknown>).schema !== 1) {
		notices.push(
			`global config schema is unsupported; using defaults and leaving ${configPath} untouched`,
		);
		return { config: structuredClone(DEFAULT_GLOBAL_CONFIG), notices, fresh: false, corrupt: true };
	}
	const reviewer = normalizeGlobalRole((data as Record<string, unknown>).reviewer, notices, "global config");
	const config: GlobalConfig = { schema: 1, reviewer };
	const lastRaw = (data as Record<string, unknown>).executor_last;
	if (lastRaw !== undefined && lastRaw !== null) {
		const parsed = parseExecutorChoice(lastRaw, VALID_THINKING_LEVELS);
		if ("error" in parsed) notices.push(`global config: ignoring executor_last (${parsed.error})`);
		else config.executor_last = parsed;
	}
	return { config, notices, fresh: false, corrupt: false };
}

/** Atomic write with a unique temp name (concurrent writers never collide
 * on a shared `.tmp` path). */
export function writeGlobalConfig(config: GlobalConfig): void {
	const configPath = resolveGlobalConfigPath();
	mkdirSync(path.dirname(configPath), { recursive: true });
	const tmp = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	renameSync(tmp, configPath);
}

/**
 * Gate predicate shared by every spawn site: current-session runs in the
 * main session (no model needed); delegated-subagent requires a confirmed,
 * CONCRETE `provider/model` selector (the inherit entry point was removed —
 * a null selector can never pass confirmation).
 */
export function reviewerReady(role: GlobalRoleConfig): boolean {
	if (role.mode === "current-session") return true;
	return role.confirmed_at !== null && role.model_selector !== null;
}

export interface SetGlobalRoleOptions {
	mode?: string;
	/** Exact "provider/model" selector; "inherit" resets BOTH the selector
	 * and the confirmation (a pure reset, never a confirmable state). */
	modelSelector?: string;
	/** Level from VALID_THINKING_LEVELS, or "default" for null (omit
	 * --thinking). Omitted = keep, except when modelSelector changes
	 * concurrently, which resets the level. */
	thinkingLevel?: string;
	confirmed?: boolean;
	resetConfirmation?: boolean;
}

/** Apply set-role options to a role snapshot. Throws GlobalStateError on
 * invalid combinations BEFORE any mutation lands on disk. */
export function applyGlobalRoleOptions(base: GlobalRoleConfig, options: SetGlobalRoleOptions): GlobalRoleConfig {
	const role = { ...base };
	if (options.mode !== undefined && !VALID_ROLE_MODES.has(options.mode)) {
		throw new GlobalStateError(`mode must be one of ${[...VALID_ROLE_MODES].sort().join(", ")}`);
	}
	if (options.confirmed && options.resetConfirmation) {
		throw new GlobalStateError("confirmed and resetConfirmation are mutually exclusive");
	}
	if (options.thinkingLevel !== undefined) {
		if (options.thinkingLevel === "default") {
			role.thinking_level = null;
		} else if (!VALID_THINKING_LEVELS.has(options.thinkingLevel)) {
			throw new GlobalStateError(
				`thinkingLevel must be one of ${[...VALID_THINKING_LEVELS].join(", ")}, or "default"`,
			);
		} else {
			role.thinking_level = options.thinkingLevel as ThinkingLevelValue;
		}
	}
	if (options.modelSelector !== undefined) {
		if (options.modelSelector === "inherit") {
			if (options.confirmed) {
				throw new GlobalStateError(
					"'inherit' is a reset and cannot be combined with confirmed; confirm an exact provider/model selector instead",
				);
			}
			role.model_selector = null;
			role.confirmed_at = null;
		} else {
			role.model_selector = options.modelSelector;
			// Switching models invalidates a stored level (the level domain is
			// per-model); callers that keep the level pass it explicitly.
			if (options.thinkingLevel === undefined) role.thinking_level = null;
		}
	}
	if (options.mode !== undefined) role.mode = options.mode;
	if (options.confirmed) {
		if (role.mode === "delegated-subagent" && role.model_selector === null) {
			throw new GlobalStateError(
				"confirmed requires an exact provider/model selector for delegated-subagent; use the first-use model panel or pass modelSelector",
			);
		}
		role.confirmed_at = utcNow();
	}
	if (options.resetConfirmation) role.confirmed_at = null;
	return role;
}

export interface SetGlobalRoleResult {
	global: GlobalConfig;
	/** Load-time diagnostics merged from the initial load. */
	notices: string[];
}

/** Load → apply → write the global reviewer role. Global writes never touch
 * workspace state (no git-init side effects, F-013). */
export function setGlobalRole(options: SetGlobalRoleOptions): SetGlobalRoleResult {
	const loaded = loadGlobalConfig();
	const reviewer = applyGlobalRoleOptions(loaded.config.reviewer, options);
	const config: GlobalConfig = { ...loaded.config, schema: 1, reviewer };
	writeGlobalConfig(config);
	return { global: config, notices: loaded.notices };
}

/** Remember the last execution choice as the next handoff's preselection.
 * Best-effort: a corrupt global file is never overwritten for this. */
export function rememberLastExecutor(choice: ExecutorChoice): void {
	const loaded = loadGlobalConfig();
	if (loaded.corrupt) return;
	writeGlobalConfig({ ...loaded.config, schema: 1, executor_last: choice });
}

/** True when a legacy workspace reviewer block carries real user intent
 * (anything but the scaffold defaults). Scaffolded blocks are dropped
 * silently; intent blocks seed the global file exactly once (the first
 * touched workspace wins, Q-1=A). */
export function legacyReviewerHasUserIntent(raw: unknown): boolean {
	if (raw === null || raw === undefined || typeof raw !== "object") return false;
	const record = raw as Record<string, unknown>;
	if (record.confirmed_at !== null && record.confirmed_at !== undefined) return true;
	if (typeof record.model_selector === "string" && record.model_selector.trim() !== "") return true;
	if (typeof record.mode === "string" && record.mode !== "delegated-subagent") return true;
	return false;
}

/** Seed a global role from a legacy workspace reviewer block (v0.6.x). A
 * confirmed-inherit block (model_selector null) loses its confirmation —
 * under v0.7.0 semantics a delegated reviewer needs a concrete model, so
 * the first refine re-asks once with the native panel (decision 8). */
export function seedGlobalRoleFromLegacy(raw: unknown): { role: GlobalRoleConfig; notices: string[] } {
	const notices: string[] = [];
	const role = normalizeGlobalRole(raw, notices, "legacy workspace reviewer");
	role.thinking_level = null; // pre-0.7.0 blocks never carried a level
	if (role.model_selector === null) role.confirmed_at = null;
	return { role, notices };
}

export function globalMigratedNotice(globalPath: string): string {
	return `migrated the reviewer role from workspace config.json to the global config (${globalPath}); the workspace reviewer key is removed on the next config write`;
}

export function globalIgnoredNotice(globalPath: string): string {
	return `workspace config.json still carries a reviewer block; the global config (${globalPath}) is the source of truth — the workspace block is ignored and will be removed on the next config write`;
}
