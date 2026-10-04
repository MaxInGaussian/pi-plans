import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { after, before, describe, it } from "node:test";

import { getExecution, startExecution, stopExecution } from "../src/exec.ts";
import { setMessagingApi } from "../src/messaging.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-execute-test-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("execute handoff", () => {
	it("rejects an inconsistent task tree at the handoff gate (lint hard-reject)", async () => {
		const workdir = mkWorkdir("lint-gate");
		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(
			planPath,
			"## Tasks\n\n- Task-1: a — files: src/a.ts; wave: 1\n- Task-2: b — deps: Task-9\n\n## Verification Checks\n\n- [ ] \\`VC-001\\` covers \\`Task-1\\`; pass condition: x\n",
			"utf8",
		);
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const ctx = { cwd: workdir, hasUI: false } as never;
		setMessagingApi(ctx);
		const outcome = await executeHandoff(ctx, planPath);
		assert.equal(outcome.status, "error");
		assert.match(outcome.message, /consistency gate/);
		assert.match(outcome.message, /deps 引用未知任务/);
	});

	it("starts execution without switching models", async () => {
		const workdir = mkWorkdir("handoff");
		const recorded = {
			messages: [] as string[],
			entries: [] as Array<{ customType: string; data: unknown }>,
		};
		const ctx = {
			cwd: workdir,
			ui: {
				setStatus: () => {},
				theme: {
					fg: (_kind: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
		} as any;
		setMessagingApi({
			appendEntry: (customType: string, data: unknown) => {
				recorded.entries.push({ customType, data });
			},
			sendMessage: (message: { customType: string; content: string }) => {
				recorded.messages.push(message.content);
			},
			sendUserMessage: async () => {},
		});

		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(
			planPath,
			"## Tasks\n\n- Task-1: first — files: src/a.ts; wave: 1\n\n## Verification Checks\n\n- [ ] \\`VC-001\\` covers \\`Task-1\\`; pass condition: first item\n",
			"utf8",
		);
		await startExecution(ctx, {
			planPath,
			planTasks: parsePlanTasks(fs.readFileSync(planPath, "utf8")),
			items: parseChecklist(fs.readFileSync(planPath, "utf8")),
		});
		const execution = getExecution();
		assert.ok(execution);
		assert.equal(execution!.tasks.length, 1);
		assert.match(recorded.messages.at(-1) ?? "", /plans_update_task/);

		await stopExecution(ctx, "cleanup");
		assert.equal(getExecution(), null);
	});
});

describe("plan-huge execution gate", () => {
	async function setupHuge(name: string): Promise<{
		workdir: string;
		runId: string;
		artifactDir: string;
		session: { id: string };
	}> {
		const { spawnSync } = await import("node:child_process");
		const { initState, startRun } = await import("../src/state.ts");
		const { createCheckpoint } = await import("../src/workflow-state.ts");
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		const { bindRun } = await import("../src/run-context.ts");
		const workdir = mkWorkdir(`huge-${name}`);
		spawnSync("git", ["init"], { cwd: workdir });
		initState(workdir);
		const { run } = startRun(workdir, { topic: `huge-${name}`, skill: "plan-huge", requestText: "t" });
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		const session = { id: "huge-session" };
		bindRun(session, workdir, run.run_id);
		const ctx = { sessionManager: session };
		const overallPath = path.join(run.artifact_dir, "PLAN_overall_v1.md");
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		fs.writeFileSync(
			overallPath,
			"## Versions\n\n- `v0.1.0`: skeleton — done: runs.\n- `v0.2.0`: store — done: persists.\n\n## Architecture\n\nx\n\n## File Map\n\nx\n\n## User Experience\n\nx\n\n## Final Objective\n\nx\n",
			"utf8",
		);
		recordCheckpointTransition(ctx, workdir, run.run_id, { transition: "overall-plan-written", planPath: overallPath });
		recordCheckpointTransition(ctx, workdir, run.run_id, { transition: "overall-accepted" });
		return { workdir, runId: run.run_id, artifactDir: run.artifact_dir, session };
	}

	function versionPlanText(title: string): string {
		return `## Tasks\n\n- \`Task-1\`: ${title} — files: src/a.ts; wave: 1\n\n## Verification Checks\n\n- [ ] \`VC-001\` covers \`Task-1\`; pass condition: src/a.ts exists; evidence: file; metric: 0.\n`;
	}

	it("hard-rejects the overall plan and points at the current version plan", async () => {
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const { getRun } = await import("../src/state.ts");
		const { workdir, runId, artifactDir, session } = await setupHuge("overall-gate");
		const versionPath = path.join(artifactDir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(versionPath, versionPlanText("first"), "utf8");
		const overallPath = path.join(artifactDir, "PLAN_overall_v1.md");
		const ctx = { cwd: workdir, sessionManager: session, hasUI: false } as never;
		const outcome = await executeHandoff(ctx, overallPath);
		assert.equal(outcome.status, "error");
		assert.match(outcome.message, /never executable/);
		assert.match(outcome.message, /PLAN_v0\.1\.0_v1\.md/);
		// The refusal happened before any approval or status change.
		assert.equal(getRun(workdir, runId)?.status, "planning");
	});

	it("resolves the current version's latest round when no path is given", async () => {
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const { workdir, artifactDir, session } = await setupHuge("resolve");
		const ctx = { cwd: workdir, sessionManager: session, hasUI: false } as never;
		// The version plan does not exist yet: the error names the resolved path.
		const missing = await executeHandoff(ctx);
		assert.equal(missing.status, "error");
		assert.match(missing.message, /PLAN_v0\.1\.0_v1\.md/);
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v1.md"), "# empty\n", "utf8");
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v2.md"), "# empty v2\n", "utf8");
		const latest = await executeHandoff(ctx);
		assert.equal(latest.status, "error");
		assert.match(latest.message, /PLAN_v0\.1\.0_v2\.md/);
		assert.match(latest.message, /Verification Checks/);
	});

	it("accepts an explicit latest-round version path and refuses stale ones", async () => {
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const { getExecution, stopExecution } = await import("../src/exec.ts");
		const { workdir, runId, artifactDir, session } = await setupHuge("accept-latest");
		const latest = path.join(artifactDir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(latest, versionPlanText("first"), "utf8");
		// The skill records the version plan before the handoff; the checkpoint
		// must therefore hold THIS plan's identity for the approval to match.
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		recordCheckpointTransition({ sessionManager: session }, workdir, runId, {
			transition: "version-plan-written",
			planPath: latest,
		});
		const ctx = {
			cwd: workdir,
			sessionManager: session,
			hasUI: false,
			ui: { setStatus: () => {}, theme: { fg: (_k: string, t: string) => t } },
		} as never;
		setMessagingApi({
			appendEntry: () => {},
			sendMessage: () => {},
			sendUserMessage: async () => {},
		});
		// PI_PLANS_AUTO_APPROVE=1 is the documented eval-only switch that lets the
		// handoff proceed without a UI: reaching "executing" proves every huge
		// gate accepted this explicit latest-round path.
		const previous = process.env.PI_PLANS_AUTO_APPROVE;
		process.env.PI_PLANS_AUTO_APPROVE = "1";
		try {
			const accepted = await executeHandoff(ctx, latest);
			assert.equal(accepted.status, "executing", accepted.message);
			assert.equal(accepted.planPath, latest);
			assert.ok(getExecution());
			await stopExecution(ctx, "test cleanup");
		} finally {
			if (previous === undefined) delete process.env.PI_PLANS_AUTO_APPROVE;
			else process.env.PI_PLANS_AUTO_APPROVE = previous;
		}
		// A stale round of the same stream is refused by the gate.
		const second = path.join(artifactDir, "PLAN_v0.1.0_v2.md");
		fs.writeFileSync(second, versionPlanText("first revised"), "utf8");
		const stale = await executeHandoff(ctx, latest);
		assert.equal(stale.status, "error");
		assert.match(stale.message, /stale round/);
	});

	it("refuses stale rounds, other streams and completed versions", async () => {
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const { loadCheckpoint, mutateCheckpoint } = await import("../src/workflow-state.ts");
		const { workdir, runId, artifactDir, session } = await setupHuge("stale");
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v1.md"), versionPlanText("first"), "utf8");
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.1.0_v2.md"), versionPlanText("first revised"), "utf8");
		fs.writeFileSync(path.join(artifactDir, "PLAN_v0.2.0_v1.md"), versionPlanText("second"), "utf8");
		const ctx = { cwd: workdir, sessionManager: session, hasUI: false } as never;
		const stale = await executeHandoff(ctx, path.join(artifactDir, "PLAN_v0.1.0_v1.md"));
		assert.equal(stale.status, "error");
		assert.match(stale.message, /stale round/);
		const otherStream = await executeHandoff(ctx, path.join(artifactDir, "PLAN_v0.2.0_v1.md"));
		assert.equal(otherStream.status, "error");
		assert.match(otherStream.message, /is not the current version/);
		// Mark the current version done: it can no longer be executed.
		mutateCheckpoint(workdir, runId, (cp) => {
			if (!cp.huge) throw new Error("missing huge state");
			const versions = cp.huge.versions.map((version, i) =>
				i === 0 ? { ...version, status: "done" as const, completion: { completedAt: "2026-10-04T00:00:00Z" } } : version,
			);
			return { ...cp, huge: { ...cp.huge, versions } };
		});
		const done = await executeHandoff(ctx, path.join(artifactDir, "PLAN_v0.1.0_v2.md"));
		assert.equal(done.status, "error");
		assert.match(done.message, /already complete/);
		const load = loadCheckpoint(workdir, runId);
		assert.equal(load.status, "ok");
	});
});
