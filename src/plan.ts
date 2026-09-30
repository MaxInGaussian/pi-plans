/** Plan artifact parsing: verifier checklist extraction and [DONE:VC-xxx] markers,
 * plus the v0.6.1 task-tree model (`## Tasks` + `## Verification Checks`). */

import * as fs from "node:fs";

export interface CheckItem {
	id: string;
	text: string;
	done: boolean;
}

/** Checklist section header names: the v0.6.1 canonical name and the
 * legacy alias accepted for fallback parsing of older artifacts. */
export const CHECKLIST_HEADERS = ["Verification Checks", "Verifier Checklist"] as const;

/** Parse the `## Verification Checks` (v0.6.1) or legacy `## Verifier
 * Checklist` section of a PLAN_vN.md into items. */
export function parseChecklist(planText: string): CheckItem[] {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+(?:Verification Checks|Verifier Checklist)\s*$/.test(line.trim()));
	if (headerIndex < 0) return [];
	const items: CheckItem[] = [];
	const seen = new Set<string>();
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line.trim())) break; // next section ends the checklist
		const match = line.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/);
		if (!match) continue;
		const idMatch = match[2].match(/`(VC-\d+)`/) ?? match[2].match(/\b(VC-\d+)\b/);
		if (!idMatch) continue;
		const id = idMatch[1];
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ id, text: match[2].trim(), done: match[1].toLowerCase() === "x" });
	}
	return items;
}

export interface ImplItem {
	id: string;
	text: string;
}

/**
 * Parse the `## Implementation Items` section of a PLAN_vN.md. Tolerant
 * grammar: TOP-LEVEL bullets only (no leading indentation — nested
 * sub-lists are ignored) with the backticked id followed by a half-width
 * `:`, a full-width `：`, or at least one space of plain separation.
 * Multi-line bodies are ignored (text stops at end of the first line).
 */
export function parseImplItems(planText: string): ImplItem[] {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+Implementation Items\s*$/.test(line.trim()));
	if (headerIndex < 0) return [];
	const items: ImplItem[] = [];
	const seen = new Set<string>();
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line.trim())) break; // next section ends the items
		const match = line.match(/^-\s+`(I-\d+)`(?:\s*[:：]\s*|\s+)(.*)$/);
		if (!match) continue;
		const id = match[1];
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ id, text: match[2].trim() });
	}
	return items;
}

/** Lint the Implementation Items section: returns a warning string when the
 * section header exists but zero items parse (format drift), null otherwise.
 * Plans without the section are fine (older artifacts). */
export function lintImplItems(planText: string): string | null {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+Implementation Items\s*$/.test(line.trim()));
	if (headerIndex < 0) return null;
	if (parseImplItems(planText).length > 0) return null;
	return (
		"Implementation Items 节存在但解析出 0 项：条目需为顶层无缩进行，形如 " +
		"`- `I-00N`: 描述`（冒号半角/全角可省，但 id 与描述间至少一个分隔）"
	);
}

/**
 * Extract the covered I-ids from a VC checklist line's coverage clause
 * ("`VC-001` covers `I-002` and `I-003`; pass condition: ..." → ["I-002",
 * "I-003"]). Only references before the first ";" count.
 */
export function extractCoverage(vcText: string): string[] {
	const clause = vcText.split(";")[0] ?? "";
	return [...clause.matchAll(/\bI-\d+\b/g)].map((match) => match[0]);
}

export interface PlanVersionFile {
	path: string;
	version: number;
}

/** Find the highest PLAN_vN.md in an artifact directory. */
export function latestPlanVersion(artifactDir: string): PlanVersionFile | null {
	if (!fs.existsSync(artifactDir)) return null;
	let best: PlanVersionFile | null = null;
	for (const name of fs.readdirSync(artifactDir)) {
		const match = name.match(/^PLAN_v(\d+)\.(md|markdown)$/i);
		if (!match) continue;
		const version = Number(match[1]);
		if (best === null || version > best.version) {
			best = { path: `${artifactDir}/${name}`, version };
		}
	}
	return best;
}

