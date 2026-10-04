/**
 * Huge-plan artifact parsing for the `plan-huge` workflow.
 *
 * The huge workflow keeps one run and one flat artifact directory, but adds
 * two new plan-file shapes on top of the legacy `PLAN_vN.md`:
 *
 * - `PLAN_overall_vN.md` — the abstract overall plan (version table,
 *   architecture, file map, UX, final objective). It is never executable.
 * - `PLAN_vX.Y.Z_vN.md` — a per-version plan (`v0.1.0` … up to 10 versions),
 *   structured like a `plan-big` plan plus a `## Deferred to vX.Y.Z` ledger.
 *
 * In both shapes the trailing `vN` is the *revision round* of that stream;
 * the version label (`vX.Y.Z`) is part of the stream identity. The legacy
 * helpers in `./plan.ts` (`latestPlanVersion`, `nextPlanVersionPath`) are
 * deliberately left untouched and keep ignoring these names, so existing
 * runs and plans behave exactly as before.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type HugeStreamKind = "overall" | "version";

/** Stream id of the abstract overall plan. */
export const OVERALL_STREAM = "overall";

/** Minimum and maximum number of product versions in an overall plan. */
export const HUGE_MIN_VERSIONS = 2;
export const HUGE_MAX_VERSIONS = 10;

/** Minimum GitHub project references a version plan's Evidence section must
 * carry (the user-set range is 1–3). */
export const HUGE_MIN_GITHUB_REFS = 1;

export interface HugePlanFile {
	/** Absolute or artifact-dir-relative path as discovered. */
	path: string;
	/** `overall` for the abstract plan, else the version label (`v0.1.0`). */
	stream: string;
	kind: HugeStreamKind;
	/** Version label for version streams; undefined for the overall stream. */
	versionLabel?: string;
	/** Revision round parsed from the trailing `vN`. */
	round: number;
}

export interface HugeVersionRow {
	label: string;
	mission: string;
	done: string;
	minor: number;
	patch: number;
}

export interface DeferredEntry {
	/** Stable, version-scoped id (`D-v0.1.0-1`); never reused. */
	id: string;
	summary: string;
	reason: string;
}

export interface DeferredSection {
	/** Target version label, or null for `## Deferred to none`. */
	target: string | null;
	entries: DeferredEntry[];
}

const OVERALL_NAME_RE = /^PLAN_overall_v(\d+)\.(md|markdown)$/i;
const VERSION_NAME_RE = /^PLAN_(v0\.\d+\.\d+)_v(\d+)\.(md|markdown)$/i;
const VERSION_LABEL_RE = /^v0\.(\d+)\.(\d+)$/;
const DEFERRED_ID_RE = /^D-v0\.\d+\.\d+-\d+$/;

/** Parse a `vX.Y.Z` version label. `v0.Y.Z` with Y >= 1 (the first version
 * is `v0.1.0`); `Z` is a patch counter. Returns null for anything else. */
export function parseVersionLabel(label: string): { minor: number; patch: number } | null {
	const match = label.match(VERSION_LABEL_RE);
	if (!match) return null;
	const minor = Number(match[1]);
	const patch = Number(match[2]);
	if (minor < 1) return null;
	return { minor, patch };
}

/** Parse a huge plan file name (basename only). Returns null when the name
 * is not a huge plan (including the legacy `PLAN_vN.md` shape). */
export function parseHugePlanName(fileName: string): Omit<HugePlanFile, "path"> | null {
	const overall = fileName.match(OVERALL_NAME_RE);
	if (overall) {
		return { stream: OVERALL_STREAM, kind: "overall", round: Number(overall[1]) };
	}
	const version = fileName.match(VERSION_NAME_RE);
	if (version) {
		const label = version[1]!;
		if (!parseVersionLabel(label)) return null;
		return { stream: label, kind: "version", versionLabel: label, round: Number(version[2]) };
	}
	return null;
}

/** Parse a huge plan path. */
export function parseHugePlanPath(filePath: string): HugePlanFile | null {
	const parsed = parseHugePlanName(path.basename(filePath));
	if (!parsed) return null;
	return { path: filePath, ...parsed };
}

/** True when the path names an overall plan (`PLAN_overall_vN.md`). */
export function isOverallPlan(filePath: string): boolean {
	return parseHugePlanPath(filePath)?.kind === "overall";
}

/** Stream id of a huge plan path, or null when the path is not a huge plan. */
export function hugeStreamOf(filePath: string): string | null {
	return parseHugePlanPath(filePath)?.stream ?? null;
}

/** Canonical file name for a stream revision. */
export function hugePlanFileName(stream: string, round: number): string {
	return stream === OVERALL_STREAM ? `PLAN_overall_v${round}.md` : `PLAN_${stream}_v${round}.md`;
}

