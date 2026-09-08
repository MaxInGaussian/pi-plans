/** Session-bound run attribution tests (I-002). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	boundRunId,
	clearRunBinding,
	activeInfoById,
	resetRunBindingForTests,
	resolveActiveRun,
	restoreRunBindingFromSession,
	bindRun,
} from "../src/run-context.ts";
import { initState, startRun } from "../src/state.ts";

let tmpRoot: string;

function setupRepo(name: string): string {
	const workdir = path.join(tmpRoot, name);
	fs.mkdirSync(workdir, { recursive: true });
	initState(workdir);
	return workdir;
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-rc-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	resetRunBindingForTests();
});

describe("run binding", () => {
	it("binds, resolves, and never leaks across sessions or workdirs", () => {
		resetRunBindingForTests();
		const workdir = setupRepo("bind");
		const { run } = startRun(workdir, { topic: "bind", skill: "plan-small", requestText: "t" });
		const sessionA = { id: "a" };
		const sessionB = { id: "b" };
		bindRun(sessionA, workdir, run.run_id);
		assert.equal(boundRunId(sessionA, workdir), run.run_id);
		assert.equal(boundRunId(sessionB, workdir), null);
		assert.equal(boundRunId(sessionA, path.join(tmpRoot, "elsewhere")), null);
		clearRunBinding(sessionB);
		assert.equal(boundRunId(sessionA, workdir), run.run_id);
		clearRunBinding(sessionA);
		assert.equal(boundRunId(sessionA, workdir), null);
	});

	it("the session-bound run wins over the shared active pointer", () => {
		resetRunBindingForTests();
		const workdir = setupRepo("priority");
		const first = startRun(workdir, { topic: "first", skill: "plan-small", requestText: "t" }).run;
		const second = startRun(workdir, { topic: "second", skill: "plan-small", requestText: "t" }).run;
		const session = { id: "s" };
		// Shared pointer now names `second`; this session works on `first`.
		bindRun(session, workdir, first.run_id);
		const resolved = resolveActiveRun(session, workdir);
		assert.equal(resolved?.run_id, first.run_id);
		assert.equal(resolved?.artifact_dir, first.artifact_dir);
		// Sessions without a binding keep the legacy fallback.
		assert.equal(resolveActiveRun({ id: "other" }, workdir)?.run_id, second.run_id);
	});

	it("a binding to a deleted run falls back to the shared pointer", () => {
		resetRunBindingForTests();
		const workdir = setupRepo("deleted");
		const first = startRun(workdir, { topic: "first", skill: "plan-small", requestText: "t" }).run;
		const second = startRun(workdir, { topic: "second", skill: "plan-small", requestText: "t" }).run;
		const session = { id: "s" };
		bindRun(session, workdir, first.run_id);
		// Delete the bound run's state directory; active.json still names `second`.
		fs.rmSync(path.join(workdir, ".git", "pi_plans", "runs", first.run_id), { recursive: true, force: true });
		const resolved = resolveActiveRun(session, workdir);
		assert.equal(resolved?.run_id, second.run_id);
		resetRunBindingForTests();
	});

	it("activeInfoById resolves or returns null", () => {
		const workdir = setupRepo("by-id");
		const { run } = startRun(workdir, { topic: "byid", skill: "plan-small", requestText: "t" });
		const info = activeInfoById(workdir, run.run_id);
		assert.equal(info?.run_id, run.run_id);
		assert.equal(info?.artifact_dir, run.artifact_dir);
		assert.equal(activeInfoById(workdir, "20990101T000000Z-none"), null);
	});

	it("restores the binding from run-start entries on the current branch", () => {
		resetRunBindingForTests();
		const workdir = setupRepo("restore");
		const first = startRun(workdir, { topic: "first", skill: "plan-small", requestText: "t" }).run;
		const second = startRun(workdir, { topic: "second", skill: "plan-small", requestText: "t" }).run;
		const session = { id: "s" };
		const entries = [
			{ type: "custom", customType: "pi-plans-run-start", data: { runId: first.run_id } },
			{ type: "message" },
			{ type: "custom", customType: "pi-plans-run-start", data: { runId: second.run_id } },
			{ type: "custom", customType: "pi-plans-run-start", data: { runId: "" } }, // malformed tail
		];
		const restored = restoreRunBindingFromSession(session, workdir, entries as never);
		assert.equal(restored, second.run_id);
		assert.equal(boundRunId(session, workdir), second.run_id);
		// No entries → no binding.
		resetRunBindingForTests();
		assert.equal(restoreRunBindingFromSession(session, workdir, []), null);
		// Entry for a deleted run → no binding.
		resetRunBindingForTests();
		assert.equal(
			restoreRunBindingFromSession(session, workdir, [
				{ type: "custom", customType: "pi-plans-run-start", data: { runId: "20990101T000000Z-gone" } },
			] as never),
			null,
		);
	});
});
