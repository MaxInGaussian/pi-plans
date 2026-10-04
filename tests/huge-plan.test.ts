/** Tests for huge-plan artifact parsing (plan-huge streams). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { latestPlanVersion } from "../src/plan.ts";
import {
	OVERALL_STREAM,
	deferredEntryIds,
	githubEvidenceLint,
	githubEvidenceUrls,
	hasHugePlan,
	hugePlanFileName,
	hugeStreamOf,
	isOverallPlan,
	latestHugePlan,
	latestHugePlansByStream,
	lintDeferredSection,
	lintVersionsTable,
	listHugePlans,
	nextHugePlanPath,
	parseDeferredSection,
	parseHugePlanName,
	parseHugePlanPath,
	parseVersionLabel,
	parseVersionsTable,
	readHugeVersionRows,
} from "../src/huge-plan.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/huge/", import.meta.url));
const OVERALL_PLAN = fs.readFileSync(path.join(FIXTURE_DIR, "PLAN_overall_v1.md"), "utf8");
const VERSION_PLAN = fs.readFileSync(path.join(FIXTURE_DIR, "PLAN_v0.1.0_v1.md"), "utf8");

const tmpDirs: string[] = [];
function tmpdir(tag: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-plans-huge-${tag}-`));
	tmpDirs.push(dir);
	return dir;
}
function writePlan(dir: string, name: string, text = ""): void {
	fs.writeFileSync(path.join(dir, name), text, "utf8");
}

after(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function versionsTable(labels: string[], extra = ""): string {
	const rows = labels.map((label) => `- \`${label}\`: mission of ${label} — done: ${label} works.`);
	return `## Versions\n\n${rows.join("\n")}\n${extra}`;
}

describe("huge plan names", () => {
	it("parses overall and version plan names with rounds", () => {
		assert.deepEqual(parseHugePlanName("PLAN_overall_v1.md"), { stream: OVERALL_STREAM, kind: "overall", round: 1 });
		assert.deepEqual(parseHugePlanName("PLAN_v0.1.0_v3.md"), {
			stream: "v0.1.0",
			kind: "version",
			versionLabel: "v0.1.0",
			round: 3,
		});
		assert.deepEqual(parseHugePlanName("PLAN_v0.12.4_v10.markdown"), {
			stream: "v0.12.4",
			kind: "version",
			versionLabel: "v0.12.4",
			round: 10,
		});
	});

	it("rejects legacy names, wrong labels and non-plan files", () => {
		assert.equal(parseHugePlanName("PLAN_v1.md"), null);
		assert.equal(parseHugePlanName("PLAN_v0.1.0.md"), null);
		assert.equal(parseHugePlanName("PLAN_v1.0.0_v1.md"), null);
		assert.equal(parseHugePlanName("PLAN_overall_v1.txt"), null);
		assert.equal(parseHugePlanName("PLAN_v0.1.0_v1.md.bak"), null);
	});

	it("parses version labels with the v0.Y.Z contract", () => {
		assert.deepEqual(parseVersionLabel("v0.1.0"), { minor: 1, patch: 0 });
		assert.deepEqual(parseVersionLabel("v0.12.3"), { minor: 12, patch: 3 });
		assert.equal(parseVersionLabel("v0.0.1"), null);
		assert.equal(parseVersionLabel("v1.0.0"), null);
		assert.equal(parseVersionLabel("0.1.0"), null);
	});

	it("builds paths and stream identities", () => {
		const file = parseHugePlanPath("/tmp/artifacts/PLAN_v0.2.0_v4.md");
		assert.equal(file?.stream, "v0.2.0");
		assert.equal(file?.round, 4);
		assert.equal(isOverallPlan("/tmp/artifacts/PLAN_overall_v2.md"), true);
		assert.equal(isOverallPlan("/tmp/artifacts/PLAN_v0.2.0_v4.md"), false);
		assert.equal(hugeStreamOf("/tmp/artifacts/PLAN_v0.2.0_v4.md"), "v0.2.0");
		assert.equal(hugeStreamOf("/tmp/artifacts/PLAN_v4.md"), null);
		assert.equal(hugePlanFileName(OVERALL_STREAM, 2), "PLAN_overall_v2.md");
		assert.equal(hugePlanFileName("v0.3.0", 1), "PLAN_v0.3.0_v1.md");
	});

	it("resolves the latest round per stream and the next path", () => {
		const dir = tmpdir("latest");
		writePlan(dir, "PLAN_overall_v1.md", OVERALL_PLAN);
		writePlan(dir, "PLAN_v0.1.0_v1.md", VERSION_PLAN);
		writePlan(dir, "PLAN_v0.1.0_v2.md", VERSION_PLAN);
		writePlan(dir, "PLAN_v0.2.0_v1.md", VERSION_PLAN.replaceAll("v0.1.0", "v0.2.0"));
		assert.equal(latestHugePlan(dir, "v0.1.0")?.round, 2);
		assert.equal(latestHugePlan(dir, OVERALL_STREAM)?.round, 1);
		assert.equal(latestHugePlan(dir, "v0.9.9"), null);
		assert.equal(nextHugePlanPath(dir, "v0.1.0").path, path.join(dir, "PLAN_v0.1.0_v3.md"));
		assert.equal(nextHugePlanPath(dir, OVERALL_STREAM).path, path.join(dir, "PLAN_overall_v2.md"));
		assert.equal(nextHugePlanPath(dir, "v0.1.0", 7).path, path.join(dir, "PLAN_v0.1.0_v7.md"));
		assert.equal(nextHugePlanPath(dir, "v0.1.0", 7).round, 7);
		assert.throws(() => nextHugePlanPath(dir, "v0.1.0", 0));
		assert.equal(hasHugePlan(dir), true);
		assert.deepEqual(
			latestHugePlansByStream(dir).map((file) => file.stream),
			[OVERALL_STREAM, "v0.1.0", "v0.2.0"].sort((a, b) => a.localeCompare(b)),
		);
		assert.deepEqual(
			listHugePlans(dir).map((file) => `${file.stream}:${file.round}`),
			[`${OVERALL_STREAM}:1`, "v0.1.0:1", "v0.1.0:2", "v0.2.0:1"],
		);
	});

	it("legacy-latestPlanVersion-ignores-huge-names", () => {
		const dir = tmpdir("legacy");
		writePlan(dir, "PLAN_overall_v1.md", OVERALL_PLAN);
		writePlan(dir, "PLAN_v0.1.0_v1.md", VERSION_PLAN);
		writePlan(dir, "PLAN_v0.1.0_v2.md", VERSION_PLAN);
		assert.equal(latestPlanVersion(dir), null);
		assert.equal(listHugePlans(dir).length, 3);
	});

	it("reads the version rows of the latest overall plan", () => {
		assert.deepEqual(
			readHugeVersionRows(FIXTURE_DIR).map((row) => row.label),
			["v0.1.0", "v0.2.0", "v0.3.0"],
		);
		assert.deepEqual(readHugeVersionRows(tmpdir("empty")), []);
	});
});

describe("huge version table", () => {
	it("parses rows with mission and done clauses", () => {
		const rows = parseVersionsTable(OVERALL_PLAN);
		assert.equal(rows.length, 3);
		assert.deepEqual(
			rows.map((row) => row.label),
			["v0.1.0", "v0.2.0", "v0.3.0"],
		);
		assert.match(rows[0]!.mission, /walking skeleton/);
		assert.match(rows[0]!.done, /end to end/);
		assert.equal(lintVersionsTable(OVERALL_PLAN), null);
	});

	it("version-table-rejects-one-and-eleven", () => {
		assert.match(lintVersionsTable(versionsTable(["v0.1.0"])) ?? "", /至少 2 版/);
		const eleven = Array.from({ length: 11 }, (_, i) => `v0.${i + 1}.0`);
		assert.match(lintVersionsTable(versionsTable(eleven)) ?? "", /最多 10 版/);
	});

	it("version-table-rejects-nonascending", () => {
		assert.match(lintVersionsTable(versionsTable(["v0.1.0", "v0.2.0", "v0.2.0"])) ?? "", /严格升序/);
		assert.match(lintVersionsTable(versionsTable(["v0.1.0", "v0.1.0"])) ?? "", /严格升序/);
		assert.match(lintVersionsTable(versionsTable(["v0.2.0", "v0.3.0"])) ?? "", /首版必须是 v0.1.0/);
		assert.match(lintVersionsTable(versionsTable(["v0.1.0", "v0.0.5"])) ?? "", /v0\.Y\.Z/);
	});

	it("rejects rows without mission or done clause and a missing section", () => {
		assert.match(lintVersionsTable(versionsTable(["v0.1.0", "v0.2.0"]).replace(/done: v0\.2\.0 works\./, "")) ?? "", /缺少 done/);
		assert.match(lintVersionsTable("## Goals\n\n- nothing\n") ?? "", /缺少 `## Versions`/);
	});
});

describe("huge deferred ledger", () => {
	it("parses the section target and entries", () => {
		const section = parseDeferredSection(VERSION_PLAN);
		assert.equal(section?.target, "v0.2.0");
		assert.deepEqual(
			section?.entries.map((entry) => entry.id),
			["D-v0.1.0-1", "D-v0.1.0-2"],
		);
		assert.match(section?.entries[0]!.reason ?? "", /backend seam/);
		assert.equal(lintDeferredSection(VERSION_PLAN), null);
	});

	it("parses `Deferred to none` as a null target", () => {
		const section = parseDeferredSection("## Deferred to none\n\n- `D-v0.3.0-1`: polish — reason: out of scope.\n");
		assert.equal(section?.target, null);
		assert.deepEqual(
			section?.entries.map((entry) => entry.id),
			["D-v0.3.0-1"],
		);
	});

	it("deferred-ids-are-version-scoped", () => {
		const first = parseDeferredSection(VERSION_PLAN);
		const second = parseDeferredSection(VERSION_PLAN.replaceAll("v0.1.0", "v0.2.0").replace("## Deferred to v0.2.0", "## Deferred to v0.3.0"));
		const firstIds = new Set(deferredEntryIds(VERSION_PLAN));
		const secondIds = new Set(deferredEntryIds(VERSION_PLAN.replaceAll("v0.1.0", "v0.2.0").replace("## Deferred to v0.2.0", "## Deferred to v0.3.0")));
		assert.equal(first?.target, "v0.2.0");
		assert.equal(second?.target, "v0.3.0");
		assert.equal(firstIds.size, 2);
		assert.equal(secondIds.size, 2);
		for (const id of secondIds) assert.equal(firstIds.has(id), false);
	});

	it("lints malformed, duplicate and reason-less entries", () => {
		const malformed = "## Deferred to v0.2.0\n\n- `D-1`: x — reason: y.\n";
		assert.match(lintDeferredSection(malformed) ?? "", /D-vX\.Y\.Z-n/);
		const duplicate = "## Deferred to v0.2.0\n\n- `D-v0.1.0-1`: x — reason: y.\n- `D-v0.1.0-1`: z — reason: w.\n";
		assert.match(lintDeferredSection(duplicate) ?? "", /重复/);
		const noReason = "## Deferred to v0.2.0\n\n- `D-v0.1.0-1`: x.\n";
		assert.match(lintDeferredSection(noReason) ?? "", /缺少 reason/);
		assert.equal(lintDeferredSection("## Tasks\n\n- `Task-1`: x\n"), null);
	});
});

describe("huge evidence lint", () => {
	it("counts GitHub project urls from the Evidence section", () => {
		assert.deepEqual(githubEvidenceUrls(VERSION_PLAN), [
			"https://github.com/example/cli-kit",
			"https://github.com/example/tiny-store",
		]);
		assert.deepEqual(githubEvidenceUrls("## Tasks\n\n- `Task-1`: x\n"), []);
		const duplicated = "## Evidence\n\n- https://github.com/a/b\n- https://github.com/a/b\n";
		assert.deepEqual(githubEvidenceUrls(duplicated), ["https://github.com/a/b"]);
	});

	it("github-evidence-count-threshold-one", () => {
		assert.equal(githubEvidenceLint(VERSION_PLAN), null);
		assert.match(githubEvidenceLint("## Evidence\n\n- nothing here\n") ?? "", /0 个 GitHub/);
		assert.equal(githubEvidenceLint("## Evidence\n\n- nothing\n", 0), null);
		assert.match(githubEvidenceLint("## Evidence\n\n- https://github.com/a/b\n", 2) ?? "", /1 个 GitHub/);
	});
});
