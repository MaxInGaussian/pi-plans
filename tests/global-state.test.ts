/** Global reviewer-role config tests (node:test, stdlib only).
 *
 * Covers the v0.7.0 global config layer: read/write isolation via
 * PI_PLANS_GLOBAL_DIR, corrupt-file tolerance (never clobbered), legacy
 * workspace migration seeding rules (Q-1=A), read-path effective
 * resolution, and reviewerReady semantics (F-003). */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	initState,
	resolveEffectiveReviewer,
	setRole,
	showStateView,
	startRun,
	StateError,
} from "../src/state.ts";
import {
	applyGlobalRoleOptions,
	DEFAULT_GLOBAL_ROLE,
	loadGlobalConfig,
	legacyReviewerHasUserIntent,
	resolveGlobalConfigPath,
	reviewerReady,
	seedGlobalRoleFromLegacy,
	setGlobalRole,
	writeGlobalConfig,
	GlobalStateError,
} from "../src/global-state.ts";

let tmpRoot: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

function mkWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function git(workdir: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd: workdir, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr ?? "");
}

function commonDir(workdir: string): string {
	const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: workdir, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr ?? "");
	return path.resolve(workdir, result.stdout.trim());
}

function workspaceConfigPath(workdir: string): string {
	return path.join(commonDir(workdir), "pi-plans", "config.json");
}

function readWorkspaceConfig(workdir: string): Record<string, any> {
	return JSON.parse(fs.readFileSync(workspaceConfigPath(workdir), "utf8"));
}

