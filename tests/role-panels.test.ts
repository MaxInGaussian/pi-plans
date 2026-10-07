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
	BorderedPanel,
	EffortPanelComponent,
	adapterModelRuntime,
	availableModels,
	borderColorFrom,
	effortItems,
	findModel,
	firstUseCancelledError,
	firstUseTextGuidance,
	runFirstUseFlow,
	type RolePanelHost,
} from "../src/role-panels.ts";
import { loadGlobalConfig } from "../src/global-state.ts";
import { visibleWidth } from "../src/refine-ui-helpers.ts";

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
		assert.match(items[0]!.description, /no explicit level/);
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

describe("BorderedPanel (v0.7.1 full-box panels)", () => {
	const plain = (s: string) => s;
	function inner(lines: string[]) {
		return {
			rendered: [] as number[],
			render(width: number) {
				this.rendered.push(width);
				return lines;
			},
			handleInput: (d: string) => { void d; },
			invalidate: () => {},
		};
	}
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

	it("draws left/right rules and strips the inner component's own rules", () => {
		const panel = new BorderedPanel(inner(["─".repeat(20), "hello", "─".repeat(20)]), plain);
		const lines = panel.render(22).map(strip);
		assert.equal(lines[0], `┌${"─".repeat(20)}┐`);
		assert.equal(lines[lines.length - 1], `└${"─".repeat(20)}┘`);
		assert.equal(lines[1], `│hello${" ".repeat(15)}│`);
		assert.equal(lines.length, 3, "two inner rules replaced by two box rules (height preserved)");
		assert.equal(lines.filter((l) => l.includes("hello")).length, 1);
	});

	it("renders the inner component two columns narrower", () => {
		const innerCmp = inner(["body"]);
		new BorderedPanel(innerCmp, plain).render(30);
		assert.deepEqual(innerCmp.rendered, [28]);
	});

	it("pads short lines and truncates overlong ones to the box width", () => {
		const short = new BorderedPanel(inner(["ab"]), plain).render(10).map(strip);
		assert.equal(short[1], `│ab${" ".repeat(6)}│`);
		assert.equal(strip(short[1]!).length, 10);
		const long = new BorderedPanel(inner(["x".repeat(50)]), plain).render(10).map(strip);
		assert.equal(strip(long[1]!), `│${"x".repeat(8)}│`, "overlong content is clipped to the box width, never overflows");
		assert.equal(strip(long[1]!).length, 10);
	});

	it("relays focus, keyboard, invalidate and dispose to the inner component", () => {
		const seen: string[] = [];
		const target = {
			focused: false,
			render: () => ["x"],
			handleInput: (d: string) => seen.push(`key:${d}`),
			invalidate: () => seen.push("invalidate"),
			dispose: () => seen.push("dispose"),
		};
		const panel = new BorderedPanel(target);
		panel.focused = true;
		assert.equal(target.focused, true, "TUI focus must reach the inner search input");
		assert.equal(panel.focused, true);
		panel.handleInput("j");
		panel.invalidate();
		panel.dispose();
		assert.deepEqual(seen, ["key:j", "invalidate", "dispose"]);
	});

	it("translates mouse coordinates into the inner component's space", () => {
		let received: Record<string, number> | null = null;
		const target = {
			render: () => ["a", "b", "c"],
			handleMouse: (e: { x: number; y: number; width: number; height: number }) => {
				received = { x: e.x, y: e.y, width: e.width, height: e.height };
				return undefined;
			},
			invalidate: () => {},
		};
		const panel = new BorderedPanel(target);
		// Click the second content row (box row 0 = top rule, row 3 = first content).
		panel.handleMouse({ x: 5, y: 3, width: 20, height: 5 } as never);
		assert.deepEqual(received, { x: 4, y: 2, width: 18, height: 3 });
		received = null;
		panel.handleMouse({ x: 5, y: 0, width: 20, height: 5 } as never);
		assert.equal(received, null, "the top rule row is not part of the inner component");
	});

	it("paints the border with the host theme when one is supplied", () => {
		const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
		const colored = new BorderedPanel(inner(["body"]), borderColorFrom(theme)).render(10);
		assert.ok(colored[0]!.startsWith("<border>┌"), "border uses the theme's border color");
		const plainOut = new BorderedPanel(inner(["body"]), borderColorFrom(undefined)).render(10);
		assert.equal(strip(plainOut[0]!), `┌${"─".repeat(8)}┐`, "a missing theme degrades to plain text");
	});

	it("the effort panel now renders inside a full box without double rules", () => {
		const bare = new EffortPanelComponent(effortItems(fakeModel, null), "default", () => {}, () => {});
		const boxed = new BorderedPanel(bare, plain).render(60).map(strip);
		assert.ok(boxed[0]!.startsWith("┌"), "top rule");
		assert.ok(boxed[boxed.length - 1]!.startsWith("└"), "bottom rule");
		assert.equal(boxed.filter((l) => /^─+$/.test(l)).length, 0, "no leftover bare inner rules");
		assert.equal(boxed.filter((l) => l.startsWith("│") && l.endsWith("│")).length, boxed.length - 2);
	});

	it("every row is boxed and exactly the requested width, even when content wraps", () => {
		// Narrow widths make the footer Text wrap onto a second line; that
		// continuation row must still carry both side rules.
		for (const width of [40, 46, 60, 80]) {
			const bare = new EffortPanelComponent(effortItems(fakeModel, "high"), "default", () => {}, () => {});
			const lines = new BorderedPanel(bare, plain).render(width).map(strip);
			for (const [i, line] of lines.entries()) {
				const isEdge = i === 0 || i === lines.length - 1;
				if (isEdge) {
					assert.ok(line.startsWith("┌") || line.startsWith("└"), `row ${i} @${width} is a rule`);
					continue;
				}
				assert.ok(line.startsWith("│") && line.endsWith("│"), `row ${i} @${width} must have both rules`);
			}
			assert.equal(new Set(lines.map((l) => l.length)).size, 1, `all rows equal width @${width}`);
			assert.equal(lines[0]!.length, width);
		}
	});

	it("renders without a global pi theme (no bare DynamicBorder left in our panels)", () => {
		// A no-arg DynamicBorder reads pi's global theme, which is undefined when
		// the extension is loaded through jiti. The effort panel must not rely on it.
		const bare = new EffortPanelComponent(effortItems(fakeModel, null), "default", () => {}, () => {});
		assert.doesNotThrow(() => new BorderedPanel(bare, plain).render(60));
	});

	it("keeps the right border aligned on the focused search row (CURSOR_MARKER is zero-width)", () => {
		// A focused Input emits pi's CURSOR_MARKER — an APC sequence (ESC _ … BEL).
		// If width math counted its payload as text, that row would measure too
		// wide and its right-hand rule would sit short of the other rows.
		const marker = "\x1b_pi:c\x07";
		assert.equal(visibleWidth(marker), 0, "CURSOR_MARKER must measure zero columns");

		for (const focused of [false, true]) {
			const bare = new EffortPanelComponent(effortItems(fakeModel, null), "default", () => {}, () => {});
			(bare as unknown as { focused: boolean }).focused = focused;
			const lines = new BorderedPanel(bare, plain).render(46);
			const widths = new Set(lines.map((l) => visibleWidth(l)));
			assert.deepEqual([...widths], [46], `every row is exactly the box width (focused=${focused})`);
			for (const [i, line] of lines.entries()) {
				if (i === 0 || i === lines.length - 1) continue;
				assert.ok(line.startsWith("│") && line.endsWith("│"), `row ${i} keeps both rules (focused=${focused})`);
			}
		}
	});

	it("treats OSC/DCS/APC and simple escapes as zero-width, and SGR as atomic", () => {
		assert.equal(visibleWidth("\x1b]0;window title\x07x"), 1, "OSC payload is zero-width");
		assert.equal(visibleWidth("\x1bPi:c\x07x"), 1, "APC payload is zero-width");
		assert.equal(visibleWidth("\x1bPx;y\x1b\\x"), 1, "DCS terminated by ST is zero-width");
		assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3, "SGR still measures its text only");
		assert.equal(visibleWidth("\x1b(Bx"), 1, "charset-select escape is zero-width");
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
					// v0.7.1: the panel is wrapped in a BorderedPanel; unwrap to
					// assert pi's ModelSelectorComponent is still what we drive.
					const inner = component instanceof BorderedPanel ? component.content : component;
					if (inner instanceof ModelSelectorComponent) sawPanel = true;
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
