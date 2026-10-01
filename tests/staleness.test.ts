/** Tests for the stale-extension probe shared by /plans and the completion
 * auditor. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { newestSourceMtime, staleReloadHint, stalenessLine } from "../src/staleness.ts";

let root: string;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-stale-"));
	fs.mkdirSync(path.join(root, "src"));
	fs.mkdirSync(path.join(root, "tools"));
	fs.writeFileSync(path.join(root, "index.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Set every scanned file's mtime to `when`. */
function touchAll(when: number): void {
	for (const rel of ["index.ts", "src/a.ts", "tools"]) {
		const full = path.join(root, rel);
		if (fs.statSync(full).isDirectory()) {
			fs.writeFileSync(path.join(full, "b.ts"), "export const b = 1;\n");
			fs.utimesSync(path.join(full, "b.ts"), when / 1000, when / 1000);
		} else {
			fs.utimesSync(full, when / 1000, when / 1000);
		}
	}
}

describe("staleness probe", () => {
	it("finds the newest .ts mtime across the root, src and tools", () => {
		const now = Date.now();
		touchAll(now - 60_000);
		const newest = newestSourceMtime(root);
		assert.ok(newest >= now - 61_000 && newest <= now + 1_000, `unexpected mtime ${newest}`);
	});

	it("reports the copy as current when disk is older than the load time", () => {
		touchAll(Date.now() - 60_000);
		const line = stalenessLine(root, new Date());
		assert.match(line, /up to date/);
		assert.equal(staleReloadHint(root, new Date()), null, "no /reload advice when current");
	});

	it("reports the copy as stale and advises /reload when disk is newer", () => {
		const future = new Date(Date.now() + 10 * 60_000);
		touchAll(future.getTime());
		const line = stalenessLine(root, new Date(Date.now() - 60_000));
		assert.match(line, /newer than the loaded copy/);
		assert.match(line, /run \/reload/);
		const hint = staleReloadHint(root, new Date(Date.now() - 60_000));
		assert.ok(hint && hint.includes("/reload"), "the hint carries the /reload advice");
	});

	it("tolerates a same-second write instead of calling it stale", () => {
		// Without the 2s tolerance, a file written moments after load reads as
		// staleness and users chase a /reload that changes nothing.
		touchAll(Date.now());
		const line = stalenessLine(root, new Date());
		assert.match(line, /up to date/);
	});

	it("degrades to a loaded-timestamp line when the tree cannot be walked", () => {
		const line = stalenessLine(path.join(root, "does-not-exist"), new Date("2026-01-01T00:00:00.000Z"));
		assert.match(line, /Extension loaded: 2026-01-01T00:00:00.000Z/);
		assert.equal(staleReloadHint(path.join(root, "does-not-exist"), new Date()), null);
	});
});