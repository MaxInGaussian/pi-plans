/**
 * Execution-review budget tests (v0.9.3): the budget arithmetic, the shared
 * review-pause predicate, the unlimited no-progress valve, and the picker's
 * fallback matrix. The loop-level behaviour (resolution timing, tolerated
 * completion, grants) lives in tests/exec-review-loop.test.ts.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../src/refine-ui-helpers.ts";
import {
	askReviewBudget,
	budgetExhausted,
	bumpNoProgress,
	formatReviewBudget,
	isReviewPauseReason,
	noProgressSignature,
	noProgressTripped,
	resolveStoredBudget,
	reviewBudgetPanelAvailable,
	unlimitedHardCapCeiling,
	DEFAULT_REVIEW_BUDGET,
	LEGACY_REVIEW_MAX_ROUNDS,
	NO_PROGRESS_MAX_STREAK,
	REVIEW_BUDGET_CHOICES,
	UNLIMITED_HARD_CAP,
} from "../src/review-budget.ts";
import { reviewBudgetChrome } from "../src/ui-language.ts";

describe("review budget arithmetic (v0.9.3)", () => {
	it("resolves a stored budget, the legacy bound, and the undecided state", () => {
		assert.equal(DEFAULT_REVIEW_BUDGET, 3);
		assert.equal(LEGACY_REVIEW_MAX_ROUNDS, 5);
		assert.equal(UNLIMITED_HARD_CAP, 50);
		assert.deepEqual([...REVIEW_BUDGET_CHOICES], [1, 2, 3, 5, "unlimited"]);
		// Undecided: a fresh run has not picked yet.
		assert.equal(resolveStoredBudget(undefined, 0), undefined);
		// Legacy: a pre-feature checkpoint that already spent rounds keeps 5.
		assert.equal(resolveStoredBudget(undefined, 2), LEGACY_REVIEW_MAX_ROUNDS);
		// A stored value wins.
		assert.equal(resolveStoredBudget("unlimited", 2), "unlimited");
		assert.equal(resolveStoredBudget(1, 0), 1);
	});

	it("formats the budget the way status lines do", () => {
		assert.equal(formatReviewBudget(1), "1");
		assert.equal(formatReviewBudget(3), "3");
		assert.equal(formatReviewBudget(5), "5");
		assert.equal(formatReviewBudget("unlimited"), "∞");
	});

	it("measures numeric budgets per grant and unlimited across the whole run", () => {
		const counters = { reviewRoundsTotal: 0, reviewCapExtension: 0 };
		assert.equal(budgetExhausted(3, 2, counters), false);
		assert.equal(budgetExhausted(3, 3, counters), true);
		assert.equal(budgetExhausted(1, 1, counters), true);
		// Unlimited ignores the per-grant counter and uses the cumulative one.
		assert.equal(budgetExhausted("unlimited", 9999, counters), false);
		assert.equal(budgetExhausted("unlimited", 0, { reviewRoundsTotal: UNLIMITED_HARD_CAP - 1, reviewCapExtension: 0 }), false);
		assert.equal(budgetExhausted("unlimited", 0, { reviewRoundsTotal: UNLIMITED_HARD_CAP, reviewCapExtension: 0 }), true);
		// An explicit unlimited grant lifts the cap by exactly one window.
		assert.equal(budgetExhausted("unlimited", 0, { reviewRoundsTotal: UNLIMITED_HARD_CAP + 10, reviewCapExtension: 50 }), false);
		assert.equal(unlimitedHardCapCeiling({ reviewRoundsTotal: 12, reviewCapExtension: 50 }), 100);
	});

	it("bills the exempt non-high repair cycle as one round (v0.10 caller contract)", () => {
		// The credit lives in the caller (`reviewNonHighCredit` in exec.ts): the
		// engine passes `audit.rounds - credit`, so one granted cycle unspends a
		// numeric budget by exactly one round without touching the unlimited cap.
		const counters = { reviewRoundsTotal: 1, reviewCapExtension: 0 };
		assert.equal(budgetExhausted(1, 1, counters), true, "raw round 1 of 1 is exhausted");
		assert.equal(budgetExhausted(1, 0, counters), false, "billed with the exempt cycle: not exhausted");
		assert.equal(budgetExhausted("unlimited", 0, { reviewRoundsTotal: 1, reviewCapExtension: 0 }), false, "the hard cap counts raw rounds only");
	});

	it("recognizes every review pause reason and nothing else (shared predicate)", () => {
		assert.equal(isReviewPauseReason("execution review exhausted 3 rounds (failed: VC-002). Only /plans-execute"), true);
		assert.equal(isReviewPauseReason("execution review exhausted 50 rounds (unlimited budget safety cap)"), true);
		assert.equal(isReviewPauseReason("completion audit exhausted 5 rounds (legacy prefix)"), true);
		assert.equal(isReviewPauseReason("execution review stalled — 3 consecutive rounds reported the same outcome"), true);
		// A blocked wake names a different state and must never be grantable.
		assert.equal(isReviewPauseReason("blocked: review round 2 cannot start — Task-2 still open"), false);
		assert.equal(isReviewPauseReason(undefined), false);
		assert.equal(isReviewPauseReason(""), false);
	});
});

describe("no-progress valve (v0.9.3)", () => {
	it("signs the post-classification triple deterministically", () => {
		const base = noProgressSignature(["VC-002"], ["VC-001"], ["F-001"]);
		assert.equal(base, noProgressSignature(["VC-002"], ["VC-001"], ["F-001"]));
		// Order and duplicates never change the signature.
		assert.equal(base, noProgressSignature(["VC-002", "VC-002"], ["VC-001"], ["F-001"]));
		// Any real movement changes it — the valve only fires on a dead loop.
		assert.notEqual(base, noProgressSignature([], ["VC-001"], ["F-001"]));
		assert.notEqual(base, noProgressSignature(["VC-002"], [], ["F-001"]));
		assert.notEqual(base, noProgressSignature(["VC-002"], ["VC-001"], []));
		assert.notEqual(base, noProgressSignature(["VC-001"], ["VC-002"], ["F-001"]));
	});

	it("counts consecutive identical outcomes and trips on the third", () => {
		const sig = noProgressSignature([], ["VC-001", "VC-002"], []);
		const first = bumpNoProgress(undefined, sig);
		assert.deepEqual(first, { key: sig, streak: 1 });
		assert.equal(noProgressTripped(first), false);
		const second = bumpNoProgress(first, sig);
		assert.equal(second.streak, 2);
		assert.equal(noProgressTripped(second), false);
		const third = bumpNoProgress(second, sig);
		assert.equal(third.streak, NO_PROGRESS_MAX_STREAK);
		assert.equal(noProgressTripped(third), true);
		// Progress resets the streak to one.
		const moved = bumpNoProgress(third, noProgressSignature(["VC-001"], ["VC-002"], []));
		assert.equal(moved.streak, 1);
		assert.equal(noProgressTripped(moved), false);
	});
});

describe("budget picker (v0.9.3)", () => {
	it("falls back to null without a native surface (the default-budget path)", async () => {
		assert.equal(reviewBudgetPanelAvailable({ mode: "print", hasUI: false }), false);
		assert.equal(reviewBudgetPanelAvailable({ mode: "tui", hasUI: true, ui: {} }), false);
		assert.equal(await askReviewBudget({ mode: "print", hasUI: false }, "en"), null);
		assert.equal(await askReviewBudget({ mode: "tui", hasUI: true, ui: {} }, "en"), null);
	});

	it("treats a headless session as menu-less even though ui.select exists (round-1 F-001)", async () => {
		// The SDK's ExtensionUIContext.select is REQUIRED, so json/print
		// sessions still carry a function; hasUI is the availability signal.
		const headless = {
			mode: "json" as const,
			hasUI: false,
			ui: {
				select: async () => {
					throw new Error("a headless select must never be asked");
				},
			},
		};
		assert.equal(reviewBudgetPanelAvailable(headless), false, "hasUI false means no menu");
		assert.equal(await askReviewBudget(headless, "en"), null, "and the picker answers null without calling the UI");
	});

	it("(a) opens the session's select menu and maps the pick back to a budget", async () => {
		const titles: string[] = [];
		const rows: string[][] = [];
		const tuiHost = {
			mode: "tui" as const,
			hasUI: true,
			ui: {
				select: async (title: string, options: string[]): Promise<string | undefined> => {
					titles.push(title);
					rows.push(options);
					return options[3];
				},
			},
		};
		assert.equal(reviewBudgetPanelAvailable(tuiHost), true, "a TUI host is served by the same select menu");
		assert.equal(await askReviewBudget(tuiHost, "en", 3), 5, "options[3] is the 5-round row");
		assert.match(titles[0] ?? "", /current: 3/, "the title names the current budget (no preselection parameter)");
		assert.equal(rows[0]?.length, REVIEW_BUDGET_CHOICES.length, "one row per pickable budget");
		assert.match(rows[0]?.[3] ?? "", /^5 rounds$/);
	});

	it("(b) treats a cancelled select (Esc) as no answer", async () => {
		const cancelling = { mode: "rpc" as const, hasUI: true, ui: { select: async () => undefined } };
		assert.equal(await askReviewBudget(cancelling, "en"), null, "first ask: the caller applies the default");
		assert.equal(await askReviewBudget(cancelling, "zh", 3), null, "at a pause: the caller keeps the run paused");
	});

	it("(c) never calls a legacy ui.custom, even when the host provides one", async () => {
		let customCalls = 0;
		const legacyHost: {
			mode: string;
			hasUI: boolean;
			ui: { custom: () => Promise<unknown>; select: (title: string, options: string[]) => Promise<string | undefined> };
		} = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: () => {
					customCalls += 1;
					throw new Error("ui.custom must never be asked — the overlay surface is gone");
				},
				select: async (_title, options) => options[0],
			},
		};
		assert.equal(reviewBudgetPanelAvailable(legacyHost), true, "availability no longer depends on ui.custom");
		assert.equal(await askReviewBudget(legacyHost, "en"), 1, "the select menu answers");
		assert.equal(customCalls, 0, "the removed overlay branch is never consulted");
	});

	it("(d) answers null for a UI host without a select menu", async () => {
		const noMenu = { mode: "tui" as const, hasUI: true, ui: {} };
		assert.equal(reviewBudgetPanelAvailable(noMenu), false, "the menu is the only surface");
		assert.equal(await askReviewBudget(noMenu, "en"), null, "the caller falls back to the default budget");
	});

	it("(e) survives a selector that throws (catch → null, never a stranded run)", async () => {
		const throwing = {
			mode: "tui" as const,
			hasUI: true,
			ui: {
				select: async () => {
					throw new Error("host selector exploded");
				},
			},
		};
		assert.equal(reviewBudgetPanelAvailable(throwing), true);
		assert.equal(await askReviewBudget(throwing, "en"), null, "the catch lands on the default-budget path");
	});

	it("(f) keeps the menu title and every row within 74 display columns (zh and en)", async () => {
		for (const lang of ["zh", "en"] as const) {
			let title = "";
			let labels: string[] = [];
			const host = {
				mode: "rpc" as const,
				hasUI: true,
				ui: {
					select: async (t: string, options: string[]): Promise<string | undefined> => {
						title = t;
						labels = options;
						return undefined;
					},
				},
			};
			// `unlimited` is the longest suffix ("(current: unlimited)").
			await askReviewBudget(host, lang, "unlimited");
			assert.ok(visibleWidth(title) <= 74, `${lang} title fits one line (${visibleWidth(title)} cols): ${title}`);
			assert.equal(labels.length, REVIEW_BUDGET_CHOICES.length);
			for (const label of labels) {
				assert.ok(visibleWidth(label) <= 74, `${lang} row fits one line (${visibleWidth(label)} cols): ${label}`);
			}
		}
	});

	it("ships zh and en chrome for the menu and its rows", () => {
		const zh = reviewBudgetChrome("zh");
		const en = reviewBudgetChrome("en");
		assert.equal("panelHint" in zh, false, "the overlay-only footer hint is gone");
		assert.equal("panelHint" in en, false, "the overlay-only footer hint is gone");
		assert.match(zh.unlimitedOption, /无上限/);
		assert.match(zh.roundsOption(3), /3 轮/);
		assert.match(zh.currentSuffix("3"), /当前 3/);
		assert.match(en.unlimitedOption, /unlimited/);
		assert.match(en.roundsOption(1), /^1 round$/);
		assert.match(en.roundsOption(3), /^3 rounds$/);
		assert.notEqual(zh.panelTitle, en.panelTitle);
	});
});
