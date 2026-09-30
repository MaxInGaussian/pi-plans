/**
 * Task dashboard lifecycle (v0.6.1): the aboveEditor widget registers when
 * execution starts, reflects task-tool updates, renders the expanded tree on
 * toggle, unregisters on stop/complete with the status line cleared, and
 * rebuilds after restoreFromSession.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	executionContextMessage,
	getExecution,
	isDashboardExpanded,
	persistTaskProgress,
	restoreFromSession,
	startExecution,
	stopExecution,
	toggleDashboardExpanded,
	updateStatusWidget,
} from "../src/exec.ts";
import { applyTaskUpdate } from "../src/task-tool.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { initState, startRun } from "../src/state.ts";
import { setMessagingApi } from "../src/messaging.ts";

let root: string;
let counter = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-dash-life-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const PLAN = `## Tasks

- Task-1: parser — files: src/a.ts; wave: 1
- Task-2: tool — files: src/b.ts; wave: 2

### Execution Waves

- wave 1: Task-1 — first
- wave 2: Task-2 — second

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: parser
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: tool
`;

function freshWorkdir(): string {
	counter += 1;
	const workdir = path.join(root, `repo-${counter}`);
	fs.mkdirSync(workdir, { recursive: true });
	initState(workdir);
	return workdir;
}

interface PanelCall {
	key: string;
	content: unknown;
	placement?: string;
}

function makeHarness(workdir: string) {
	const recorded: {
		widgets: PanelCall[];
		status: string | undefined;
		entries: Array<{ customType: string; data?: unknown; content?: string }>;
		messages: string[];
	} = { widgets: [], status: undefined, entries: [], messages: [] };
	const ctx = {
		cwd: workdir,
		sessionManager: {},
		hasUI: true,
		mode: "print" as const,
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				recorded.status = text;
			},
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				if (content === undefined) {
					recorded.widgets.push({ key, content: undefined });
					return;
				}
				recorded.widgets.push({ key, content, placement: options?.placement });
			},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	setMessagingApi({
		appendEntry: (customType: string, data: unknown) => recorded.entries.push({ customType, data }),
		sendMessage: (message: { customType: string; content: string }) => recorded.messages.push(message.content),
		sendUserMessage: async () => {},
	});
	return { ctx, recorded };
}

function lastWidget(h: ReturnType<typeof makeHarness>): PanelCall | undefined {
	return h.recorded.widgets.at(-1);
}

function renderWidget(call: PanelCall | undefined, width: number): string[] {
	if (!call || call.content === undefined) return [];
	const factory = call.content as (ui: unknown, theme: unknown) => { render(w: number): string[] };
	return factory({ theme: { fg: (_c: string, s: string) => s } }, { fg: (_c: string, s: string) => s }).render(width);
}

async function start(h: ReturnType<typeof makeHarness>, workdir: string, name = "PLAN_v1.md") {
	const planPath = path.join(workdir, name);
	fs.writeFileSync(planPath, PLAN, "utf8");
	await startExecution(h.ctx, { planPath, planTasks: parsePlanTasks(PLAN), items: parseChecklist(PLAN) });
}

describe("dashboard lifecycle", () => {
	it("registers the dashboard above the editor when execution starts", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await start(h, workdir);
		const call = lastWidget(h);
		assert.ok(call, "widget registered");
		assert.equal(call!.key, "pi-plans-dashboard");
		assert.equal(call!.placement, "aboveEditor");
		const lines = renderWidget(call, 100);
		assert.ok(lines.join("\n").includes("Task-1"));
		assert.match(h.recorded.status ?? "", /tasks 0\/2/);
		await stopExecution(h.ctx, "done");
	});

	it("task updates refresh the widget content and status line", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await start(h, workdir);
		applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "a-tests green");
		persistTaskProgress(h.ctx);
		updateStatusWidget(h.ctx);
		assert.match(h.recorded.status ?? "", /tasks 1\/2/);
		const lines = renderWidget(lastWidget(h), 100);
		assert.ok(lines.join("\n").includes("Task-2"), "current task advances");
		await stopExecution(h.ctx, "done");
	});

	it("toggle switches the widget to the expanded tree view", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await start(h, workdir);
		toggleDashboardExpanded(h.ctx);
		assert.equal(isDashboardExpanded(), true);
		const lines = renderWidget(lastWidget(h), 120);
		assert.ok(lines.join("\n").includes("Verification checks:"), "tree view lists checks");
		toggleDashboardExpanded(h.ctx);
		assert.equal(isDashboardExpanded(), false);
		const compact = renderWidget(lastWidget(h), 100);
		assert.ok(!compact.join("\n").includes("Verification checks:"), "compact view returns");
		await stopExecution(h.ctx, "done");
	});

	it("clears the widget and status line on stop", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await start(h, workdir);
		await stopExecution(h.ctx, "user stop");
		const call = lastWidget(h);
		assert.ok(call && call.content === undefined, "widget unregistered");
	});

	it("rebuilds the dashboard after restoreFromSession", async () => {
		const workdir = freshWorkdir();
		startRun(workdir, { topic: "restore", skill: "plan-small", requestText: "x" });
		const h = makeHarness(workdir);
		await start(h, workdir);
		applyTaskUpdate(getExecution()!.tasks, "Task-1", "complete", "e1");
		persistTaskProgress(h.ctx);
		const snapshot = getExecution();
		await stopExecution(h.ctx, "restart");
		assert.equal(getExecution(), null);
		const h2 = makeHarness(workdir);
		await restoreFromSession(h2.ctx, [{ type: "custom", customType: "pi-plans-exec", data: snapshot }]);
		assert.ok(getExecution(), "execution restored");
		const lines = renderWidget(lastWidget(h2), 100);
		assert.ok(lines.join("\n").includes("Task-2"), "restored view shows the open task");
		await stopExecution(h2.ctx, "done");
	});

	it("injection names the current wave and the task tool", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await start(h, workdir);
		const injection = executionContextMessage(h.ctx)!;
		assert.match(injection, /Current wave 1 open tasks:/);
		assert.match(injection, /plans_update_task/);
		await stopExecution(h.ctx, "done");
	});
});
