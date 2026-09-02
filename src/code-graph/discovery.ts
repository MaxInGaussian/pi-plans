/**
 * Discovery: walk the worktree, filter out unwanted directories, classify files
 * by language and return a deterministic file order.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isIgnoredDir } from "./paths.ts";
import type { Language } from "./types.ts";

export interface DiscoveredFile {
	fileDir: string;
	fileName: string;
	absolutePath: string;
	language: Language;
}

const LANGUAGE_BY_EXT: Record<string, Language> = {
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".ts": "typescript",
	".tsx": "tsx",
	".py": "python",
};

function classify(filename: string): Language | null {
	const ext = path.extname(filename).toLowerCase();
	return LANGUAGE_BY_EXT[ext] ?? null;
}

/** Whether a relative POSIX path would be indexed (used by update-graph/drift path filtering). */
export function isIndexablePath(relativePath: string): boolean {
	const base = relativePath.split("/").pop() ?? relativePath;
	return classify(base) !== null && !hasIgnoredDirectory(relativePath);
}

function hasIgnoredDirectory(relativePath: string): boolean {
	const segments = relativePath.split(/[\\/]+/).filter(Boolean);
	return segments.slice(0, -1).some((segment) => isIgnoredDir(segment));
}

function runGitLsFiles(cwd: string): string[] | null {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete env[key];
	const result = spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
		cwd,
		env,
		encoding: "utf8",
	});
	if (result.status !== 0) return null;
	const raw = result.stdout ?? "";
	const files = raw.split("\0").filter((entry) => entry.length > 0);
	if (!files.length) return null;
	return files;
}

function walkFs(root: string, onFile: (abs: string) => void): void {
	const stack = ["."];
	while (stack.length) {
		const rel = stack.pop()!;
		const abs = path.join(root, rel);
		let stat;
		try {
			stat = fs.lstatSync(abs);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			const name = path.basename(abs);
			if (rel !== "." && isIgnoredDir(name)) continue;
			for (const entry of fs.readdirSync(abs)) stack.push(path.join(rel, entry));
			continue;
		}
		if (stat.isFile()) onFile(abs);
	}
}

export interface DiscoverOptions {
	worktreeRoot: string;
}

export function discoverFiles(options: DiscoverOptions): DiscoveredFile[] {
	const gitFiles = runGitLsFiles(options.worktreeRoot);
	const out = new Map<string, DiscoveredFile>();
	const register = (abs: string) => {
		if (!abs.startsWith(options.worktreeRoot + path.sep) && abs !== options.worktreeRoot) return;
		const rel = path.relative(options.worktreeRoot, abs);
		if (hasIgnoredDirectory(rel)) return;
		const lang = classify(path.basename(rel));
		if (!lang) return;
		const posix = rel.split(path.sep).join("/");
		const parts = posix.split("/");
		const fileName = parts[parts.length - 1];
		const fileDir = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
		out.set(posix, {
			fileDir,
			fileName,
			absolutePath: abs,
			language: lang,
		});
	};
	if (gitFiles && gitFiles.length > 0) {
		for (const rel of gitFiles) register(path.resolve(options.worktreeRoot, rel));
	}
	walkFs(options.worktreeRoot, (abs) => {
		if (!out.has(path.relative(options.worktreeRoot, abs).split(path.sep).join("/"))) {
			register(abs);
		}
	});
	return [...out.values()].sort((a, b) => {
		const aKey = `${a.fileDir}/${a.fileName}`;
		const bKey = `${b.fileDir}/${b.fileName}`;
		return aKey.localeCompare(bKey);
	});
}
