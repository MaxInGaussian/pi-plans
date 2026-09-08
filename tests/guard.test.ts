/** Tests for the planning write guard. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { planningWriteBlockReason } from "../src/guard.ts";
import { initState, setRefsRoot, setRunStatus, startRun } from "../src/state.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-guard-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("planning write guard", () => {
	it("blocks source writes during planning, allows artifacts, lifts after handoff", () => {
		const workdir = path.join(tmpRoot, "repo");
		fs.mkdirSync(workdir);
		initState(workdir);
		const { run } = startRun(workdir, {
			topic: "guard check",
			skill: "plan-small",
			requestText: "x",
		});

		const block = planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" });
		assert.ok(block);
		assert.ok(block.includes("read-only outside planning artifacts"));

		// Artifact writes are allowed (absolute artifact_dir and relative path into it).
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "write", rawPath: path.join(run.artifact_dir, "PLAN_v1.md") }),
			null,
		);
		const relArtifact = path.join(path.relative(workdir, run.artifact_dir), "DECISIONS.md");
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "edit", rawPath: relArtifact }),
			null,
		);
		// Another run's artifact directory is still blocked (per-run boundary).
		assert.ok(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "./docs/pi-plans/other-run/PLAN_v1.md" }));

		// State dir writes are allowed; @-prefixed paths are normalized.
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "write", rawPath: ".git/pi_plans/tmp/note" }),
			null,
		);
		assert.ok(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "@/src/main.ts" }));

		// Read tools are never guarded.
		assert.equal(planningWriteBlockReason({ workdir, toolName: "read", rawPath: "src/main.ts" }), null);

		// Once the run leaves planning/accepted, the guard lifts.
		setRunStatus(workdir, run.run_id, "executing");
		assert.equal(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" }), null);
	});

	it("allows writes under a configured refs_root and stays strict without one", () => {
		const workdir = path.join(tmpRoot, "refs-root-guard");
		fs.mkdirSync(workdir);
		initState(workdir);
		startRun(workdir, { topic: "refs guard", skill: "plan-with-refs", requestText: "x" });

		// Without a configured refs_root, ./refs/ writes stay blocked.
		assert.ok(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "./refs/paper.md" }));

		setRefsRoot(workdir, "./refs", "user");
		assert.equal(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "./refs/paper.md" }), null);
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "edit", rawPath: path.join(workdir, "refs", "notes.md") }),
			null,
		);
		// The refs root does not open up the whole worktree.
		assert.ok(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" }));

		// The .git/pi-plans/refs (hyphenated) recommendation is covered by an absolute entry too.
		setRefsRoot(workdir, ".git/pi-plans/refs", "user");
		assert.equal(
			planningWriteBlockReason({ workdir, toolName: "write", rawPath: ".git/pi-plans/refs/repo-a/" }),
			null,
		);
	});

	it("is inactive without an active run", () => {
		const workdir = path.join(tmpRoot, "no-run");
		fs.mkdirSync(workdir);
		initState(workdir);
		assert.equal(planningWriteBlockReason({ workdir, toolName: "write", rawPath: "src/main.ts" }), null);
	});
});

describe("session-bound guard run (I-002)", () => {
	it("activeRunId overrides the shared pointer; null falls back", () => {
		const workdir = path.join(tmpRoot, "repo-bound");
		fs.mkdirSync(workdir);
		initState(workdir);
		const first = startRun(workdir, { topic: "first run", skill: "plan-small", requestText: "x" }).run;
		const second = startRun(workdir, { topic: "second run", skill: "plan-small", requestText: "x" }).run;

		// Shared pointer names `second`; this session works on `first`.
		const bound = planningWriteBlockReason({
			workdir,
			toolName: "write",
			rawPath: path.relative(workdir, path.join(first.artifact_dir, "PLAN_v1.md")),
			activeRunId: first.run_id,
		});
		assert.equal(bound, null, "bound run artifacts stay writable");

		// The other run's artifacts are NOT writable for the bound session.
		const other = planningWriteBlockReason({
			workdir,
			toolName: "write",
			rawPath: path.relative(workdir, path.join(second.artifact_dir, "PLAN_v1.md")),
			activeRunId: first.run_id,
		});
		assert.ok(other);

		// null = no session binding → legacy shared-pointer behavior.
		const shared = planningWriteBlockReason({
			workdir,
			toolName: "write",
			rawPath: path.relative(workdir, path.join(first.artifact_dir, "PLAN_v1.md")),
			activeRunId: null,
		});
		assert.ok(shared, "shared pointer names second; first is not writable");

		// A binding to a missing run falls back to the shared pointer.
		const vanished = planningWriteBlockReason({
			workdir,
			toolName: "write",
			rawPath: path.relative(workdir, path.join(second.artifact_dir, "PLAN_v1.md")),
			activeRunId: "20990101T000000Z-gone",
		});
		assert.equal(vanished, null);
	});
});
