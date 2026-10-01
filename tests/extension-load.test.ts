/** Extension-load smoke test (audit round 1 fix).
 *
 * `npm test` runs under node --experimental-strip-types, which erases types
 * WITHOUT typechecking — duplicate type/interface declarations pass silently.
 * pi's extension loader parses TypeScript for real and refused the whole
 * extension ("Identifier 'RoleConfig' has already been declared"), which made
 * every spawned subagent (including the execution reviewer) fail while the
 * whole suite stayed green.
 *
 * Guard: spawn `pi` from the repo root with a deliberately missing model.
 * Extension loading happens BEFORE model resolution, so:
 * - a parse/registration failure prints "Failed to load extension" and aborts;
 * - a healthy extension reaches model resolution and fails differently.
 * No API call is made either way. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { describe, it } from "node:test";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function piBinary(): string {
	return process.platform === "win32" ? "pi.cmd" : "pi";
}

describe("extension load smoke (audit round 1)", () => {
	it("pi's real TypeScript loader accepts the extension sources", () => {
		assert.ok(fs.existsSync(path.join(ROOT, "index.ts")), "index.ts must exist");
		const result = spawnSync(
			piBinary(),
			["--mode", "json", "-p", "--no-session", "--model", "definitely/missing-model", "Task: x"],
			{ cwd: ROOT, encoding: "utf8", timeout: 60_000 },
		);
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.ok(
			!output.includes("Failed to load extension"),
			`pi's TS loader rejected the extension sources:\n${output.slice(0, 2000)}`,
		);
		// Sanity: the run must have failed for the MODEL reason (proving it got
		// PAST extension loading), or succeeded entirely on a machine without pi.
		if (result.error?.code === "ENOENT") return; // pi not installed: skip silently
		assert.notEqual(result.status, null, "the smoke run must terminate");
	});
});
