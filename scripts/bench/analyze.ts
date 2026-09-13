/**
 * Statistical analysis for the pi-plans A/B benchmark (I-003).
 *
 * Pre-registered rules (PLAN_v3 D-012) — do not adjust after seeing data:
 * - Analysis unit: task (paired across arms).
 * - PRIMARY: seed-1 full-set McNemar exact test on resolve outcomes +
 *   paired bootstrap CIs (10k resamples) for cost and turns.
 * - SECONDARY (sensitivity): discordant-pair reruns aggregated by per-task
 *   majority vote across seeds; reported separately, never pooled into the
 *   primary test.
 * - Cost includes parent + subagent usage (F-001/C-F001).
 *
 * Input: a results directory containing harbor trial outputs
 * (a result.json per trial with task id + reward + agent context tokens/cost), or an
 * explicit trials JSON for testing (see --input).
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench/analyze.ts --results-dir <dir>
 *   node --experimental-strip-types scripts/bench/analyze.ts --input trials.json --out <dir>
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface TrialRecord {
	taskId: string;
	arm: "baseline" | "treatment";
	seed: number;
	resolved: boolean;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	turns: number;
	wallTimeSec: number;
	subagentCostUsd?: number;
	subagentInputTokens?: number;
}

interface Pair {
	taskId: string;
	baseline: TrialRecord;
	treatment: TrialRecord;
}

function binomialLowerTail(k: number, n: number): number {
	// P(X <= k) under Bin(n, 0.5).
	if (k < 0) return 0;
	if (k >= n) return 1;
	const p = 0.5;
	let sum = 0;
	const coeff = (a: number): number => {
		let r = 1;
		for (let i = 1; i <= a; i++) r = (r * (n - i + 1)) / i;
		return r;
	};
	for (let i = 0; i <= k; i++) sum += coeff(i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
	return Math.min(1, sum);
}

/** Exact McNemar on paired binary outcomes: two-sided p = 2 * P(X <= min(b,c)).
 * (b=3,c=0 -> 2*0.125 = 0.25; b=0,c=0 -> 1 by definition of no discordance.) */
export function mcnemarExact(b: number, c: number): { statistic: number; pValue: number } {
	const n = b + c;
	if (n === 0) return { statistic: 0, pValue: 1 };
	const tail = binomialLowerTail(Math.min(b, c), n);
	return { statistic: b - c, pValue: Math.min(1, 2 * tail) };
}

// F-008: deterministic bootstrap — fixed-seed PRNG so published CIs are
// byte-reproducible from the same input.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function bootstrapCI(values: number[], iterations = 10_000, alpha = 0.05): {
	mean: number;
	ciLow: number;
	ciHigh: number;
} {
	const n = values.length;
	if (n === 0) return { mean: NaN, ciLow: NaN, ciHigh: NaN };
	let mean = 0;
	for (const v of values) mean += v;
	mean /= n;
	const rand = mulberry32(20260912);
	const means: number[] = [];
	for (let it = 0; it < iterations; it++) {
		let acc = 0;
		for (let i = 0; i < n; i++) acc += values[(rand() * n) | 0];
		means.push(acc / n);
	}
	means.sort((a, b2) => a - b2);
	const lo = means[Math.floor((alpha / 2) * iterations)];
	const hi = means[Math.ceil((1 - alpha / 2) * iterations) - 1];
	return { mean, ciLow: lo, ciHigh: hi };
}

