/**
 * pi-plans workspace state, persisted under <git-common-dir>/pi-plans/.
 *
 * State lives inside the resolved git common dir (`git rev-parse
 * --git-common-dir`) as `.git/pi-plans/`, so it is never tracked and needs no
 * .gitignore rules. When the workdir is not a git repository, mutating
 * functions auto-run `git init` (never commits) under the same safety
 * conditions as the original helper.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintImplItems, lintPlanTasks } from "./plan.ts";
import {
	DEFAULT_GLOBAL_CONFIG,
	GlobalStateError,
	globalIgnoredNotice,
	globalMigratedNotice,
	legacyReviewerHasUserIntent,
	loadGlobalConfig,
	resolveGlobalConfigPath,
	resolveGlobalDir,
	seedGlobalRoleFromLegacy,
	setGlobalRole,
	testHooks,
	utcNow,
	writeGlobalConfig,
	type GlobalConfig,
	type GlobalRoleConfig,
	type SetGlobalRoleOptions,
} from "./global-state.ts";

export {
	GLOBAL_DIR_ENV,
	GlobalStateError,
	VALID_ROLE_MODES,
	VALID_THINKING_LEVELS,
	loadGlobalConfig,
	resolveGlobalConfigPath,
	resolveGlobalDir,
	reviewerReady,
	writeGlobalConfig,
	utcNow,
	testHooks,
} from "./global-state.ts";
export type { GlobalConfig, GlobalRoleConfig, ThinkingLevelValue } from "./global-state.ts";
/** Back-compat alias: the reviewer role now lives in the global config. */
export type RoleConfig = GlobalRoleConfig;

export const STATE_DIRNAME = "pi-plans";
const GIT_ENV_SCRUB = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"];

export class StateError extends Error {}

export type SettingSource = "user" | "auto" | "unset";

export interface LanguageConfig {
	tag: string | null;
	source: SettingSource;
	updated_at: string | null;
}


/** Pre-0.7.0 reviewer block as it may still exist inside a workspace
 * config.json. Read-tolerated: honored read-only until the first mutating
 * state call seeds the global config from it (intent blocks only) and the
 * next workspace write strips the key. */
export interface PlansConfig {
	schema: number;
	language: LanguageConfig;
	/** Legacy v0.6.x reviewer block — the source of truth is the global
	 * config (`~/.pi/pi-plans/config.json`); see global-state.ts. */
	reviewer?: GlobalRoleConfig;
	artifact_root: string;
	artifact_root_source: SettingSource;
	artifact_root_updated_at: string | null;
	/** null = never asked; plan-with-refs must ask once (three options) before downloading. */
	refs_root: string | null;
	refs_root_source: SettingSource;
	refs_root_updated_at: string | null;
	/** null = never asked; the plans tool surfaces a hint so the agent asks once. */
	graph_enabled: boolean | null;
	graph_enabled_updated_at: string | null;
}

/** Plan artifacts default inside the state root: `<git-common-dir>/pi-plans/plans/`. */
const DEFAULT_ARTIFACT_ROOT = "./.git/pi-plans/plans";
const LEGACY_ARTIFACT_ROOTS = new Set(["docs/plans", "./docs/plans"]);

function normalizeArtifactRoot(config: PlansConfig): PlansConfig {
	if (LEGACY_ARTIFACT_ROOTS.has(config.artifact_root)) {
		return { ...config, artifact_root: DEFAULT_ARTIFACT_ROOT };
	}
	return config;
}

/** Raw config shape as it may exist on disk, including keys this version
 * ignores (the v0.6.0 `criticizer` role block, removed in v0.6.1 when the
 * reviewer absorbed the criticizer's questioning duty). */
type LegacyPlansConfig = PlansConfig & { execution?: unknown; criticizer?: unknown };

export const DEFAULT_CONFIG: PlansConfig = {
	schema: 1,
	language: { tag: null, source: "unset", updated_at: null },
	artifact_root: DEFAULT_ARTIFACT_ROOT,
	artifact_root_source: "unset",
	artifact_root_updated_at: null,
	refs_root: null,
	refs_root_source: "unset",
	refs_root_updated_at: null,
	graph_enabled: null,
	graph_enabled_updated_at: null,
};

