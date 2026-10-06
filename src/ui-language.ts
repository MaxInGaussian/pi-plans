/**
 * Single source of truth for user-visible UI chrome language (issue #3).
 *
 * Workspace `language.tag` (`.git/pi-plans/config.json`) selects the chrome
 * strings for every user-visible surface: the batch form (src/ask-form.ts)
 * and the refine/refs overlay footer (src/refine-ui.ts).
 *
 * Mapping follows RFC 4647 primary-subtag fallback (zh-Hant-CN → zh-Hant →
 * zh), so every `zh*` tag renders the existing Simplified strings verbatim.
 * Unset / unreadable / wrong-typed tags fall back to English — the same
 * convention as the rest of the plugin chrome.
 *
 * Extension point: adding zh-Hant later means widening `UiLanguage`, splitting
 * the tag mapping (`zh-Hant*` → "zh-Hant") and adding the third entry in each
 * chrome table below.
 */

import { loadConfig, resolveStateRootOrNull } from "./state.ts";

export type UiLanguage = "zh" | "en";

/**
 * BCP47 primary-subtag fallback (RFC 4647 §3.4: zh-Hant-CN → zh-Hant → zh).
 * Non-string input (hand-edited config, JSON type drift) is treated as unset.
 */
export function uiLanguageFromTag(tag: unknown): UiLanguage {
	if (typeof tag !== "string") return "en";
	const normalized = tag.trim().replace(/_/g, "-").toLowerCase();
	return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}

/**
 * Best-effort chrome language for a workdir. Never throws: no git root, a
 * missing or corrupt config, or an unexpected tag type all fall back to "en"
 * so opening a form or rendering the panel can never fail on config I/O.
 */
export function resolveUiLanguage(workdir: string): UiLanguage {
	try {
		const root = resolveStateRootOrNull(workdir);
		if (root === null) return "en";
		return uiLanguageFromTag(loadConfig(root).language.tag);
	} catch {
		return "en";
	}
}

// ---------------------------------------------------------------------------
// Form chrome (src/ask-form.ts) — zh strings are byte-identical to 0.5.6.
// ---------------------------------------------------------------------------

export interface FormChrome {
	customLabel: string;
	submitChip: string;
	tabsSubmit: string;
	optionsHint: string;
	editingHeader(index: number, total: number, question: string): string;
	editingHint: string;
	unanswered: string;
	submitHeader(total: number): string;
	blockedSubmitHint(missingIndices: number[]): string;
	submitAllHint: string;
}

const FORM_CHROME: Record<UiLanguage, FormChrome> = {
	zh: {
		customLabel: "✏️ 自定义答案…",
		submitChip: " ✓ 提交 ",
		tabsSubmit: " 提交",
		optionsHint: "[↑/↓] 选择  [Enter] 选定  [Tab] 下一题  [Esc] 取消",
		editingHeader: (index, total, question) => `输入答案 — Q${index}/${total}: ${question}`,
		editingHint: "[Enter] 确认  [Esc] 放弃输入",
		unanswered: "(未作答)",
		submitHeader: (total) => `提交 — 全部 ${total} 题答案确认`,
		blockedSubmitHint: (missing) =>
			`[Enter] 提交（还差 ${missing.length} 题未作答: Q${missing.map((i) => i + 1).join("/Q")}）  [←→] 返回修改  [Esc] 取消`,
		submitAllHint: "[Enter] 提交全部  [←→] 返回修改  [Esc] 取消",
	},
	en: {
		customLabel: "✏️ Custom answer…",
		submitChip: " ✓ Submit ",
		tabsSubmit: " Submit",
		optionsHint: "[↑/↓] Select  [Enter] Choose  [Tab] Next  [Esc] Cancel",
		editingHeader: (index, total, question) => `Answer — Q${index}/${total}: ${question}`,
		editingHint: "[Enter] Confirm  [Esc] Discard input",
		unanswered: "(unanswered)",
		submitHeader: (total) => `Submit — confirm all ${total} answers`,
		blockedSubmitHint: (missing) =>
			`[Enter] Submit (${missing.length} unanswered: Q${missing.map((i) => i + 1).join("/Q")})  [←→] Review  [Esc] Cancel`,
		submitAllHint: "[Enter] Submit all  [←→] Review  [Esc] Cancel",
	},
};

export function formChrome(lang: UiLanguage): FormChrome {
	return FORM_CHROME[lang];
}

// ---------------------------------------------------------------------------
// Refine overlay footer chrome (src/refine-ui.ts)
// ---------------------------------------------------------------------------