/** All huge plan files in an artifact directory, sorted by stream then round. */
export function listHugePlans(artifactDir: string): HugePlanFile[] {
	if (!fs.existsSync(artifactDir)) return [];
	const files: HugePlanFile[] = [];
	for (const name of fs.readdirSync(artifactDir)) {
		const parsed = parseHugePlanName(name);
		if (!parsed) continue;
		files.push({ path: path.join(artifactDir, name), ...parsed });
	}
	return files.sort((a, b) => (a.stream === b.stream ? a.round - b.round : a.stream.localeCompare(b.stream)));
}

/** True when the artifact directory holds at least one huge plan file. */
export function hasHugePlan(artifactDir: string): boolean {
	return latestHugePlansByStream(artifactDir).length > 0;
}

/** Highest round per stream in an artifact directory. */
export function latestHugePlansByStream(artifactDir: string): HugePlanFile[] {
	const best = new Map<string, HugePlanFile>();
	for (const file of listHugePlans(artifactDir)) {
		const current = best.get(file.stream);
		if (!current || file.round > current.round) best.set(file.stream, file);
	}
	return [...best.values()].sort((a, b) => a.stream.localeCompare(b.stream));
}

/** Latest revision of one stream, or null when the stream has no plan yet. */
export function latestHugePlan(artifactDir: string, stream: string): HugePlanFile | null {
	let best: HugePlanFile | null = null;
	for (const file of listHugePlans(artifactDir)) {
		if (file.stream !== stream) continue;
		if (!best || file.round > best.round) best = file;
	}
	return best;
}

/** Path of the next revision of a stream. `round` overrides the default
 * (latest round + 1) when a caller needs an explicit revision number. */
export function nextHugePlanPath(artifactDir: string, stream: string, round?: number): HugePlanFile {
	const latest = latestHugePlan(artifactDir, stream);
	const resolved = round ?? (latest?.round ?? 0) + 1;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error(`nextHugePlanPath: round must be a positive integer (got ${round})`);
	}
	const round_ = resolved;
	return {
		path: path.join(artifactDir, hugePlanFileName(stream, round_)),
		stream,
		kind: stream === OVERALL_STREAM ? "overall" : "version",
		versionLabel: stream === OVERALL_STREAM ? undefined : stream,
		round: round_,
	};
}

/** Version rows declared by the latest overall plan, or [] when none parse. */
export function readHugeVersionRows(artifactDir: string): HugeVersionRow[] {
	const overall = latestHugePlan(artifactDir, OVERALL_STREAM);
	if (!overall) return [];
	try {
		return parseVersionsTable(fs.readFileSync(overall.path, "utf8"));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// `## Versions` table
// ---------------------------------------------------------------------------

function sectionBody(planText: string, headerRe: RegExp): { header: string; lines: string[] } | null {
	const lines = planText.split("\n");
	const index = lines.findIndex((line) => headerRe.test(line.trim()));
	if (index < 0) return null;
	const body: string[] = [];
	for (let i = index + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i]!.trim())) break;
		body.push(lines[i]!);
	}
	return { header: lines[index]!, lines: body };
}

/** Split a row tail at the em-dash separator (`—`/`——`/`--`/`–`). */
function splitRowParts(text: string): string[] {
	return text.split(/\s+(?:——|—|--|–)\s+/);
}

/** Parse the `## Versions` table of an overall plan. Row grammar:
 * ``- `vX.Y.Z`: <mission> — done: <completion criterion>``. */