export function collectTrials(resultsDir: string): TrialRecord[] {
	// Dedup: a repaired rerun appends a NEWER job dir for the same
	// (arm, task, seed); the newest result.json wins (older attempts stay on
	// disk for audit, analysis reflects the latest attempt).
	const byKey = new Map<string, { rec: TrialRecord; mtime: number }>();
	// Arm detection by RELATIVE path SEGMENT under resultsDir — never a regex
	// over the absolute path (the repo itself is .../Research/pi-plans/...,
	// which would classify every trial as treatment). Archived attempts
	// (non-authoritative) are excluded from the walk entirely.
	const walk = (dir: string, rel: string): void => {
		if (!fs.existsSync(dir)) return;
		const segs = rel.split("/");
		// Excluded subtrees: archived attempts (non-authoritative) and the
		// sensitivity reruns (separate analysis — their records must never
		// leak into the seed-1 primary via mtime dedup).
		if (segs.includes("archive") || segs.includes("sensitivity")) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			const childRel = rel ? rel + "/" + entry.name : entry.name;
			if (entry.isDirectory()) walk(p, childRel);
			else if (entry.name === "result.json") {
				try {
					const mtime = fs.statSync(p).mtimeMs;
					const data = JSON.parse(fs.readFileSync(p, "utf8"));
					// harbor result shapes: agent_result carries the AgentContext;
					// verifier rewards are nested (rewards.reward).
					const ctx = data?.agent_result ?? data?.agent_context ?? {};
					const startedAt = Date.parse(data?.agent_execution?.started_at ?? "");
					const finishedAt = Date.parse(data?.agent_execution?.finished_at ?? "");
					const wall = Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? (finishedAt - startedAt) / 1000 : 0;
					const segments = childRel.split("/");
					const arm: "baseline" | "treatment" = segments.includes("treatment") ? "treatment" : "baseline";
					const rec: TrialRecord = {
						taskId: String(data?.task_name ?? data?.taskName ?? path.basename(path.dirname(p))),
						arm,
						seed: Number(data?.seed ?? 1),
						resolved: Number(data?.verifier_result?.rewards?.reward ?? data?.verifier_result?.reward ?? 0) > 0,
						costUsd: Number(ctx?.cost_usd ?? 0),
						inputTokens: Number(ctx?.n_input_tokens ?? 0),
						outputTokens: Number(ctx?.n_output_tokens ?? 0),
						turns: Number(ctx?.metadata?.pi_plans_driver?.turns ?? 0),
						wallTimeSec: wall,
						subagentCostUsd: Number(ctx?.metadata?.pi_plans_subagent_usage?.totals?.cost ?? 0) || undefined,
						subagentInputTokens: Number(ctx?.metadata?.pi_plans_subagent_usage?.totals?.input ?? 0) || undefined,
					};
					const key = rec.arm + ":" + rec.taskId + ":" + rec.seed;
					const prev = byKey.get(key);
					if (!prev || prev.mtime < mtime) byKey.set(key, { rec, mtime });
				} catch { /* skip unreadable */ }
			}
		}
	};
	walk(resultsDir, "");
	return [...byKey.values()].map((v) => v.rec);
}

export function pairTrials(trials: TrialRecord[]): Pair[] {
	const byKey = new Map<string, TrialRecord>();
	for (const t of trials) byKey.set(t.arm + ":" + t.taskId + ":" + t.seed, t);
	const tasks = new Set(trials.filter((t) => t.arm === "baseline").map((t) => t.taskId));
	const pairs: Pair[] = [];
	for (const taskId of tasks) {
		const baseline = byKey.get("baseline:" + taskId + ":1");
		const treatment = byKey.get("treatment:" + taskId + ":1");
		if (baseline && treatment) pairs.push({ taskId, baseline, treatment });
	}
	return pairs;
}

export function analyze(pairs: Pair[]): Record<string, unknown> {
	const b = pairs.filter((p) => p.baseline.resolved && !p.treatment.resolved).length;
	const c = pairs.filter((p) => !p.baseline.resolved && p.treatment.resolved).length;
	// F-002: count both-resolved directly (pairs.length - b - c is the
	// concordant count, which also includes both-failed pairs).
	const both = pairs.filter((p) => p.baseline.resolved && p.treatment.resolved).length;
	const bothFailed = pairs.filter((p) => !p.baseline.resolved && !p.treatment.resolved).length;
	const mc = mcnemarExact(b, c);
	const baselineResolve = pairs.filter((p) => p.baseline.resolved).length;
	const treatmentResolve = pairs.filter((p) => p.treatment.resolved).length;

	const costDelta = pairs.map((p) => p.treatment.costUsd - p.baseline.costUsd);
	const costCi = bootstrapCI(costDelta);
	const turnsCi = bootstrapCI(pairs.map((p) => p.treatment.turns - p.baseline.turns));
	// Cost proxy: when the provider price table is zero (zai coding plan),
	// reported $ is 0 — token deltas are the meaningful cost dimension (C-004 note).
	const tokensPerTask = (t: (typeof pairs)[number]["baseline"]): number => t.inputTokens + t.outputTokens;
	const tokenDelta = pairs.map((p) => tokensPerTask(p.treatment) - tokensPerTask(p.baseline));
	const tokenCi = bootstrapCI(tokenDelta);
	const perResolvedCostTreatment = treatmentResolve
		? pairs.reduce((acc, p) => acc + p.treatment.costUsd, 0) / treatmentResolve
		: 0;
	const perResolvedCostBaseline = baselineResolve
		? pairs.reduce((acc, p) => acc + p.baseline.costUsd, 0) / baselineResolve
		: 0;
	const perResolvedTokensTreatment = treatmentResolve
		? pairs.reduce((acc, p) => acc + tokensPerTask(p.treatment), 0) / treatmentResolve
		: 0;
	const perResolvedTokensBaseline = baselineResolve
		? pairs.reduce((acc, p) => acc + tokensPerTask(p.baseline), 0) / baselineResolve
		: 0;

	return {
		n_pairs: pairs.length,
		resolve: {
			baseline: baselineResolve,
			treatment: treatmentResolve,
			baseline_rate: pairs.length ? baselineResolve / pairs.length : NaN,
			treatment_rate: pairs.length ? treatmentResolve / pairs.length : NaN,
		},
		mcnemar: { discordant_baseline_only: b, discordant_treatment_only: c, both_resolved: both, both_failed: bothFailed, p_value: mc.pValue },
		cost_delta_usd: costCi,
		token_delta_per_task: tokenCi,
		turns_delta: turnsCi,
		cost_per_resolved_task: { baseline: perResolvedCostBaseline, treatment: perResolvedCostTreatment },
		tokens_per_resolved_task: { baseline: perResolvedTokensBaseline, treatment: perResolvedTokensTreatment },
	};
}

