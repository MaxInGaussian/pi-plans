/** Tests for run-scoped Auto-complete and planning continuation. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	autoCompleteStatus,
	disableAutoComplete,
	enableAutoComplete,
	isAutoCompleteEnabled,
	markPlanWritten,
	recordAskChoice,
	registerAutoCompleteTurnHandlers,
	restoreAutoCompleteFromSession,
	setAutoCompleteApi,
} from "../src/autocomplete.ts";
import { initState, setRunStatus, startRun } from "../src/state.ts";

let root: string;

function makeRun(name: string): { workdir: string; runId: string } {
	const workdir = path.join(root, name);
	fs.mkdirSync(workdir, { recursive: true });
	initState(workdir);
	const { run } = startRun(workdir, { topic: name, skill: "plan-small", requestText: "test" });
	return { workdir, runId: run.run_id };
}

function makeContext(workdir: string, sessionManager: any = {}): any {
	return {
		cwd: workdir,
		hasUI: true,
		mode: "tui",
		sessionManager,
		ui: {
			select: async (_question: string, options: string[]) => options.at(-1),
			input: async () => "typed",
		},
	};
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-autocomplete-"));
});

after(() => {
	setAutoCompleteApi(null);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("Auto-complete state", () => {
	it("enables only for the active planning run and restores only while planning", () => {
		const { workdir, runId } = makeRun("restore");
		const entries: any[] = [];
		setAutoCompleteApi({ appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as any);
		const ctx = makeContext(workdir);

		assert.equal(enableAutoComplete(ctx), true);
		assert.equal(autoCompleteStatus(ctx), "enabled");
		assert.equal(entries.at(-1)?.data.runId, runId);

		const restored = makeContext(workdir);
		restoreAutoCompleteFromSession(restored, entries);
		assert.equal(isAutoCompleteEnabled(restored), true);

		setRunStatus(workdir, runId, "done");
		const finished = makeContext(workdir);
		restoreAutoCompleteFromSession(finished, entries);
		assert.equal(autoCompleteStatus(finished), "disabled");

		const stoppedEntries = [...entries, { type: "custom", customType: "pi-plans-autocomplete", data: { runId, enabled: false } }];
		const stopped = makeContext(workdir);
		restoreAutoCompleteFromSession(stopped, stoppedEntries);
		assert.equal(autoCompleteStatus(stopped), "disabled");
	});

	it("clears explicitly and marks plan writes as a continuation boundary", () => {
		const { workdir } = makeRun("clear");
		const entries: any[] = [];
		setAutoCompleteApi({ appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }) } as any);
		const ctx = makeContext(workdir);
		enableAutoComplete(ctx);
		markPlanWritten(ctx);
		recordAskChoice(ctx, true);
		assert.equal(disableAutoComplete(ctx, "test"), true);
		assert.equal(autoCompleteStatus(ctx), "disabled");
		assert.equal(entries.at(-1)?.data.enabled, false);
	});
});

describe("Auto-complete continuation", () => {
	it("queues one follow-up after an early stop and none after a natural next question", async () => {
		const { workdir } = makeRun("continuation");
		const session = {};
		const sent: any[] = [];
		const handlers = new Map<string, Function[]>();
		const pi: any = {
			on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			appendEntry: () => {},
			sendUserMessage: async (content: string, options: unknown) => sent.push({ content, options }),
		};
		setAutoCompleteApi(pi);
		registerAutoCompleteTurnHandlers(pi);
		const ctx = makeContext(workdir, session);
		enableAutoComplete(ctx);
		await handlers.get("turn_start")?.[0]?.({}, ctx);
		recordAskChoice(ctx, true);
		await handlers.get("turn_end")?.[0]?.({ message: { role: "assistant" } }, ctx);
		await handlers.get("turn_end")?.[0]?.({ message: { role: "assistant" } }, ctx);
		assert.equal(sent.length, 1);
		assert.equal((sent[0]!.options as any).deliverAs, "followUp");

		await handlers.get("turn_start")?.[0]?.({}, ctx);
		recordAskChoice(ctx, true);
		markPlanWritten(ctx);
		await handlers.get("turn_end")?.[0]?.({ message: { role: "assistant" } }, ctx);
		assert.equal(sent.length, 1);

		await handlers.get("turn_start")?.[0]?.({}, ctx);
		recordAskChoice(ctx, true);
		recordAskChoice(ctx, false);
		await handlers.get("turn_end")?.[0]?.({ message: { role: "assistant" } }, ctx);
		assert.equal(sent.length, 1);
	});
});

describe("ask_choice Auto-complete wiring", () => {
	it("routes eligible questions through the run-scoped mode", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "tools", "ask-choice.ts"), "utf8");
		assert.match(source, /isAutoCompleteEnabled/);
		assert.match(source, /recordAskChoice\(ctx, true\)/);
		assert.match(source, /autoComplete && selected\.startsWith\("Auto-complete"\)/);
		// Trailing option: Auto-refine loop replaces Auto-complete and is suppressed in headless sessions.
		assert.match(source, /trailing === undefined/);
		assert.match(source, /AUTO_REFINE_LOOP_LABEL/);
		assert.match(source, /trailing && selected\.startsWith\("Auto-refine loop"\)/);
		const indexSource = fs.readFileSync(path.join(process.cwd(), "index.ts"), "utf8");
		assert.match(indexSource, /plans-autocomplete-stop/);
		assert.match(indexSource, /autoCompleteStatus\(ctx\)/);
		assert.match(indexSource, /restoreAutoCompleteFromSession/);
		const execSource = fs.readFileSync(path.join(process.cwd(), "src", "exec.ts"), "utf8");
		assert.match(execSource, /customType === AUTOCOMPLETE_ENTRY/);
	});
});
