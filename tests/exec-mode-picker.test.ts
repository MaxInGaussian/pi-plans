import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { askExecutionMode, type ExecModeHost } from "../src/exec-mode-picker.ts";
import { CURRENT_SESSION_EXECUTOR, MAX_EXECUTOR_WORKERS, executorLabel, parseExecutorChoice, type ExecutorChoice } from "../src/executor-config.ts";
import { loadGlobalConfig, setGlobalRole, rememberLastExecutor, VALID_THINKING_LEVELS } from "../src/global-state.ts";
import { pickModelAndEffort } from "../src/role-panels.ts";

const modelA = { provider: "devin", id: "glm-5.3", reasoning: true, thinkingLevelMap: { off: null, low: "low", high: "high" } } as never;
const modelB = { provider: "zai", id: "fast", reasoning: false } as never;

let globalDir = "";
let previousGlobalDir: string | undefined;

before(() => {
	previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-exec-mode-"));
	process.env.PI_PLANS_GLOBAL_DIR = globalDir;
});

after(() => {
	if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
	else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
	fs.rmSync(globalDir, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(path.join(globalDir, "config.json"), { force: true });
});

interface Prompt {
	title: string;
	options: string[];
}

/** Menu host: answers each select() from `answers` (a function of the prompt). */
function menuHost(answer: (prompt: Prompt) => string | undefined, overrides: Partial<ExecModeHost> = {}) {
	const prompts: Prompt[] = [];
	const notices: string[] = [];
	const host: ExecModeHost = {
		mode: "rpc",
		hasUI: true,
		model: { provider: "main", id: "session" },
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [modelA, modelB],
			find: (provider: string, id: string) => [modelA, modelB].find((m) => (m as { provider: string; id: string }).provider === provider && (m as { id: string }).id === id),
			getError: () => undefined,
			refresh: async () => ({}),
		},
		ui: {
			select: async (title: string, options: string[]) => {
				const prompt = { title, options };
				prompts.push(prompt);
				return answer(prompt);
			},
			notify: (message: string) => notices.push(message),
		},
		...overrides,
	};
	return { host, prompts, notices };
}

const pick = (needle: string) => (prompt: Prompt) => prompt.options.find((option) => option.includes(needle));

describe("askExecutionMode", () => {
	it("current session: no model questions, remembered as the last choice", async () => {
		const { host, prompts } = menuHost(pick("Current session"));
		const outcome = await askExecutionMode(host);
		assert.deepEqual(outcome, { status: "chosen", choice: CURRENT_SESSION_EXECUTOR });
		assert.equal(prompts.length, 1);
		assert.match(prompts[0]!.options[0]!, /Current session — same model \(main\/session\)/);
		assert.deepEqual(loadGlobalConfig().config.executor_last, CURRENT_SESSION_EXECUTOR);
	});

	it("one delegated subagent: reuses the reviewer model and effort picker", async () => {
		const { host, prompts } = menuHost((prompt) => {
			if (prompt.title.startsWith("Where")) return pick("One delegated")(prompt);
			if (prompt.title.startsWith("Executor model?")) return "devin/glm-5.3";
			if (prompt.title.startsWith("Executor thinking level?")) return prompt.options.find((o) => o.startsWith("high"));
			return undefined;
		});
		const outcome = await askExecutionMode(host);
		assert.deepEqual(outcome, {
			status: "chosen",
			choice: { mode: "delegated", workers: 1, model_selector: "devin/glm-5.3", thinking_level: "high" },
		});
		assert.deepEqual(prompts.map((prompt) => prompt.title.split("?")[0]), ["Where should this plan run", "Executor model", "Executor thinking level"]);
		assert.ok(prompts[1]!.options.includes("zai/fast"));
	});

	it("several subagents: asks how many, then the model, and offers the default effort row", async () => {
		const { host, prompts } = menuHost((prompt) => {
			if (prompt.title.startsWith("Where")) return pick("Several")(prompt);
			if (prompt.title.startsWith("How many")) return "3";
			if (prompt.title.startsWith("Executor model?")) return "devin/glm-5.3";
			if (prompt.title.startsWith("Executor thinking level?")) return prompt.options[0];
			return undefined;
		});
		const outcome = await askExecutionMode(host);
		assert.deepEqual(outcome, {
			status: "chosen",
			choice: { mode: "delegated", workers: 3, model_selector: "devin/glm-5.3", thinking_level: null },
		});
		assert.deepEqual(prompts[1]!.options, ["2", "3", "4"]);
	});

	it("offers the last choice first and marks it", async () => {
		const last: ExecutorChoice = { mode: "delegated", workers: 2, model_selector: "devin/glm-5.3", thinking_level: "low" };
		const { host, prompts } = menuHost(() => undefined);
		await askExecutionMode(host, { last });
		assert.match(prompts[0]!.options[0]!, /^Several delegated subagents.*\(last used\)$/);
		assert.equal(prompts[0]!.options.length, 3);
	});

	it("puts the last worker count first in the count menu", async () => {
		const last: ExecutorChoice = { mode: "delegated", workers: 4, model_selector: "devin/glm-5.3", thinking_level: null };
		const { host, prompts } = menuHost((prompt) => (prompt.title.startsWith("Where") ? pick("Several")(prompt) : undefined));
		await askExecutionMode(host, { last });
		assert.deepEqual(prompts[1]!.options, ["4", "2", "3"]);
	});

	it("cancelling at any step picks nothing and remembers nothing", async () => {
		for (const stopAt of ["Where", "How many", "Executor model", "Executor thinking"]) {
			const { host } = menuHost((prompt) => {
				if (prompt.title.startsWith(stopAt)) return undefined;
				if (prompt.title.startsWith("Where")) return pick("Several")(prompt);
				if (prompt.title.startsWith("How many")) return "2";
				if (prompt.title.startsWith("Executor model")) return "devin/glm-5.3";
				return prompt.options[0];
			});
			assert.deepEqual(await askExecutionMode(host), { status: "cancelled" }, `cancel at ${stopAt}`);
		}
		assert.equal(loadGlobalConfig().config.executor_last, undefined);
	});

	it("falls back to the current session when no model picker is possible", async () => {
		const { host, notices } = menuHost(pick("One delegated"), {
			mode: "tui",
			modelRegistry: undefined,
			ui: {
				custom: async () => undefined,
				select: async (_title: string, options: string[]) => options.find((o) => o.includes("One delegated")),
				notify: (message: string) => void notices.push(message),
			},
		});
		const outcome = await askExecutionMode(host);
		assert.deepEqual(outcome, { status: "chosen", choice: CURRENT_SESSION_EXECUTOR });
		assert.match(notices[0] ?? "", /running in the current session instead/);
	});

	it("renders the Chinese chrome", async () => {
		const { host, prompts } = menuHost(() => undefined);
		await askExecutionMode(host, { lang: "zh" });
		assert.equal(prompts[0]!.title, "在哪里执行这份计划？");
		assert.match(prompts[0]!.options[0]!, /当前会话/);
	});

	it("does not touch the saved reviewer role", async () => {
		setGlobalRole({ modelSelector: "devin/glm-5.3", thinkingLevel: "high", confirmed: true });
		const before = loadGlobalConfig().config.reviewer;
		const { host } = menuHost(pick("Current session"));
		await askExecutionMode(host);
		assert.deepEqual(loadGlobalConfig().config.reviewer, before);
	});
});

