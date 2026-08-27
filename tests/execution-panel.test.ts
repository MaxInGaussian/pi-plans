import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	captureRepoSnapshot,
	completeCompletedItems,
	createExecutionPanelState,
	refreshExecutionPanel,
	restorePanelState,
	subtractSnapshots,
	toggleExpanded,
	truncateAnsi,
	visibleWidth,
} from "../src/execution-panel.ts";

function initGitRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const git = (args: string[]): void => {
		const result = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed`);
		}
	};
	git(["init"]);
	git(["config", "user.name", "Pi Plans Test"]);
	git(["config", "user.email", "test@example.com"]);
	fs.writeFileSync(path.join(dir, "tracked.txt"), "line 1\n");
	git(["add", "tracked.txt"]);
	git(["commit", "-m", "baseline"]);
}

describe("execution panel helpers", () => {
	let tmpRoot: string;
	let repo: string;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-panel-"));
		repo = path.join(tmpRoot, "repo");
		initGitRepo(repo);
	});

	after(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("captures diff snapshots and restores panel state", () => {
		const baseline = captureRepoSnapshot(repo);
		fs.appendFileSync(path.join(repo, "tracked.txt"), "line 2\n");
		fs.writeFileSync(path.join(repo, "new.txt"), "new file\n");
		const current = captureRepoSnapshot(repo);
		const delta = subtractSnapshots(baseline, current);
		assert.ok(delta.added >= 1);
		assert.ok(delta.files >= 1);

		const panel = createExecutionPanelState();
		panel.expanded = true;
		panel.baseline = baseline;
		panel.lastSnapshot = current;
		panel.touchedPaths = ["tracked.txt", "new.txt"];
		panel.itemSummaries = {
			"VC-001": {
				summary: {
					added: 1,
					removed: 0,
					files: 2,
					paths: ["tracked.txt", "new.txt"],
				},
			},
		};
		const restored = restorePanelState(panel);
		assert.ok(restored);
		assert.equal(restored?.expanded, true);
		assert.equal(restored?.baseline?.added, baseline.added);
		assert.equal(restored?.itemSummaries["VC-001"]?.summary?.files, 2);
		assert.deepEqual(restored?.touchedPaths, ["tracked.txt", "new.txt"]);
	});

	it("records completed-item summaries with touched paths", () => {
		fs.writeFileSync(path.join(repo, "tracked.txt"), "line 1\n");
		fs.rmSync(path.join(repo, "new.txt"), { force: true });
		const baseline = captureRepoSnapshot(repo);
		fs.appendFileSync(path.join(repo, "tracked.txt"), "line 2\n");
		fs.writeFileSync(path.join(repo, "new.txt"), "new file\n");

		const execution = {
			planPath: path.join(repo, "PLAN_v1.md"),
			items: [{ id: "VC-001", text: "`VC-001` demo item", done: true }],
			panel: createExecutionPanelState(),
		};
		execution.panel.baseline = baseline;
		execution.panel.lastSnapshot = baseline;
		execution.panel.touchedPaths = ["tracked.txt", "new.txt"];

		const summary = completeCompletedItems(execution as any, repo, ["VC-001"]);
		assert.ok(summary);
		assert.ok((summary?.added ?? 0) >= 1);
		assert.ok((summary?.files ?? 0) >= 1);
		assert.deepEqual(execution.panel.itemSummaries["VC-001"]?.summary?.paths, ["tracked.txt", "new.txt"]);
	});

	it("toggles expanded state", () => {
		const execution = { planPath: path.join(repo, "PLAN_v1.md"), items: [] as any[], panel: createExecutionPanelState() };
		assert.equal(toggleExpanded(execution), true);
		assert.equal(toggleExpanded(execution), false);
	});

	it("reuses one registered widget factory across refreshes", () => {
		const execution: any = {
			planPath: "/tmp/PLAN_v1.md",
			items: [{ id: "VC-001", text: "item", done: false }],
			panel: createExecutionPanelState(),
		};
		const factories: unknown[] = [];
		const theme = { fg: (_color: string, text: string) => `\u001b[38;5;2m${text}\u001b[39m`, strikethrough: (text: string) => text };
		const ctx = { ui: { setWidget: (_key: string, factory: any) => void factories.push(factory) } } as any;

		// Collapsed execution renders no widget at all — the bottom status bar
		// owns the count (each clear call pushes `undefined`).
		refreshExecutionPanel(ctx, execution);
		refreshExecutionPanel(ctx, execution); // stays cleared while collapsed
		assert.equal(factories.length, 2);
		assert.equal(factories[0], undefined);
		assert.equal(factories[1], undefined);

		// Expanding registers the detail widget exactly once.
		toggleExpanded(execution);
		refreshExecutionPanel(ctx, execution);
		assert.equal(factories.length, 3);
		const widget = (factories[2] as any)({}, theme);
		assert.ok(widget.render(80).length >= 1, "expanded render should list items");

		refreshExecutionPanel(ctx, execution); // same host: reuse, no re-register
		assert.equal(factories.length, 3);
		assert.ok(widget.render(80).length >= 1, "invalidate did not pick up latest state");

		// Clearing releases the slot so a future run registers afresh.
		refreshExecutionPanel(ctx, null);
		refreshExecutionPanel(ctx, execution);
		assert.equal(factories.length, 5); // #4 was the explicit clear (undefined)
	});
});

describe("execution panel width safety", () => {
	const styledTheme = {
		fg: (_color: string, text: string) => `\u001b[38;5;2m${text}\u001b[39m`,
		strikethrough: (text: string) => text,
	};

	it("measures CJK code points as double width and zero-width runs as none", () => {
		assert.equal(visibleWidth("新的"), 4);
		assert.equal(visibleWidth("菜单配置"), 8);
		assert.equal(visibleWidth("\uFF46\uFF55\uFF4C\uFF4C"), 8); // fullwidth “full”
		assert.equal(visibleWidth("e\u0301"), 1); // combining acute
		assert.equal(visibleWidth("\u2764\uFE0F"), 1); // variation selector
		assert.equal(visibleWidth("a\u001b[31mbc\u001b[0m"), 3); // ANSI ignored
	});

	it("truncates styled CJK lines within the requested width", () => {
		const cjk = "新的 Nemotron AIME 配置和批量入口能验证 seed vector、model pin、arm set 和 500 budget；" +
			"evidence: pr… 后续还有很长的中文描述需要被安全截断。".repeat(6);
		for (const width of [20, 40, 138]) {
			const line = truncateAnsi(styledTheme.fg("accent", cjk), width);
			assert.ok(
				visibleWidth(line) <= width,
				`width ${width}: rendered ${visibleWidth(line)} columns`,
			);
		}
	});

	it("renders every expanded checklist line inside the terminal width", () => {
		const execution: any = {
			planPath: "/tmp/PLAN_v1.md",
			items: [
				{
					id: "VC-001",
					// Mirrors the crash-log line that rendered at 155 columns in a 138-column terminal.
					text: "`VC-001` covers `I-001` 和 `I-003`；pass condition: 新的 Nemotron AIME 配置和批量入口能验证 seed vector、model pin、arm set 和 500 budget；evidence: pr…",
					done: false,
				},
				{ id: "VC-002", text: "`VC-002` plain ascii item that is also far too long to fit one line ".repeat(4), done: false },
			],
			panel: createExecutionPanelState(),
		};
		toggleExpanded(execution);

		let factory: ((tui: unknown, theme: unknown) => any) | undefined;
		refreshExecutionPanel({ ui: { setWidget: (_key: string, f: any) => void (factory = f) } } as any, execution);
		const widget = factory!({}, styledTheme);

		let sawEllipsis = false;
		for (const width of [20, 40, 80, 138]) {
			for (const line of widget.render(width)) {
				if (line.endsWith("…") || line.includes("…\u001b[0m")) sawEllipsis = true;
				assert.ok(
					visibleWidth(line) <= width,
					`width ${width}: rendered ${visibleWidth(line)} columns: ${JSON.stringify(line.slice(0, 60))}`,
				);
			}
		}
		assert.ok(sawEllipsis, "expected at least one truncated line with an ellipsis");
	});
});