export const VALID_RUN_STATUSES = new Set([
	"planning",
	"accepted",
	"executing",
	"verifying",
	"stopped",
	"abandoned",
	"done",
]);

export interface RunNotice {
	/** Notice category, e.g. "plan-lint". */
	kind: string;
	/** Stable producer id used for dedupe, e.g. "lint-impl-items". */
	source: string;
	text: string;
	created_at: string;
}

export interface RunInfo {
	schema: number;
	run_id: string;
	skill: string;
	topic: string;
	request_text: string;
	workdir: string;
	artifact_dir: string;
	language_tag: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	/** Durable run-level notices (plan lint warnings etc.). Absent on older
	 * run.json files — read as []. */
	notices?: RunNotice[];
}

export interface ActiveInfo {
	run_id: string;
	run_dir: string;
	artifact_dir: string;
}

/** Lightweight registry view of one run (RunInfo minus the heavy fields). */
export interface RunSummary {
	run_id: string;
	topic: string;
	skill: string;
	status: string;
	created_at: string;
	updated_at: string;
	artifact_dir: string;
}

/** Terminal statuses: a run that can no longer be resumed or guarded. */
export const TERMINAL_RUN_STATUSES = new Set(["abandoned", "done"]);

function summarize(run: RunInfo): RunSummary {
	return {
		run_id: run.run_id,
		topic: run.topic,
		skill: run.skill,
		status: run.status,
		created_at: run.created_at,
		updated_at: run.updated_at,
		artifact_dir: run.artifact_dir,
	};
}

/**
 * Filesystem-derived run registry (v0.6.0): scans `<stateRoot>/runs/<runId>/run.json`
 * and returns summaries sorted by `updated_at` desc (ties go to run_id desc so the
 * newest-created run wins within one timestamp tick). Corrupt or partial run
 * dirs are skipped, never thrown. This replaces the racy shared `active.json`
 * pointer: there is no new shared mutable file, and per-run files are written
 * only by the flow that owns the run.
 */
export function listRuns(workdir: string): RunSummary[] {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return [];
	const runsRoot = path.join(stateRoot, "runs");
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(runsRoot);
	} catch {
		return [];
	}
	const summaries: Array<RunSummary & { mtimeMs: number }> = [];
	for (const entry of entries) {
		const runPath = path.join(runsRoot, entry, "run.json");
		if (!existsSync(runPath)) continue;
		try {
			const run = JSON.parse(readFileSync(runPath, "utf8")) as RunInfo;
			if (typeof run?.run_id !== "string" || typeof run?.status !== "string") continue;
			// utcNow() has second precision: same-second runs tie on updated_at, so
			// the per-run run.json mtime (written only by the owning flow) is the
		// race-free recency tie-break.
			summaries.push({ ...summarize(run), mtimeMs: Number(fs.statSync(runPath, { bigint: true }).mtimeNs) / 1e6 });
	} catch {
			/* corrupt run.json: skip, never fail the registry scan */
		}
	}
	summaries.sort((a, b) =>
		a.updated_at === b.updated_at
			? a.mtimeMs === b.mtimeMs
				? (a.run_id < b.run_id ? 1 : -1)
				: b.mtimeMs - a.mtimeMs
			: a.updated_at < b.updated_at ? 1 : -1,
	);
	return summaries.map(({ mtimeMs: _mtimeMs, ...summary }) => summary);
}

