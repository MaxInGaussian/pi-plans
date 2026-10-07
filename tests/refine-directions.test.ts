import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DIRECTION_MAX_CHARS,
	DIRECTION_MIN_CHARS,
	GENERAL_LANE,
	buildReviewerTask,
	directionsGuidance,
	lanesFromDirections,
	validateDirections,
} from "../src/refine-prompts.ts";

const good = (id: string, text = `Dig into how ${id} behaves when the plan's change is only half applied.`) => ({ id, direction: text });

describe("validateDirections", () => {
	it("accepts exactly `count` well-formed directions and trims the text", () => {
		const checked = validateDirections(2, [good("rollback"), { id: "blast-radius", direction: "   Find the indirect callers the tasks forgot about.   " }]);
		assert.ok(checked.ok);
		assert.deepEqual(checked.directions.map((entry) => entry.id), ["rollback", "blast-radius"]);
		assert.equal(checked.directions[1]!.direction, "Find the indirect callers the tasks forgot about.");
	});

	it("requires directions for more than one reviewer and explains how to write them", () => {
		for (const missing of [undefined, null]) {
			const checked = validateDirections(3, missing);
			assert.ok(!checked.ok);
			assert.match(checked.error, /reviewers: 3 needs tailor-made directions/);
			assert.match(checked.error, /exactly 3 entries/);
			assert.match(checked.error, /complementary, not overlapping/);
		}
	});

	it("rejects a wrong count in either direction", () => {
		assert.match((validateDirections(3, [good("a"), good("b")]) as { error: string }).error, /exactly 3 directions, got 2/);
		assert.match((validateDirections(2, [good("a"), good("b"), good("c")]) as { error: string }).error, /exactly 2 directions, got 3/);
		assert.match((validateDirections(1, [good("a"), good("b")]) as { error: string }).error, /at most one direction/);
	});

	it("rejects malformed entries, bad slugs, duplicate ids and out-of-range text", () => {
		const cases: Array<[unknown, RegExp]> = [
			["not-an-array", /must be an array/],
			[[good("a"), null], /must be an object/],
			[[good("a"), { id: 7, direction: "x".repeat(30) }], /not a valid slug/],
			[[good("a"), good("Has Space")], /not a valid slug/],
			[[good("a"), good("-leading")], /not a valid slug/],
			[[good("a"), good("a".repeat(33))], /not a valid slug/],
			[[good("a"), good("a")], /used twice/],
			[[good("a"), { id: "b", direction: "y".repeat(DIRECTION_MIN_CHARS - 1) }], /must be 20-800 characters/],
			[[good("a"), { id: "b", direction: "y".repeat(DIRECTION_MAX_CHARS + 1) }], /must be 20-800 characters/],
			[[good("a"), { id: "b" }], /must be 20-800 characters \(got 0\)/],
			[[good("a"), { id: "b", direction: `${" ".repeat(40)}x` }], /must be 20-800 characters/],
		];
		for (const [input, pattern] of cases) {
			const checked = validateDirections(2, input);
			assert.ok(!checked.ok, JSON.stringify(input));
			assert.match(checked.error, pattern);
		}
	});

	it("allows a single reviewer to take zero or one direction", () => {
		assert.deepEqual(validateDirections(1, undefined), { ok: true, directions: [] });
		const one = validateDirections(1, [good("focus")]);
		assert.ok(one.ok && one.directions.length === 1);
	});

	it("guidance names the limits and the blind-spot prompts", () => {
		const text = directionsGuidance(2);
		assert.match(text, /exactly 2 entries/);
		assert.match(text, /20-800 characters/);
		assert.match(text, /migration\/rollback/);
		assert.match(text, /whether the verification checks really prove the claims/);
	});
});

describe("lanesFromDirections", () => {
	it("maps directions to lanes and falls back to the single general lane", () => {
		assert.deepEqual(lanesFromDirections([good("a", "x".repeat(25)), good("b", "y".repeat(25))]), [
			{ id: "a", direction: "x".repeat(25) },
			{ id: "b", direction: "y".repeat(25) },
		]);
		assert.deepEqual(lanesFromDirections([]), [GENERAL_LANE]);
	});

	it("never hands out the shared general lane object", () => {
		const [lane] = lanesFromDirections([]);
		lane!.direction = "mutated";
		assert.equal(GENERAL_LANE.direction, null);
	});
});

describe("buildReviewerTask", () => {
	const base = { planText: "PLAN BODY", planPath: "/p/PLAN_v1.md" };

	it("assigns the direction, lists the other directions, and keeps the escape clause", () => {
		const task = buildReviewerTask({
			...base,
			direction: "Probe the migration path.",
			otherDirections: [{ id: "blast-radius", direction: "Find indirect callers." }],
		});
		assert.match(task, /Your assigned direction: Probe the migration path\./);
		assert.match(task, /Go deeper here than a generic review would/);
		assert.match(task, /Do not pad the report with generic coverage/);
		assert.match(task, /high-severity problem outside your direction, report it briefly/);
		assert.match(task, /Other reviewers in this round cover different directions — do not duplicate them:\n- blast-radius: Find indirect callers\./);
		assert.doesNotMatch(task, /Review lens/);
	});

	it("omits the others block when there are none and the whole block for a general reviewer", () => {
		const alone = buildReviewerTask({ ...base, direction: "Probe the migration path.", otherDirections: [] });
		assert.doesNotMatch(alone, /Other reviewers in this round/);
		const general = buildReviewerTask({ ...base, direction: null });
		assert.doesNotMatch(general, /Your assigned direction/);
		assert.doesNotMatch(general, /Other reviewers/);
	});

	it("places the direction before the focus and context lines and keeps the plan and output contract", () => {
		const task = buildReviewerTask({ ...base, direction: "Probe the migration path.", focus: "FOCUS TEXT", context: "CONTEXT TEXT" });
		assert.ok(task.indexOf("Your assigned direction") < task.indexOf("FOCUS TEXT"));
		assert.ok(task.indexOf("FOCUS TEXT") < task.indexOf("CONTEXT TEXT"));
		assert.match(task, /## Findings/);
		assert.match(task, /## Questions/);
		assert.match(task, /---8<--- PLAN CONTENT ---8<---\nPLAN BODY\n---8<--- END PLAN CONTENT ---8<---/);
	});
});
