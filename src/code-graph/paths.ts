/**
 * Canonical worktree root and relative POSIX path helpers for the code-graph
 * module. Strictly forbids absolute paths, `..`, and Windows separators.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { resolveStateRootOrNull } from "../state.ts";

export interface WorktreePaths {
	worktreeRoot: string;
	gitCommonDir: string;
	stateRoot: string;
	codeGraphDb: string;
}

export class PathError extends Error {}

function runGit(cwd: string, args: string[]): { code: number; stdout: string } {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	return { code: result.status ?? 1, stdout: result.stdout ?? "" };
}

export function resolveCanonicalWorktree(workdir: string): WorktreePaths {
	const toplevel = runGit(workdir, ["rev-parse", "--show-toplevel"]);
	if (toplevel.code !== 0) {
		throw new PathError(`workdir is not inside a git work tree: ${workdir}`);
	}
	const common = runGit(workdir, ["rev-parse", "--git-common-dir"]);
	if (common.code !== 0) {
		throw new PathError(`git common dir unavailable for ${workdir}`);
	}
	const worktreeRoot = path.resolve(toplevel.stdout.trim());
	const gitCommonDir = path.resolve(workdir, common.stdout.trim());
	const stateRoot = path.join(gitCommonDir, "pi_plans");
	if (!resolveStateRootOrNull(workdir)) {
		throw new PathError(`pi-plans state missing; run a planning init first`);
	}
	return {
		worktreeRoot,
		gitCommonDir,
		stateRoot,
		codeGraphDb: path.join(stateRoot, "code_graph.db"),
	};
}

export function normalizeRelative(worktreeRoot: string, target: string): { fileDir: string; fileName: string } {
	const abs = path.resolve(target);
	if (!abs.startsWith(worktreeRoot + path.sep) && abs !== worktreeRoot) {
		throw new PathError(`path ${target} is outside worktree root ${worktreeRoot}`);
	}
	const rel = abs === worktreeRoot ? "." : path.relative(worktreeRoot, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new PathError(`path ${target} escapes the worktree root`);
	}
	const posix = rel.split(path.sep).join("/");
	const parts = posix.split("/");
	const fileName = parts[parts.length - 1];
	const fileDir = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
	return { fileDir, fileName };
}

export function isIgnoredDir(name: string): boolean {
	const ignored = new Set([
		"node_modules",
		"dist",
		"build",
		".next",
		".nuxt",
		"out",
		"coverage",
		"target",
		"venv",
		".venv",
		"__pycache__",
		".pytest_cache",
		".tox",
		".mypy_cache",
	]);
	if (ignored.has(name)) return true;
	if (name.startsWith(".") && name !== ".") return true;
	return false;
}
