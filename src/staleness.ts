/**
 * Stale-extension probe (v0.7.1, extracted).
 *
 * pi imports an extension's module graph once per process, so a fix written
 * to disk while the session is running stays invisible until /reload. Both
 * /plans (which reports it) and the execution reviewer (which suggests it when
 * a verdict cannot be read) need the same answer, so the probe lives here
 * rather than in index.ts -- exec.ts already depends on index.ts's imports and
 * a back-import would close a cycle.
 *
 * index.ts records when its own copy was loaded; this module never holds that
 * state, so callers pass it in and stay testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** mtime (ms) of the newest .ts file under the extension root, or 0. */
export function newestSourceMtime(baseDir: string): number {
	const stack = [baseDir, path.join(baseDir, "src"), path.join(baseDir, "tools")];
	let newest = 0;
	while (stack.length) {
		const dir = stack.pop()!;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".ts")) {
				const mtime = fs.statSync(full).mtimeMs;
				if (mtime > newest) newest = mtime;
			}
		}
	}
	return newest;
}

/** One line describing whether the loaded copy is current. A clock-skew
 * tolerance keeps a same-second write from reading as staleness. */
export function stalenessLine(baseDir: string, loadedAt: Date): string {
	try {
		if (newestSourceMtime(baseDir) > loadedAt.getTime() + 2000) {
			return `⚠ extension code on disk is newer than the loaded copy (loaded ${loadedAt.toISOString()}); run /reload to pick it up`;
		}
		return `Extension loaded: ${loadedAt.toISOString()} (up to date)`;
	} catch {
		return `Extension loaded: ${loadedAt.toISOString()}`;
	}
}

/** Short form for inline hints: the /reload advice, or null when current. */
export function staleReloadHint(baseDir: string, loadedAt: Date): string | null {
	const line = stalenessLine(baseDir, loadedAt);
	return line.startsWith("⚠") ? line : null;
}