/** Path for the next plan revision (PLAN_vN+1.md) in an artifact directory. */
export function nextPlanVersionPath(artifactDir: string): PlanVersionFile {
	const latest = latestPlanVersion(artifactDir);
	const version = (latest?.version ?? 0) + 1;
	return { path: `${artifactDir}/PLAN_v${version}.md`, version };
}

// ============================================================================
// v0.6.1 task-tree model: `## Tasks` (+ `### Execution Waves`) parsing.
// ============================================================================

/** One task from the `## Tasks` section. Subtasks nest one level
 * (`Task-3.1`); the executor treats a parent as complete only when all of
 * its children are complete or skipped. */
export interface TaskNode {
	id: string;
	title: string;
	/** Normalized task ids this task depends on (`I-001` → `Task-1`). */
	deps: string[];
	/** Worktree-relative paths the task is expected to touch. */
	files: string[];
	/** Inline `wave:` field, when present. The `### Execution Waves`
	 * subsection wins on conflict (linted). */
	wave?: number;
	children: TaskNode[];
}

/** One row of the `### Execution Waves` subsection. */
export interface WaveEntry {
	wave: number;
	taskIds: string[];
	rationale?: string;
}

/** The parsed task model of a plan: the task forest, the explicit waves
 * table, and whether it came from the legacy `I-###` fallback. */
export interface PlanTasks {
	tasks: TaskNode[];
	waves: WaveEntry[];
	legacy: boolean;
}

const TASK_ID_RE = /\b(?:task-\d+(?:\.\d+)?|i-\d+)\b/gi;

/** Normalize a task reference to canonical form: `I-001`→`Task-1`,
 * `task-03.1`→`Task-3.1`. Returns null when the text is not a task id. */
export function normalizeTaskId(raw: string): string | null {
	const t = raw.trim().replace(/^`+|`+$/g, "");
	let m = t.match(/^task-(\d+)(?:\.(\d+))?$/i);
	if (m) {
		return `Task-${Number(m[1])}${m[2] !== undefined ? `.${Number(m[2])}` : ""}`;
	}
	m = t.match(/^i-(\d+)$/i);
	if (m) return `Task-${Number(m[1])}`;
	return null;
}

/** Split a multi-value field on half/full-width commas and enumeration
 * commas, tolerating surrounding backticks. */
function splitFieldValues(raw: string): string[] {
	return raw
		.split(/[,，、]\s*/)
		.map((v) => v.trim().replace(/^`+|`+$/g, ""))
		.filter((v) => v.length > 0);
}

/** Parse the inline metadata fields of a task tail. Field clauses are
 * separated by `;`/`；`; each starts with `deps:`/`files:`/`wave:`. */
function parseTaskFields(tail: string): { deps: string[]; files: string[]; wave?: number; leftovers: string[] } {
	const deps: string[] = [];
	const files: string[] = [];
	let wave: number | undefined;
	const leftovers: string[] = [];
	for (const clause of tail.split(/[;；]/)) {
		const m = clause.trim().match(/^(deps|files|wave)\s*[:：]\s*(.+)$/i);
		if (!m) {
			if (clause.trim().length > 0) leftovers.push(clause.trim());
			continue;
		}
		const value = m[2];
		if (m[1].toLowerCase() === "wave") {
			const n = Number(value.trim().replace(/^`+|`+$/g, ""));
			if (Number.isFinite(n) && n >= 1) wave = Math.floor(n);
		} else {
			const values = splitFieldValues(value);
			const target = m[1].toLowerCase() === "deps" ? deps : files;
			for (const v of values) {
				if (m[1].toLowerCase() === "deps") {
				const id = normalizeTaskId(v);
				target.push(id ?? v);
			} else {
				target.push(v);
			}
			}
		}
	}
	return { deps, files, wave, leftovers };
}

/** Split a task line body into title and metadata tail at the dash
 * separator (`—`/`——`/`--`/`–`). No separator → title only. */
function splitTaskBody(body: string): { title: string; tail: string } {
	const m = body.match(/^(.*?)\s+(?:——|—|--|–)\s+(.+)$/);
	if (!m) return { title: body.trim(), tail: "" };
	return { title: m[1].trim(), tail: m[2].trim() };
}

interface RawTaskLine {
	id: string;
	body: string;
	indent: boolean;
}

