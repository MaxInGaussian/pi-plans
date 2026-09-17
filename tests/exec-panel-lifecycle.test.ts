/**
 * Fixed tasks' status panel lifecycle (0.4.0 feature 2, VC-006): the
 * aboveEditor widget registers when execution starts, refreshes from marker
 * updates, unregisters on complete/stop with the status line cleared, and
 * rebuilds after restoreFromSession. The panel never installs timers.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	executionContextMessage,
	registerExecutionTurnHandlers,
	restoreFromSession,
	startExecution,
	stopExecution,
	updateStatusWidget,
} from "../src/exec.ts";
import { initState, startRun } from "../src/state.ts";

let root: string;
let counter = 0;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-panel-life-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

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
		status: string | undefined;
		statusCalls: number;
		widgets: PanelCall[];
		entries: Array<{ customType: string; data: unknown }>;
		messages: Array<{ customType: string }>;
		notifies: Array<{ message: string }>;
	} = { status: undefined, statusCalls: 0, widgets: [], entries: [], messages: [], notifies: [] };
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => {
			recorded.entries.push({ customType, data });
		},
		sendMessage: (message: { customType: string }) => {
			recorded.messages.push({ customType: message.customType });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: workdir,
		hasUI: true,
		sessionManager: {},
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				recorded.status = value;
				recorded.statusCalls += 1;
			},
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				recorded.widgets.push({ key, content, placement: options?.placement });
			},
			notify: (message: string) => {
				recorded.notifies.push({ message });
			},
			theme: { fg: (_c: string, s: string) => s },
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown): Promise<void> => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, ctx, recorded, emit };
}

function items(...ids: string[]) {
	return ids.map((id) => ({ id, text: `\`${id}\` demo item`, done: false }));
}

function lastWidget(h: ReturnType<typeof makeHarness>): PanelCall | undefined {
	return h.recorded.widgets.at(-1);
}

function renderWidget(call: PanelCall | undefined, width: number): string[] {
	if (!call || call.content === undefined) return [];
	const factory = call.content as (ui: unknown, theme: unknown) => { render(w: number): string[] };
	return factory({ theme: { fg: (_c: string, s: string) => s } }, { fg: (_c: string, s: string) => s }).render(width);
}

describe("exec panel lifecycle", () => {
	it("registers the panel above the editor when execution starts", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await startExecution(h.pi, h.ctx, path.join(workdir, "PLAN_v1.md"), items("VC-001", "VC-002"), [
			{ id: "I-001", text: "First item." },
			{ id: "I-002", text: "Second item." },
		]);
		const call = lastWidget(h);
		assert.ok(call, "widget registered");
		assert.equal(call!.key, "pi-plans");
		assert.equal(call!.placement, "aboveEditor");
		const lines = renderWidget(call, 100);
		assert.equal(lines.length, 7);
		assert.ok(lines[0].includes("pi-plans"));
		assert.ok(lines.join("\n").includes("Next: Implement I-001"));
		assert.match(h.recorded.status ?? "", /plans: .* ▸ exec/);
		await stopExecution(h.pi, h.ctx, "done");
	});

	it("refreshes panel content from marker updates without re-registering", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		registerExecutionTurnHandlers(h.pi);
		await startExecution(h.pi, h.ctx, path.join(workdir, "PLAN_v2.md"), items("VC-001", "VC-002"), [
			{ id: "I-001", text: "First item." },
			{ id: "I-002", text: "Second item." },
		]);
		await h.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "starting [I-002:current]" }] },
		});
		// The factory closure reads live state: render picks up the new focus.
		const lines = renderWidget(lastWidget(h), 100);
		assert.ok(lines.join("\n").includes("I-002"), "panel content follows the current-I marker");
		assert.equal(h.recorded.widgets.length, 1, "no duplicate registrations across updates");
		await stopExecution(h.pi, h.ctx, "done");
	});

	it("unregisters the panel and clears the execution summary on stop", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		await startExecution(h.pi, h.ctx, path.join(workdir, "PLAN_v3.md"), items("VC-001"));
		await stopExecution(h.pi, h.ctx, "test-stop");
		const call = lastWidget(h);
		assert.ok(call, "clear call recorded");
		assert.equal(call!.key, "pi-plans");
		assert.equal(call!.content, undefined, "widget cleared");
	});

	it("rebuilds the panel from a session snapshot on restore", async () => {
		const workdir = freshWorkdir();
		startRun(workdir, { topic: "restore-topic", skill: "plan-small", requestText: "x" });
		fs.writeFileSync(path.join(workdir, "PLAN_v9.md"), "# plan");
		const h = makeHarness(workdir);
		// A prior session persisted an exec snapshot; restore must rebind the UI.
		await restoreFromSession(
			h.pi,
			h.ctx,
			[
				{ type: "custom", customType: "pi-plans-exec", data: {
					planPath: path.join(workdir, "PLAN_v9.md"),
					items: items("VC-001", "VC-002"),
					implItems: [{ id: "I-001", text: "First." }],
					startedAt: new Date().toISOString(),
					usage: { inToks: 0, outToks: 0 },
				} },
			] as never,
		);
		const lines = renderWidget(lastWidget(h), 100);
		assert.equal(lines.length, 7, "panel rebuilt after restore");
		assert.match(h.recorded.status ?? "", /plans: restore-topic ▸ exec/);
		await stopExecution(h.pi, h.ctx, "done");
	});

	it("injection text shares the panel's next action (VC-007 same-source)", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		registerExecutionTurnHandlers(h.pi);
		await startExecution(h.pi, h.ctx, path.join(workdir, "PLAN_v5.md"), items("VC-001", "VC-002"), [
			{ id: "I-001", text: "First item." },
			{ id: "I-002", text: "Second item." },
		]);
		await h.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "starting [I-002:current]" }] },
		});
		const rules = executionContextMessage(h.ctx)!;
		assert.ok(rules.includes("Suggested next action"), "injection carries the next-action line");
		assert.ok(rules.includes("Implement I-002"), "injection matches the panel's derived action");
		const panelLines = renderWidget(lastWidget(h), 100).join("\n");
		assert.ok(panelLines.includes("Next: Implement I-002"), "panel shows the same action");
		await stopExecution(h.pi, h.ctx, "done");
	});

	it("ignores widget work entirely when the host lacks setWidget", async () => {
		const workdir = freshWorkdir();
		const h = makeHarness(workdir);
		(h.ctx as unknown as { ui: Record<string, unknown> }).ui.setWidget = undefined;
		await startExecution(h.pi, h.ctx, path.join(workdir, "PLAN_v4.md"), items("VC-001"));
		assert.equal(h.recorded.widgets.length, 0, "capability guard skips widget registration");
		assert.match(h.recorded.status ?? "", /plans: .* ▸ exec/);
	});
});
