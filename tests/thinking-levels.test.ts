/** Thinking-level adapter tests (F-012): the wrapper delegates level-domain
 * rules to pi-ai and only owns the "default" sentinel + spawn resolution. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DEFAULT_LEVEL_DESCRIPTION,
	DEFAULT_LEVEL_SENTINEL,
	isLevelSupported,
	levelsForModel,
	resolveReviewerSpawn,
	roleModelLabel,
	spawnThinkingFlag,
} from "../src/thinking-levels.ts";

const reasoningModel = {
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
} as const;

const plainModel = { reasoning: false } as const;

describe("levelsForModel (delegates to pi-ai)", () => {
	it("keeps only supported levels; xhigh/max require explicit mappings", () => {
		const levels = levelsForModel(reasoningModel as never);
		assert.deepEqual(levels, ["low", "high", "max"]);
	});

	it("non-reasoning models only support off", () => {
		assert.deepEqual(levelsForModel(plainModel as never), ["off"]);
	});

	it("matches pi-ai's own output (no drift)", () => {
		assert.deepEqual(levelsForModel(reasoningModel as never), getSupportedThinkingLevels(reasoningModel as never));
	});
});

describe("default sentinel", () => {
	it("null stored level means: omit the --thinking flag", () => {
		assert.equal(spawnThinkingFlag(null), null);
		assert.equal(spawnThinkingFlag("high"), "high");
		assert.equal(spawnThinkingFlag("off"), "off");
		assert.equal(DEFAULT_LEVEL_SENTINEL, "default");
	});

	it("isLevelSupported treats null as always valid", () => {
		assert.equal(isLevelSupported(reasoningModel as never, null), true);
		assert.equal(isLevelSupported(reasoningModel as never, "high"), true);
		assert.equal(isLevelSupported(reasoningModel as never, "xhigh"), false);
		assert.equal(isLevelSupported(plainModel as never, "high"), false);
		assert.equal(isLevelSupported(plainModel as never, "off"), true);
	});
});

describe("labels and spawn resolution", () => {
	it("roleModelLabel suffixes the level or the default sentinel", () => {
		assert.equal(roleModelLabel("devin/claude-sonnet-5.5", null), "devin/claude-sonnet-5.5:default");
		assert.equal(roleModelLabel("devin/claude-sonnet-5.5", "high"), "devin/claude-sonnet-5.5:high");
	});

	it("resolveReviewerSpawn returns concrete model + optional level", () => {
		const spawn = resolveReviewerSpawn({ model_selector: "devin/glm-5.3", thinking_level: "xhigh" });
		assert.deepEqual(spawn, { modelSelector: "devin/glm-5.3", thinkingLevel: "xhigh", label: "devin/glm-5.3:xhigh" });
		const defaulted = resolveReviewerSpawn({ model_selector: "devin/glm-5.3", thinking_level: null });
		assert.deepEqual(defaulted, {
			modelSelector: "devin/glm-5.3",
			thinkingLevel: null,
			label: "devin/glm-5.3:default",
		});
	});

	it("the default row documents the child pi default chain, not the session level", () => {
		assert.match(DEFAULT_LEVEL_DESCRIPTION, /child pi/);
		assert.match(DEFAULT_LEVEL_DESCRIPTION, /defaultThinkingLevel/);
	});
});