function matchTaskBullet(line: string): { id: string; body: string } | null {
	const m = line.match(/^\s*(?:-|\*)\s+`?(task-\d+(?:\.\d+)?)`?(?:\s*[:：]\s*|\s+)(.*)$/i);
	if (!m) return null;
	const id = normalizeTaskId(m[1]);
	if (id === null) return null;
	return { id, body: m[2].trim() };
}

/** Parse the `### Execution Waves` subsection rows. */
function parseWaveLine(line: string): WaveEntry | null {
	const m = line.match(/^\s*-\s+wave\s+(\d+)\s*[:：]\s*(.+)$/i);
	if (!m) return null;
	const wave = Number(m[1]);
	const rest = m[2];
	const dash = rest.match(/^(.*?)\s+(?:——|—|--|–)\s+(.+)$/);
	const idsRaw = dash ? dash[1] : rest;
	const rationale = dash ? dash[2].trim() : undefined;
	const taskIds: string[] = [];
	for (const hit of idsRaw.matchAll(TASK_ID_RE)) {
		const id = normalizeTaskId(hit[0]);
		if (id !== null && !taskIds.includes(id)) taskIds.push(id);
	}
	return { wave, taskIds, rationale };
}

/** Map legacy plans onto the task model. `## Implementation Items` entries
 * map directly (`I-001` → `Task-1`, no deps/files/waves). A checklist-only
 * plan (no item sections at all, pre-0.5 artifacts) synthesizes one serial
 * task per verification check — `VC-003` → `Task-3` — so legacy in-flight
 * executions stay resumable; the covers clauses (`covers \`I-003\``)
 * normalize onto the same ids. */
function legacyFallback(planText: string): PlanTasks {
	const impl = parseImplItems(planText);
	if (impl.length > 0) {
		return {
			tasks: impl.map((item) => {
				const id = normalizeTaskId(item.id) ?? item.id;
				return { id, title: item.text, deps: [], files: [], children: [] };
			}),
			waves: [],
			legacy: true,
		};
	}
	const checklist = parseChecklist(planText);
	if (checklist.length === 0) return { tasks: [], waves: [], legacy: false };
	return {
		tasks: checklist.map((item) => {
			const num = Number(item.id.replace(/^VC-/, ""));
			return {
				id: `Task-${Number.isFinite(num) ? num : 1}`,
				title: item.text.split(/[;；]/)[0]?.slice(0, 80) ?? item.id,
				deps: [],
				files: [],
				children: [],
			};
		}),
		waves: [],
		legacy: true,
	};
}

/** Parse the `## Tasks` section into the task forest + waves table. When
 * the section is absent, falls back to legacy `## Implementation Items`
 * parsing mapped onto task ids. */
export function parsePlanTasks(planText: string): PlanTasks {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+Tasks\s*$/.test(line.trim()));
	if (headerIndex < 0) return legacyFallback(planText);

	const tasks: TaskNode[] = [];
	const seen = new Set<string>();
	let lastTop: TaskNode | null = null;
	const waves: WaveEntry[] = [];
	let inWaves = false;

	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (/^##\s/.test(trimmed)) break; // next section ends the tasks
		if (/^###\s+Execution Waves\s*$/.test(trimmed)) {
			inWaves = true;
			continue;
		}
		if (/^###\s/.test(trimmed)) {
			inWaves = false;
			continue;
		}
		if (inWaves) {
			const entry = parseWaveLine(trimmed);
			if (entry) waves.push(entry);
			continue;
		}
		const bullet = matchTaskBullet(line);
		if (!bullet) continue;
		const isIndented = /^\s+/.test(line);
		if (seen.has(bullet.id)) continue;
		seen.add(bullet.id);
		const { title, tail } = splitTaskBody(bullet.body);
		const fields = parseTaskFields(tail);
		const node: TaskNode = { id: bullet.id, title, deps: fields.deps, files: fields.files, wave: fields.wave, children: [] };
		if (isIndented && lastTop !== null && /\./.test(bullet.id)) {
			lastTop.children.push(node);
		} else {
			tasks.push(node);
			lastTop = node;
		}
	}
	return { tasks, waves, legacy: false };
}

