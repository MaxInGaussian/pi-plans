/**
 * Plan-quality rubric scoring for the pi-plans benchmark (I-006, D-017).
 *
 * DESCRIPTIVE ONLY for the treatment arm (the baseline arm produces no plan
 * artifacts, so no cross-arm quality comparison exists). Four dimensions,
 * 1-5 each: goal decomposition, acceptance criteria, risk anticipation,
 * scope control. Judge should be a different model than the benchmark model
 * (RUBRIC_JUDGE_MODEL); if the same model is unavoidable, disclose in the
 * tech note. If fewer than 20 plan artifacts are available, report the actual
 * count and the reason (pre-registered degrade clause, C-F010).
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench/rubric.ts --results-dir <dir> [--sample 20]
 *   node --experimental-strip-types scripts/bench/rubric.ts --plans-dir <dir> --offline
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const RUBRIC_DIMENSIONS = [
	"goal decomposition",
	"acceptance criteria",
	"risk anticipation",
	"scope control",
] as const;

function parseArgs(): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 2; i < process.argv.length; i++) {
		const t = process.argv[i];
		if (t.startsWith("--")) {
			const next = process.argv[i + 1];
			out[t.replace(/^--/, "")] = next !== undefined && !next.startsWith("--") ? next : true;
			if (out[t.replace(/^--/, "")] !== true) i++;
		}
	}
	return out;
}

function findPlanFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "vendor" || entry.name === "node_modules") continue;
				walk(p);
			} else if (entry.name === "PLAN_v1.md" || entry.name.startsWith("PLAN_v")) found.push(p);
		}
	};
	walk(root);
	return found;
}

function judgeModel(): string {
	return String(process.env.RUBRIC_JUDGE_MODEL ?? "");
}

function scoreWithJudge(planText: string): Record<string, number> | null {
	const model = judgeModel();
	if (!model) return null;
	const prompt = [
		"You are scoring a coding-agent PLAN artifact for research. Score each dimension 1-5 (integers).",
		`Dimensions: ${RUBRIC_DIMENSIONS.join(", ")}.`,
		"Respond with ONLY a JSON object like {\"goal decomposition\": 3, \"acceptance criteria\": 4, \"risk anticipation\": 2, \"scope control\": 4}.",
		"--- PLAN START ---",
		planText.slice(0, 20000),
		"--- PLAN END ---",
	].join("\n");
	const res = spawnSync("pi", ["--print", "--no-session", "--model", model, prompt], {
		encoding: "utf8",
		timeout: 120_000,
	});
	const match = res.stdout?.match(/\{[^{}]*\}/s);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[0]);
		const scores: Record<string, number> = {};
		for (const dim of RUBRIC_DIMENSIONS) scores[dim] = Number(parsed[dim]) || 0;
		return scores;
	} catch {
		return null;
	}
}

function main(): void {
	const args = parseArgs();
	const resultsDir = String(args["results-dir"] ?? path.join(import.meta.dirname ?? ".", "results"));
	const sample = Number(args["sample"] ?? 20);
	const plans = args["plans-dir"]
		? findPlanFiles(String(args["plans-dir"]))
		: findPlanFiles(resultsDir).filter((p) => p.includes("treatment") || p.includes("plans"));
	if (plans.length === 0) {
		console.error("No PLAN_v*.md artifacts found. Run the treatment arm with plan-artifact syncing enabled.");
		process.exit(1);
	}
	const picked = plans.slice(0, sample);
	if (plans.length < sample) {
		console.log(`[rubric] NOTE: only ${plans.length} plan artifacts available (<${sample}); reporting actual count (pre-registered degrade clause).`);
	}
	const rows: string[] = ["plan,goal_decomposition,acceptance_criteria,risk_anticipation,scope_control,average"];
	const summary: Record<string, { sum: number; n: number }> = {};
	for (const file of picked) {
		const text = fs.readFileSync(file, "utf8");
		let scores = args["offline"] ? null : scoreWithJudge(text);
		scores ??= Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, 0]));
		const avg = RUBRIC_DIMENSIONS.reduce((acc, d) => acc + (scores?.[d] ?? 0), 0) / RUBRIC_DIMENSIONS.length;
		rows.push([path.basename(file), ...RUBRIC_DIMENSIONS.map((d) => scores?.[d] ?? 0), avg.toFixed(2)].join(","));
		for (const d of RUBRIC_DIMENSIONS) {
			summary[d] ??= { sum: 0, n: 0 };
			summary[d].sum += scores?.[d] ?? 0;
			summary[d].n += scores?.[d] ? 1 : 0;
		}
	}
	const outDir = path.dirname(picked[0]);
	const means = RUBRIC_DIMENSIONS.map((d) => `- ${d}: ${(summary[d].sum / Math.max(1, summary[d].n)).toFixed(2)} (n=${summary[d].n})`);
	const md = [
		"# Plan-quality rubric — treatment arm, DESCRIPTIVE ONLY (D-017)",
		"",
		`- Artifacts scored: ${picked.length} (requested ${sample})`,
		`- Judge model: ${judgeModel() || "NOT SET — scores are placeholders; set RUBRIC_JUDGE_MODEL (prefer non-flash) or fill manually"}`,
		"",
		...means,
		"",
		"> Not comparable with the baseline arm (it produces no plan artifacts by design).",
	].join("\n");
	fs.writeFileSync(path.join(outDir, "rubric.md"), md);
	fs.writeFileSync(path.join(outDir, "rubric.csv"), rows.join("\n"));
	console.log(md);
}

main();