export function parseVersionsTable(planText: string): HugeVersionRow[] {
	const section = sectionBody(planText, /^##\s+Versions\s*$/);
	if (!section) return [];
	const rows: HugeVersionRow[] = [];
	for (const line of section.lines) {
		const match = line.match(/^\s*-\s+`?(v\d+\.\d+\.\d+)`?\s*[:：]\s*(.+)$/);
		if (!match) continue;
		const parsed = parseVersionLabel(match[1]!) ?? { minor: -1, patch: -1 };
		const parts = splitRowParts(match[2]!.trim());
		const doneIndex = parts.findIndex((part) => /^done\s*[:：]/i.test(part));
		const done = doneIndex >= 0 ? parts[doneIndex]!.replace(/^done\s*[:：]\s*/i, "").trim() : "";
		const mission = (doneIndex >= 0 ? parts.slice(0, doneIndex) : parts).join(" — ").trim();
		rows.push({ label: match[1]!, mission, done, minor: parsed.minor, patch: parsed.patch });
	}
	return rows;
}

/** Lint the `## Versions` table. Returns a message when the table is
 * missing or violates the contract (2–10 rows, first row `v0.1.0`, strictly
 * ascending `v0.Y.Z` labels, mission and `done:` clause on every row),
 * else null. */
export function lintVersionsTable(planText: string): string | null {
	const section = sectionBody(planText, /^##\s+Versions\s*$/);
	if (!section) return "缺少 `## Versions` 版本表";
	const rows = parseVersionsTable(planText);
	if (rows.length < HUGE_MIN_VERSIONS) return `版本表至少 ${HUGE_MIN_VERSIONS} 版（当前 ${rows.length} 版）`;
	if (rows.length > HUGE_MAX_VERSIONS) return `版本表最多 ${HUGE_MAX_VERSIONS} 版（当前 ${rows.length} 版）`;
	if (rows[0]!.label !== "v0.1.0") return `首版必须是 v0.1.0（当前 ${rows[0]!.label}）`;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (row.minor < 0) return `版本号必须是 v0.Y.Z（Y≥1）：${row.label}`;
		if (row.mission.length === 0) return `${row.label} 缺少使命描述`;
		if (row.done.length === 0) return `${row.label} 缺少 done: 完成判据`;
		if (i === 0) continue;
		const previous = rows[i - 1]!;
		if (row.minor < previous.minor || (row.minor === previous.minor && row.patch <= previous.patch)) {
			return `版本号必须严格升序：${previous.label} → ${row.label}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// `## Deferred to vX.Y.Z` ledger
// ---------------------------------------------------------------------------

/** Parse the deferred-work section of a version plan. Header grammar:
 * `## Deferred to v0.2.0` (or `## Deferred to none` for the last version).
 * Row grammar: ``- `D-v0.1.0-1`: <summary> — reason: <why>``. */
export function parseDeferredSection(planText: string): DeferredSection | null {
	const section = sectionBody(planText, /^##\s+Deferred to\s+.+$/);
	if (!section) return null;
	const targetRaw = section.header.replace(/^##\s+Deferred to\s+/i, "").trim().replace(/^`+|`+$/g, "");
	const target = /^none$/i.test(targetRaw) ? null : targetRaw;
	const entries: DeferredEntry[] = [];
	for (const line of section.lines) {
		const match = line.match(/^\s*-\s+`(D-[^`]+)`\s*[:：]\s*(.+)$/);
		if (!match) continue;
		const parts = splitRowParts(match[2]!.trim());
		const reasonIndex = parts.findIndex((part) => /^reason\s*[:：]/i.test(part));
		const reason = reasonIndex >= 0 ? parts[reasonIndex]!.replace(/^reason\s*[:：]\s*/i, "").trim() : "";
		const summary = (reasonIndex >= 0 ? parts.slice(0, reasonIndex) : parts).join(" — ").trim();
		entries.push({ id: match[1]!, summary, reason });
	}
	return { target, entries };
}

/** Ids of one version plan's deferred entries; ids are version-scoped and
 * must be unique and well formed (`D-vX.Y.Z-n`). */
export function deferredEntryIds(planText: string): string[] {
	const section = parseDeferredSection(planText);
	if (!section) return [];
	return section.entries.filter((entry) => DEFERRED_ID_RE.test(entry.id)).map((entry) => entry.id);
}

/** Lint a version plan's deferred ledger: well-formed, unique ids and a
 * reason on every row. Returns the first problem, or null. */
export function lintDeferredSection(planText: string): string | null {
	const section = parseDeferredSection(planText);
	if (!section) return null;
	const seen = new Set<string>();
	for (const entry of section.entries) {
		if (!DEFERRED_ID_RE.test(entry.id)) return `Deferred id 必须是 D-vX.Y.Z-n 形式：${entry.id}`;
		if (seen.has(entry.id)) return `Deferred id 重复：${entry.id}`;
		seen.add(entry.id);
		if (entry.summary.length === 0) return `${entry.id} 缺少摘要`;
		if (entry.reason.length === 0) return `${entry.id} 缺少 reason:`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Evidence section (GitHub project references)
// ---------------------------------------------------------------------------

/** GitHub project URLs cited in a plan's `## Evidence` section (deduped,
 * insertion order). A plan without the section yields []. */
export function githubEvidenceUrls(planText: string): string[] {
	const section = sectionBody(planText, /^##\s+Evidence\s*$/);
	if (!section) return [];
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const line of section.lines) {
		for (const match of line.matchAll(/https?:\/\/github\.com\/[^\s)>\]`"']+/gi)) {
			const url = match[0].replace(/[.,;:]+$/, "");
			if (seen.has(url)) continue;
			seen.add(url);
			urls.push(url);
		}
	}
	return urls;
}

/** Lint a version plan's Evidence section against the configured minimum
 * (1–3 GitHub references, at least `min`). Returns a message when fewer are
 * cited — a run notice, never a hard block. */
export function githubEvidenceLint(planText: string, min = HUGE_MIN_GITHUB_REFS): string | null {
	const urls = githubEvidenceUrls(planText);
	if (urls.length >= min) return null;
	return `Evidence 段只有 ${urls.length} 个 GitHub 开源项目引用（期望 ${min}–3 个）：每版计划应引用 1–3 个相关项目`;
}