export interface RefineChrome {
	close: string;
	scroll: string;
	page: string;
	switchLane: string;
	/** Auditor overlay only (v0.8): the shortcut that reopens the in-flight round. */
	reopen: string;
}

const REFINE_CHROME: Record<UiLanguage, RefineChrome> = {
	zh: {
		close: "Esc 关闭",
		scroll: "↑/↓ 滚动",
		page: "PgUp/PgDn 翻页",
		switchLane: "Tab & Shift + Tab 切换 lane",
		reopen: "Ctrl+Shift+R 重开评审面板",
	},
	en: {
		close: "Esc close",
		scroll: "↑/↓ scroll",
		page: "PgUp/PgDn page",
		switchLane: "Tab & Shift + Tab switch lane",
		reopen: "Ctrl+Shift+R reopen review overlay",
	},
};

export function refineChrome(lang: UiLanguage): RefineChrome {
	return REFINE_CHROME[lang];
}

// --------------------------------------------------------------------------
// Execution-review budget picker chrome (src/review-budget.ts)
// --------------------------------------------------------------------------

export interface ReviewBudgetChrome {
	/** Select-menu title prefix (the menu the review-budget question opens). */
	panelTitle: string;
	/** Suffix appended to the menu title when re-picking at a pause. */
	currentSuffix(current: string): string;
	/** Row label for a numeric budget. */
	roundsOption(rounds: number): string;
	/** Row label for the unlimited budget. */
	unlimitedOption: string;
}

const REVIEW_BUDGET_CHROME: Record<UiLanguage, ReviewBudgetChrome> = {
	zh: {
		panelTitle: "执行评审轮数预算 — 评议会逐轮验证计划里的每条 VC",
		currentSuffix: (current) => `（当前 ${current}）`,
		roundsOption: (rounds) => `${rounds} 轮`,
		unlimitedOption: "无上限（直到没有 high findings；3 轮无进展或累计 50 轮时暂停）",
	},
	en: {
		panelTitle: "Execution review budget — rounds the reviewer runs",
		currentSuffix: (current) => `(current: ${current})`,
		roundsOption: (rounds) => `${rounds} round${rounds === 1 ? "" : "s"}`,
		unlimitedOption: "unlimited (valve after 3 stalled rounds; 50-round cap)",
	},
};

export function reviewBudgetChrome(lang: UiLanguage): ReviewBudgetChrome {
	return REVIEW_BUDGET_CHROME[lang];
}

// --------------------------------------------------------------------------
// User-authorized termination chrome (/plans-terminate)
// --------------------------------------------------------------------------

/**
 * Chrome for the manual termination path: the confirm dialog, the disclosure
 * message that precedes it, and the notices around both. The `TERMINATION.md`
 * record itself stays English (it is run evidence, like the round reports).
 */
export interface TerminationChrome {
	/** Confirm-dialog title. */
	confirmTitle: string;
	/** Short confirm body: counts plus the done/unresumable contract. */
	confirmBody(rounds: number, budget: string): string;
	/** Committed rounds plus the budget in force (termination message). */
	roundsLabel(rounds: number, budget: string): string;
	/** Extra note when fewer than three rounds have been committed. */
	fewRoundsNote(rounds: number): string;
	/** Heading of the disclosure message shown before the confirm. */
	disclosureHeading: string;
	unverifiedLabel(count: number): string;
	openTasksLabel(count: number): string;
	highsLabel(count: number): string;
	residualLabel(count: number): string;
	/** Truncation notice: the full list lives in the message above. */
	partialIds(remaining: number): string;
	/** Post-termination message heading. */
	terminatedHeading: string;
	/** Where the termination record was written. */
	recordLine(path: string): string;
	/** The record could not be written (artifact dir missing/unwritable). */
	recordUnavailable: string;
	/** Terminal-state contract repeated after termination. */
	doneNotice: string;
	/** In-flight round that the termination aborted. */
	abortedRoundLabel(round: number, attempt: number): string;
	noExecution: string;
	requiresInteractive: string;
	cancelledNotice: string;
	/** Terminal-run guard notice for `/plans-execute` handoffs. */
	guardNotice(runId: string, status: string): string;
}

