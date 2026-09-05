import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { after, before, describe, it } from "node:test";

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

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-config-command-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function workdir(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function configPath(workdirPath: string): string {
	return path.join(workdirPath, ".git", "pi_plans", "config.json");
}

function runPath(workdirPath: string, runId: string): string {
	return path.join(workdirPath, ".git", "pi_plans", "runs", runId, "run.json");
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

describe("config-pi-plans command", () => {
	it("registers the slash command in index.ts and delegates to the helper", () => {
		const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		assert.match(source, /import \{ configPiPlansCommand \} from "\.\/src\/config-command\.ts";/);
		assert.match(source, /registerCommand\("config-pi-plans"/);
		assert.match(source, /await configPiPlansCommand\(args, ctx\);/);
	});

	it("writes the full wizard into config.json", async () => {
		const dir = workdir("full-wizard");
		const { ctx } = makeContext(dir, {
			model: { provider: "live", id: "pro" },
			availableModels: [{ provider: "registry", id: "critic" }],
			select: (question, labels) => {
				if (question === "Language?") return labels.find((label) => label.includes("en"));
				if (question === "Artifact root?") return labels.find((label) => label.includes("./.git/pi_plans/plans"));
				if (question === "Code graph?") return labels.find((label) => label.includes("Disable code graph"));
				if (question === "Reviewer mode?") return labels.find((label) => label.includes("Switch to current-session"));
				if (question === "Reviewer model?") return labels.find((label) => label.includes("Use current session model (live/pro)"));
				if (question === "Criticizer mode?") return labels.find((label) => label.includes("Keep delegated-subagent"));
				if (question === "Criticizer model?") return labels.find((label) => label.includes("Other..."));
				return undefined;
			},
			input: (prompt) => {
				if (prompt === "Criticizer model selector:") return "custom/critic-model";
				return undefined;
			},
		});

		await configPiPlansCommand("", ctx);

		assert.ok(fs.existsSync(configPath(dir)));
		const config = readJson(configPath(dir));
		assert.equal(config.language.tag, "en");
		assert.equal(config.language.source, "user");
		assert.equal(config.artifact_root, "./.git/pi_plans/plans");
		assert.equal(config.artifact_root_source, "user");
		assert.equal(config.graph_enabled, false);
		assert.equal(config.reviewer.mode, "current-session");
		assert.equal(config.reviewer.model_selector, "live/pro");
		assert.equal(config.criticizer.mode, "delegated-subagent");
		assert.equal(config.criticizer.model_selector, "custom/critic-model");
		assert.ok(config.reviewer.confirmed_at);
		assert.ok(config.criticizer.confirmed_at);
	});

	it("dedupes model choices and falls back to the live model when no default is stored", async () => {
		const dir = workdir("model-menu");
		const { ctx, recorded } = makeContext(dir, {
			model: { provider: "live", id: "pro" },
			scopedModels: [{ model: { provider: "scoped", id: "model-a" } }],
			availableModels: [
				{ provider: "scoped", id: "model-a" },
				{ provider: "registry", id: "model-b" },
			],
			select: (question, labels) => {
				if (question === "Language?") return labels[0];
				if (question === "Artifact root?") return labels[0];
				if (question === "Code graph?") return labels[0];
				if (question === "Reviewer mode?") return labels[0];
				if (question === "Reviewer model?") return labels[0];
				if (question === "Criticizer mode?") return undefined;
				return undefined;
			},
		});

		await configPiPlansCommand("", ctx);

		const reviewerModelPrompt = recorded.selects.find((entry) => entry.question === "Reviewer model?");
		assert.ok(reviewerModelPrompt);
		assert.deepEqual(reviewerModelPrompt?.labels, [
			"1. Keep current default (inherit live model: live/pro)",
			"2. Use current session model (live/pro)",
			"3. Use available model (scoped/model-a)",
			"4. Use available model (registry/model-b)",
			"5. Other...",
		]);
		assert.equal(fs.existsSync(configPath(dir)), false);
		assert.equal(recorded.notifies.at(-1)?.severity, "warning");
	});

	it("rejects an invalid model selector entered through Other and leaves config untouched", async () => {
		const dir = workdir("invalid-model");
		const { ctx, recorded } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Language?") return labels[0];
				if (question === "Artifact root?") return labels[0];
				if (question === "Code graph?") return labels[0];
				if (question === "Reviewer mode?") return labels[0];
				if (question === "Reviewer model?") return labels.find((label) => label.includes("Other..."));
				return undefined;
			},
			input: () => "bad selector",
		});

		await configPiPlansCommand("", ctx);

		assert.equal(fs.existsSync(configPath(dir)), false);
		assert.equal(recorded.notifies.some((entry) => entry.message.includes("Model selector must be an exact provider/model string.")), true);
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

	it("renders a two-option inherit menu when no model sources exist", async () => {
		const dir = workdir("empty-model-menu");
		const { ctx, recorded } = makeContext(dir, {
			model: null,
			scopedModels: [],
			availableModels: [],
			select: (question, labels) => {
				if (question === "Language?") return labels[0];
				if (question === "Artifact root?") return labels[0];
				if (question === "Code graph?") return labels[0];
				if (question === "Reviewer mode?") return labels[0];
				if (question === "Reviewer model?") return labels[0];
				return undefined;
			},
		});

		await configPiPlansCommand("", ctx);

		const reviewerModelPrompt = recorded.selects.find((entry) => entry.question === "Reviewer model?");
		assert.ok(reviewerModelPrompt);
		assert.deepEqual(reviewerModelPrompt?.labels, [
			"1. Keep current default (inherit)",
			"2. Other...",
		]);
		assert.equal(fs.existsSync(configPath(dir)), false);
	});

	it("keeps the active run snapshot unchanged", async () => {
		const dir = workdir("active-run");
		const { run } = startRun(dir, { topic: "config", skill: "plan-small", requestText: "x" });
		const before = readJson(runPath(dir, run.run_id));
		const { ctx } = makeContext(dir, {
			select: (question, labels) => {
				if (question === "Language?") return labels.find((label) => label.includes("en"));
				if (question === "Artifact root?") return labels.find((label) => label.includes("./.git/pi_plans/plans"));
				if (question === "Code graph?") return labels.find((label) => label.includes("Enable code graph"));
				if (question === "Reviewer mode?") return labels.find((label) => label.includes("Keep delegated-subagent"));
				if (question === "Reviewer model?") return labels[0];
				if (question === "Criticizer mode?") return labels.find((label) => label.includes("Keep delegated-subagent"));
				if (question === "Criticizer model?") return labels[0];
				return undefined;
			},
		});

		await configPiPlansCommand("", ctx);

		const after = readJson(runPath(dir, run.run_id));
		assert.deepEqual(after, before);
		const config = readJson(configPath(dir));
		assert.equal(config.language.tag, "en");
		assert.equal(config.artifact_root, "./.git/pi_plans/plans");
		assert.equal(config.reviewer.model_selector, null);
		assert.ok(config.reviewer.confirmed_at);
	});
});