describe("pickModelAndEffort", () => {
	it("returns the choice without persisting anything", async () => {
		const { host } = menuHost((prompt) => (prompt.title.includes("model") ? "devin/glm-5.3" : prompt.options.find((o) => o.startsWith("low"))));
		const outcome = await pickModelAndEffort(host, { storedLevel: null });
		assert.equal(outcome.status, "picked");
		assert.equal((outcome as { thinkingLevel: string | null }).thinkingLevel, "low");
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false);
	});

	it("keeps the reviewer wording by default", async () => {
		const { host, prompts } = menuHost(() => undefined);
		await pickModelAndEffort(host, { storedLevel: null });
		assert.match(prompts[0]!.title, /^Reviewer model\?/);
	});
});

describe("executor config", () => {
	it("validates strictly", () => {
		const ok = parseExecutorChoice({ mode: "delegated", workers: 2, model_selector: "a/b", thinking_level: "high" }, VALID_THINKING_LEVELS);
		assert.deepEqual(ok, { mode: "delegated", workers: 2, model_selector: "a/b", thinking_level: "high" });
		for (const bad of [
			null,
			[],
			{ mode: "remote" },
			{ mode: "delegated", workers: 0, model_selector: "a/b" },
			{ mode: "delegated", workers: MAX_EXECUTOR_WORKERS + 1, model_selector: "a/b" },
			{ mode: "delegated", workers: 1.5, model_selector: "a/b" },
			{ mode: "delegated", workers: 1 },
			{ mode: "delegated", workers: 1, model_selector: "nomodel" },
			{ mode: "delegated", workers: 1, model_selector: "a/b", thinking_level: "extreme" },
			{ mode: "delegated", workers: 1, model_selector: "a/b", extra: true },
			{ mode: "current-session", workers: 2 },
			{ mode: "current-session", model_selector: "a/b" },
		]) {
			assert.ok("error" in (parseExecutorChoice(bad, VALID_THINKING_LEVELS) as object), JSON.stringify(bad));
		}
		assert.deepEqual(parseExecutorChoice({ mode: "current-session" }, VALID_THINKING_LEVELS), CURRENT_SESSION_EXECUTOR);
	});

	it("labels choices for the UI", () => {
		assert.equal(executorLabel(null), "current session");
		assert.equal(executorLabel(CURRENT_SESSION_EXECUTOR), "current session");
		assert.equal(executorLabel({ mode: "delegated", workers: 1, model_selector: "a/b", thinking_level: null }), "1 worker · a/b");
		assert.equal(executorLabel({ mode: "delegated", workers: 3, model_selector: "a/b", thinking_level: "high" }), "3 workers · a/b:high");
	});

	it("keeps executor_last across reviewer-role writes and ignores a corrupt value", () => {
		const choice: ExecutorChoice = { mode: "delegated", workers: 2, model_selector: "a/b", thinking_level: "high" };
		rememberLastExecutor(choice);
		setGlobalRole({ modelSelector: "devin/glm-5.3", confirmed: true });
		assert.deepEqual(loadGlobalConfig().config.executor_last, choice);
		fs.writeFileSync(path.join(globalDir, "config.json"), JSON.stringify({ schema: 1, reviewer: loadGlobalConfig().config.reviewer, executor_last: { mode: "delegated", workers: 99, model_selector: "a/b" } }));
		const loaded = loadGlobalConfig();
		assert.equal(loaded.config.executor_last, undefined);
		assert.ok(loaded.notices.some((notice) => notice.includes("ignoring executor_last")));
		assert.equal(loaded.corrupt, false, "a bad optional key never poisons the reviewer config");
	});
});