/** The newest non-terminal run (planning/accepted/executing/stopped), or null. */
export function newestNonTerminalRun(workdir: string): RunSummary | null {
	return listRuns(workdir).find((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? null;
}

/** The newest run of ANY status — display-only (status widget), never attribution. */
export function latestRun(workdir: string): RunSummary | null {
	return listRuns(workdir)[0] ?? null;
}

function activeInfoFromSummary(stateRoot: string, run: RunSummary): ActiveInfo {
	return {
		run_id: run.run_id,
		run_dir: path.join(stateRoot, "runs", run.run_id),
		artifact_dir: run.artifact_dir,
	};
}

export interface DecisionEntry {
	question: string;
	options: string[];
	answer: string;
	answer_source: "user" | "auto-complete";
	artifact?: string;
	/** Stable question id when the ask_choice call carried one (F-005 reconcile). */
	questionId?: string;
	recorded_at: string;
}

export interface RefEntry {
	title: string;
	url: string;
	kind: string;
	retrieval: string;
	local_path?: string;
	coverage?: string;
	gaps?: string;
	recorded_at: string;
}

export interface SubagentEntry {
	role: "reviewer" | "criticizer" | "ref-analyst";
	name: string;
	model?: string | null;
	/** Thinking level actually passed to the child ("--thinking"); null or
	 * absent = default chain (v0.7.0). Older entries remain readable. */
	thinking_level?: string | null;
	session_dir?: string;
	/** I-010: aggregated child usage (tokens/cost) recorded after the run. */
	usage?: { input: number; output: number; cache_read: number; cache_write: number; cost: number } | null;
	recorded_at: string;
}

// ---------------------------------------------------------------------------
// Git resolution
// ---------------------------------------------------------------------------

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function runGit(workdir: string, ...args: string[]): GitResult {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of GIT_ENV_SCRUB) delete env[key];
	const result = spawnSync("git", args, { cwd: workdir, env, encoding: "utf8" });
	if (result.error) {
		throw new StateError("git executable not found; pi-plans state requires git");
	}
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function resolveGitCommonDir(workdir: string): string | null {
	const result = runGit(workdir, "rev-parse", "--git-common-dir");
	if (result.code !== 0) return null;
	const raw = result.stdout.trim();
	if (!raw) return null;
	return path.resolve(workdir, raw);
}

function ensureNotBare(workdir: string): void {
	const result = runGit(workdir, "rev-parse", "--is-bare-repository");
	if (result.code === 0 && result.stdout.trim() === "true") {
		throw new StateError("pi-plans state is not supported in bare repositories");
	}
}

export function normalizeWorkdir(value: string): string {
	const expanded = value === "~" || value.startsWith("~/")
		? path.join(os.homedir(), value.slice(1))
		: value;
	return path.resolve(expanded);
}

/**
 * Resolve the git common dir, auto-initializing a repo when safe.
 * Auto-init only runs when the workdir has no `.git` entry AND is not inside
 * any work tree AND is not the home directory or filesystem root.
 */
export function ensureGitRepo(workdir: string, notices: string[]): string {
	const common = resolveGitCommonDir(workdir);
	if (common !== null) {
		ensureNotBare(workdir);
		return common;
	}
	if (existsSync(path.join(workdir, ".git"))) {
		throw new StateError(
			`${workdir} has a .git entry but git cannot resolve it; repair or remove it before running pi-plans`,
		);
	}
	const inside = runGit(workdir, "rev-parse", "--is-inside-work-tree");
	if (inside.code === 0 && inside.stdout.trim() === "true") {
		throw new StateError("git resolution failed despite being inside a work tree; check your git setup");
	}
	if (path.resolve(workdir) === path.resolve(os.homedir()) || path.dirname(path.resolve(workdir)) === path.resolve(workdir)) {
		throw new StateError(
			"refusing to auto-initialize a git repository in the home directory or filesystem root; pass a project workdir",
		);
	}
	notices.push(`no git repository found in ${workdir}; ran git init to store state`);
	const init = runGit(workdir, "init");
	if (init.code !== 0) {
		throw new StateError(`git init failed in ${workdir}: ${init.stderr.trim()}`);
	}
	const created = resolveGitCommonDir(workdir);
	if (created === null) throw new StateError("git init succeeded but git dir resolution still fails");
	return created;
}

/** Read-only state root resolution; returns null when no repo exists. */
export function resolveStateRootOrNull(workdir: string): string | null {
	const common = resolveGitCommonDir(workdir);
	if (common === null) return null;
	return path.join(common, STATE_DIRNAME);
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function atomicWriteJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	renameSync(tmp, filePath);
}

function deepMergeDefaults<T>(data: T, defaults: T): T {
	const merged: Record<string, unknown> = { ...(data as Record<string, unknown>) };
	for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
		if (!(key in merged)) {
			merged[key] = value;
		} else if (value && typeof value === "object" && !Array.isArray(value) &&
			merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
			merged[key] = deepMergeDefaults(merged[key], value);
		}
	}
	return merged as T;
}

export function loadConfig(stateRoot: string): PlansConfig {
	const configPath = path.join(stateRoot, "config.json");
	if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new StateError(`invalid config.json: ${(error as Error).message}`);
	}
	const merged = deepMergeDefaults(data as LegacyPlansConfig, DEFAULT_CONFIG as LegacyPlansConfig);
	return normalizeLegacyKeys(normalizeArtifactRoot(merged as PlansConfig));
}

