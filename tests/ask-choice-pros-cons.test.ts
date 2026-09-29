/**
 * Feature 5 (v0.6.0): every AI-written ask_choice option must state its
 * advantage AND its drawback as '✓ <advantage> / ✗ <drawback>' in the
 * configured language.
 *
 * The rule is SOFT GUIDANCE (deliberately — no runtime validation, no new
 * schema fields), so these tests pin the *contract text* the model actually
 * reads: the Option schema, the tool description, the promptGuidelines, the
 * batch/single `options` arrays, the six skills, and the normative reference
 * doc. They also prove the convention is actually RENDERABLE by the existing
 * form renderer, so guidance can never drift away from what users see.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Option, AskChoiceParams, BatchQuestionParams, registerAskChoiceTool } from "../tools/ask-choice.ts";
import { createFormState, formRender, type FormQuestion } from "../src/ask-form.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRO = "✓";
const CON = "✗";

interface ToolDef {
	name: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: unknown;
	execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown>;
}

function loadTool(): ToolDef {
	let tool: ToolDef | undefined;
	const pi = { registerTool: (definition: ToolDef) => { tool = definition; } } as unknown as ExtensionAPI;
	registerAskChoiceTool(pi);
	if (!tool) throw new Error("ask_choice tool not registered");
	return tool;
}

/** Read a TypeBox property description out of a schema object. */
function propertyDescription(schema: unknown, property: string): string {
	const properties = (schema as { properties?: Record<string, { description?: string }> }).properties;
	const found = properties?.[property]?.description;
	assert.equal(typeof found, "string", `expected a description on property ${property}`);
	return found!;
}

const SKILL_DIRS = ["planning", "debug-and-plan", "plan-small", "plan-normal", "plan-big", "plan-with-refs"];

describe("ask_choice pros/cons contract (v0.6.0 feature 5)", () => {
	it("Option.description requires both halves via the ✓ / ✗ markers", () => {
		const text = propertyDescription(Option, "description");
		assert.ok(text.includes(PRO), "description must show the advantage marker");
		assert.ok(text.includes(CON), "description must show the drawback marker");
		assert.ok(/drawback/i.test(text), "description must name the drawback half");
		assert.ok(/advantage/i.test(text), "description must name the advantage half");
		assert.ok(/configured language/i.test(text), "description must pin the configured language");
	});

	it("the registered tool description states the rule and exempts the tool-appended tails", () => {
		const tool = loadTool();
		assert.ok(tool.description.includes(PRO) && tool.description.includes(CON));
		assert.ok(/advantage/i.test(tool.description) && /drawback/i.test(tool.description));
		assert.ok(/Other/.test(tool.description) && /Auto-complete/.test(tool.description));
	});

	it("promptGuidelines carry the rule as an imperative, not as new schema fields", () => {
		const tool = loadTool();
		assert.ok(Array.isArray(tool.promptGuidelines));
		const joined = tool.promptGuidelines.join("\n");
		assert.ok(joined.includes(PRO) && joined.includes(CON), "a guideline must carry the markers");
		assert.ok(/drawback/i.test(joined), "a guideline must name the drawback half");
		// The failure mode this guards: a model inventing `pros`/`cons` keys,
		// which Option rejects (additionalProperties: false).
		assert.ok(
			/no separate pros\/cons fields|there are no separate pros\/cons fields/i.test(joined),
			"guidelines must forbid inventing pros/cons fields",
		);
	});

	it("both the batch and single-question options arrays propagate the rule", () => {
		const batch = propertyDescription(BatchQuestionParams, "options");
		assert.ok(batch.includes(PRO) && batch.includes(CON));
		assert.ok(/configured language/i.test(batch));

		const single = propertyDescription(AskChoiceParams, "options");
		assert.ok(single.includes(PRO) && single.includes(CON));
		assert.ok(/configured language/i.test(single));
	});

	it("every skill states the per-option pros/drawbacks rule", () => {
		for (const dir of SKILL_DIRS) {
			const file = path.join(ROOT, "skills", dir, "SKILL.md");
			const text = fs.readFileSync(file, "utf8");
			assert.ok(text.includes(PRO), `${dir}: must show the advantage marker`);
			assert.ok(text.includes(CON), `${dir}: must show the drawback marker`);
		}
	});

	it("the normative workflow doc states the rule at the options clause", () => {
		const text = fs.readFileSync(path.join(ROOT, "references", "pi-planning-workflow.md"), "utf8");
		const optionsBullet = text.split("\n").find((line) => line.startsWith("- `options`:"));
		assert.ok(optionsBullet, "the options clause must exist");
		assert.ok(optionsBullet!.includes(PRO) && optionsBullet!.includes(CON));
		assert.ok(/configured language/i.test(optionsBullet!));
		assert.ok(/accept\/execute/.test(optionsBullet!), "the handoff must be in scope");
	});

	it("the convention is renderable by the existing form renderer", () => {
		const question: FormQuestion = {
			question: "Which storage approach?",
			options: [
				{ label: "Reuse the existing table", description: `${PRO} no migration / ${CON} needs a backfill`, recommended: true },
				{ label: "Add a new table", description: `${PRO} clean isolation / ${CON} doubles write cost` },
			],
			allowOther: true,
			questionId: "q1",
			autoComplete: true,
		};
		const rows = formRender(createFormState([question]), 100);
		const rendered = rows.join("\n");
		assert.ok(rendered.includes(PRO), "the advantage half must reach the user");
		assert.ok(rendered.includes(CON), "the drawback half must reach the user");
		assert.ok(rendered.includes("no migration"), "the advantage text must be shown");
		assert.ok(rendered.includes("backfill"), "the drawback text must be shown");
	});

	it("a convention-following option still validates against the Option schema", () => {
		// No new keys: the whole point of riding `description` is that the
		// existing schema accepts it unchanged.
		const ok = Value.Check(Option, {
			label: "Reuse the existing table",
			description: `${PRO} no migration / ${CON} needs a backfill`,
			recommended: true,
		});
		assert.equal(ok, true);
		// And stray pros/cons keys are still rejected loudly.
		const stray = Value.Check(Option, { label: "x", pros: "a", cons: "b" });
		assert.equal(stray, false);
	});
});
