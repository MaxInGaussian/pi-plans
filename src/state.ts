/**
 * pi-plans workspace state, persisted under <git-common-dir>/pi_plans/.
 *
 * State lives inside the resolved git common dir (`git rev-parse
 * --git-common-dir`) as `.git/pi_plans/`, so it is never tracked and needs no
 * .gitignore rules. When the workdir is not a git repository, mutating
 * functions auto-run `git init` (never commits) under the same safety
 * conditions as the original helper.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STATE_DIRNAME = "pi_plans";
const GIT_ENV_SCRUB = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"];

export class StateError extends Error {}

export type SettingSource = "user" | "auto" | "unset";

export interface LanguageConfig {
	tag: string | null;
	source: SettingSource;
	updated_at: string | null;
}

export interface RoleConfig {
	mode: string;
	model_selector: string | null;
	name_prefix: string;
	confirmed_at: string | null;
}


export interface PlansConfig {
	schema: number;
	language: LanguageConfig;
	reviewer: RoleConfig;
	criticizer: RoleConfig;
	artifact_root: string;
	artifact_root_source: SettingSource;
	artifact_root_updated_at: string | null;
}

const DEFAULT_ARTIFACT_ROOT = "./docs/pi-plans";
const LEGACY_ARTIFACT_ROOTS = new Set(["docs/plans", "./docs/plans"]);

function normalizeArtifactRoot(config: PlansConfig): PlansConfig {
	if (LEGACY_ARTIFACT_ROOTS.has(config.artifact_root)) {
		return { ...config, artifact_root: DEFAULT_ARTIFACT_ROOT };
	}
	return config;
}

type LegacyPlansConfig = PlansConfig & { execution?: unknown };

function normalizeLegacyExecutionConfig(config: LegacyPlansConfig): PlansConfig {
	const { execution: _execution, ...rest } = config;
	return rest as PlansConfig;
}

export const DEFAULT_CONFIG: PlansConfig = {
	schema: 1,
	language: { tag: null, source: "unset", updated_at: null },
	reviewer: {
		mode: "delegated-subagent",
		model_selector: null,
		name_prefix: "pi-plans-reviewer",
		confirmed_at: null,
	},
	criticizer: {
		mode: "delegated-subagent",
		model_selector: null,
		name_prefix: "pi-plans-criticizer",
		confirmed_at: null,
	},
	artifact_root: DEFAULT_ARTIFACT_ROOT,
	artifact_root_source: "unset",
	artifact_root_updated_at: null,
};

export const VALID_ROLE_MODES = new Set(["delegated-subagent", "current-session"]);
export const VALID_RUN_STATUSES = new Set([
	"planning",
	"accepted",
	"executing",
	"stopped",
	"abandoned",
	"done",
]);

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
}

export interface ActiveInfo {
	run_id: string;
	run_dir: string;
	artifact_dir: string;
}

export interface DecisionEntry {
	question: string;
	options: string[];
	answer: string;
	answer_source: "user" | "auto-complete";
	artifact?: string;
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
	role: "reviewer" | "criticizer";
	name: string;
	model?: string | null;
	session_dir?: string;
	recorded_at: string;
}

/** Test hook so tests can pin the clock (run-id dedup etc.). */
export const testHooks: { now: () => Date } = { now: () => new Date() };

export function utcNow(): string {
	return testHooks.now().toISOString().replace(/\.\d{3}Z$/, "Z");
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

function atomicWriteJson(filePath: string, data: unknown): void {
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
	return normalizeLegacyExecutionConfig(normalizeArtifactRoot(merged as PlansConfig));
}

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
	const config = loadConfig(stateRoot);
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
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


export interface SetRoleOptions {
	role: "reviewer" | "criticizer";
	mode?: string;
	modelSelector?: string; // exact "provider/model" selector, or "inherit" to reset
	confirmed?: boolean;
	resetConfirmation?: boolean;
}

export function setRole(workdir: string, options: SetRoleOptions): EnsureResult {
	if (options.mode !== undefined && !VALID_ROLE_MODES.has(options.mode)) {
		throw new StateError(`mode must be one of ${[...VALID_ROLE_MODES].sort().join(", ")}`);
	}
	if (options.confirmed && options.resetConfirmation) {
		throw new StateError("confirmed and resetConfirmation are mutually exclusive");
	}
	const { config, stateRoot, notices } = ensureState(workdir);
	const role: RoleConfig = { ...DEFAULT_CONFIG[options.role], ...(config[options.role] as RoleConfig | undefined) };
	if (options.mode !== undefined) role.mode = options.mode;
	if (options.modelSelector !== undefined) {
		role.model_selector = options.modelSelector === "inherit" ? null : options.modelSelector;
	}
	if (options.confirmed) role.confirmed_at = utcNow();
	if (options.resetConfirmation) role.confirmed_at = null;
	config[options.role] = role;
	atomicWriteJson(path.join(stateRoot, "config.json"), config);
	return { config, stateRoot, notices };
}

// ---------------------------------------------------------------------------
// Runs
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
	let artifactRoot = config.artifact_root ?? DEFAULT_ARTIFACT_ROOT;
	if (!path.isAbsolute(artifactRoot)) artifactRoot = path.resolve(workdir, artifactRoot);
	const dateSlug = now.slice(0, 10);
	const artifactDir = path.join(artifactRoot, `${dateSlug}-${topicSlug}`);
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
	atomicWriteJson(path.join(stateRoot, "active.json"), {
		run_id: runId,
		run_dir: runDir,
		artifact_dir: artifactDir,
	} satisfies ActiveInfo);
	if (options.onStart) {
		try {
			options.onStart(run);
		} catch {
			/* marker failure is non-fatal: planning start should not abort when the entry appender rejects */
		}
	}
	return { run, notices };
}

/** Read the active run pointer; read-only, returns null when absent. */
export function readActive(workdir: string): ActiveInfo | null {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) return null;
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

export function refsCacheDir(): string {
	return path.join(os.homedir(), ".cache", "pi-plans", "refs");
}
