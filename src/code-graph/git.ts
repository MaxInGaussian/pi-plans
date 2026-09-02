/**
 * Git porcelain helpers for the code-graph loop. All calls go through
 * spawnSync with scrubbed environment (mirrors paths.ts) and never introduce
 * new dependencies.
 */

import { spawnSync } from "node:child_process";

function runGit(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	// -c core.quotepath=false keeps non-ASCII paths literal instead of octal-escaped.
	const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd, env, encoding: "utf8" });
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export class GitError extends Error {}

function must(cwd: string, args: string[], what: string): string {
	const result = runGit(cwd, args);
	if (result.code !== 0) {
		throw new GitError(`${what} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
	}
	return result.stdout;
}

/** Current HEAD commit SHA (empty string when no commits exist). */
export function gitHead(cwd: string): string {
	const result = runGit(cwd, ["rev-parse", "HEAD"]);
	if (result.code !== 0) return "";
	return result.stdout.trim();
}

export interface PorcelainEntry {
	/** Single-letter + optional sub-status code, e.g. "M", " M", "A", "??", "R ". */
	status: string;
	/** Path for normal entries; NEW path for rename/copy entries. */
	path: string;
	/** Original path for rename (R) / copy (C) entries; null otherwise. */
	origPath: string | null;
}

/** Parse `git status --porcelain` output, including rename (R old -> new). */
export function parsePorcelain(stdout: string): PorcelainEntry[] {
	const entries: PorcelainEntry[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const status = line.slice(0, 2);
		const rest = line.slice(3);
		if (rest.startsWith('"') && rest.endsWith('"')) {
			// Quoted path with possible embedded quotes; renames use "old" -> "new".
			const inner = rest.slice(1, -1);
			const arrow = inner.indexOf('" -> "');
			if ((status[0] === "R" || status[0] === "C") && arrow >= 0) {
				entries.push({ status, path: inner.slice(arrow + 6), origPath: inner.slice(0, arrow) });
			} else {
				entries.push({ status, path: inner, origPath: null });
			}
			continue;
		}
		const arrow = rest.indexOf(" -> ");
		if ((status[0] === "R" || status[0] === "C") && arrow >= 0) {
			entries.push({ status, path: rest.slice(arrow + 4), origPath: rest.slice(0, arrow) });
		} else {
			entries.push({ status, path: rest, origPath: null });
		}
	}
	return entries;
}

/** `git status --porcelain` parsed; includes untracked (`??`) and rename entries. */
export function gitStatusPorcelain(cwd: string): PorcelainEntry[] {
	return parsePorcelain(must(cwd, ["status", "--porcelain"], "git status"));
}

/** `git diff --name-only` against HEAD (or --base commit); excludes untracked. */
export function gitDiffNameOnly(cwd: string, base?: string): string[] {
	const args = base ? ["diff", "--name-only", base] : ["diff", "--name-only", "HEAD"];
	const stdout = must(cwd, args, "git diff --name-only");
	return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Stage everything and commit; returns the new HEAD (or "" when nothing to commit). */
export function gitAddAllAndCommit(cwd: string, message: string): string {
	const status = gitStatusPorcelain(cwd);
	if (status.length === 0) return "";
	must(cwd, ["add", "-A"], "git add -A");
	must(cwd, ["commit", "-m", message], "git commit");
	return gitHead(cwd);
}

/** Parse "--flag" booleans and "--key value" pairs from a slash-command arg string. */
export function parseCommandArgs(args: string): { flags: Set<string>; values: Map<string, string> } {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const tokens = args.split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) continue;
		if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("--")) {
			values.set(token.slice(2), tokens[i + 1]!);
			i++;
		} else {
			flags.add(token.slice(2));
		}
	}
	return { flags, values };
}
