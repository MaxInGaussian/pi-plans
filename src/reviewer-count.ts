/**
 * Reviewer count for the execution review.
 *
 * One review round used to run a single reviewer that had to verify every
 * pending check and also hunt for further defects. The user now picks 1–3
 * parallel reviewers right before round 1 (every task is terminal): the pending
 * checks are split evenly and each reviewer digs along its own direction (see
 * `planReviewLanes` in ./auditor.ts). The choice is stored in the run
 * checkpoint (`execution.reviewers`) and reused by every later round.
 */

import { DIRECTION_ID_RE, DIRECTION_MAX_CHARS, DIRECTION_MIN_CHARS } from "./refine-prompts.ts";
import { MAX_REVIEWERS, type ReviewDirection } from "./auditor.ts";
import { reviewBudgetPanelAvailable, type ReviewBudgetPanelHost } from "./review-budget.ts";
import { reviewerCountChrome, type UiLanguage } from "./ui-language.ts";

/** Reviewer count when the question cannot be asked (no UI) or is dismissed. */
export const DEFAULT_REVIEWER_COUNT = 1;

/** Counts the picker offers, in display order. */
export const REVIEWER_COUNT_CHOICES: readonly number[] = [1, 2, 3];

/** Largest useful count for `pendingChecks` checks: a reviewer with no share
 * of the checks would only duplicate another's findings. */
export function maxUsefulReviewers(pendingChecks: number): number {
	return Math.max(1, Math.min(MAX_REVIEWERS, pendingChecks));
}

function perReviewerLabel(pendingChecks: number, count: number): string {
	const low = Math.floor(pendingChecks / count);
	const high = Math.ceil(pendingChecks / count);
	return low === high ? String(high) : `${low}–${high}`;
}

/**
 * Ask how many reviewers the execution review should run. Returns the picked
 * count, or `null` when the question could not be answered (no UI, Esc, a
 * selector that threw) — the caller then applies `DEFAULT_REVIEWER_COUNT`.
 */
export async function askReviewerCount(
	host: ReviewBudgetPanelHost,
	lang: UiLanguage | undefined,
	pendingChecks: number,
): Promise<number | null> {
	if (!reviewBudgetPanelAvailable(host) || !host.ui) return null;
	const chrome = reviewerCountChrome(lang ?? "en");
	const choices = REVIEWER_COUNT_CHOICES.filter((count) => count <= maxUsefulReviewers(pendingChecks));
	const labels = choices.map((count) => chrome.option(count, perReviewerLabel(pendingChecks, count)));
	try {
		const picked = await host.ui.select(chrome.panelTitle(pendingChecks), labels);
		if (typeof picked === "string") {
			const index = labels.indexOf(picked);
			if (index >= 0) return choices[index]!;
		}
	} catch {
		/* a selector that throws must never strand the run */
	}
	return null;
}

export interface SanitizedDirections {
	directions: ReviewDirection[];
	/** One line per entry that was dropped, for the tool result. */
	dropped: string[];
}

/** Lenient validation of the executor's suggested directions: keep every valid
 * entry (up to the reviewer maximum), report what was dropped and why. */
export function sanitizeDirections(value: unknown): SanitizedDirections {
	const directions: ReviewDirection[] = [];
	const dropped: string[] = [];
	if (!Array.isArray(value)) return { directions, dropped: ["directions must be an array of { id, direction } objects"] };
	const seen = new Set<string>();
	for (const [index, raw] of value.entries()) {
		const entry = raw as { id?: unknown; direction?: unknown } | null;
		const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
		const direction = entry && typeof entry.direction === "string" ? entry.direction.trim() : "";
		if (!DIRECTION_ID_RE.test(id)) dropped.push(`directions[${index}]: id ${JSON.stringify(entry?.id)} is not a valid slug (${DIRECTION_ID_RE.source})`);
		else if (seen.has(id)) dropped.push(`directions[${index}]: id "${id}" is used twice`);
		else if (direction.length < DIRECTION_MIN_CHARS || direction.length > DIRECTION_MAX_CHARS) {
			dropped.push(`directions[${index}]: direction must be ${DIRECTION_MIN_CHARS}-${DIRECTION_MAX_CHARS} characters (got ${direction.length})`);
		} else if (directions.length >= MAX_REVIEWERS) dropped.push(`directions[${index}]: at most ${MAX_REVIEWERS} directions are used`);
		else {
			seen.add(id);
			directions.push({ id, direction });
		}
	}
	return { directions, dropped };
}
