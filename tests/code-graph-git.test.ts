/**
 * Unit tests for src/code-graph/git.ts — porcelain parsing (renames,
 * untracked, quoted paths), HEAD/diff helpers, commit no-op, and the
 * valued-arg parser.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
	gitAddAllAndCommit,
	gitDiffNameOnly,
	gitHead,
	gitStatusPorcelain,
	parseCommandArgs,
	parsePorcelain,
} from "../src/code-graph/git.ts";

function git(cwd: string, args: string[]): { code: number; stdout: string } {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	return { code: result.status ?? 1, stdout: result.stdout ?? "" };
}

function initRepo(): { root: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-git-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	return {
		root: dir,
		cleanup: () => {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

test("parsePorcelain handles modified, untracked, and rename entries", () => {
	const entries = parsePorcelain([
		" M src/a.ts",
		"?? new-file.ts",
		"R  old-name.ts -> new-name.ts",
		'A  "quoted path.ts"',
		'RM "old q.ts" -> "new q.ts"',
		"",
	].join("\n"));
	assert.deepEqual(entries[0], { status: " M", path: "src/a.ts", origPath: null });
	assert.deepEqual(entries[1], { status: "??", path: "new-file.ts", origPath: null });
	assert.deepEqual(entries[2], { status: "R ", path: "new-name.ts", origPath: "old-name.ts" });
	assert.deepEqual(entries[3], { status: "A ", path: "quoted path.ts", origPath: null });
	assert.deepEqual(entries[4], { status: "RM", path: "new q.ts", origPath: "old q.ts" });
});

test("gitHead / status / diff / commit round-trip in a temp repo", () => {
	const { root, cleanup } = initRepo();
	try {
		assert.equal(gitHead(root), "", "no commits yet");
		fs.writeFileSync(path.join(root, "a.js"), "function a() { return 1; }\n");
		const head1 = gitAddAllAndCommit(root, "first");
		assert.notEqual(head1, "");
		assert.equal(gitStatusPorcelain(root).length, 0, "clean after commit");

		fs.writeFileSync(path.join(root, "a.js"), "function a() { return 2; }\n");
		fs.writeFileSync(path.join(root, "b.js"), "function b() { return 3; }\n");
		const entries = gitStatusPorcelain(root);
		assert.deepEqual(entries.map((entry) => entry.path).sort(), ["a.js", "b.js"]);
		assert.deepEqual(gitDiffNameOnly(root).sort(), ["a.js"], "untracked excluded from diff");
		assert.deepEqual(gitDiffNameOnly(root, `${head1}..HEAD`).length, 0);

		const head2 = gitAddAllAndCommit(root, "second");
		assert.notEqual(head2, head1);
		assert.equal(gitAddAllAndCommit(root, "noop"), "", "clean tree is a no-op commit");

		git(root, ["mv", "b.js", "c.js"]);
		const renamed = gitStatusPorcelain(root);
		const renameEntry = renamed.find((entry) => entry.origPath !== null);
		assert.ok(renameEntry, "rename entry present");
		assert.equal(renameEntry.origPath, "b.js");
		assert.equal(renameEntry.path, "c.js");
	} finally {
		cleanup();
	}
});

test("parseCommandArgs splits boolean flags and valued args", () => {
	const parsed = parseCommandArgs("--dry-run --base abc123 extra-word");
	assert.deepEqual([...parsed.flags], ["dry-run"]);
	assert.equal(parsed.values.get("base"), "abc123");
	assert.equal(parsed.values.size, 1);
});
