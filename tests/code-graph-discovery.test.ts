/** Discovery regression tests for tracked, untracked, and excluded source paths. */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverFiles } from "../src/code-graph/discovery.ts";

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
}

test("discovery applies product exclusions to Git and filesystem paths", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-discovery-"));
	try {
		git(root, ["init", "--initial-branch=main"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "test"]);
		fs.writeFileSync(path.join(root, "tracked.js"), "function tracked() {}\n");
		git(root, ["add", "tracked.js"]);
		git(root, ["commit", "-m", "tracked"]);
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.mkdirSync(path.join(root, "node_modules", "dependency"), { recursive: true });
		fs.writeFileSync(path.join(root, "src", "untracked.ts"), "export function untracked() {}\n");
		fs.writeFileSync(path.join(root, "node_modules", "dependency", "ignored.js"), "function ignored() {}\n");
		fs.mkdirSync(path.join(root, "dist"), { recursive: true });
		fs.writeFileSync(path.join(root, "dist", "built.py"), "def built(): pass\n");

		const files = discoverFiles({ worktreeRoot: root });
		const names = files.map((file) => `${file.fileDir}/${file.fileName}`);
		assert.deepEqual(names, ["./tracked.js", "src/untracked.ts"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