/** Strip ignored legacy keys (`execution`, `criticizer`) from a loaded
 * config. The criticizer role was removed in v0.6.1 — the reviewer now
 * carries the questioning duty — so its block is dropped on read and a
 * migration notice is surfaced when the caller has a notices channel. */
function normalizeLegacyKeys(config: LegacyPlansConfig): PlansConfig {
	const { execution: _execution, criticizer: _criticizer, ...rest } = config;
	return rest as PlansConfig;
}

/** True when the on-disk config still carries the removed `criticizer`
 * role block (v0.6.0 and earlier). Callers surface a one-time migration
 * notice; the next config write persists the trimmed shape. */
export function configHasLegacyCriticizer(stateRoot: string): boolean {
	const configPath = path.join(stateRoot, "config.json");
	if (!existsSync(configPath)) return false;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		return Object.hasOwn(raw, "criticizer");
	} catch {
		return false;
	}
}

export const CRITICIZER_MIGRATION_NOTICE =
	"config.json 仍含已移除的 criticizer 角色块（v0.6.1 起 reviewer 同轮输出 findings+questions，criticizer 已合并）：读入时忽略该键，下次写配置时自动落盘为单 reviewer 形状";

function noticeIfSubdir(workdir: string, notices: string[]): void {
	const result = runGit(workdir, "rev-parse", "--show-toplevel");
	if (result.code !== 0) return;
	const top = path.resolve(result.stdout.trim());
	if (top !== path.resolve(workdir)) {
		notices.push(`storing state in enclosing repository ${top}`);
	}
}

export interface EnsureResult {
	config: PlansConfig;
	stateRoot: string;
	notices: string[];
}

function ensureState(workdir: string): EnsureResult {
	const notices: string[] = [];
	const common = ensureGitRepo(workdir, notices);
	const stateRoot = path.join(common, STATE_DIRNAME);
	for (const sub of ["runs", "tmp", "cache"]) {
		mkdirSync(path.join(stateRoot, sub), { recursive: true });
	}
	noticeIfSubdir(workdir, notices);
	if (configHasLegacyCriticizer(stateRoot)) notices.push(CRITICIZER_MIGRATION_NOTICE);
	const config = loadConfig(stateRoot);
	migrateLegacyReviewer(config, notices);
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
}

/** Migrate the legacy workspace reviewer block (v0.6.x) into the global
 * config — the single source of truth since v0.7.0. Runs ONLY inside
 * mutating state calls (ensureState): read paths resolve the effective
 * reviewer in memory and never write (F-001).
 *
 * Rules (Q-1=A):
 * - no legacy block → nothing to do;
 * - legacy block with user intent (confirmed, explicit selector, or
 *   non-default mode) + missing global file → seed the global file once
 *   (first touched workspace wins); a confirmed-inherit block seeds with
 *   model_selector null and NO confirmation (re-asked once via the panel);
 * - legacy block with intent + existing global file → one-time "ignored"
 *   notice (the global config wins);
 * - scaffold-only block (pure defaults) → dropped silently;
 * - corrupt global file → never seeded over; the corrupt-file notice from
 *   loadGlobalConfig is surfaced by the caller.
 *
 * In every case the workspace key is stripped from the config before the
 * caller writes it back. */
