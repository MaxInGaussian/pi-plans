import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
	initState,
	listRuns,
	newestNonTerminalRun,
	latestRun,
	readActive,
	setRunStatus,
	startRun,
	TERMINAL_RUN_STATUSES,
} from "../src/state.ts";
import { resolveActiveRun, resetRunBindingForTests } from "../src/run-context.ts";
import { planningWriteBlockReason } from "../src/guard.ts";
import { executionCandidates, abandonCandidates, runPickerLabel } from "../src/run-picker.ts";
import {
	getExecution,
	startExecution,
	stopExecution,
} from "../src/exec.ts";

let tmpRoot: string;
let counter = 0;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-multi-run-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	resetRunBindingForTests();
	delete process.env.PI_PLANS_EXECUTOR;
	delete process.env.PI_PLANS_RUN_ID;
});

function freshWorkdir(): string {
	counter += 1;
	const workdir = path.join(tmpRoot, `repo-${counter}`);
	fs.mkdirSync(workdir, { recursive: true });
	return workdir;
}

function fakeCtx(workdir: string, extra: Record<string, unknown> = {}): any {
	return {
		cwd: workdir,
		sessionManager: { id: `session-${counter}` },
		ui: {
			setStatus: () => {},
			notify: () => {},
			theme: { fg: (_k: string, t: string) => t, bold: (t: string) => t },
		},
		mode: "noninteractive",
		...extra,
	};
}

describe("run registry (v0.6.0)", () => {
	it("listRuns sorts newest-first, skips corrupt run dirs, and survives partial state", () => {
		const workdir = freshWorkdir();
		initState(workdir);
		const first = startRun(workdir, { topic: "first", skill: "plan-small", requestText: "a" }).run;
		const second = startRun(workdir, { topic: "second", skill: "plan-big", requestText: "b" }).run;
		// Corrupt a third run's run.json: the scan must skip it, never throw.
		const stateRoot = path.join(workdir, ".git", "pi-plans");
		fs.mkdirSync(path.join(stateRoot, "runs", "corrupt-run-id"), { recursive: true });
		fs.writeFileSync(path.join(stateRoot, "runs", "corrupt-run-id", "run.json"), "{ broken", "utf8");

		const runs = listRuns(workdir);
		const ids = runs.map((run) => run.run_id);
		assert.equal(ids.includes(first.run_id), true);
		assert.equal(ids.includes(second.run_id), true);
		assert.equal(ids.includes("corrupt-run-id"), false);
		assert.equal(runs.indexOf(runs.find((r) => r.run_id === second.run_id)!), 0, "newest first");
		assert.equal(runs[0]!.skill, "plan-big");
	});

	it("start-run no longer writes the shared active.json pointer", () => {
		const workdir = freshWorkdir();
		initState(workdir);
		startRun(workdir, { topic: "pointerless", skill: "plan-small", requestText: "x" });
		const activePath = path.join(workdir, ".git", "pi-plans", "active.json");
		assert.equal(fs.existsSync(activePath), false, "registry workdirs keep no shared pointer");
	});

	it("readActive = newest NON-terminal run; null when every run is terminal", () => {
		const workdir = freshWorkdir();
		initState(workdir);
		const only = startRun(workdir, { topic: "only", skill: "plan-small", requestText: "x" }).run;
		assert.equal(readActive(workdir)?.run_id, only.run_id);
		setRunStatus(workdir, only.run_id, "done");
		assert.equal(readActive(workdir), null, "terminal-only workdir resolves no active run");
		assert.equal(newestNonTerminalRun(workdir), null);
		assert.equal(latestRun(workdir)?.run_id, only.run_id, "display-only latest keeps terminal runs");
	});

	it("readActive falls back to a legacy active.json only when the scan finds nothing", () => {
		const workdir = freshWorkdir();
		initState(workdir);
		const stateRoot = path.join(workdir, ".git", "pi-plans");
		fs.mkdirSync(path.join(stateRoot, "runs", "legacy-run"), { recursive: true });
		// No run.json at all → scan finds nothing → legacy pointer honored.
		const activePath = path.join(stateRoot, "active.json");
		fs.writeFileSync(
			activePath,
			JSON.stringify({ run_id: "legacy-run", run_dir: path.join(stateRoot, "runs", "legacy-run"), artifact_dir: path.join(workdir, "docs") }),
			"utf8",
		);
		assert.equal(readActive(workdir)?.run_id, "legacy-run");
		fs.rmSync(activePath);
		assert.equal(readActive(workdir), null);
	});

	it("parallel start-runs in one workdir get distinct ids and dirs", () => {
		const workdir = freshWorkdir();
		initState(workdir);
		const a = startRun(workdir, { topic: "same-topic", skill: "plan-small", requestText: "x" }).run;
		const b = startRun(workdir, { topic: "same-topic", skill: "plan-small", requestText: "y" }).run;
		assert.notEqual(a.run_id, b.run_id);
		assert.notEqual(a.artifact_dir, b.artifact_dir);
		assert.equal(listRuns(workdir).length, 2);
	});
});

describe("multi-run resolution and guard", () => {


});

describe("run picker candidates", () => {
	it("executionCandidates needs a plan file and non-terminal status; abandonCandidates takes all non-terminal", () => {
		const workdir = freshWorkdir();
		initState(workdir);
		const withPlan = startRun(workdir, { topic: "with-plan", skill: "plan-small", requestText: "a" }).run;
		fs.writeFileSync(path.join(withPlan.artifact_dir, "PLAN_v1.md"), "# p\n\n## Verifier Checklist\n\n- [ ] `VC-001` x\n");
		startRun(workdir, { topic: "no-plan", skill: "plan-small", requestText: "b" });
		const done = startRun(workdir, { topic: "done", skill: "plan-small", requestText: "c" }).run;
		setRunStatus(workdir, done.run_id, "done");

		const exec = executionCandidates(workdir);
		assert.deepEqual(exec.map((run) => run.topic), ["with-plan"]);
		const abandon = abandonCandidates(workdir);
		assert.equal(abandon.length, 2, "with-plan + no-plan are abandonable; done is not");
		assert.equal(abandon.every((run) => !TERMINAL_RUN_STATUSES.has(run.status)), true);
	});

	it("labels are descriptive, width-fitted, and mark the recommended run", () => {
		const run = {
			run_id: "20260926T000000Z-demo",
			topic: "demo-topic",
			skill: "plan-big",
			status: "planning",
			created_at: "2026-09-26T00:00:00Z",
			updated_at: "2026-09-26T00:00:00Z",
			artifact_dir: "/tmp/x",
		};
		const label = runPickerLabel(run, true);
		assert.match(label, /^★ demo-topic · planning · plan-big · 2026-09-26T00:00:00Z/);
		const long = { ...run, topic: "x".repeat(200) };
		assert.ok(runPickerLabel(long, false).length <= 200, "long topics truncate");
	});
});

