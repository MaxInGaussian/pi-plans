/**
 * `plans_review_directions` tool: the executor's channel for suggesting what
 * the execution reviewers should dig into. The review splits the pending
 * verification checks evenly across the chosen reviewers; each reviewer also
 * looks for defects and improvements along one complementary direction. The
 * executor knows best what it touched, where the seams are and what it was
 * unsure about, so it proposes the directions; when it proposes none the
 * review falls back to fixed back-up aspects (see `resolveReviewerDirections`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getExecution, setSuggestedReviewDirections } from "./exec.ts";
import { DIRECTION_MAX_CHARS, DIRECTION_MIN_CHARS } from "./refine-prompts.ts";
import { StateError } from "./state.ts";

export const ReviewDirectionsParams = Type.Object({
	directions: Type.Array(
		Type.Object({
			id: Type.String({ description: 'Short slug, unique, e.g. "migration-rollback"' }),
			direction: Type.String({
				description: `${DIRECTION_MIN_CHARS}-${DIRECTION_MAX_CHARS} characters: what this reviewer should dig into, naming real files, modules or risks of this change and why they are easy to get wrong.`,
			}),
		}),
		{ description: "2-3 complementary, non-overlapping review directions", maxItems: 3 },
	),
});

export const REVIEW_DIRECTIONS_DESCRIPTION =
	"Suggest 2-3 complementary directions for the independent execution reviewers (what you touched, risky seams, what you were unsure about; name real files and modules). Each reviewer verifies its share of the verification checks and digs along one direction for defects and improvements. Call it once, before your final task update; a later call replaces the earlier one. Optional: without it the reviewers use fixed back-up aspects.";

/** Text of the tool result, shared by the main-session and worker tools. */
export function reviewDirectionsResultText(accepted: number, dropped: string[]): string {
	const lines = [accepted > 0 ? `✓ recorded ${accepted} review direction(s)` : "no valid direction recorded"];
	for (const line of dropped) lines.push(`- dropped: ${line}`);
	return lines.join("\n");
}

export function registerReviewDirectionsTool(ext: ExtensionAPI): void {
	ext.registerTool({
		name: "plans_review_directions",
		label: "Review directions",
		description: REVIEW_DIRECTIONS_DESCRIPTION,
		promptSnippet: "Suggest complementary directions for the execution reviewers",
		parameters: ReviewDirectionsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const execution = getExecution();
			if (!execution) throw new StateError("no live pi-plans execution; review directions are only valid in execution mode");
			const { accepted, dropped } = setSuggestedReviewDirections(ctx, execution, params.directions);
			return {
				content: [{ type: "text", text: reviewDirectionsResultText(accepted.length, dropped) }],
				details: { accepted: accepted.map((entry) => entry.id), dropped },
			};
		},

		renderCall(args, theme) {
			const ids = Array.isArray(args.directions) ? args.directions.map((entry: { id?: unknown }) => String(entry?.id ?? "?")).join(", ") : "";
			return new Text(theme.bold("review directions ") + theme.fg("accent", ids), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});
}
