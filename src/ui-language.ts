/**
 * Single source of truth for user-visible UI chrome language (issue #3).
 *
 * Workspace `language.tag` (`.git/pi_plans/config.json`) selects the chrome
 * strings for every user-visible surface: the batch form (src/ask-form.ts),
 * the refine/refs overlay footer (src/refine-ui.ts), the status panel
 * (src/panel.ts) and the execution status line (src/exec.ts).
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
}

const REFINE_CHROME: Record<UiLanguage, RefineChrome> = {
	zh: {
		close: "Esc 关闭",
		scroll: "↑/↓ 滚动",
		page: "PgUp/PgDn 翻页",
		switchLane: "Tab & Shift + Tab 切换 lane",
	},
	en: {
		close: "Esc close",
		scroll: "↑/↓ scroll",
		page: "PgUp/PgDn page",
		switchLane: "Tab & Shift + Tab switch lane",
	},
};

export function refineChrome(lang: UiLanguage): RefineChrome {
	return REFINE_CHROME[lang];
}

// ---------------------------------------------------------------------------
// Status panel chrome (src/panel.ts) — implWarning branch only.
// ---------------------------------------------------------------------------

export interface PanelChrome {
	badgeStatus(topic: string, vcDone: number, vcTotal: number): string;
	progressWarning(): string;
	summaryWarning(topic: string, vcDone: number, vcTotal: number, nextAction: string): string;
}

const PANEL_CHROME: Record<UiLanguage, PanelChrome> = {
	zh: {
		badgeStatus: (topic, vcDone, vcTotal) => `${topic} · ⚠ I 解析 0 项 · VC ${vcDone}/${vcTotal}`,
		progressWarning: () => `⚠ plan 格式：Implementation Items 解析 0 项（面板无法计 I 进度）`,
		summaryWarning: (topic, vcDone, vcTotal, nextAction) =>
			`plans: ${topic} ▸ ⚠ Implementation Items 解析 0 项 · VC ${vcDone}/${vcTotal} · next: ${nextAction}`,
	},
	en: {
		badgeStatus: (topic, vcDone, vcTotal) => `${topic} · ⚠ I parse 0 items · VC ${vcDone}/${vcTotal}`,
		progressWarning: () => `⚠ plan format: Implementation Items parsed 0 items (I progress cannot be counted)`,
		summaryWarning: (topic, vcDone, vcTotal, nextAction) =>
			`plans: ${topic} ▸ ⚠ Implementation Items parsed 0 items · VC ${vcDone}/${vcTotal} · next: ${nextAction}`,
	},
};

export function panelChrome(lang: UiLanguage): PanelChrome {
	return PANEL_CHROME[lang];
}

// ---------------------------------------------------------------------------
// Execution status line chrome (src/exec.ts) — goal-wait segment.
// ---------------------------------------------------------------------------

export interface ExecChrome {
	goalWait(noProgressRounds: number, waitRounds: number): string;
}

const EXEC_CHROME: Record<UiLanguage, ExecChrome> = {
	zh: {
		goalWait: (noProgressRounds, waitRounds) =>
			` · 🔁 goal-wait · 无进展 ${noProgressRounds}/3 · 等待 ${waitRounds}/6`,
	},
	en: {
		goalWait: (noProgressRounds, waitRounds) =>
			` · 🔁 goal-wait · no progress ${noProgressRounds}/3 · waiting ${waitRounds}/6`,
	},
};

export function execChrome(lang: UiLanguage): ExecChrome {
	return EXEC_CHROME[lang];
}