/** Subagent spawn argument tests (v0.7.0): the child pi receives the exact
 * --model selector and, only when a level is stored, --thinking. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPiSubagent } from "../src/subagent.ts";

/** Fake `pi` that echoes its raw argv (after the script path) as the final
 * assistant message so tests can assert the exact flags. */
async function spawnEchoingArgs(extra: { model?: string; thinkingLevel?: string }): Promise<string[]> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-fake-pi-"));
	const script = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		script,
		[
			'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
			'emit({ type: "turn_start" });',
			'const args = process.argv.slice(2).join(" ");',
			'emit({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: args }] } });',
		].join("\n"),
	);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runPiSubagent({
			systemPrompt: "test system prompt",
			task: "echo",
			cwd: process.cwd(),
			timeoutMs: 10_000,
			...extra,
		});
		assert.ok(result.ok, result.errorMessage ?? result.stderr);
		return (result.output ?? "").split(" ");
	} finally {
		process.argv[1] = previousScript;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("subagent spawn flags", () => {
	it("passes the concrete --model selector", async () => {
		const argv = await spawnEchoingArgs({ model: "devin/claude-sonnet-5.5" });
		const modelIndex = argv.indexOf("--model");
		assert.ok(modelIndex >= 0);
		assert.equal(argv[modelIndex + 1], "devin/claude-sonnet-5.5");
		assert.equal(argv.includes("--thinking"), false, "null level must not add --thinking");
	});

	it("passes --thinking only when a level is stored", async () => {
		const argv = await spawnEchoingArgs({ model: "devin/glm-5.3", thinkingLevel: "high" });
		const thinkingIndex = argv.indexOf("--thinking");
		assert.ok(thinkingIndex >= 0);
		assert.equal(argv[thinkingIndex + 1], "high");
	});

	it("explicit 'off' is a real flag (distinct from the null default)", async () => {
		const argv = await spawnEchoingArgs({ model: "devin/adaptive", thinkingLevel: "off" });
		const thinkingIndex = argv.indexOf("--thinking");
		assert.ok(thinkingIndex >= 0);
		assert.equal(argv[thinkingIndex + 1], "off");
	});
});