function migrateLegacyReviewer(config: PlansConfig, notices: string[]): void {
	if (config.reviewer === undefined) return;
	const legacy = config.reviewer;
	const globalPath = resolveGlobalConfigPath();
	if (legacyReviewerHasUserIntent(legacy)) {
		const global = loadGlobalConfig();
		if (global.fresh && !global.corrupt) {
			const seeded = seedGlobalRoleFromLegacy(legacy);
			writeGlobalConfigSafe({ schema: 1, reviewer: seeded.role }, notices);
			notices.push(globalMigratedNotice(globalPath));
			notices.push(...seeded.notices);
		} else {
			notices.push(globalIgnoredNotice(globalPath));
		}
	}
	delete config.reviewer;
}

/** Best-effort global write inside migration: a failure to persist must not
 * break the workspace state write (the effective reviewer falls back to the
 * in-memory legacy block on read paths until the global file exists). */
function writeGlobalConfigSafe(config: GlobalConfig, notices: string[]): void {
	try {
		writeGlobalConfig(config);
	} catch (error) {
		notices.push(`failed to write global config (${(error as Error).message}); reviewer migration skipped — will retry on the next mutating call`);
	}
}

export function initState(workdir: string): EnsureResult {
	return ensureState(workdir);
}

/** Read-only config dump; never creates state. */
export function showConfig(workdir: string): PlansConfig {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null || !existsSync(path.join(stateRoot, "config.json"))) {
		throw new StateError("no pi-plans state found; run the plans tool with action \"init\" first");
	}
	return loadConfig(stateRoot);
}

export interface StateView {
	config: PlansConfig;
	stateRoot: string | null;
	/** Effective reviewer role: global config first, then the legacy
	 * workspace block (read-only compat), then defaults. */
	reviewer: GlobalRoleConfig;
	globalRoot: string;
	globalConfigPath: string;
	notices: string[];
}

/** Composite read-only view for the `plans show` action: workspace config +
 * effective global reviewer + diagnostics. Never writes (F-001: read paths
 * resolve the effective reviewer in memory only). */
export function showStateView(workdir: string): StateView {
	const stateRoot = resolveStateRootOrNull(workdir);
	const config =
		stateRoot !== null && existsSync(path.join(stateRoot, "config.json")) ? loadConfig(stateRoot) : null;
	const global = loadGlobalConfig();
	const notices = [...global.notices];
	let reviewer = global.config.reviewer;
	if (global.fresh && config?.reviewer !== undefined) {
		// Global never configured: fall back to the legacy workspace block so
		// read-only consumers (gates, show) see the pre-migration intent.
		const legacy = seedGlobalRoleFromLegacy(config.reviewer);
		reviewer = legacy.role;
		notices.push(...legacy.notices);
		notices.push(
			`reviewer not yet migrated to the global config; showing the workspace block (${resolveGlobalConfigPath()}) — the next mutating pi-plans call migrates it`,
		);
	}
	return {
		config: config ?? structuredClone(DEFAULT_CONFIG),
		stateRoot,
		reviewer,
		globalRoot: resolveGlobalDir(),
		globalConfigPath: resolveGlobalConfigPath(),
		notices,
	};
}

/** Effective reviewer for read-only gates (refine / analyze_refs): global
 * config first; before migration, the legacy workspace block still counts
 * (in memory — never written). */
export function resolveEffectiveReviewer(stateRoot: string): { reviewer: GlobalRoleConfig; notices: string[] } {
	const global = loadGlobalConfig();
	if (!global.fresh) return { reviewer: global.config.reviewer, notices: global.notices };
	if (existsSync(path.join(stateRoot, "config.json"))) {
		const config = loadConfig(stateRoot);
		if (config.reviewer !== undefined) {
			const legacy = seedGlobalRoleFromLegacy(config.reviewer);
			return { reviewer: legacy.role, notices: [...global.notices, ...legacy.notices] };
		}
	}
	return { reviewer: structuredClone(DEFAULT_GLOBAL_CONFIG).reviewer, notices: global.notices };
}

export function setLanguage(workdir: string, tag: string, source: "user" | "auto"): EnsureResult {
	const { config, stateRoot, notices } = ensureState(workdir);
	config.language = { tag, source, updated_at: utcNow() };
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
}

export function setArtifactRoot(workdir: string, artifactRoot: string, source: "user" | "auto"): EnsureResult {
	const { config, stateRoot, notices } = ensureState(workdir);
	config.artifact_root = artifactRoot;
	config.artifact_root_source = source;
	config.artifact_root_updated_at = utcNow();
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
}