/** Flatten a task forest in document order. */
export function flattenTasks(tasks: TaskNode[]): TaskNode[] {
	const out: TaskNode[] = [];
	for (const t of tasks) {
		out.push(t);
		out.push(...flattenTasks(t.children));
	}
	return out;
}

/** Effective wave per task id: the waves subsection wins, then the inline
 * `wave:` field, then derivation from deps (1 + max(dep wave), floor 1).
 * Subtasks inherit their parent's effective wave. */
export function resolveTaskWaves(planTasks: PlanTasks): Map<string, number> {
	const resolved = new Map<string, number>();
	const flat = flattenTasks(planTasks.tasks);
	const byId = new Map(flat.map((t) => [t.id, t]));
	for (const entry of planTasks.waves) {
		for (const id of entry.taskIds) resolved.set(id, entry.wave);
	}
	for (const t of planTasks.tasks) {
		if (t.wave !== undefined && !resolved.has(t.id)) resolved.set(t.id, t.wave);
	}
	const derive = (id: string, guard: Set<string>): number => {
		const known = resolved.get(id);
		if (known !== undefined) return known;
		if (guard.has(id)) return 1; // dependency cycle: floor at 1
		guard.add(id);
		const t = byId.get(id);
		let wave = 1;
		if (t) {
			for (const dep of t.deps) {
				const dw = derive(dep, guard);
				if (dw + 1 > wave) wave = dw + 1;
			}
		}
		resolved.set(id, wave);
		return wave;
	};
	for (const t of planTasks.tasks) derive(t.id, new Set());
	// Subtasks inherit their parent's effective wave (subsection entries for
	// subtask ids still win — they were set before derivation).
	const inherit = (parent: TaskNode): void => {
		const pw = resolved.get(parent.id) ?? 1;
		for (const child of parent.children) {
			if (!resolved.has(child.id)) resolved.set(child.id, pw);
			inherit(child);
		}
	};
	for (const t of planTasks.tasks) inherit(t);
	return resolved;
}

/** Extract normalized task ids from a VC line's coverage clause
 * ("`VC-001` covers `Task-2` and `Task-3`; …" → ["Task-2", "Task-3"];
 * legacy `I-###` targets normalize too). Only references before the first
 * `;`/`；` count. */