function td0(v: number): string {
	return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtInt(v: number): string {
	return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "n/a";
}
function renderMarkdown(report: Record<string, any>): string {
	const r = report.resolve;
	const m = report.mcnemar;
	const cd = report.cost_delta_usd;
	const tk = report.token_delta_per_task;
	const td = report.turns_delta;
	const cpr = report.cost_per_resolved_task;
	return [
		"# pi-plans A/B — primary analysis (seed-1, paired, D-012)",
		"",
		`- Pairs (tasks): **${report.n_pairs}**`,
		`- Resolve: baseline **${r.baseline}/${report.n_pairs}** (${(100 * r.baseline_rate).toFixed(1)}%) vs treatment **${r.treatment}/${report.n_pairs}** (${(100 * r.treatment_rate).toFixed(1)}%)`,
		`- McNemar exact: discordant b=${m.discordant_baseline_only} (baseline-only), c=${m.discordant_treatment_only} (treatment-only), both=${m.both_resolved}; **p = ${m.p_value.toFixed(4)}**`,
		`- Δcost per task (treatment−baseline): mean **$${cd.mean.toFixed(4)}**, 95% CI [$${cd.ciLow.toFixed(4)}, $${cd.ciHigh.toFixed(4)}] (bootstrap 10k, includes parent+subagent)`,
		`- Δturns per task: mean **${td.mean.toFixed(2)}**, 95% CI [${td.ciLow.toFixed(2)}, ${td.ciHigh.toFixed(2)}]`,
		`- Δtokens per task (in+out, treatment−baseline): mean **${td0(tk.mean)}**, 95% CI [${td0(tk.ciLow)}, ${td0(tk.ciHigh)}] — the $ columns are 0 when the provider price table is zero (zai coding plan); tokens are the cost dimension`,
		`- per resolved task: baseline **$${cpr.baseline.toFixed(4)} / ${fmtInt(report.tokens_per_resolved_task.baseline)} tok** vs treatment **$${cpr.treatment.toFixed(4)} / ${fmtInt(report.tokens_per_resolved_task.treatment)} tok**`,
		"",
		"> Exploratory: pi-plans (forced-plan-big variant) on Terminal-Bench 2.0 / GLM-5.3-Flash / single seed (D-018). No generalization beyond this configuration.",
	].join("\n");
}

/** D-012 sensitivity analysis: per-task majority vote across ALL seeds present
 * under <results-dir>/sensitivity/ (plus the seed-1 outcome as one
 * vote). Reported separately from the primary test — never pooled into it. */
export interface SensitivityTrial extends TrialRecord {
	relSeed: number;
}

/** Sensitivity trials live under <resultsDir>/sensitivity/seed-N/<arm>/ — the
 * seed comes from the PATH (harbor result.json has no seed field). Each trial
 * dir is analyzed in isolation via collectTrials (safe: that subtree contains
 * no sensitivity/archive segments, so no contamination). */
export function collectSensitivityTrials(resultsDir: string): SensitivityTrial[] {
	const out: SensitivityTrial[] = [];
	const root = path.join(resultsDir, "sensitivity");
	const walk = (dir: string, rel: string): void => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			const childRel = rel ? rel + "/" + entry.name : entry.name;
			if (entry.isDirectory()) walk(p, childRel);
			else if (entry.name === "result.json") {
				try {
					const seedMatch = childRel.match(/seed-(\d+)/);
					if (!seedMatch) continue;
					const recs = collectTrials(path.dirname(p));
					if (recs.length > 0) out.push({ ...recs[recs.length - 1], relSeed: Number(seedMatch[1]) });
				} catch { /* skip unreadable */ }
			}
		}
	};
	walk(root, "");
	return out;
}

