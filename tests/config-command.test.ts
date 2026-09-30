import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

import { configPiPlansCommand } from "../src/config-command.ts";
import { startRun } from "../src/state.ts";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

interface Recorded {
	selects: Array<{ question: string; labels: string[] }>;
	inputs: Array<{ prompt: string }>;
	notifies: Array<{ message: string; severity: string }>;
}

interface HarnessOptions {
	select: (question: string, labels: string[]) => string | undefined | Promise<string | undefined>;
	input?: (prompt: string) => string | undefined | Promise<string | undefined>;
	model?: { provider: string; id: string } | null;
	scopedModels?: Array<{ model: { provider: string; id: string } }>;
	availableModels?: Array<{ provider: string; id: string }>;
}

let root: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-config-command-"));
	previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-config-command-"));
	process.env.PI_PLANS_GLOBAL_DIR = globalDir;
});

beforeEach(() => {
	fs.rmSync(path.join(globalDir, "config.json"), { force: true });
});

after(() => {
	if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
	else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});

function workdir(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function configPath(workdirPath: string): string {
	return path.join(workdirPath, ".git", "pi-plans", "config.json");
}

function runPath(workdirPath: string, runId: string): string {
	return path.join(workdirPath, ".git", "pi-plans", "runs", runId, "run.json");
}

function readGlobal(): any {
	return JSON.parse(fs.readFileSync(path.join(globalDir, "config.json"), "utf8"));
}

function readJson(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeContext(workdirPath: string, options: HarnessOptions) {
	const recorded: Recorded = {
		selects: [],
		inputs: [],
		notifies: [],
	};
	const ctx = {
		cwd: workdirPath,
		hasUI: true,
		mode: "rpc",
		model: options.model ?? null,
		scopedModels: options.scopedModels ?? [],
		modelRegistry: {
			getAvailable: () => options.availableModels ?? [],
		},
		ui: {
			notify: (message: string, severity: string) => {
				recorded.notifies.push({ message, severity });
			},
			select: async (question: string, labels: string[]) => {
				recorded.selects.push({ question, labels });
				return options.select(question, labels);
			},
			input: async (prompt: string) => {
				recorded.inputs.push({ prompt });
				return options.input?.(prompt);
			},
		},
	} as unknown as Parameters<typeof configPiPlansCommand>[1];
	return { ctx, recorded };
}

/** Default answers for the four workspace menus (language/artifact/refs/graph). */
function workspaceDefaults(question: string, labels: string[]): string | undefined {
	if (question === "Language?") return labels[0];
	if (question === "Artifact root?") return labels[0];
	if (question === "Refs root (plan-with-refs downloads)?") return labels[0];
	if (question === "Code graph?") return labels[0];
	return undefined;
}

describe("config-pi-plans command", () => {
	it("registers the slash command in index.ts and delegates to the helper", () => {
		const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		assert.match(source, /import \{ configPiPlansCommand \} from "\.\/src\/config-command\.ts";/);
		assert.match(source, /registerCommand\("config-pi-plans"/);
		assert.match(source, /await configPiPlansCommand\(args, ctx\);/);
	});

	it("writes the workspace settings and switches the reviewer mode globally; current-session skips the model step (Q-3)", async () => {
		const dir = workdir("full-wizard");
		const { ctx, recorded } = makeContext(dir, {
			model: { provider: "live", id: "pro" },
			availableModels: [{ provider: "registry", id: "critic" }],
			select: (question, labels) => {
				if (question === "Reviewer mode?") return labels.find((label) => label.includes("Switch to current-session"));
				return workspaceDefaults(question, labels);
			},
		});

		await configPiPlansCommand("", ctx);

		assert.ok(fs.existsSync(configPath(dir)));
		const config = readJson(configPath(dir));
		assert.equal(config.language.tag, "zh-Hans", "labels[0] on the language menu");
		assert.equal(config.artifact_root, "./.git/pi-plans/plans");
		assert.equal(config.refs_root, ".git/pi-plans/refs");
		assert.equal(config.graph_enabled, true, "labels[0] on the graph menu enables");
		assert.equal("reviewer" in config, false, "the reviewer role never lands in the workspace config");
		assert.equal("criticizer" in config, false);
		// The mode switch went to the GLOBAL config.
		const globalRole = readGlobal().reviewer;
		assert.equal(globalRole.mode, "current-session");
		// Q-3: no reviewer-model prompt in current-session mode.
		assert.equal(recorded.selects.some((entry) => entry.question === "Reviewer model?"), false);
	});

	it("shows a keep/change entry menu when the reviewer is unconfirmed", async () => {
		const dir = workdir("entry-menu");
		const { ctx, recorded } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Reviewer mode?") return labels[0];
				if (question === "Reviewer model?") return labels[0];
				return workspaceDefaults(question, labels);
			},
		});

		await configPiPlansCommand("", ctx);

		const entry = recorded.selects.find((entry) => entry.question === "Reviewer model?");
		assert.ok(entry);
		assert.deepEqual(entry?.labels, [
			"1. Keep current (unconfirmed; first refine will ask)",
			"2. Choose model & thinking level…",
		]);
		// Keeping the unconfirmed role writes nothing to the global config.
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false);
		assert.equal(fs.existsSync(configPath(dir)), true);
	});

	it("change flow via menus persists model + level to the global config", async () => {
		const dir = workdir("change-menus");
		const { ctx, recorded } = makeContext(dir, {
			model: { provider: "live", id: "pro" },
			scopedModels: [{ model: { provider: "scoped", id: "model-a" } }],
			availableModels: [
				{ provider: "scoped", id: "model-a" },
				{ provider: "registry", id: "model-b" },
			],
			select: (question, labels) => {
				if (question === "Reviewer mode?") return labels[0];
				if (question === "Reviewer model?") {
					const modelMenus = recorded.selects.filter((e) => e.question === "Reviewer model?");
					if (modelMenus.length === 1) return labels.find((label) => label.includes("Choose model & thinking level"));
					return labels.find((label) => label.includes("Use registry/model-b"));
				}
				if (question.startsWith("Reviewer thinking level?")) return labels[0];
				return workspaceDefaults(question, labels);
			},
		});

		await configPiPlansCommand("", ctx);

		const globalRole = readGlobal().reviewer;
		assert.equal(globalRole.mode, "delegated-subagent");
		assert.equal(globalRole.model_selector, "registry/model-b");
		assert.equal(globalRole.thinking_level, null, "first row = default → null");
		assert.ok(globalRole.confirmed_at);
		// The workspace config stays reviewer-free.
		assert.equal("reviewer" in readJson(configPath(dir)), false);
	});

	it("an invalid manual selector keeps the current role and still writes workspace settings (F-011)", async () => {
		const dir = workdir("invalid-model");
		const { ctx, recorded } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Reviewer mode?") return labels[0];
				if (question === "Reviewer model?") {
					const modelMenus = recorded.selects.filter((e) => e.question === "Reviewer model?");
					if (modelMenus.length === 1) return labels.find((label) => label.includes("Choose model & thinking level"));
					return labels.find((label) => label.includes("Other..."));
				}
				return workspaceDefaults(question, labels);
			},
			input: () => "bad selector",
		});

		await configPiPlansCommand("", ctx);

		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false, "nothing persisted for the reviewer");
		assert.equal(fs.existsSync(configPath(dir)), true, "workspace settings still written");
		assert.equal(
			recorded.notifies.some((entry) => entry.message.includes("Model selector must be an exact provider/model string.")),
			true,
		);
		assert.equal(
			recorded.notifies.some((entry) => entry.message.includes("Reviewer change failed")),
			true,
			"the summary reports the failed reviewer change",
		);
	});

	it("does not write when the wizard is cancelled", async () => {
		const dir = workdir("cancelled");
		const { ctx } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Language?") return undefined;
				return labels[0];
			},
		});

		await configPiPlansCommand("", ctx);

		assert.equal(fs.existsSync(configPath(dir)), false);
	});

	it("keeps the active run snapshot unchanged", async () => {
		const dir = workdir("active-run");
		const { run } = startRun(dir, { topic: "config", skill: "plan-small", requestText: "x" });
		const before = readJson(runPath(dir, run.run_id));
		const { ctx } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Reviewer mode?") return labels.find((label) => label.includes("Keep delegated-subagent"));
				if (question === "Reviewer model?") return labels[0];
				return workspaceDefaults(question, labels);
			},
		});

		await configPiPlansCommand("", ctx);

		const after = readJson(runPath(dir, run.run_id));
		assert.deepEqual(after, before);
		const config = readJson(configPath(dir));
		assert.equal("reviewer" in config, false);
	});

	it("with an active run, a successful save never notifies an error (impl review F-001)", async () => {
		const dir = workdir("active-run-refresh-guard");
		startRun(dir, { topic: "config-guard", skill: "plan-small", requestText: "x" });
		const { ctx, recorded } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Language?") return labels.find((label) => label.includes("zh-Hans")) ?? labels[0];
				return labels[0];
			},
		});

		await configPiPlansCommand("", ctx);

		assert.equal(fs.existsSync(configPath(dir)), true, "the wizard must keep saving");
		assert.equal(
			recorded.notifies.find((entry) => entry.severity === "error"),
			undefined,
			`refreshUiLanguage must not throw into the wizard error path: ${JSON.stringify(recorded.notifies)}`,
		);
	});
});