export function setRefsRoot(workdir: string, refsRoot: string, source: "user" | "auto"): EnsureResult {
	const { config, stateRoot, notices } = ensureState(workdir);
	config.refs_root = refsRoot;
	config.refs_root_source = source;
	config.refs_root_updated_at = utcNow();
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
}

export function setGraphEnabled(workdir: string, enabled: boolean): EnsureResult {
	const { config, stateRoot, notices } = ensureState(workdir);
	config.graph_enabled = enabled;
	config.graph_enabled_updated_at = utcNow();
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
}

export interface SetRoleOptions extends SetGlobalRoleOptions {
	role: "reviewer";
}

export interface SetRoleResult {
	/** The updated global config (source of truth for the reviewer role). */
	global: GlobalConfig;
	globalRoot: string;
	/** Load-time diagnostics from the global file. */
	notices: string[];
	/** Read-only workspace snapshot (null outside a repo or when the
	 * workspace config is unusable — global writes never auto-init). */
	config: PlansConfig | null;
	stateRoot: string | null;
}

/** Set the reviewer role in the GLOBAL config (`~/.pi/pi-plans/config.json`,
 * overridable via PI_PLANS_GLOBAL_DIR). Since v0.7.0 this never touches
 * workspace state and never triggers auto git-init (F-013); a legacy
 * workspace reviewer key is opportunistically stripped when workspace state
 * already exists. */
export function setRole(workdir: string, options: SetRoleOptions): SetRoleResult {
	try {
		const applied = setGlobalRole(options);
		const stateRoot = resolveStateRootOrNull(workdir);
		let config: PlansConfig | null = null;
		if (stateRoot !== null && existsSync(path.join(stateRoot, "config.json"))) {
			try {
				const workspace = loadConfig(stateRoot);
				if (workspace.reviewer !== undefined) {
					delete workspace.reviewer;
					atomicWriteJson(path.join(stateRoot, "config.json"), workspace);
				}
				config = workspace;
			} catch {
				/* corrupt workspace config: strip skipped, global write still wins */
			}
		}
		return {
			global: applied.global,
			globalRoot: resolveGlobalDir(),
			notices: applied.notices,
			config,
			stateRoot,
		};
	} catch (error) {
		if (error instanceof GlobalStateError) throw new StateError(error.message);
		throw error;
	}
}

export function updateConfig(workdir: string, updater: (config: PlansConfig) => PlansConfig): EnsureResult {
	const { config, stateRoot, notices } = ensureState(workdir);
	const next = updater(structuredClone(config));
	atomicWriteJson(path.join(stateRoot, "config.json"), next);
	return { config: next, stateRoot, notices };
}

// ---------------------------------------------------------------------------

const SLUG_RE = /[^a-z0-9]+/g;

export function slugify(topic: string): string {
	const slug = topic.toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "");
	return slug.slice(0, 80) || "planning-run";
}

export interface StartRunOptions {
	topic: string;
	skill: string;
	requestText: string;
	onStart?: (run: RunInfo) => void;
}

export interface StartRunResult {
	run: RunInfo;
	notices: string[];
}

/**
 * Resolve a configured artifact root to an absolute directory.
 *
 * A leading `.git/` segment resolves against the git *common* dir rather than
 * the workdir: in a linked worktree `<workdir>/.git` is a file holding a
 * `gitdir:` pointer, not a directory, so the naive `path.resolve(workdir,
 * root)` would not name a usable path there. The default artifact root lives
 * under `.git/`, so this is the common path, not an edge case.
 */
