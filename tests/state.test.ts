/** State test suite (node:test, stdlib only). */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	initState,
	getRun,
	readActive,
	recordDecision,
	setLanguage,
	setArtifactRoot,
	setRole,
	setRunStatus,
	showConfig,
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
	return JSON.parse(fs.readFileSync(path.join(commonDir(workdir), "pi_plans", "config.json"), "utf8"));
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
		const state = path.join(workdir, ".git", "pi_plans");
		assert.equal(path.join(commonDir(workdir), "pi_plans"), state);
		const config = JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8"));
		assert.equal(config.schema, 1);
		assert.equal(config.language.tag, null);
		assert.equal(config.reviewer.mode, "delegated-subagent");
		assert.equal(config.reviewer.confirmed_at, null);
		assert.equal(config.criticizer.confirmed_at, null);
		assert.equal("execution" in config, false);
		assert.equal(config.artifact_root, "./docs/pi-plans");
		assert.equal(config.artifact_root_source, "unset");
		assert.equal(config.artifact_root_updated_at, null);
	});

	it("migrates legacy artifact roots to ./docs/pi-plans", () => {
		const workdir = mkWorkdir("artifact-root-migration");
		initState(workdir);
		const configPath = path.join(commonDir(workdir), "pi_plans", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.artifact_root = "docs/plans";
		delete config.artifact_root_source;
		delete config.artifact_root_updated_at;
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		const updated = initState(workdir);
		assert.equal(updated.config.artifact_root, "./docs/pi-plans");
		assert.equal(updated.config.artifact_root_source, "unset");
		assert.equal(readConfig(workdir).artifact_root, "./docs/pi-plans");
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
		assert.ok(fs.existsSync(path.join(commonDir(repo), "pi_plans", "config.json")));
		assert.ok(!fs.existsSync(path.join(sub, ".git")));
	});

	it("supports private planning docs under .git/pi_plans/plans", () => {
		const workdir = mkWorkdir("private-artifact-root");
		setArtifactRoot(workdir, "./.git/pi_plans/plans", "user");
		const { run } = startRun(workdir, {
			topic: "Private Docs",
			skill: "plan-small",
			requestText: "Plan the example",
		});
		assert.ok(fs.statSync(run.artifact_dir).isDirectory());
		assert.equal(readConfig(workdir).artifact_root, "./.git/pi_plans/plans");
		assert.equal(run.artifact_dir, path.join(workdir, ".git", "pi_plans", "plans", `${run.created_at.slice(0, 10)}-private-docs`));
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
		assert.ok(fs.existsSync(path.join(workdir, ".git", "pi_plans", "config.json")));
		assert.ok(!fs.existsSync(path.join(repoA, ".git", "pi_plans")));
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
				reviewer: { mode: "delegated-subagent", model_selector: null, name_prefix: "pi-plans-reviewer", confirmed_at: null },
				criticizer: { mode: "delegated-subagent", model_selector: null, name_prefix: "pi-plans-criticizer", confirmed_at: null },
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
		const configPath = path.join(commonDir(workdir), "pi_plans", "config.json");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		config.execution = { model_selector: "zai/glm-5.3-flash:high", source: "user", updated_at: null };
		fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		const shown = showConfig(workdir) as any;
		assert.equal(shown.execution, undefined);
		setLanguage(workdir, "zh-Hans", "user");
		assert.equal(readConfig(workdir).execution, undefined);
	});
});

describe("set-role invariants", () => {
	it("mode-only edits never forge or discard confirmations", () => {
		const workdir = mkWorkdir("roles");
		git(workdir, "init", "-q");
		initState(workdir);

		setRole(workdir, { role: "reviewer", mode: "current-session" });
		let role = readConfig(workdir).reviewer;
		assert.equal(role.mode, "current-session");
		assert.equal(role.confirmed_at, null);

		setRole(workdir, {
			role: "reviewer",
			mode: "delegated-subagent",
			modelSelector: "deepseek/deepseek-v4-flash",
			confirmed: true,
		});
		role = readConfig(workdir).reviewer;
		assert.equal(role.model_selector, "deepseek/deepseek-v4-flash");
		const stamped = role.confirmed_at;
		assert.ok(stamped);

		setRole(workdir, { role: "reviewer", mode: "current-session" });
		role = readConfig(workdir).reviewer;
		assert.equal(role.mode, "current-session");
		assert.equal(role.model_selector, "deepseek/deepseek-v4-flash");
		assert.equal(role.confirmed_at, stamped);

		setRole(workdir, { role: "reviewer", resetConfirmation: true });
		role = readConfig(workdir).reviewer;
		assert.equal(role.confirmed_at, null);
		assert.equal(role.model_selector, "deepseek/deepseek-v4-flash");

		// Confirmed-inherit is distinguishable from never-confirmed.
		setRole(workdir, { role: "criticizer", confirmed: true });
		role = readConfig(workdir).criticizer;
		assert.equal(role.model_selector, null);
		assert.ok(role.confirmed_at);

		assert.throws(() => setRole(workdir, { role: "reviewer", confirmed: true, resetConfirmation: true }), StateError);
	});
});