export function sensitivityVotes(
	primaryPairs: Array<{ taskId: string; baseline: TrialRecord; treatment: TrialRecord }>,
	rerun: SensitivityTrial[],
): Array<{ taskId: string; baselineVotes: number; treatmentVotes: number; winner: string }> {
	// Votes: seed-1 primary outcome + each rerun seed, per arm. Tasks enter the
	// table only if they are discordant at seed-1 (the rerun targets them).
	const rows: Array<{ taskId: string; baselineVotes: number; treatmentVotes: number; winner: string }> = [];
	for (const pair of primaryPairs) {
		const b1 = pair.baseline.resolved;
		const t1 = pair.treatment.resolved;
		if (b1 === t1) continue;
		let bv = (b1 ? 1 : 0);
		let tv = (t1 ? 1 : 0);
		for (const t of rerun) {
			if (t.taskId !== pair.taskId) continue;
			if (t.arm === "baseline") bv += t.resolved ? 1 : 0;
			else tv += t.resolved ? 1 : 0;
		}
		const winner = bv > tv ? "baseline" : tv > bv ? "treatment" : "tie";
		rows.push({ taskId: pair.taskId, baselineVotes: bv, treatmentVotes: tv, winner });
	}
	return rows;
}

function renderSensitivity(rows: Array<{ taskId: string; baselineVotes: number; treatmentVotes: number; winner: string }>): string {
	const treatment = rows.filter((r) => r.winner === "treatment").length;
	const baseline = rows.filter((r) => r.winner === "baseline").length;
	const ties = rows.filter((r) => r.winner === "tie").length;
	return [
		"# Sensitivity analysis — discordant-pair reruns (D-012, NOT the primary test)",
		"",
		`- Tasks with rerun votes: ${rows.length} (each task: seed-1 + up to 2 rerun seeds, majority vote)`,
		`- Majority winner: treatment **${treatment}** | baseline **${baseline}** | tie **${ties}**`,
		"",
		"| task | baseline votes | treatment votes | winner |",
		"|---|---|---|---|",
		...rows.map((r) => `| ${r.taskId} | ${r.baselineVotes} | ${r.treatmentVotes} | ${r.winner} |`),
		"",
		"> Sensitivity only: this table never replaces or augments the seed-1 McNemar primary result.",
	].join("\n");
}

function main(): void {
	const args: Record<string, string> = {};
	for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
	const resultsDir = args["results-dir"] ?? path.join(import.meta.dirname ?? ".", "results");
	const pairs = args["input"]
		? pairTrials(JSON.parse(fs.readFileSync(args["input"], "utf8")))
		: pairTrials(collectTrials(resultsDir));
	if (pairs.length === 0) {
		console.error("No paired trials found (need baseline:treatment at seed 1 per task).");
		process.exit(1);
	}
	const report = analyze(pairs);
	const outDir = args["out"] ?? path.dirname(args["input"] ?? ".");
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "analysis.md"), renderMarkdown(report));
	fs.writeFileSync(path.join(outDir, "analysis.json"), JSON.stringify(report, null, 2));
	const csv = [
		"task_id,baseline_resolved,treatment_resolved,baseline_cost_usd,treatment_cost_usd,baseline_turns,treatment_turns",
		...pairs.map((p) =>
			[p.taskId, +p.baseline.resolved, +p.treatment.resolved, p.baseline.costUsd, p.treatment.costUsd, p.baseline.turns, p.treatment.turns].join(","),
		),
	].join("\n");
	fs.writeFileSync(path.join(outDir, "pairs.csv"), csv);
	// Sensitivity (only when rerun data exists alongside the primary results)
	if (!args["input"]) {
		const rerun = collectSensitivityTrials(resultsDir);
		const rows = sensitivityVotes(pairs, rerun);
		if (rows.length > 0) {
			fs.writeFileSync(path.join(outDir, "sensitivity.md"), renderSensitivity(rows));
			fs.writeFileSync(
				path.join(outDir, "sensitivity.csv"),
				["task_id,baseline_votes,treatment_votes,winner", ...rows.map((r) => [r.taskId, r.baselineVotes, r.treatmentVotes, r.winner].join(","))].join("\n"),
			);
			console.log(`[sensitivity] ${rows.length} task(s) with rerun votes -> sensitivity.md`);
		}
	}
	console.log(renderMarkdown(report));
}

if (process.argv[1] && process.argv[1].endsWith("analyze.ts")) main();