export function resolveArtifactRoot(workdir: string, artifactRoot: string): string {
	if (path.isAbsolute(artifactRoot)) return artifactRoot;
	const rel = artifactRoot.replace(/^\.\//, "");
	if (rel === ".git" || rel.startsWith(`.git${path.sep}`) || rel.startsWith(".git/")) {
		const common = resolveGitCommonDir(workdir);
		if (common !== null) return path.join(common, rel.slice(".git".length).replace(/^[/\\]+/, ""));
	}
	return path.resolve(workdir, artifactRoot);
}

export function startRun(workdir: string, options: StartRunOptions): StartRunResult {
	const { config, stateRoot, notices } = ensureState(workdir);
	const now = utcNow();
	const stamp = now.replace(/[-:]/g, "");
	const topicSlug = slugify(options.topic);
	const baseRunId = `${stamp}-${topicSlug}`;
	let runId = baseRunId;
	let suffix = 2;
	while (existsSync(path.join(stateRoot, "runs", runId))) {
		runId = `${baseRunId}-${suffix}`;
		suffix += 1;
	}
	const artifactRoot = resolveArtifactRoot(workdir, config.artifact_root ?? DEFAULT_ARTIFACT_ROOT);
	const dateSlug = now.slice(0, 10);
	const baseArtifactDir = path.join(artifactRoot, `${dateSlug}-${topicSlug}`);
	// v0.6.0: same-topic runs on the same day (concurrent sessions) must not
	// share an artifact directory — suffix until unused, mirroring the run-id loop.
	let artifactDir = baseArtifactDir;
	let artifactSuffix = 2;
	while (existsSync(artifactDir)) {
		artifactDir = `${baseArtifactDir}-${artifactSuffix}`;
		artifactSuffix += 1;
	}
	const runDir = path.join(stateRoot, "runs", runId);
	mkdirSync(runDir, { recursive: true });
	mkdirSync(artifactDir, { recursive: true });
	const run: RunInfo = {
		schema: 1,
		run_id: runId,
		skill: options.skill,
		topic: topicSlug,
		request_text: options.requestText,
		workdir: path.resolve(workdir),
		artifact_dir: artifactDir,
		language_tag: config.language.tag ?? null,
		status: "planning",
		created_at: now,
		updated_at: now,
	};
	atomicWriteJson(path.join(runDir, "run.json"), run);
	for (const name of ["decisions.jsonl", "subagents.jsonl", "refs.jsonl"]) {
		const ledger = path.join(runDir, name);
		if (!existsSync(ledger)) writeFileSync(ledger, "", "utf8");
	}
	// v0.6.0: the shared active.json pointer is no longer written — the run
	// registry is derived from runs/*/run.json (race-free across sessions).
	if (options.onStart) {
		try {
			options.onStart(run);
		} catch {
			/* marker failure is non-fatal: planning start should not abort when the entry appender rejects */
		}
	}
	return { run, notices };
}

/**
 * v0.6.0 registry-backed resolution (replaces the shared `active.json`
 * pointer): the newest NON-TERMINAL run, or null when every run is terminal.
 * Legacy fallback: when the scan finds zero runs but a pre-0.6.0 `active.json`
 * exists, honor it once (one-release migration shim; deprecation is surfaced
 * on the `/plans` and `/resume-plans` command surfaces, not here — this is a
 * read-only hot path with no notices channel).
 */
export function readActive(workdir: string): ActiveInfo | null {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return null;
	const newest = newestNonTerminalRun(workdir);
	if (newest !== null) return activeInfoFromSummary(stateRoot, newest);
	const activePath = path.join(stateRoot, "active.json");
	if (!existsSync(activePath)) return null;
	try {
		return JSON.parse(readFileSync(activePath, "utf8")) as ActiveInfo;
	} catch {
		return null;
	}
}

export function getRun(workdir: string, runId: string): RunInfo | null {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return null;
	const runPath = path.join(stateRoot, "runs", runId, "run.json");
	if (!existsSync(runPath)) return null;
	try {
		return JSON.parse(readFileSync(runPath, "utf8")) as RunInfo;
	} catch {
		return null;
	}
}

function appendJsonl(filePath: string, entry: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function requireRunDir(workdir: string, runId: string): string {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) throw new StateError("no pi-plans state found; run init first");
	const runDir = path.join(stateRoot, "runs", runId);
	if (!existsSync(runDir)) throw new StateError(`run does not exist: ${runId}`);
	return runDir;
}

/** Read-only run directory resolution; returns null when the run does not exist. */
export function runDirPath(workdir: string, runId: string): string | null {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return null;
	const runDir = path.join(stateRoot, "runs", runId);
	return existsSync(runDir) ? runDir : null;
}

export function recordDecision(workdir: string, runId: string, entry: Omit<DecisionEntry, "recorded_at">): DecisionEntry {
	const runDir = requireRunDir(workdir, runId);
	const full: DecisionEntry = { ...entry, recorded_at: utcNow() };
	appendJsonl(path.join(runDir, "decisions.jsonl"), full);
	return full;
}

export function recordRef(workdir: string, runId: string, entry: Omit<RefEntry, "recorded_at">): RefEntry {
	const runDir = requireRunDir(workdir, runId);
	const full: RefEntry = { ...entry, recorded_at: utcNow() };
	appendJsonl(path.join(runDir, "refs.jsonl"), full);
	return full;
}

export function recordSubagent(workdir: string, runId: string, entry: Omit<SubagentEntry, "recorded_at">): SubagentEntry {
	const runDir = requireRunDir(workdir, runId);
	const full: SubagentEntry = { ...entry, recorded_at: utcNow() };
	appendJsonl(path.join(runDir, "subagents.jsonl"), full);
	return full;
}

/** Update a run's recorded workdir (cross-worktree migration, D-007). */
export function updateRunWorkdir(workdir: string, runId: string, newWorkdir: string): RunInfo {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) throw new StateError("no pi-plans state found; run init first");
	const runPath = path.join(stateRoot, "runs", runId, "run.json");
	if (!existsSync(runPath)) throw new StateError(`run does not exist: ${runId}`);
	const run = JSON.parse(readFileSync(runPath, "utf8")) as RunInfo;
	run.workdir = path.resolve(newWorkdir);
	run.updated_at = utcNow();
	atomicWriteJson(runPath, run);
	return run;
}

