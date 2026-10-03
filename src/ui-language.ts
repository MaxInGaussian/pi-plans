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
	/** Panel title (TUI) / select title prefix (menus). */
	panelTitle: string;
	/** Suffix appended to the menu title when re-picking at a pause. */
	currentSuffix(current: string): string;
	/** Row label for a numeric budget. */
	roundsOption(rounds: number): string;
	/** Row label for the unlimited budget. */
	unlimitedOption: string;
	/** Footer hint under the TUI panel. */
	panelHint: string;
}

const REVIEW_BUDGET_CHROME: Record<UiLanguage, ReviewBudgetChrome> = {
	zh: {
		panelTitle: "执行评审轮数预算 — 评议会逐轮验证计划里的每条 VC",
		currentSuffix: (current) => `（当前 ${current}）`,
		roundsOption: (rounds) => `${rounds} 轮`,
		unlimitedOption: "无上限（直到没有 high findings；3 轮无进展或累计 50 轮时暂停）",
		panelHint: "[↑/↓] 选择  [Enter] 选定  [Esc] 取消（改用默认值）",
	},
	en: {
		panelTitle: "Execution review budget — the reviewer verifies every VC round by round",
		currentSuffix: (current) => `(current: ${current})`,
		roundsOption: (rounds) => `${rounds} round${rounds === 1 ? "" : "s"}`,
		unlimitedOption: "unlimited (until no high findings; pauses after 3 no-progress rounds or 50 committed rounds)",
		panelHint: "[↑/↓] Select  [Enter] Choose  [Esc] Cancel (use the default)",
	},
};

export function reviewBudgetChrome(lang: UiLanguage): ReviewBudgetChrome {
	return REVIEW_BUDGET_CHROME[lang];
}


