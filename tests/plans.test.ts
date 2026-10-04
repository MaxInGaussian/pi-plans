/** Tests for the plans tool source wiring. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { describe, it } from "node:test";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function readPlansSource(): string {
	return fs.readFileSync(path.join(ROOT, "tools", "plans.ts"), "utf8");
}

describe("plans tool source", () => {
	it("declares artifactRootSource in PlansParams", () => {
		const source = readPlansSource();
		const start = source.indexOf("const PlansParams = Type.Object({");
		const end = source.indexOf("});", start);
		assert.ok(start >= 0, "missing PlansParams block start");
		assert.ok(end >= 0, "missing PlansParams block end");

		const params = source.slice(start, end);
		assert.match(params, /artifactRootSource:\s*Type\.Optional/);
		assert.doesNotMatch(params, /executionModelSelector/);
		assert.doesNotMatch(params, /executionModelSource/);
	});

	it("keeps the plans handler wired to artifact root and no separate model-selection action", () => {
		const source = readPlansSource();
		assert.match(source, /import \{[\s\S]*setArtifactRoot,[\s\S]*\} from "\.\.\/src\/state\.ts";/);
		assert.match(source, /case "set-artifact-root"/);
		assert.doesNotMatch(source, /setExecutionModel/);
		assert.doesNotMatch(source, /case "set-execution-model"/);
		assert.match(source, /params\.artifactRootSource/);
	});

	it("declares refsRootSource and wires the set-refs-root action plus ref-analyst role", () => {
		const source = readPlansSource();
		assert.match(source, /refsRoot:\s*Type\.Optional/);
		assert.match(source, /refsRootSource:\s*Type\.Optional/);
		assert.match(source, /import \{[\s\S]*setRefsRoot,[\s\S]*\} from "\.\.\/src\/state\.ts";/);
		assert.match(source, /case "set-refs-root"/);
		assert.match(source, /params\.refsRootSource/);
		assert.match(source, /"reviewer", "ref-analyst"/);
	});
});

describe("record-checkpoint transitions (I-003)", () => {
	it("records plan identity and rejects forged terminal states", async () => {
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-rcp-"));
		try {
			spawnSync("git", ["init"], { cwd: workdir });
			const { initState, startRun } = await import("../src/state.ts");
			initState(workdir);
			const { run } = startRun(workdir, { topic: "rcp", skill: "plan-normal", requestText: "t" });
			const { createCheckpoint, loadCheckpoint } = await import("../src/workflow-state.ts");
			createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
			const ctx = { sessionManager: { id: "s" } };

			// plan-written records the exact file identity.
			const planPath = path.join(run.artifact_dir, "PLAN_v1.md");
			fs.mkdirSync(run.artifact_dir, { recursive: true });
			fs.writeFileSync(planPath, "# plan body", "utf8");
			const updated = recordCheckpointTransition(ctx, workdir, run.run_id, {
				transition: "plan-written",
				planPath,
			});
			assert.equal(updated.plan?.version, 1);
			assert.equal(updated.plan?.sha256.length, 64);
			const loaded = loadCheckpoint(workdir, run.run_id);
			assert.equal(loaded.status, "ok");
			assert.equal(loaded.checkpoint.plan?.path, planPath);

			// v0.6.1: the implementation-review transitions are gone from the
			// schema — the union no longer accepts them at compile time, and
			// the handler switch exhausts on the two remaining names.
			assert.ok(
				!"completed".includes("plan-written") && !"completed".includes("review-consolidated"),
			);
			// planPath is required.
			assert.throws(
				() => recordCheckpointTransition(ctx, workdir, run.run_id, { transition: "plan-written" }),
				/planPath/,
			);
		} finally {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	});
});

describe("pre-plan compaction wiring", () => {
	it("start-run marks pre-plan compaction pending under settings and execution guards", () => {
		const source = readPlansSource();
		assert.match(source, /import \{ getExecution, markPrePlanCompactPending, refreshUiLanguage \} from "\.\.\/src\/exec\.ts";/);
		assert.match(source, /import \{ loadVccSettings, scaffoldVccSettings \} from "\.\.\/src\/compaction\.ts";/);
		assert.match(source, /const prePlanStateRoot = resolveStateRootOrNull\(workdir\);/);
		assert.match(source, /if \(prePlanStateRoot && !getExecution\(\)\) \{/);
		assert.match(source, /scaffoldVccSettings\(prePlanStateRoot\);/);
		assert.match(source, /loadVccSettings\(prePlanStateRoot\)\.prePlanCompact/);
		assert.match(source, /markPrePlanCompactPending\(ctx, result\.run\.run_id\);/);
	});

	it("index.ts consumes the pending flag from the plans tool_result hook", () => {
		const source = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		assert.match(source, /consumePrePlanCompactPending/);
		assert.match(source, /customInstructions: PLANNING_PREPLAN_COMPACT_HINT/);
		assert.match(source, /sendPrePlanCompactResume\(ctx\)/);
		assert.match(source, /pre-plan compaction skipped; continuing planning\./);
	});
});


describe("plan-huge record-checkpoint transitions", () => {
	async function setup(name: string): Promise<{ workdir: string; runId: string; artifactDir: string }> {
		const { recordCheckpointTransition: _unused } = await import("../tools/plans.ts");
		const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-plans-huge-${name}-`));
		spawnSync("git", ["init"], { cwd: workdir });
		const { initState, startRun } = await import("../src/state.ts");
		initState(workdir);
		const { run } = startRun(workdir, { topic: `huge-${name}`, skill: "plan-huge", requestText: "t" });
		const { createCheckpoint } = await import("../src/workflow-state.ts");
		createCheckpoint(workdir, { runId: run.run_id, originWorkdir: workdir, workdir });
		fs.mkdirSync(run.artifact_dir, { recursive: true });
		return { workdir, runId: run.run_id, artifactDir: run.artifact_dir };
	}

	const VERSIONS_MD = [
		"## Versions",
		"",
		"- `v0.1.0`: walking skeleton \u2014 done: cli runs.",
		"- `v0.2.0`: persistence \u2014 done: data survives restart.",
		"- `v0.3.0`: multi-user \u2014 done: users isolated.",
		"",
	].join("\n");

	function overallPlan(table: string, extra = ""): string {
		return `# PLAN_overall_v1\n\n## Original Request\n\nx\n\n${table}\n## Architecture\n\nx\n\n## File Map\n\nx\n\n## User Experience\n\nx\n\n## Final Objective\n\nx\n${extra}`;
	}

	function versionPlan(body: string): string {
		return `# PLAN_v0.1.0_v1\n\n## Original Request\n\nx\n\n## Tasks\n\n- \`Task-1\`: x \u2014 files: src/a.ts; wave: 1\n\n### Execution Waves\n\n- wave 1: Task-1 \u2014 first\n\n## Verification Checks\n\n- [ ] \`VC-001\` covers \`Task-1\`; pass condition: src/a.ts exists; evidence: file; metric: 0.\n\n${body}`;
	}

	it("refuses overall plans whose version table breaks the contract", async () => {
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		const { workdir, runId, artifactDir } = await setup("table");
		const ctx = { sessionManager: { id: "s" } };
		const cases: Array<[string, string]> = [
			["one", "## Versions\n\n- `v0.1.0`: m \u2014 done: d.\n"],
			["eleven", `## Versions\n\n${Array.from({ length: 11 }, (_, i) => `- \`v0.${i + 1}.0\`: m \u2014 done: d.`).join("\n")}\n`],
			["descending", "## Versions\n\n- `v0.1.0`: m \u2014 done: d.\n- `v0.1.0`: m \u2014 done: d.\n"],
			["first", "## Versions\n\n- `v0.2.0`: m \u2014 done: d.\n- `v0.3.0`: m \u2014 done: d.\n"],
			["label", "## Versions\n\n- `v0.1.0`: m \u2014 done: d.\n- `v0.0.5`: m \u2014 done: d.\n"],
			["missing", "## Goals\n\n- nothing\n"],
		];
		for (const [tag, table] of cases) {
			const planPath = path.join(artifactDir, `PLAN_overall_v1.md`);
			fs.writeFileSync(planPath, overallPlan(tag === "missing" ? table : table), "utf8");
			assert.throws(
				() => recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-plan-written", planPath }),
				/overall plan rejected/,
				`expected rejection for ${tag}`,
			);
		}
	});

	it("records a valid overall plan, requires controlled-revision metadata, then accepts it", async () => {
		const { recordCheckpointTransition, hugeRunSummary } = await import("../tools/plans.ts");
		const { workdir, runId, artifactDir } = await setup("overall");
		const ctx = { sessionManager: { id: "s" } };
		const planPath = path.join(artifactDir, "PLAN_overall_v1.md");
		fs.writeFileSync(planPath, overallPlan(VERSIONS_MD), "utf8");
		const cp = recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-plan-written", planPath });
		assert.equal(cp.nextAction, "accept-overall");
		assert.equal(cp.huge?.versions.length, 3);
		assert.equal(cp.plan?.stream, "overall");
		assert.equal(cp.plan?.version, 1);

		const revisionPath = path.join(artifactDir, "PLAN_overall_v2.md");
		fs.writeFileSync(revisionPath, overallPlan(VERSIONS_MD.replace("persistence", "persistence-v2")), "utf8");
		assert.throws(
			() => recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-plan-written", planPath: revisionPath }),
			/controlled overall revision/,
		);
		assert.throws(
			() =>
				recordCheckpointTransition(ctx, workdir, runId, {
					transition: "overall-plan-written",
					planPath: revisionPath,
					reason: "seam moved",
					affectedVersions: ["v0.3.0"],
				}),
			/not listed in affectedVersions/,
		);

		const accepted = recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-accepted" });
		assert.equal(accepted.nextAction, "start-version-planning");
		assert.equal(accepted.huge?.versions[0]?.status, "planning");
		const summary = hugeRunSummary(workdir, runId) as { position: string; currentVersion: string };
		assert.equal(summary.position, "1/3");
		assert.equal(summary.currentVersion, "v0.1.0");
	});

	it("enforces deferred processing and the GitHub reference lint", async () => {
		const { recordCheckpointTransition, hugeRunSummary } = await import("../tools/plans.ts");
		const { workdir, runId, artifactDir } = await setup("deferred");
		const ctx = { sessionManager: { id: "s" } };
		const overallPath = path.join(artifactDir, "PLAN_overall_v1.md");
		fs.writeFileSync(overallPath, overallPlan(VERSIONS_MD), "utf8");
		recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-plan-written", planPath: overallPath });
		recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-accepted" });

		const firstPath = path.join(artifactDir, "PLAN_v0.1.0_v1.md");
		fs.writeFileSync(
			firstPath,
			versionPlan(
				"## Evidence\n\n- https://github.com/example/one\n\n## Deferred to v0.2.0\n\n- `D-v0.1.0-1`: file store — reason: seam first.\n- `D-v0.1.0-2`: users — reason: later.\n- `D-v0.1.0-3`: polish — reason: later.\n",
			),
			"utf8",
		);
		recordCheckpointTransition(ctx, workdir, runId, { transition: "version-plan-written", planPath: firstPath });
		// Simulate v0.1.0 having completed: advance the run to v0.2.0.
		const { loadCheckpoint: load1, mutateCheckpoint: mutate1 } = await import("../src/workflow-state.ts");
		mutate1(workdir, runId, (cp) => {
			if (!cp.huge) throw new Error("missing huge state");
			const versions = cp.huge.versions.map((version, i) =>
				i === 0 ? { ...version, status: "done" as const, completion: { completedAt: "2026-10-04T00:00:00Z" } } : version,
			);
			return { ...cp, phase: "planning" as const, nextAction: "plan-next-version" as const, huge: { ...cp.huge, versions, currentIndex: 1 } };
		});
		assert.equal((load1(workdir, runId) as { checkpoint: { huge: { currentIndex: number } } }).checkpoint.huge.currentIndex, 1);

		const secondPath = path.join(artifactDir, "PLAN_v0.2.0_v1.md");
		const secondText = versionPlan("## Evidence\n\n- nothing\n")
			.replace(
				"- `Task-1`: x — files: src/a.ts; wave: 1",
				"- `Task-1`: D-v0.1.0-1 file store and D-v0.1.0-3 polish — files: src/a.ts; wave: 1",
			)
			.concat("\n## Deferred to v0.3.0\n\n- `D-v0.2.0-1`: more polish — reason: later.\n");
		fs.writeFileSync(secondPath, secondText, "utf8");

		// Unprocessed items are refused outright.
		assert.throws(
			() => recordCheckpointTransition(ctx, workdir, runId, { transition: "version-plan-written", planPath: secondPath }),
			/deferred item D-v0.1.0-1 of v0.1.0 is unprocessed/,
		);
		// An absorbed item must be referenced by this plan.
		assert.throws(
			() =>
				recordCheckpointTransition(ctx, workdir, runId, {
					transition: "version-plan-written",
					planPath: path.join(artifactDir, "PLAN_v0.2.0_v9.md"),
					deferred: [{ itemId: "D-v0.1.0-1", disposition: "absorbed" }],
				}),
			/ENOENT|not found/,
		);
		const unreferenced = secondText.replace("D-v0.1.0-1 file store and ", "");
		const unreferencedPath = path.join(artifactDir, "PLAN_v0.2.0_v8.md");
		fs.writeFileSync(unreferencedPath, unreferenced, "utf8");
		assert.throws(
			() =>
				recordCheckpointTransition(ctx, workdir, runId, {
					transition: "version-plan-written",
					planPath: unreferencedPath,
					deferred: [{ itemId: "D-v0.1.0-1", disposition: "absorbed" }],
				}),
			/must be referenced by this version plan/,
		);

		// A dropped item now needs a confirmation; auto-complete never counts.
		const { applyQuestionAnswered, applyQuestionAsked, deferredQuestionId, mutateCheckpoint } = await import(
			"../src/workflow-state.ts"
		);
		const dropUser = deferredQuestionId("v0.1.0", "D-v0.1.0-2");
		mutateCheckpoint(workdir, runId, (cp) =>
			applyQuestionAnswered(
				applyQuestionAsked(cp, { questionId: dropUser, question: "drop?", options: ["drop", "keep"] }),
				dropUser,
				"drop",
				"user",
			),
		);
		assert.throws(
			() =>
				recordCheckpointTransition(ctx, workdir, runId, {
					transition: "version-plan-written",
					planPath: secondPath,
					deferred: [
						{ itemId: "D-v0.1.0-1", disposition: "absorbed" },
						{ itemId: "D-v0.1.0-2", disposition: "dropped" },
						{ itemId: "D-v0.1.0-3", disposition: "dropped" },
					],
				}),
			/needs a recorded user confirmation/,
		);
		const dropAuto = deferredQuestionId("v0.1.0", "D-v0.1.0-3");
		mutateCheckpoint(workdir, runId, (cp) =>
			applyQuestionAnswered(
				applyQuestionAsked(cp, { questionId: dropAuto, question: "drop 3?", options: ["drop", "keep"] }),
				dropAuto,
				"drop",
				"auto-complete",
			),
		);
		assert.throws(
			() =>
				recordCheckpointTransition(ctx, workdir, runId, {
					transition: "version-plan-written",
					planPath: secondPath,
					deferred: [
						{ itemId: "D-v0.1.0-1", disposition: "absorbed" },
						{ itemId: "D-v0.1.0-2", disposition: "dropped" },
						{ itemId: "D-v0.1.0-3", disposition: "dropped" },
					],
				}),
			/does not count/,
		);

		// Absorb 1 and 3, drop 2 with the recorded user confirmation: accepted,
		// and the missing GitHub references surface as a run notice.
		const recorded = recordCheckpointTransition(ctx, workdir, runId, {
			transition: "version-plan-written",
			planPath: secondPath,
			deferred: [
				{ itemId: "D-v0.1.0-1", disposition: "absorbed" },
				{ itemId: "D-v0.1.0-2", disposition: "dropped" },
				{ itemId: "D-v0.1.0-3", disposition: "absorbed" },
			],
		});
		assert.equal(recorded.huge?.deferred.length, 3);
		assert.equal(recorded.huge?.deferred.find((entry) => entry.itemId === "D-v0.1.0-2")?.confirmationId, dropUser);
		const summary = hugeRunSummary(workdir, runId) as { refNotices: string[]; position: string };
		assert.equal(summary.position, "2/3");
		assert.ok(summary.refNotices.length >= 1, "expected a huge-refs run notice");
		assert.match(summary.refNotices[0] ?? "", /GitHub/);
	});

	it("consolidates huge review rounds into their stage next actions", async () => {
		const { recordCheckpointTransition } = await import("../tools/plans.ts");
		const { workdir, runId, artifactDir } = await setup("review");
		const ctx = { sessionManager: { id: "s" } };
		const overallPath = path.join(artifactDir, "PLAN_overall_v1.md");
		fs.writeFileSync(overallPath, overallPlan(VERSIONS_MD), "utf8");
		recordCheckpointTransition(ctx, workdir, runId, { transition: "overall-plan-written", planPath: overallPath });
		const { recordLaneOutcome, startReviewRound } = await import("../src/workflow-state.ts");
		const roundId = "huge-overall-r1";
		startReviewRound(workdir, runId, {
			roundId,
			role: "reviewer",
			target: "plan",
			reviewers: 1,
			lanes: [{ laneId: "a" }],
			planPath: overallPath,
		});
		recordLaneOutcome(workdir, runId, roundId, "a", { ok: true, output: "finding" });
		const consolidated = recordCheckpointTransition(ctx, workdir, runId, {
			transition: "overall-review-consolidated",
			roundId,
		});
		assert.equal(consolidated.nextAction, "accept-overall");
	});
});
