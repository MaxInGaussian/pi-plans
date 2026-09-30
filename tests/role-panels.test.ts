/** First-use reviewer model/effort panel tests (v0.7.0): runtime adapter
 * priority (public facade first, F-010), effort panel rows, flow outcomes
 * (confirm / cancel / menu fallback / text guidance), and the cancel-error
 * contract (F-005). Panel wiring uses pi's own ModelSelectorComponent — the
 * "no menu fallback" assertion proves the panel was actually constructed. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { ModelSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	EffortPanelComponent,
	adapterModelRuntime,
	availableModels,
	effortItems,
	findModel,
	firstUseCancelledError,
	firstUseTextGuidance,
	runFirstUseFlow,
	type RolePanelHost,
} from "../src/role-panels.ts";
import { loadGlobalConfig } from "../src/global-state.ts";

const fakeModel = {
	provider: "devin",
	id: "glm-5.3",
	reasoning: true,
	thinkingLevelMap: { off: null, low: "low", high: "high" },
} as never;

let globalDir: string;
let previousGlobalDir: string | undefined;

before(() => {
	// Panel components use themed lists at CONSTRUCTION time.
	initTheme();
	previousGlobalDir = process.env.PI_PLANS_GLOBAL_DIR;
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-global-panels-"));
	process.env.PI_PLANS_GLOBAL_DIR = globalDir;
});

after(() => {
	if (previousGlobalDir === undefined) delete process.env.PI_PLANS_GLOBAL_DIR;
	else process.env.PI_PLANS_GLOBAL_DIR = previousGlobalDir;
	fs.rmSync(globalDir, { recursive: true, force: true });
});

function registryHost(overrides: Partial<RolePanelHost> = {}): RolePanelHost {
	return {
		mode: "rpc",
		hasUI: true,
		model: null,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [fakeModel],
			find: (provider: string, id: string) => (provider === "devin" && id === "glm-5.3" ? fakeModel : undefined),
			getError: () => undefined,
			refresh: async () => ({}),
		},
		ui: {},
		...overrides,
	};
}

describe("adapterModelRuntime (F-010, Q-5=A)", () => {
	it("prefers the public ModelRegistry facade over the private runtime field", () => {
		const calls: string[] = [];
		const host = registryHost({
			modelRegistry: {
				getAvailable: () => { calls.push("getAvailable"); return [fakeModel]; },
				find: () => { calls.push("find"); return fakeModel; },
				getError: () => { calls.push("getError"); return undefined; },
				refresh: async () => { calls.push("refresh"); return {}; },
				runtime: { getAvailableSnapshot: () => { calls.push("PRIVATE"); return []; } },
			},
		});
		const runtime = adapterModelRuntime(host)!;
		assert.ok(runtime);
		runtime.getAvailableSnapshot();
		(runtime.getModel as (p: string, i: string) => unknown)("devin", "glm-5.3");
		runtime.getError();
		void runtime.refresh();
		assert.deepEqual(calls, ["getAvailable", "find", "getError", "refresh"], "public facade wins; private runtime untouched");
	});

	it("falls back to the private runtime field when the facade is incomplete", () => {
		const host = registryHost({
			modelRegistry: { runtime: { getAvailableSnapshot: () => [fakeModel] } },
		});
		const runtime = adapterModelRuntime(host)!;
		assert.deepEqual((runtime.getAvailableSnapshot as () => unknown[])(), [fakeModel]);
	});

	it("returns null when neither path is usable", () => {
		assert.equal(adapterModelRuntime(registryHost({ modelRegistry: undefined })), null);
		assert.equal(adapterModelRuntime(registryHost({ modelRegistry: { getAvailable: () => [] } })), null);
	});

	it("availableModels / findModel tolerate missing or throwing registries", () => {
		assert.deepEqual(availableModels(registryHost({ modelRegistry: undefined })), []);
		assert.equal(findModel(registryHost({ modelRegistry: undefined }), "devin/glm-5.3"), null);
		assert.equal(findModel(registryHost(), "devin/missing"), null);
		assert.ok(findModel(registryHost(), "devin/glm-5.3"));
	});
});

describe("effort panel rows", () => {
	it("Default sentinel first, then pi-ai-supported levels", () => {
		const items = effortItems(fakeModel, null);
		assert.equal(items[0]!.value, "default");
		assert.match(items[0]!.description, /no --thinking flag/);
		assert.deepEqual(items.slice(1).map((item) => item.value), ["minimal", "low", "medium", "high"]);
	});

	it("an unsupported stored level stays visible with a marker", () => {
		const items = effortItems(fakeModel, "xhigh");
		const last = items.at(-1)!;
		assert.equal(last.value, "xhigh");
		assert.match(last.description, /not supported/);
	});

	it("the panel component renders the title and default row", () => {
		const component = new EffortPanelComponent(effortItems(fakeModel, null), "default", () => {}, () => {});
		const lines = component.render(100) as unknown as string[];
		assert.ok(lines.some((line) => line.includes("Reviewer Thinking Level")));
		assert.ok(lines.some((line) => line.includes("default")));
		assert.ok(lines.some((line) => line.includes("Esc to cancel")));
	});
});

describe("runFirstUseFlow outcomes", () => {
	it("menu path (hasUI non-TUI) confirms model + level and persists globally", async () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const selections: string[] = [];
		const host = registryHost({
			ui: { select: async (_title: string, options: string[]) => { const pick = options.find((o) => o.startsWith("devin/glm-5.3")) ?? options[0]!; selections.push(pick); return pick; } },
		});
		const outcome = await runFirstUseFlow(host, null);
		assert.equal(outcome.status, "confirmed");
		if (outcome.status !== "confirmed") return;
		assert.equal(outcome.modelSelector, "devin/glm-5.3");
		assert.equal(outcome.thinkingLevel, null, "effort menu first row = default → null");
		// The stored level is whatever the effort menu's first row (default) maps to: null.
		assert.equal(outcome.role.model_selector, "devin/glm-5.3");
		assert.equal(outcome.role.thinking_level, null);
		assert.ok(outcome.role.confirmed_at);
		assert.equal(loadGlobalConfig().config.reviewer.model_selector, "devin/glm-5.3");
		assert.equal(selections.length, 2, "model menu then effort menu");
	});

	it("menu cancel (undefined) cancels the whole gate without persisting", async () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const host = registryHost({ ui: { select: async () => undefined } });
		const outcome = await runFirstUseFlow(host, null);
		assert.deepEqual(outcome, { status: "cancelled", via: "menu" });
		assert.equal(fs.existsSync(path.join(globalDir, "config.json")), false, "nothing persisted on cancel");
	});

	it("UI-less hosts return unavailable (caller falls back to text guidance)", async () => {
		const host = registryHost({ hasUI: false, ui: {} });
		const outcome = await runFirstUseFlow(host, null);
		assert.equal(outcome.status, "unavailable");
	});

	it("TUI constructs pi's ModelSelectorComponent (no menu fallback) and Esc cancels", async () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		let sawPanel = false;
		const fakeTui = { requestRender: () => {} };
		const host = registryHost({
			mode: "tui",
			ui: {
				custom: async (factory: (...a: unknown[]) => unknown) => {
					const component = factory(fakeTui, {}, {}, () => {});
					if (component instanceof ModelSelectorComponent) sawPanel = true;
					// Simulate Esc: resolve the overlay promise with null (cancel).
					return null;
				},
			},
		});
		const outcome = await runFirstUseFlow(host, null);
		assert.ok(sawPanel, "the /model-style panel must be constructed, not the menu");
		assert.deepEqual(outcome, { status: "cancelled", via: "panel" });
	});

	it("TUI with an unusable registry falls back to menus", async () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		const host = registryHost({
			mode: "tui",
			modelRegistry: undefined,
			ui: {
				custom: async () => undefined,
				select: async (_t: string, options: string[]) => options[0],
			},
		});
		const outcome = await runFirstUseFlow(host, null);
		assert.equal(outcome.status, "unavailable", "no registry → no models for menus either");
	});

	it("panel construction failure falls back to menus instead of throwing", async () => {
		fs.rmSync(path.join(globalDir, "config.json"), { force: true });
		let menuCalls = 0;
		const host = registryHost({
			mode: "tui",
			ui: {
				custom: async () => {
					throw new Error("component drift");
				},
				select: async (_t: string, options: string[]) => {
					menuCalls += 1;
					return menuCalls === 1 ? options.find((o) => o.startsWith("devin/glm-5.3")) : options[0];
				},
			},
		});
		const outcome = await runFirstUseFlow(host, null);
		assert.equal(outcome.status, "confirmed");
	});
});

describe("gate error contracts", () => {
	it("the cancelled error tells the agent not to re-ask or retry", () => {
		const error = firstUseCancelledError("refine");
		assert.match(error.message, /closed the refine/);
		assert.match(error.message, /NOT re-ask/);
		assert.match(error.message, /\/config-pi-plans/);
	});

	it("text guidance embeds model ids and the exact set-role call", () => {
		const text = firstUseTextGuidance([fakeModel] as never, "/global/config.json");
		assert.match(text, /devin\/glm-5\.3/);
		assert.match(text, /modelSelector=<provider\/model>/);
		assert.match(text, /\/global\/config\.json/);
	});
});
