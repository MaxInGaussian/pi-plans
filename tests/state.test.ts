/** State test suite (node:test, stdlib only). */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	initState,
	getRun,
	readActive,
	recordDecision,
	resolveArtifactRoot,
	setLanguage,
	setArtifactRoot,
	setRefsRoot,
	setRole,
	setRunStatus,
	showConfig,
	runDirPath,
	startRun,
	StateError,
	testHooks,
	utcNow,
} from "../src/state.ts";

let tmpRoot: string;

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
	const raw = result.stdout.trim();
	return path.resolve(workdir, raw);
}

function readConfig(workdir: string): Record<string, any> {
	return JSON.parse(fs.readFileSync(path.join(commonDir(workdir), "pi-plans", "config.json"), "utf8"));
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-test-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	testHooks.now = () => new Date();
});

describe("init", () => {
	it("auto-inits and resolves state under the git common dir", () => {
		const workdir = mkWorkdir("fresh");
		const result = initState(workdir);
		assert.ok(result.notices.some((notice) => notice.includes("git init")));
		const state = path.join(workdir, ".git", "pi-plans");
		assert.equal(path.join(commonDir(workdir), "pi-plans"), state);
		const config = JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8"));
		assert.equal(config.schema, 1);
		assert.equal(config.language.tag, null);
		// v0.7.0: the reviewer role lives in the GLOBAL config, never in the
		// workspace config (the legacy key is stripped on every write).
		assert.equal("reviewer" in config, false);
		assert.equal("criticizer" in config, false);
		assert.equal("execution" in config, false);
		assert.equal(config.artifact_root, "./.git/pi-plans/plans");
		assert.equal(config.artifact_root_source, "unset");
		assert.equal(config.artifact_root_updated_at, null);
		assert.equal(config.refs_root, null);
		assert.equal(config.refs_root_source, "unset");
		assert.equal(config.refs_root_updated_at, null);
	});

	it("normalizes old configs missing the refs_root trio", () => {
		const workdir = mkWorkdir("refs-root-normalize");
		initState(workdir);
		const configPath = path.join(commonDir(workdir), "pi-plans", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		delete config.refs_root;
		delete config.refs_root_source;
		delete config.refs_root_updated_at;
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		const updated = initState(workdir);
		assert.equal(updated.config.refs_root, null);
		assert.equal(updated.config.refs_root_source, "unset");
		assert.equal(updated.config.refs_root_updated_at, null);
		assert.equal(readConfig(workdir).refs_root, null);
	});

	it("setRefsRoot persists the trio", () => {
		const workdir = mkWorkdir("refs-root-set");
		initState(workdir);
		setRefsRoot(workdir, ".git/pi-plans/refs", "user");
		assert.equal(readConfig(workdir).refs_root, ".git/pi-plans/refs");
		assert.equal(readConfig(workdir).refs_root_source, "user");
		assert.ok(typeof readConfig(workdir).refs_root_updated_at === "string");
		const shown = showConfig(workdir);
		assert.equal(shown.refs_root, ".git/pi-plans/refs");
		assert.equal(shown.refs_root_source, "user");
	});

	it("resolves a .git/-prefixed artifact root against the git common dir", () => {
		const workdir = mkWorkdir("artifact-root-gitdir");
		initState(workdir);
		// A plain relative root stays workdir-relative.
		assert.equal(resolveArtifactRoot(workdir, "./docs/pi-plans"), path.join(workdir, "docs", "pi-plans"));
		// A `.git/` root lands in the common dir, not `<workdir>/.git/...`.
		assert.equal(resolveArtifactRoot(workdir, "./.git/pi-plans/plans"), path.join(commonDir(workdir), "pi-plans", "plans"));
		assert.equal(resolveArtifactRoot(workdir, ".git/pi-plans/plans"), path.join(commonDir(workdir), "pi-plans", "plans"));
		// Absolute roots pass through.
		assert.equal(resolveArtifactRoot(workdir, "/tmp/abs-root"), "/tmp/abs-root");
	});

	it("default artifact root lands in the state dir of a linked worktree", () => {
		const main = mkWorkdir("wt-main");
		git(main, "init", "-q");
		initState(main);
		const linked = path.join(tmpRoot, "wt-linked");
		git(main, "worktree", "add", linked, "-b", "wt-branch");
		// A linked worktree's `.git` is a file, so the default must resolve via
		// the common dir or mkdirSync would fail with ENOTDIR. Compare on the
		// realpath: on macOS /var is a symlink to /private/var and `git rev-parse`
		// reports the short form while the resolver returns the real one.
		const expected = path.join(fs.realpathSync(commonDir(main)), "pi-plans", "plans");
		const { run } = startRun(linked, { topic: "linked run", skill: "plan-small", requestText: "x" });
		assert.equal(path.dirname(run.artifact_dir), expected);
		assert.ok(fs.existsSync(run.artifact_dir), "artifact directory created inside the shared state dir");
		assert.equal(getRun(linked, run.run_id)?.artifact_dir, run.artifact_dir);
	});

	it("migrates legacy artifact roots to ./.git/pi-plans/plans", () => {
		const workdir = mkWorkdir("artifact-root-migration");
		initState(workdir);
		const configPath = path.join(commonDir(workdir), "pi-plans", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.artifact_root = "docs/plans";
		delete config.artifact_root_source;
		delete config.artifact_root_updated_at;
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		const updated = initState(workdir);
		assert.equal(updated.config.artifact_root, "./.git/pi-plans/plans");
		assert.equal(updated.config.artifact_root_source, "unset");
		assert.equal(readConfig(workdir).artifact_root, "./.git/pi-plans/plans");
		assert.equal(readConfig(workdir).artifact_root_source, "unset");
	});

	it("roundtrips language, artifact root, and start-run", () => {
		const workdir = mkWorkdir("roundtrip");
		setLanguage(workdir, "zh-Hans", "user");
		setArtifactRoot(workdir, "./docs/pi-plans", "user");
		assert.equal(readConfig(workdir).language.tag, "zh-Hans");
		assert.equal(readConfig(workdir).artifact_root, "./docs/pi-plans");
		assert.equal(readConfig(workdir).artifact_root_source, "user");
		const { run } = startRun(workdir, {
			topic: "Example Plan",
			skill: "plan-small",
			requestText: "Plan the example",
		});
		assert.ok(fs.statSync(run.artifact_dir).isDirectory());
		const active = readActive(workdir);
		assert.equal(active?.run_id, run.run_id);
		assert.ok(fs.existsSync(path.join(active!.run_dir, "run.json")));
		const loaded = getRun(workdir, run.run_id);
		assert.equal(loaded?.status, "planning");
		recordDecision(workdir, run.run_id, {
			question: "Q?",
			options: ["a", "b"],
			answer: "a",
			answer_source: "user",
		});
		const decisions = fs.readFileSync(path.join(active!.run_dir, "decisions.jsonl"), "utf8").trim().split("\n");
		assert.equal(decisions.length, 1);
		assert.equal(JSON.parse(decisions[0]!).answer, "a");
	});

	it("subdir uses the enclosing repo", () => {
		const repo = mkWorkdir("enclosing");
		git(repo, "init", "-q");
		const sub = path.join(repo, "pkg", "sub");
		fs.mkdirSync(sub, { recursive: true });
		const result = initState(sub);
		assert.ok(result.notices.some((notice) => notice.includes("enclosing repository")));
		assert.ok(fs.existsSync(path.join(commonDir(repo), "pi-plans", "config.json")));
		assert.ok(!fs.existsSync(path.join(sub, ".git")));
	});

	it("supports private planning docs under .git/pi-plans/plans", () => {
		const workdir = mkWorkdir("private-artifact-root");
		setArtifactRoot(workdir, "./.git/pi-plans/plans", "user");
		const { run } = startRun(workdir, {
			topic: "Private Docs",
			skill: "plan-small",
			requestText: "Plan the example",
		});
		assert.ok(fs.statSync(run.artifact_dir).isDirectory());
		assert.equal(readConfig(workdir).artifact_root, "./.git/pi-plans/plans");
		assert.equal(run.artifact_dir, path.join(workdir, ".git", "pi-plans", "plans", `${run.created_at.slice(0, 10)}-private-docs`));
	});

	it("scrubs leaked GIT_DIR env", () => {
		const repoA = mkWorkdir("repo-a");
		git(repoA, "init", "-q");
		const workdir = mkWorkdir("repo-b");
		const stateUrl = new URL("../src/state.ts", import.meta.url).href;
		const driver = path.join(tmpRoot, "env-driver.mjs");
		fs.writeFileSync(
			driver,
			`import { initState } from ${JSON.stringify(stateUrl)};\ninitState(process.argv[2]);\n`,
		);
		const result = spawnSync(process.execPath, ["--experimental-strip-types", driver, workdir], {
			env: { ...process.env, GIT_DIR: path.join(repoA, ".git") },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr ?? "");
		assert.ok(fs.existsSync(path.join(workdir, ".git", "pi-plans", "config.json")));
		assert.ok(!fs.existsSync(path.join(repoA, ".git", "pi-plans")));
	});

	it("refuses broken .git entries and bare repos", () => {
		const broken = mkWorkdir("broken");
		fs.writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent/xyz\n");
		assert.throws(() => initState(broken), StateError);
		assert.ok(fs.statSync(path.join(broken, ".git")).isFile());

		const bare = mkWorkdir("bare");
		git(bare, "init", "-q", "--bare");
		assert.throws(() => initState(bare), StateError);
	});
});

describe("runs", () => {
	it("dedups run ids within the same second", () => {
		const workdir = mkWorkdir("dedup");
		git(workdir, "init", "-q");
		testHooks.now = () => new Date("2026-08-25T13:00:00Z");
		assert.equal(utcNow(), "2026-08-25T13:00:00Z");
		const first = startRun(workdir, { topic: "Same Topic", skill: "plan-normal", requestText: "x" });
		const second = startRun(workdir, { topic: "Same Topic", skill: "plan-normal", requestText: "x" });
		assert.equal(first.run.run_id, "20260825T130000Z-same-topic");
		assert.equal(second.run.run_id, "20260825T130000Z-same-topic-2");
	});

	it("tracks run status transitions", () => {
		const workdir = mkWorkdir("status");
		git(workdir, "init", "-q");
		const { run } = startRun(workdir, { topic: "status flow", skill: "plan-normal", requestText: "x" });
		const updated = setRunStatus(workdir, run.run_id, "accepted");
		assert.equal(updated.status, "accepted");
		assert.equal(getRun(workdir, run.run_id)?.status, "accepted");
		assert.throws(() => setRunStatus(workdir, run.run_id, "bogus"), StateError);
	});

	it("invokes the onStart callback exactly once when startRun succeeds", () => {
		const workdir = mkWorkdir("onstart");
		git(workdir, "init", "-q");
		const calls: string[] = [];
		const { run } = startRun(workdir, {
			topic: "marker demo",
			skill: "plan-normal",
			requestText: "x",
			onStart: (current) => {
				calls.push(current.run_id);
			},
		});
		assert.deepEqual(calls, [run.run_id]);
	});

	it("does not invoke the onStart callback when startRun throws", () => {
		const workdir = mkWorkdir("onstart-throw");
		git(workdir, "init", "-q");
		const calls: string[] = [];
		assert.throws(() =>
			startRun({
				workdir: path.resolve(workdir),
				artifact_root: "./docs/pi-plans",
				artifact_root_source: "user",
				artifact_root_updated_at: new Date().toISOString(),
				schema: 1,
				language: { tag: null, source: "unset", updated_at: null },
				execution: { model_selector: null, source: "unset", updated_at: null },
			}, {
				topic: "" as string,
				skill: "plan-normal",
				requestText: "x",
				onStart: () => calls.push("called"),
			} as any),
		);
		assert.equal(calls.length, 0);
	});
});

describe("legacy execution config", () => {
	it("strips legacy execution config on load and rewrite", () => {
		const workdir = mkWorkdir("legacy-exec");
		git(workdir, "init", "-q");
		initState(workdir);
		const configPath = path.join(commonDir(workdir), "pi-plans", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.execution = { model_selector: "zai/glm-5.3-flash:high", source: "user", updated_at: null };
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		const shown = showConfig(workdir) as any;
		assert.equal(shown.execution, undefined);
		setLanguage(workdir, "zh-Hans", "user");
		assert.equal(readConfig(workdir).execution, undefined);
	});
});

describe("set-role invariants (global config)", () => {
	// Each test gets its own throwaway global dir so tests never touch the
	// developer's real ~/.pi/pi-plans/config.json (F-002).
	let globalDir: string;
	let previousGlobalDir: string | undefined;

	before(() => {
		previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
		globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-test-"));
		process.env.PI_PLANS_GLOBAL_DIR = globalDir;
	});

	beforeEach(() => {
		// Each case starts from a pristine global file (no cross-test seeding).
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
	});

	after(() => {
		if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
		else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
		fs.rmSync(globalDir, { recursive: true, force: true });
	});

	function readGlobal(): Record<string, any> {
		return JSON.parse(fs.readFileSync(path.join(globalDir, "config.json"), "utf8"));
	}

	it("mode-only edits never forge or discard confirmations", () => {
		const workdir = mkWorkdir("roles");
		git(workdir, "init", "-q");
		initState(workdir);

		setRole(workdir, { role: "reviewer", mode: "current-session" });
		let role = readGlobal().reviewer;
		assert.equal(role.mode, "current-session");
		assert.equal(role.confirmed_at, null);

		setRole(workdir, {
			role: "reviewer",
			mode: "delegated-subagent",
			modelSelector: "deepseek/deepseek-v4-flash",
			confirmed: true,
		});
		role = readGlobal().reviewer;
		assert.equal(role.model_selector, "deepseek/deepseek-v4-flash");
		const stamped = role.confirmed_at;
		assert.ok(stamped);
		// No workspace reviewer key: the global config is the only home.
		assert.equal("reviewer" in readConfig(workdir), false);

		setRole(workdir, { role: "reviewer", mode: "current-session" });
		role = readGlobal().reviewer;
		assert.equal(role.mode, "current-session");
		assert.equal(role.model_selector, "deepseek/deepseek-v4-flash");
		assert.equal(role.confirmed_at, stamped);

		setRole(workdir, { role: "reviewer", resetConfirmation: true });
		role = readGlobal().reviewer;
		assert.equal(role.confirmed_at, null);
		assert.equal(role.model_selector, "deepseek/deepseek-v4-flash");

		assert.throws(() => setRole(workdir, { role: "reviewer", confirmed: true, resetConfirmation: true }), StateError);
	});

	it("confirmed requires a concrete selector in delegated mode", () => {
		const workdir = mkWorkdir("roles-confirm");
		git(workdir, "init", "-q");
		initState(workdir);
		assert.throws(
			() => setRole(workdir, { role: "reviewer", confirmed: true }),
			/exact provider\/model selector/,
		);
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false);
	});

	it("'inherit' is a full reset and never confirmable", () => {
		const workdir = mkWorkdir("roles-inherit");
		git(workdir, "init", "-q");
		initState(workdir);
		setRole(workdir, { role: "reviewer", modelSelector: "devin/claude-sonnet-5.5", thinkingLevel: "high", confirmed: true });
		setRole(workdir, { role: "reviewer", modelSelector: "inherit" });
		const role = readGlobal().reviewer;
		assert.equal(role.model_selector, null);
		assert.equal(role.confirmed_at, null);
		assert.throws(
			() => setRole(workdir, { role: "reviewer", modelSelector: "inherit", confirmed: true }),
			/cannot be combined with confirmed/,
		);
	});

	it("current-session mode is confirmable without a model", () => {
		const workdir = mkWorkdir("roles-current-session");
		git(workdir, "init", "-q");
		initState(workdir);
		setRole(workdir, { role: "reviewer", mode: "current-session", confirmed: true });
		const role = readGlobal().reviewer;
		assert.equal(role.mode, "current-session");
		assert.ok(role.confirmed_at);
		assert.equal(role.model_selector, null);
	});

	it("thinkingLevel: 'default' stores null; model switch resets the level unless passed", () => {
		const workdir = mkWorkdir("roles-thinking");
		git(workdir, "init", "-q");
		initState(workdir);
		setRole(workdir, { role: "reviewer", modelSelector: "devin/glm-5.3", thinkingLevel: "high", confirmed: true });
		assert.equal(readGlobal().reviewer.thinking_level, "high");

		setRole(workdir, { role: "reviewer", thinkingLevel: "default" });
		assert.equal(readGlobal().reviewer.thinking_level, null);

		setRole(workdir, { role: "reviewer", thinkingLevel: "off" });
		assert.equal(readGlobal().reviewer.thinking_level, "off");

		setRole(workdir, { role: "reviewer", modelSelector: "devin/claude-opus-5.5", confirmed: true });
		assert.equal(readGlobal().reviewer.thinking_level, null, "model switch resets the level");

		setRole(workdir, { role: "reviewer", modelSelector: "devin/glm-5.3", thinkingLevel: "xhigh", confirmed: true });
		assert.equal(readGlobal().reviewer.thinking_level, "xhigh");

		assert.throws(
			() => setRole(workdir, { role: "reviewer", thinkingLevel: "ultra" as string }),
			/thinkingLevel must be one of/,
		);
	});
});

describe("runDirPath", () => {
	it("resolves run directories read-only and returns null for unknown runs", () => {
		const workdir = mkWorkdir("run-dir-path");
		initState(workdir);
		const { run } = startRun(workdir, { topic: "rdp", skill: "plan-small", requestText: "t" });
		const dir = runDirPath(workdir, run.run_id);
		assert.ok(dir);
		assert.ok(fs.existsSync(path.join(dir, "run.json")));
		assert.equal(runDirPath(workdir, "20990101T000000Z-nope"), null);
		const notARepo = path.join(tmpRoot, "not-a-repo");
		fs.mkdirSync(notARepo, { recursive: true });
		assert.equal(runDirPath(notARepo, run.run_id), null);
	});
});