export function extractTaskCoverage(vcText: string): string[] {
	const clause = vcText.split(/[;；]/)[0] ?? "";
	const ids: string[] = [];
	for (const hit of clause.matchAll(TASK_ID_RE)) {
		const id = normalizeTaskId(hit[0]);
		if (id !== null && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** Lint the `## Tasks` model: returns a warning string (one notice per
 * line) when the section exists but has consistency problems, null when
 * clean or absent. The waves subsection is authoritative; every check is
 * advisory at planning time and enforced again at the execution gate. */
export function lintPlanTasks(planText: string): string | null {
	const lines = planText.split("\n");
	const headerIndex = lines.findIndex((line) => /^##\s+Tasks\s*$/.test(line.trim()));
	if (headerIndex < 0) return null;
	const notices: string[] = [];
	const parsed = parsePlanTasks(planText);
	if (!parsed.legacy && parsed.tasks.length === 0) {
		return "Tasks 节存在但解析出 0 项：条目需为顶层无缩进行，形如 `- `Task-1`: 标题 — deps: …; files: …; wave: 1`";
	}
	// Over-deep subtask ids anywhere in the section are a format drift.
	const section = lines.slice(headerIndex + 1).join("\n");
	const deep = section.match(/\btask-\d+\.\d+\.\d+\b/i);
	if (deep) notices.push(`子任务层级过深（仅支持 1 级，如 Task-3.1）：${deep[0]}`);
	const flat = flattenTasks(parsed.tasks);
	const byId = new Map(flat.map((t) => [t.id, t]));
	// Duplicate ids: the parser dedupes silently, so lint scans the raw
	// bullet ids from the section to surface duplicates (a second bullet may
	// carry different files/deps and silently widen a wave).
	const rawIds = [...section.matchAll(/^\s*(?:-|\*)\s+`?(task-\d+(?:\.\d+)?)`?/gim)].map((m) => normalizeTaskId(m[1]) ?? m[1]);
	const seenIds = new Set<string>();
	for (const id of rawIds) {
		if (seenIds.has(id)) {
			notices.push(`任务 id 重复出现（后者被忽略）：${id}`);
			break;
		}
		seenIds.add(id);
	}
	// Numbering continuity among top-level tasks.
	const topNums = parsed.tasks.map((t) => Number(t.id.replace(/^Task-/, "")));
	for (let i = 0; i < topNums.length; i++) {
		const expect = i + 1;
		if (topNums[i] !== expect) {
			notices.push(`顶层任务编号不连续：第 ${i + 1} 项为 ${parsed.tasks[i]?.id}，应为 Task-${expect}`);
			break;
		}
	}
	// Subtasks with an inline wave field inherit the parent's wave.
	for (const t of flat) {
		if (/\./.test(t.id) && t.wave !== undefined) {
			notices.push(`${t.id} 行内 wave 字段被忽略（子任务继承父任务波次）`);
		}
	}
	// Unknown dep targets.
	for (const t of flat) {
		for (const dep of t.deps) {
			if (!byId.has(dep)) notices.push(`${t.id} 的 deps 引用未知任务：${dep}`);
		}
	}
	// Wave consistency: inline vs subsection, dep ordering, file disjointness.
	const effective = resolveTaskWaves(parsed);
	const subsection = new Map<string, number>();
	for (const entry of parsed.waves) {
		for (const id of entry.taskIds) {
			if (subsection.has(id)) notices.push(`Waves 子节中 ${id} 出现在多个 wave`);
			subsection.set(id, entry.wave);
		}
	}
	for (const t of flat) {
		const sub = subsection.get(t.id);
		if (sub !== undefined && t.wave !== undefined && sub !== t.wave) {
			notices.push(`${t.id} 行内 wave=${t.wave} 与 Waves 子节 wave=${sub} 冲突，以子节为准`);
		}
	}
	for (const t of flat) {
		const tw = effective.get(t.id) ?? 1;
		for (const dep of t.deps) {
			const dw = effective.get(dep);
			if (dw !== undefined && dw >= tw) {
				notices.push(`${t.id}(wave ${tw}) 的依赖 ${dep}(wave ${dw}) 不在更早的波次`);
			}
		}
	}
	const filesByWave = new Map<number, Map<string, string>>();
	// File disjointness is checked between top-level tasks per wave: a
	// parent naturally shares files with its own children, so children's
	// files roll up to their top-level ancestor's bucket.
	const topLevelOf = new Map<string, string>();
	for (const top of parsed.tasks) {
		for (const node of flattenTasks([top])) topLevelOf.set(node.id, top.id);
	}
	for (const t of flat) {
		const owner = topLevelOf.get(t.id) ?? t.id;
		const tw = effective.get(owner) ?? 1;
		let bucket = filesByWave.get(tw);
		if (!bucket) {
			bucket = new Map();
			filesByWave.set(tw, bucket);
		}
		for (const f of t.files) {
			const existing = bucket.get(f);
			if (existing !== undefined && existing !== owner) {
				notices.push(`wave ${tw} 内 ${existing} 与 ${owner} 同时涉及文件 ${f}（波内文件集需不相交）`);
			} else {
				bucket.set(f, owner);
			}
		}
	}
	// Covers references must point at known tasks; a check with zero covers
	// never enters the completion audit — surface that exemption loudly.
	for (const item of parseChecklist(planText)) {
		const covered = extractTaskCoverage(item.text);
		if (covered.length === 0) {
			notices.push(`${item.id} 无 covers 任务：不参与完成审计（补 covers 或删除该检查）`);
			continue;
		}
		for (const id of covered) {
			if (!byId.has(id)) notices.push(`${item.id} covers 引用未知任务：${id}`);
		}
	}
	if (notices.length === 0) return null;
	return notices.join("\n");
}

/** Which checklist header name the plan uses (canonical or legacy), for
 * execution-gate upgrade hints. */
export function checklistHeaderName(planText: string): "Verification Checks" | "Verifier Checklist" | null {
	const lines = planText.split("\n");
	for (const line of lines) {
		const t = line.trim();
		if (/^##\s+Verification Checks\s*$/.test(t)) return "Verification Checks";
		if (/^##\s+Verifier Checklist\s*$/.test(t)) return "Verifier Checklist";
	}
	return null;
}