/** Append a durable run notice (dedupe by source+text); advisory, never
 * throws — notices are diagnostics, not control flow. Returns the run when a
 * notice was written or already present. */
export function appendRunNotice(workdir: string, runId: string, notice: Omit<RunNotice, "created_at">): RunInfo | null {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return null;
	const runPath = path.join(stateRoot, "runs", runId, "run.json");
	if (!existsSync(runPath)) return null;
	try {
		const run = JSON.parse(readFileSync(runPath, "utf8")) as RunInfo;
		const notices = run.notices ?? [];
		if (notices.some((n) => n.source === notice.source && n.text === notice.text)) return run;
		run.notices = [...notices, { ...notice, created_at: utcNow() }];
		run.updated_at = utcNow();
		atomicWriteJson(runPath, run);
		return run;
	} catch {
		return null;
	}
}

/** Lint a plan file's Implementation Items and persist a warning notice on
 * the run when the section parses to zero items. Shared by the three lint
 * entry points (plan-written checkpoint, execute handoff, auto apply). */
export function lintPlanIntoNotices(workdir: string, runId: string, planPath: string): string | null {
	let text: string | null = null;
	const parts: string[] = [];
	const sources: string[] = [];
	try {
		const planText = readFileSync(planPath, "utf8");
		const implLint = lintImplItems(planText);
		const taskLint = lintPlanTasks(planText);
		if (implLint !== null) {
			parts.push(implLint);
			sources.push("lint-impl-items");
		}
		if (taskLint !== null) {
			parts.push(taskLint);
			sources.push("lint-plan-tasks");
		}
	} catch {
		return null;
	}
	if (parts.length === 0) return null;
	text = parts.join("\n");
	appendRunNotice(workdir, runId, { kind: "plan-lint", source: sources.join("+"), text });
	return text;
}

export function setRunStatus(workdir: string, runId: string, status: string): RunInfo {
	if (!VALID_RUN_STATUSES.has(status)) {
		throw new StateError(`status must be one of ${[...VALID_RUN_STATUSES].join(", ")}`);
	}
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) throw new StateError("no pi-plans state found; run init first");
	const runPath = path.join(stateRoot, "runs", runId, "run.json");
	if (!existsSync(runPath)) throw new StateError(`run does not exist: ${runId}`);
	const run = JSON.parse(readFileSync(runPath, "utf8")) as RunInfo;
	run.status = status;
	run.updated_at = utcNow();
	atomicWriteJson(runPath, run);
	return run;
}
