/**
 * Multi-reviewer execution review: even VC split, direction resolution, lane
 * briefs, report merge, and the parallel session path.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { __setSessionFactoryForTests } from "../src/agent-session.ts";
import {
	BACKUP_REVIEW_ASPECTS,
	buildAuditTask,
	mergeLaneRuns,
	planReviewLanes,
	resolveReviewerDirections,
	runCompletionAudit,
	splitEvenly,
	type AuditLane,
	type ReviewFinding,
} from "../src/auditor.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { parsePlanTasks, type CheckItem } from "../src/plan.ts";
import { askReviewerCount, maxUsefulReviewers, sanitizeDirections } from "../src/reviewer-count.ts";
import { buildTaskView } from "../src/tasks.ts";
import { FakeSession, fakeModelRegistry } from "./fake-agent-session.ts";

const checks = (n: number): CheckItem[] =>
	Array.from({ length: n }, (_, i) => ({ id: `VC-${String(i + 1).padStart(3, "0")}`, text: `covers \`Task-${i + 1}\`; pass condition: ok ${i + 1}`, done: false }));

const PLAN = `## Tasks

${Array.from({ length: 6 }, (_, i) => `- Task-${i + 1}: t${i + 1} — files: src/f${i + 1}.ts; wave: 1`).join("\n")}

## Verification Checks

${checks(6).map((c) => `- [ ] \`${c.id}\` ${c.text}`).join("\n")}
`;
const doneTasks = () => buildTaskView(parsePlanTasks(PLAN), Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Task-${i + 1}`, { status: "complete" }])));

const suggested = [
	{ id: "migration-rollback", direction: "Dig into the schema migration rollback path in src/db/migrate.ts and what a half-applied migration leaves behind." },
	{ id: "cache-invalidation", direction: "Check cache invalidation in src/cache.ts when the migration reorders keys and a stale entry is served." },
	{ id: "auth-edge", direction: "Probe permission checks in src/auth.ts for the new admin-only endpoints and the unauthenticated fallback." },
];

describe("splitEvenly", () => {
	it("balances contiguous chunks and keeps order", () => {
		assert.deepEqual(splitEvenly([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5], [6, 7]]);
		assert.deepEqual(splitEvenly([1, 2, 3, 4, 5, 6], 3), [[1, 2], [3, 4], [5, 6]]);
		assert.deepEqual(splitEvenly([], 2), [[], []]);
	});
});

describe("resolveReviewerDirections", () => {
	it("is empty for one reviewer", () => {
		assert.deepEqual(resolveReviewerDirections(1, suggested), []);
	});
	it("uses the executor's suggestions first and tops up from the back-up aspects", () => {
		const got = resolveReviewerDirections(3, [suggested[0]!]);
		assert.equal(got.length, 3);
		assert.equal(got[0]!.id, "migration-rollback");
		assert.deepEqual(got.slice(1).map((d) => d.id), BACKUP_REVIEW_ASPECTS.slice(0, 2).map((d) => d.id));
	});
	it("uses only back-up aspects when nothing was suggested and ignores extras beyond the count", () => {
		assert.deepEqual(resolveReviewerDirections(2, undefined).map((d) => d.id), ["correctness-vs-plan", "tests-and-evidence"]);
		assert.deepEqual(resolveReviewerDirections(2, suggested).map((d) => d.id), ["migration-rollback", "cache-invalidation"]);
	});
});

describe("sanitizeDirections", () => {
	it("keeps valid entries and reports each dropped one", () => {
		const { directions, dropped } = sanitizeDirections([
			suggested[0],
			{ id: "Bad Id", direction: "x".repeat(40) },
			{ id: "migration-rollback", direction: "y".repeat(40) },
			{ id: "short", direction: "too short" },
		]);
		assert.deepEqual(directions.map((d) => d.id), ["migration-rollback"]);
		assert.equal(dropped.length, 3);
	});
	it("rejects a non-array", () => {
		assert.equal(sanitizeDirections("nope").directions.length, 0);
	});
});

describe("planReviewLanes", () => {
	it("splits 15 checks 5/5/5 across three directed lanes with disjoint finding ranges", () => {
		const lanes = planReviewLanes(checks(15), 3, suggested);
		assert.deepEqual(lanes.map((l) => l.checks.length), [5, 5, 5]);
		assert.deepEqual(lanes.map((l) => l.id), suggested.map((d) => d.id));
		assert.deepEqual(lanes.map((l) => l.findingIdStart), [1, 101, 201]);
		assert.deepEqual(lanes[0]!.others.map((d) => d.id), ["cache-invalidation", "auth-edge"]);
		const all = lanes.flatMap((l) => l.checks.map((c) => c.id));
		assert.equal(new Set(all).size, 15, "every check belongs to exactly one reviewer");
	});
	it("never runs more reviewers than checks, and none for a single reviewer", () => {
		assert.equal(planReviewLanes(checks(2), 3, undefined).length, 2);
		assert.equal(planReviewLanes(checks(1), 3, undefined).length, 0);
		assert.equal(planReviewLanes(checks(9), 1, undefined).length, 0);
	});
	it("runs findings-only lanes when no check is pending", () => {
		const lanes = planReviewLanes([], 2, undefined);
		assert.equal(lanes.length, 2);
		assert.ok(lanes.every((l) => l.checks.length === 0));
	});
	it("starts new finding ids above the prior ones", () => {
		const prior = [{ id: "F-003", severity: "high", taskIds: [], note: "", evidence: "", raw: "" }] as ReviewFinding[];
		assert.deepEqual(planReviewLanes(checks(4), 2, undefined, prior).map((l) => l.findingIdStart), [101, 201]);
	});
});

describe("lane brief", () => {
	it("lists only the lane's checks, its direction, the others' directions and its id range", () => {
		const lanes = planReviewLanes(checks(6), 2, suggested);
		const brief = buildAuditTask("/p/PLAN_v1.md", checks(6), doneTasks(), 1, [], undefined, lanes[1]);
		assert.match(brief, /reviewer 2 of 2/);
		assert.match(brief, /VC-004/);
		assert.doesNotMatch(brief, /`VC-001`/);
		assert.match(brief, /Your direction \(cache-invalidation\)/);
		assert.match(brief, /migration-rollback:/);
		assert.match(brief, /from F-101 upward/);
		assert.match(brief, /emit no verdict for any check not listed here/);
	});
	it("keeps the single-reviewer brief free of lane text", () => {
		const brief = buildAuditTask("/p/PLAN_v1.md", checks(6), doneTasks(), 1);
		assert.doesNotMatch(brief, /parallel review round/);
		assert.match(brief, /VC-001/);
		assert.match(brief, /VC-006/);
	});
	it("tells a findings-only lane to skip verdicts", () => {
		const lanes = planReviewLanes([], 2, undefined);
		const brief = buildAuditTask("/p/PLAN_v1.md", checks(6), doneTasks(), 1, [], undefined, lanes[0]);
		assert.match(brief, /section 1 is the single line/);
	});
});

const verdict = (id: string, v: string) => `- \`${id}\` — verdict: ${v}; evidence: x; note: n`;
const finding = (id: string, sev: string, extra = "") =>
	`- \`${id}\` — severity: ${sev}; tasks: Task-1; proposed-task: fix it; note: bad${extra}; evidence: src/a.ts`;

function lanesFor(n = 6, count = 3): AuditLane[] {
	return planReviewLanes(checks(n), count, suggested);
}

describe("mergeLaneRuns", () => {
	it("unions verdicts and findings into one outcome with sectioned report", () => {
		const lanes = lanesFor(6, 3);
		const outcome = mergeLaneRuns(2, [
			{ lane: lanes[0]!, ok: true, output: `${verdict("VC-001", "pass")}\n${verdict("VC-002", "pass")}\n\n- none.` },
			{ lane: lanes[1]!, ok: true, output: `${verdict("VC-003", "fail")}\n${verdict("VC-004", "pass")}\n\n${finding("F-101", "high")}` },
			{ lane: lanes[2]!, ok: true, output: `${verdict("VC-005", "pass")}\n${verdict("VC-006", "pass")}\n\n${finding("F-201", "low")}` },
		]);
		assert.ok(outcome && !("cancelled" in outcome));
		assert.equal(outcome.round, 2);
		assert.deepEqual([...outcome.passed].sort(), ["VC-001", "VC-002", "VC-004", "VC-005", "VC-006"]);
		assert.deepEqual(outcome.failed, ["VC-003"]);
		assert.deepEqual(outcome.undeterminable, []);
		assert.deepEqual(outcome.findings!.map((f) => f.id), ["F-101", "F-201"]);
		assert.match(outcome.report, /## Reviewer 2\/3 — cache-invalidation \(VC-003, VC-004\)/);
	});
	it("makes only a failed reviewer's checks undeterminable", () => {
		const lanes = lanesFor(6, 3);
		const outcome = mergeLaneRuns(1, [
			{ lane: lanes[0]!, ok: true, output: `${verdict("VC-001", "pass")}\n${verdict("VC-002", "pass")}` },
			{ lane: lanes[1]!, ok: false, output: "", error: "boom" },
			{ lane: lanes[2]!, ok: true, output: `${verdict("VC-005", "pass")}\n${verdict("VC-006", "pass")}` },
		]);
		assert.ok(outcome && !("cancelled" in outcome));
		assert.deepEqual([...outcome.undeterminable].sort(), ["VC-003", "VC-004"]);
		assert.match(outcome.report, /this reviewer failed to run: boom/);
	});
	it("returns null when every reviewer failed and cancelled when any was cancelled", () => {
		const lanes = lanesFor(4, 2);
		assert.equal(mergeLaneRuns(1, lanes.map((lane) => ({ lane, ok: false, output: "" }))), null);
		const cancelled = mergeLaneRuns(1, [
			{ lane: lanes[0]!, ok: true, output: verdict("VC-001", "pass") },
			{ lane: lanes[1]!, ok: false, cancelled: true, output: "" },
		]);
		assert.deepEqual(cancelled, { cancelled: true });
	});
	it("collapses a finding reported by two reviewers to one entry with the highest severity", () => {
		const lanes = lanesFor(4, 2);
		const outcome = mergeLaneRuns(1, [
			{ lane: lanes[0]!, ok: true, output: `${verdict("VC-001", "pass")}\n${verdict("VC-002", "pass")}\n${finding("F-001", "low")}` },
			{ lane: lanes[1]!, ok: true, output: `${verdict("VC-003", "pass")}\n${verdict("VC-004", "pass")}\n${finding("F-001", "high")}` },
		]);
		assert.ok(outcome && !("cancelled" in outcome));
		assert.equal(outcome.findings!.length, 1);
		assert.equal(outcome.findings![0]!.severity, "high");
	});
});

let workdir = "";
before(() => {
	workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-auditor-multi-"));
	setMessagingApi({ appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: async () => {} });
});
afterEach(() => __setSessionFactoryForTests(null));

describe("runCompletionAudit with several reviewers", () => {
	it("runs one read-only session per lane in parallel, each with its own share and direction", async () => {
		const briefs: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		__setSessionFactoryForTests(async () => ({
			session: new FakeSession(async (api) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				briefs.push(api.prompt);
				await api.sleep(20);
				const ids = [...api.prompt.matchAll(/^- `(VC-\d+)`:/gm)].map((m) => m[1]!);
				api.say(`${ids.map((id) => verdict(id, "pass")).join("\n")}\n\n- none.`);
				inFlight -= 1;
			}),
		}));
		const lanes = planReviewLanes(checks(6), 3, suggested);
		const done: string[] = [];
		const outcome = await runCompletionAudit(
			{ cwd: workdir, model: { provider: "m", id: "s" }, modelRegistry: fakeModelRegistry } as never,
			{ planPath: path.join(workdir, "PLAN_v1.md"), checklist: checks(6), tasks: doneTasks(), round: 1, lanes, onLaneResult: (id) => done.push(id) },
		);
		assert.ok(outcome && !("cancelled" in outcome));
		assert.equal(outcome.passed.length, 6);
		assert.equal(maxInFlight, 3, "reviewers run concurrently");
		assert.equal(briefs.length, 3);
		for (const lane of lanes) {
			const brief = briefs.find((b) => b.includes(`Your direction (${lane.id})`));
			assert.ok(brief, `a brief carries direction ${lane.id}`);
			for (const check of lane.checks) assert.match(brief, new RegExp(check.id));
		}
		assert.deepEqual([...done].sort(), suggested.map((d) => d.id).sort());
	});

	it("degrades only the failed reviewer's share", async () => {
		let n = 0;
		__setSessionFactoryForTests(async () => {
			const index = n++;
			return {
				session: new FakeSession(async (api) => {
					if (index === 1) throw new Error("model exploded");
					const ids = [...api.prompt.matchAll(/^- `(VC-\d+)`:/gm)].map((m) => m[1]!);
					api.say(ids.map((id) => verdict(id, "pass")).join("\n"));
				}),
			};
		});
		const lanes = planReviewLanes(checks(6), 3, undefined);
		const outcome = await runCompletionAudit(
			{ cwd: workdir, model: { provider: "m", id: "s" }, modelRegistry: fakeModelRegistry } as never,
			{ planPath: path.join(workdir, "PLAN_v1.md"), checklist: checks(6), tasks: doneTasks(), round: 1, lanes },
		);
		assert.ok(outcome && !("cancelled" in outcome));
		assert.equal(outcome.passed.length, 4);
		assert.equal(outcome.undeterminable.length, 2);
	});
});

describe("askReviewerCount", () => {
	const host = (pick: (title: string, options: string[]) => string | undefined, seen: string[][] = []) => ({
		hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => {
				seen.push(options);
				return pick(title, options);
			},
		},
	});
	it("offers no more reviewers than pending checks and returns the pick", async () => {
		const seen: string[][] = [];
		const picked = await askReviewerCount(host((_t, o) => o[1], seen), "en", 2);
		assert.equal(picked, 2);
		assert.equal(seen[0]!.length, 2);
		assert.equal(maxUsefulReviewers(15), 3);
		assert.equal(maxUsefulReviewers(0), 1);
	});
	it("shows each reviewer's share of the checks", async () => {
		const seen: string[][] = [];
		await askReviewerCount(host(() => undefined, seen), "en", 15);
		assert.match(seen[0]![2]!, /3 reviewers \(about 5 checks each\)/);
	});
	it("returns null with no UI, on Esc, and when the selector throws", async () => {
		assert.equal(await askReviewerCount({ hasUI: false }, "en", 6), null);
		assert.equal(await askReviewerCount(host(() => undefined), "en", 6), null);
		assert.equal(await askReviewerCount({ hasUI: true, ui: { select: async () => { throw new Error("x"); } } }, "en", 6), null);
	});
});
