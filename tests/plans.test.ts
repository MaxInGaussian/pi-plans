/** Tests for the plans tool source wiring. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { describe, it } from "node:test";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function readPlansSource(): string {
	return fs.readFileSync(path.join(ROOT, "tools", "plans.ts"), "utf8");
}

describe("plans tool source", () => {
	it("declares artifactRootSource in PlansParams", () => {
		const source = readPlansSource();
		const start = source.indexOf("const PlansParams = Type.Object({");
		const end = source.indexOf("});", start);
		assert.ok(start >= 0, "missing PlansParams block start");
		assert.ok(end >= 0, "missing PlansParams block end");

		const params = source.slice(start, end);
		assert.match(params, /artifactRootSource:\s*Type\.Optional/);
		assert.doesNotMatch(params, /executionModelSelector/);
		assert.doesNotMatch(params, /executionModelSource/);
	});

	it("keeps the plans handler wired to artifact root and no separate model-selection action", () => {
		const source = readPlansSource();
		assert.match(source, /import \{[\s\S]*setArtifactRoot,[\s\S]*\} from "\.\.\/src\/state\.ts";/);
		assert.match(source, /case "set-artifact-root"/);
		assert.doesNotMatch(source, /setExecutionModel/);
		assert.doesNotMatch(source, /case "set-execution-model"/);
		assert.match(source, /params\.artifactRootSource/);
	});
});