function writeWorkspaceConfig(workdir: string, config: unknown): void {
	fs.writeFileSync(workspaceConfigPath(workdir), `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

function readGlobal(): Record<string, any> {
	return JSON.parse(fs.readFileSync(path.join(globalDir, "config.json"), "utf8"));
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-test-"));
	previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
	// Each run gets an isolated global dir; nested scopes override per-test.
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-dir-"));
	process.env.PI_PLANS_GLOBAL_DIR = globalDir;
});

after(() => {
	if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
	else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});

describe("global config IO", () => {
	beforeEach(() => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
	});

	it("resolves the config path under PI_PLANS_GLOBAL_DIR", () => {
		assert.equal(resolveGlobalConfigPath(), path.join(globalDir, "config.json"));
	});

	it("returns defaults when the file is missing (fresh)", () => {
		const loaded = loadGlobalConfig();
		assert.equal(loaded.fresh, true);
		assert.equal(loaded.corrupt, false);
		assert.deepEqual(loaded.config.reviewer, DEFAULT_GLOBAL_ROLE);
	});

	it("invalid JSON yields defaults + notice and is never clobbered", () => {
		fs.writeFileSync(path.join(globalDir, "config.json"), "{ not json", "utf8");
		const loaded = loadGlobalConfig();
		assert.equal(loaded.corrupt, true);
		assert.deepEqual(loaded.config.reviewer, DEFAULT_GLOBAL_ROLE);
		assert.ok(loaded.notices.some((n) => n.includes("invalid JSON")));
		// A later write is refused? No — explicit writes replace it; but reads
		// never rewrite. Verify the corrupt bytes are still on disk after load.
		assert.equal(fs.readFileSync(path.join(globalDir, "config.json"), "utf8"), "{ not json");
	});

	it("wrong schema is treated as corrupt", () => {
		fs.writeFileSync(path.join(globalDir, "config.json"), JSON.stringify({ schema: 99 }), "utf8");
		const loaded = loadGlobalConfig();
		assert.equal(loaded.corrupt, true);
		assert.ok(loaded.notices.some((n) => n.includes("schema")));
	});

	it("invalid thinking_level normalizes to null with a notice", () => {
		writeGlobalConfig({
			schema: 1,
			reviewer: { ...DEFAULT_GLOBAL_ROLE, thinking_level: "ultra" as never },
		});
		const loaded = loadGlobalConfig();
		assert.equal(loaded.config.reviewer.thinking_level, null);
		assert.ok(loaded.notices.some((n) => n.includes("thinking_level")));
	});

	it("roundtrips a valid config", () => {
		const { global } = setGlobalRole({ modelSelector: "devin/claude-sonnet-5.5", thinkingLevel: "high", confirmed: true });
		assert.equal(global.reviewer.model_selector, "devin/claude-sonnet-5.5");
		assert.equal(global.reviewer.thinking_level, "high");
		assert.ok(global.reviewer.confirmed_at);
		const loaded = loadGlobalConfig();
		assert.deepEqual(loaded.config, global);
	});
});

describe("applyGlobalRoleOptions invariants (F-003)", () => {
	it("reviewerReady requires a concrete confirmed selector for delegated mode", () => {
		assert.equal(reviewerReady({ ...DEFAULT_GLOBAL_ROLE }), false);
		assert.equal(
			reviewerReady({ ...DEFAULT_GLOBAL_ROLE, confirmed_at: "2026-01-01T00:00:00Z" }),
			false,
			"confirmed-inherit must not pass",
		);
		assert.equal(
			reviewerReady({
				...DEFAULT_GLOBAL_ROLE,
				model_selector: "devin/claude-sonnet-5.5",
				confirmed_at: "2026-01-01T00:00:00Z",
			}),
			true,
		);
		assert.equal(reviewerReady({ ...DEFAULT_GLOBAL_ROLE, mode: "current-session" }), true);
	});

	it("throws before mutation lands (no partial writes)", () => {
		setGlobalRole({ modelSelector: "devin/claude-sonnet-5.5", confirmed: true });
		const before = readGlobal();
		assert.throws(
			() => applyGlobalRoleOptions({ ...before.reviewer }, { confirmed: true, resetConfirmation: true }),
			GlobalStateError,
		);
		assert.throws(
			() => setGlobalRole({ modelSelector: "other/model", thinkingLevel: "ultra" }),
			GlobalStateError,
		);
		assert.deepEqual(readGlobal(), before);
	});
});

describe("legacy workspace migration (Q-1=A)", () => {
	beforeEach(() => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
	});

	it("seeds the global file once from an intent block on the first mutating call", () => {
		const workdir = mkWorkdir("migrate-intent");
		git(workdir, "init", "-q");
		initState(workdir);
		// Simulate a pre-0.7.0 workspace block: confirmed current-session.
		const config = readWorkspaceConfig(workdir);
		config.reviewer = {
			mode: "current-session",
			model_selector: null,
			name_prefix: "pi-plans-reviewer",
			confirmed_at: "2025-12-31T00:00:00Z",
		};
		writeWorkspaceConfig(workdir, config);

		const ensured = initState(workdir);
		assert.ok(ensured.notices.some((n) => n.includes("migrated the reviewer role")));
		assert.equal(readGlobal().reviewer.mode, "current-session");
		assert.equal("reviewer" in readWorkspaceConfig(workdir), false, "workspace key stripped");
	});

	it("confirmed-inherit seeds WITHOUT confirmation (re-asked once)", () => {
		const workdir = mkWorkdir("migrate-inherit");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = {
			mode: "delegated-subagent",
			model_selector: null,
			name_prefix: "pi-plans-reviewer",
			confirmed_at: "2025-12-31T00:00:00Z",
		};
		writeWorkspaceConfig(workdir, config);
		initState(workdir);
		const reviewer = readGlobal().reviewer;
		assert.equal(reviewer.model_selector, null);
		assert.equal(reviewer.confirmed_at, null);
		assert.equal(reviewerReady(reviewer), false);
	});

	it("an existing global file wins: intent block gets the ignored notice", () => {
		setGlobalRole({ modelSelector: "devin/claude-opus-5.5", confirmed: true });
		const workdir = mkWorkdir("migrate-ignored");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "current-session", model_selector: null, name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(workdir, config);
		const ensured = initState(workdir);
		assert.ok(ensured.notices.some((n) => n.includes("source of truth")));
		assert.equal(readGlobal().reviewer.model_selector, "devin/claude-opus-5.5");
		assert.equal("reviewer" in readWorkspaceConfig(workdir), false);
	});

	it("scaffold-only blocks are dropped silently", () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const workdir = mkWorkdir("migrate-scaffold");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "delegated-subagent", model_selector: null, name_prefix: "pi-plans-reviewer", confirmed_at: null };
		writeWorkspaceConfig(workdir, config);
		const ensured = initState(workdir);
		assert.ok(!ensured.notices.some((n) => n.includes("reviewer")));
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false);
		assert.equal("reviewer" in readWorkspaceConfig(workdir), false);
	});

	it("first touched workspace wins across repos (seed order)", () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const first = mkWorkdir("order-first");
		git(first, "init", "-q");
		initState(first);
		const configA = readWorkspaceConfig(first);
		configA.reviewer = { mode: "current-session", model_selector: null, name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(first, configA);
		const second = mkWorkdir("order-second");
		git(second, "init", "-q");
		initState(second);
		const configB = readWorkspaceConfig(second);
		configB.reviewer = { mode: "delegated-subagent", model_selector: "devin/glm-5.3", name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(second, configB);

		initState(first);
		assert.equal(readGlobal().reviewer.mode, "current-session");
		const ensuredSecond = initState(second);
		assert.ok(ensuredSecond.notices.some((n) => n.includes("source of truth")));
		assert.equal(readGlobal().reviewer.mode, "current-session", "second repo does not overwrite");
	});

	it("read paths resolve the legacy block in memory and never write", () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const workdir = mkWorkdir("read-effective");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "delegated-subagent", model_selector: "devin/kimi-k3", name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(workdir, config);
		// No mutating call yet: effective reviewer comes from the workspace block.
		const stateRoot = path.join(commonDir(workdir), "pi-plans");
		const effective = resolveEffectiveReviewer(stateRoot);
		assert.equal(effective.reviewer.model_selector, "devin/kimi-k3");
		assert.equal(effective.reviewer.confirmed_at, "2025-12-31T00:00:00Z");
		assert.equal(effective.reviewer.thinking_level, null);
		// And nothing was written to the global dir.
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false);
		// The workspace block is still there (untouched by the read).
		assert.equal(readWorkspaceConfig(workdir).reviewer.model_selector, "devin/kimi-k3");
	});

	it("global wins over legacy once it exists (read paths)", () => {
		setGlobalRole({ modelSelector: "devin/grok-4.7", confirmed: true });
		const workdir = mkWorkdir("read-global-wins");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "delegated-subagent", model_selector: "devin/kimi-k3", name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(workdir, config);
		const stateRoot = path.join(commonDir(workdir), "pi-plans");
		const effective = resolveEffectiveReviewer(stateRoot);
		assert.equal(effective.reviewer.model_selector, "devin/grok-4.7");
	});

	it("start-run migrates too (every mutating entry goes through ensureState)", () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const workdir = mkWorkdir("migrate-start-run");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "current-session", model_selector: null, name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(workdir, config);
		const { notices } = startRun(workdir, { topic: "migration", skill: "plan-small", requestText: "x" });
		assert.ok(notices.some((n) => n.includes("migrated the reviewer role")));
		assert.equal(readGlobal().reviewer.mode, "current-session");
	});
});

describe("setRole workspace stripping (F-013)", () => {
	it("setRole writes the global config and strips a legacy workspace key without git-init side effects", () => {
		const workdir = mkWorkdir("setrole-strip");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "current-session", model_selector: null, name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(workdir, config);
		const result = setRole(workdir, { role: "reviewer", modelSelector: "devin/claude-sonnet-5.5", thinkingLevel: "medium", confirmed: true });
		assert.equal(result.global.reviewer.model_selector, "devin/claude-sonnet-5.5");
		assert.equal("reviewer" in readWorkspaceConfig(workdir), false);
		// No auto git-init in a non-repo: setRole works outside any repository.
		const nonRepo = mkWorkdir("setrole-nonrepo");
		const outside = setRole(nonRepo, { role: "reviewer", modelSelector: "devin/claude-sonnet-5.5", confirmed: true });
		assert.equal(outside.stateRoot, null);
		assert.equal(outside.config, null);
		assert.equal(fs.existsSync(path.join(nonRepo, ".git")), false, "set-role never auto-inits a repo");
	});
});

describe("showStateView", () => {
	it("exposes the effective reviewer and notices without writing", () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const workdir = mkWorkdir("show-view");
		git(workdir, "init", "-q");
		initState(workdir);
		const config = readWorkspaceConfig(workdir);
		config.reviewer = { mode: "delegated-subagent", model_selector: "devin/kimi-k3", name_prefix: "pi-plans-reviewer", confirmed_at: "2025-12-31T00:00:00Z" };
		writeWorkspaceConfig(workdir, config);
		const view = showStateView(workdir);
		assert.equal(view.reviewer.model_selector, "devin/kimi-k3");
		assert.equal(view.globalConfigPath, path.join(globalDir, "config.json"));
		assert.ok(view.notices.some((n) => n.includes("not yet migrated")));
		assert.ok(readWorkspaceConfig(workdir).reviewer, "show does not strip the legacy block");
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false, "show never writes the global file");
	});
});

describe("seedGlobalRoleFromLegacy", () => {
	it("drops thinking_level and demotes confirmed-inherit", () => {
		assert.equal(legacyReviewerHasUserIntent({ mode: "delegated-subagent", model_selector: null, confirmed_at: null }), false);
		assert.equal(legacyReviewerHasUserIntent({ mode: "current-session", model_selector: null, confirmed_at: null }), true);
		const { role } = seedGlobalRoleFromLegacy({ mode: "delegated-subagent", model_selector: "a/b", thinking_level: "high", confirmed_at: "2025-12-31T00:00:00Z" });
		assert.equal(role.thinking_level, null, "legacy blocks never carry a level");
		assert.equal(role.confirmed_at, "2025-12-31T00:00:00Z");
		const inherit = seedGlobalRoleFromLegacy({ mode: "delegated-subagent", model_selector: null, confirmed_at: "2025-12-31T00:00:00Z" });
		assert.equal(inherit.role.confirmed_at, null);
	});
});

describe("StateError surface", () => {
	it("setRole surfaces GlobalStateError as StateError", () => {
		const workdir = mkWorkdir("stateerror");
		assert.throws(() => setRole(workdir, { role: "reviewer", mode: "bogus" as string }), StateError);
	});
});