const TERMINATION_CHROME: Record<UiLanguage, TerminationChrome> = {
	zh: {
		confirmTitle: "终结当前计划？",
		confirmBody: (rounds, budget) =>
			`已提交 ${rounds} 轮评审（预算 ${budget}）。确认后 run 记为 done：未验证项与未解决 finding 原样保留，之后不可 resume。`,
		roundsLabel: (rounds, budget) => `已提交 ${rounds} 轮评审（预算 ${budget}）`,
		fewRoundsNote: (rounds) => `注意：已提交评审仅 ${rounds} 轮（少于 3 轮）。`,
		disclosureHeading: "**终止前披露** —— 下列未完成项会原样保留",
		unverifiedLabel: (count) => `未验证 VC：${count} 条`,
		openTasksLabel: (count) => `未完成任务：${count} 个`,
		highsLabel: (count) => `未解决 high finding：${count} 条`,
		residualLabel: (count) => `未解决非 high finding：${count} 条`,
		partialIds: (remaining) => `… 另有 ${remaining} 项，完整清单见上一条消息。`,
		terminatedHeading: "**计划已按用户裁定终结。**",
		recordLine: (path) => `终止记录：\`${path}\``,
		recordUnavailable: "终止记录未能写入（artifact 目录不可用）。",
		doneNotice: "run 已记为 done，之后不可 resume。",
		abortedRoundLabel: (round, attempt) => `已中断在飞轮次：round ${round} attempt ${attempt}（结局已记入轮次报告）`,
		noExecution: "当前没有进行中的执行。",
		requiresInteractive: "/plans-terminate 需要在交互式会话中运行。",
		cancelledNotice: "已取消终止，未做任何改动。",
		guardNotice: (runId, status) =>
			`run ${runId} 已是终态（${status}），不能再执行；如需继续请新起一个 run。`,
	},
	en: {
		confirmTitle: "Terminate this plan?",
		confirmBody: (rounds, budget) =>
			`${rounds} committed review round(s) (budget ${budget}). The run is recorded as done: unverified items and unresolved findings stay as-is, and the run cannot be resumed.`,
		roundsLabel: (rounds, budget) => `${rounds} committed review round(s) (budget ${budget})`,
		fewRoundsNote: (rounds) => `Note: only ${rounds} review round(s) committed (fewer than 3).`,
		disclosureHeading: "**Termination disclosure** — the unfinished items below are kept as-is",
		unverifiedLabel: (count) => `Unverified checks: ${count}`,
		openTasksLabel: (count) => `Open tasks: ${count}`,
		highsLabel: (count) => `Unresolved high findings: ${count}`,
		residualLabel: (count) => `Unresolved non-high findings: ${count}`,
		partialIds: (remaining) => `… +${remaining} more; see the message above for the full list.`,
		terminatedHeading: "**Plan terminated by user.**",
		recordLine: (path) => `Termination record: \`${path}\``,
		recordUnavailable: "The termination record could not be written (artifact directory unavailable).",
		doneNotice: "The run is recorded as done and cannot be resumed.",
		abortedRoundLabel: (round, attempt) =>
			`In-flight round aborted: round ${round} attempt ${attempt} (outcome recorded in the round report)`,
		noExecution: "No execution in progress.",
		requiresInteractive: "/plans-terminate requires an interactive session.",
		cancelledNotice: "Termination cancelled — nothing changed.",
		guardNotice: (runId, status) =>
			`Run ${runId} is ${status} (terminal) — it cannot be executed again; start a new run to continue.`,
	},
};

export function terminationChrome(lang: UiLanguage): TerminationChrome {
	return TERMINATION_CHROME[lang];
}

// --------------------------------------------------------------------------
// plan-huge chrome (dashboard progress line, /plans version tree)
// --------------------------------------------------------------------------

export interface HugeChrome {
	/** Dashboard progress line for the current version. */
	progress(version: string, index: number, total: number, status: string): string;
	/** One line of the `/plans` version tree. */
	versionLine(version: string, status: string, round: number): string;
	/** Localized label of one version status. */
	statusLabel(status: string): string;
}

const HUGE_CHROME: Record<UiLanguage, HugeChrome> = {
	zh: {
		progress: (version, index, total, status) => `huge ${version} ${index}/${total} · ${status}`,
		versionLine: (version, status, round) => `- ${version}: ${status} · 第 ${round} 轮`,
		statusLabel: (status) =>
			({
				pending: "未开始",
				planning: "规划中",
				reviewing: "评审中",
				executing: "执行中",
				verifying: "校验中",
				done: "已完成",
			})[status] ?? status,
	},
	en: {
		progress: (version, index, total, status) => `huge ${version} ${index}/${total} · ${status}`,
		versionLine: (version, status, round) => `- ${version}: ${status} · round ${round}`,
		statusLabel: (status) =>
			({
				pending: "pending",
				planning: "planning",
				reviewing: "reviewing",
				executing: "executing",
				verifying: "verifying",
				done: "done",
			})[status] ?? status,
	},
};

export function hugeChrome(lang: UiLanguage): HugeChrome {
	return HUGE_CHROME[lang];
}


