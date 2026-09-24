/** 0.5.1 fix suite: fake "I 0/0" panel counts, plan lint notices, form
 * confirmed-state (goal-x aligned ■/□), uniform-gray frame borders. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { lintImplItems, parseImplItems } from "../src/plan.ts";
import {
	appendRunNotice,
	getRun,
	initState,
	lintPlanIntoNotices,
	startRun,
} from "../src/state.ts";
import { recordCheckpointTransition } from "../tools/plans.ts";
import { createCheckpoint } from "../src/workflow-state.ts";
import {
	derivePanelModel,
	formatPanelSummaryLine,
	renderPanelLines,
	themePanelLines,
	type PanelModel,
} from "../src/panel.ts";
import { getExecution, restoreFromSession, startExecution } from "../src/exec.ts";
import {
	allAnswered,
	createFormState,
	formAnswers,
	formHandleKey,
	formRender,
	type FormQuestion,
	type FormTheme,
} from "../src/ask-form.ts";

let tmpRoot: string;
let counter = 0;

function freshWorkdir(): string {
	counter += 1;
	const workdir = path.join(tmpRoot, `repo-${counter}`);
	fs.mkdirSync(workdir, { recursive: true });
	return workdir;
}

function qs(n: number): FormQuestion[] {
	return Array.from({ length: n }, (_, i) => ({
		question: `Question ${i + 1}?`,
		options: [
			{ label: `Opt A${i + 1}`, recommended: true },
			{ label: `Opt B${i + 1}` },
		],
		allowOther: true,
		questionId: `q-${i + 1}`,
		autoComplete: true,
	}));
}

const HEADER = "## Implementation Items";

before(async () => {
	tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "panel-i-zero-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── VC-001: tolerant parser ─────────────────────────────────────────────────

describe("parseImplItems tolerant grammar (VC-001)", () => {
	it("accepts half-width colon, full-width colon and no-colon separators", () => {
		const doc = [
			"# plan",
			HEADER,
			"",
			"- `I-001`: half-width colon body",
			"- `I-002`：full-width colon 正文",
			"- `I-003` plain space separator",
			"",
		].join("\n");
		const items = parseImplItems(doc);
		assert.deepEqual(items.map((i) => i.id), ["I-001", "I-002", "I-003"]);
		assert.equal(items[2]!.text, "plain space separator");
	});

	it("ignores indented child bullets, VC lines and malformed ids", () => {
		const doc = [
			"# plan",
			HEADER,
			"",
			"- `I-001`: top level",
			"  - `I-002`: indented child must not match",
			"\t- `I-003`: tab-indented child must not match",
			"- [ ] `VC-001` covers `I-001`; verifier line",
			"- `I-x`: malformed id",
			"- `I-004`missing-separator",
			"",
		].join("\n");
		const items = parseImplItems(doc);
		assert.deepEqual(items.map((i) => i.id), ["I-001"]);
	});

	it("dedupes repeated ids and returns [] without a section header", () => {
		const dup = [HEADER, "", "- `I-001`: first", "- `I-001`: second"].join("\n");
		assert.deepEqual(parseImplItems(dup).map((i) => i.text), ["first"]);
		assert.deepEqual(parseImplItems("# no section"), []);
		assert.deepEqual(parseImplItems([HEADER, "", "- [ ] `VC-001` only VC lines"].join("\n")), []);
	});

	it("lintImplItems warns only when the section exists but parses empty", () => {
		assert.equal(lintImplItems("# no section"), null);
		assert.equal(lintImplItems([HEADER, "", "- `I-001`: ok"].join("\n")), null);
		const warn = lintImplItems([HEADER, "", "- I-001 no backticked id"].join("\n"));
		assert.ok(warn !== null && warn.includes("0 项"));
	});
});

// ── VC-002: durable notices at the lint entry points ───────────────────────

describe("run notices persistence (VC-002)", () => {
	function bootRun(name: string): { workdir: string; runId: string } {
		const workdir = freshWorkdir();
		initState(workdir);
		const { run } = startRun(workdir, { skill: "plan-small", topic: `lint-${name}` });
		return { workdir, runId: run.run_id };
	}

	it("appendRunNotice persists to run.json and dedupes by source+text", () => {
		const { workdir, runId } = bootRun("dedupe");
		appendRunNotice(workdir, runId, { kind: "plan-lint", source: "lint-impl-items", text: "w1" });
		appendRunNotice(workdir, runId, { kind: "plan-lint", source: "lint-impl-items", text: "w1" });
		appendRunNotice(workdir, runId, { kind: "plan-lint", source: "lint-impl-items", text: "w2" });
		const run = getRun(workdir, runId)!;
		assert.deepEqual(run.notices?.map((n) => n.text), ["w1", "w2"]);
	});

	it("reads legacy run.json files without a notices field", () => {
		const { workdir, runId } = bootRun("legacy");
		const run = getRun(workdir, runId)!;
		assert.equal(run.notices, undefined);
		appendRunNotice(workdir, runId, { kind: "k", source: "s", text: "t" });
		assert.equal(getRun(workdir, runId)!.notices?.length, 1);
	});

	it("lintPlanIntoNotices: hit on zero-parse section, no-op on healthy plan", () => {
		const { workdir, runId } = bootRun("helper");
		const badPlan = path.join(workdir, "PLAN_bad.md");
		fs.writeFileSync(badPlan, [HEADER, "", "- I-001 unparseable"].join("\n"));
		assert.ok(lintPlanIntoNotices(workdir, runId, badPlan) !== null);
		assert.ok(getRun(workdir, runId)!.notices?.length === 1);
		const goodPlan = path.join(workdir, "PLAN_good.md");
		fs.writeFileSync(goodPlan, [HEADER, "", "- `I-001`: fine"].join("\n"));
		assert.equal(lintPlanIntoNotices(workdir, runId, goodPlan), null);
		assert.ok(getRun(workdir, runId)!.notices?.length === 1, "no extra notice");
		assert.equal(lintPlanIntoNotices(workdir, runId, path.join(workdir, "missing.md")), null);
	});

	it("recordCheckpointTransition(plan-written) records the lint notice (entry point 1)", () => {
		const { workdir, runId } = bootRun("cp");
		const plan = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(plan, [HEADER, "", "- I-001 broken"].join("\n"));
		createCheckpoint(workdir, { runId, originWorkdir: workdir, workdir });
		recordCheckpointTransition({ sessionManager: {} }, workdir, runId, {
			transition: "plan-written",
			planPath: plan,
		});
		const run = getRun(workdir, runId)!;
		assert.equal(run.notices?.length, 1);
		assert.match(run.notices![0]!.text, /0 项/);
		// Idempotent on repeat.
		recordCheckpointTransition({ sessionManager: {} }, workdir, runId, {
			transition: "plan-written",
			planPath: plan,
		});
		assert.equal(getRun(workdir, runId)!.notices?.length, 1);
		// Healthy plan: no notice fires at this entry point either.
		const healthy = path.join(workdir, "PLAN_v2.md");
		fs.writeFileSync(healthy, [HEADER, "", "- `I-002`: fine"].join("\n"));
		recordCheckpointTransition({ sessionManager: {} }, workdir, runId, {
			transition: "plan-written",
			planPath: healthy,
		});
		assert.equal(getRun(workdir, runId)!.notices?.length, 1, "healthy plan adds no notice");
	});

	it("startExecution (execute handoff, entry point 2) records the lint notice", async () => {
		const { workdir, runId } = bootRun("exec");
		const plan = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(plan, [HEADER, "", "- I-001 broken"].join("\n"));
		const pi: any = {
			sendMessage: () => {},
			appendEntry: () => {},
			on: () => {},
		};
		const ui = { setStatus: () => {}, setWidget: () => {}, theme: { fg: (_c: string, t: string) => t } };
		const ctx: any = { cwd: workdir, sessionManager: {}, ui };
		await startExecution(pi, ctx, plan, [{ id: "VC-001", text: "`VC-001` covers `I-001`", done: false }]);
		assert.equal(getRun(workdir, runId)!.notices?.length, 1);
		// F-001 (impl review r1): the live execution state carries the warning
		// too — the panel must not wait for a restore to show the ⚠ line.
		assert.match(getExecution()!.implWarning ?? "", /0 项/);
		// Healthy plan at this entry: no notice, no warning (fresh run: the
		// approval guard fail-closes a second handoff on a different plan).
		const fresh = bootRun("exec2");
		const healthy = path.join(fresh.workdir, "PLAN_v1.md");
		fs.writeFileSync(healthy, [HEADER, "", "- `I-002`: fine"].join("\n"));
		await startExecution(pi, { ...ctx, cwd: fresh.workdir }, healthy, [
			{ id: "VC-001", text: "`VC-001` covers `I-001`", done: false },
		]);
		assert.equal((getRun(fresh.workdir, fresh.runId)!.notices ?? []).length, 0, "healthy plan adds no notice");
		assert.equal(getExecution()!.implWarning ?? null, null);
	});
});

// ── VC-003: panel warning line instead of fake "I 0/0" ──────────────────────

describe("panel impl-warning rendering (VC-003)", () => {
	const CJK = /[\u4e00-\u9fff]/;

	function model(implWarning: string | null, lang?: "zh" | "en"): PanelModel {
		return derivePanelModel(
			{
				items: [{ id: "VC-001", text: "`VC-001` covers `I-001`", done: false }],
				implItems: [],
				implStatus: {},
				implWarning,
				...(lang === undefined ? {} : { uiLanguage: lang }),
			},
			"fake-zero",
			false,
		);
	}

	it("replaces the I-count line with an explicit warning, keeping the 7-line envelope", () => {
		const m = model("warning text", "zh");
		assert.equal(m.implWarning, true);
		const lines = renderPanelLines(m, 80);
		assert.equal(lines.length, 7);
		assert.match(lines[2]!, /⚠ plan 格式：Implementation Items 解析 0 项/);
		assert.ok(!lines[2]!.includes("I items 0/0"), "must not render a fake 0/0 count");
	});

	it("narrow mode badges the warning instead of counting, summary line too", () => {
		const m = model("warning", "zh");
		const narrow = renderPanelLines(m, 20);
		assert.equal(narrow.length, 3);
		assert.match(narrow[1]!, /⚠ I/);
		assert.ok(!narrow[1]!.includes("I 0/0"));
		assert.match(formatPanelSummaryLine(m), /⚠ Implementation Items 解析 0 项/);
	});

	it("renders English warning chrome for en and for the omitted default (issue #3)", () => {
		for (const lang of ["en", undefined] as const) {
			const m = model("warning", lang);
			const lines = renderPanelLines(m, 80);
			assert.match(lines[2]!, /⚠ plan format: Implementation Items parsed 0 items/);
			const narrow = renderPanelLines(m, 20);
			// 20 columns truncate the badge right after the warning glyph.
			assert.match(narrow[1]!, /⚠ I/);
			assert.match(formatPanelSummaryLine(m), /⚠ Implementation Items parsed 0 items/);
			for (const line of [...lines, ...narrow, formatPanelSummaryLine(m)]) {
				assert.ok(!CJK.test(line), `CJK leaked (lang=${lang ?? "default"}): ${line}`);
			}
		}
	});

	it("keeps the legacy degradation when there is no lint hit", () => {
		const m = model(null);
		assert.equal(m.implWarning, false);
		const lines = renderPanelLines(m, 80);
		assert.match(lines[2]!, /I items 0\/0/);
	});

	it("restoreFromSession re-parses a stale empty snapshot implItems list", async () => {
		const workdir = freshWorkdir();
		initState(workdir);
		const plan = path.join(workdir, "PLAN_v9.md");
		// 0.5.0's actual drift shape: no colon after the backticked id.
		fs.writeFileSync(plan, [HEADER, "", "- `I-001` schema fix no colon", "- `I-002` notice wiring"].join("\n"));
		const snapshot = {
			planPath: plan,
			items: [{ id: "VC-001", text: "`VC-001` covers `I-001`", done: false }],
			startedAt: "2026-09-18T00:00:00Z",
			implItems: [],
			implStatus: {},
		};
		const pi: any = { sendMessage: () => {}, appendEntry: () => {} };
		const ui = { setStatus: () => {}, setWidget: () => {}, theme: { fg: (_c: string, t: string) => t } };
		const ctx: any = { cwd: workdir, sessionManager: {}, ui };
		await restoreFromSession(pi, ctx, [
			{ type: "custom", customType: "pi-plans-exec", data: snapshot },
		] as any);
		const exec = getExecution()!;
		assert.equal(exec.implItems?.length, 2);
		assert.equal(exec.implWarning ?? null, null);
		const m = derivePanelModel(exec, "restore", false);
		assert.equal(m.implWarning, false);
		assert.equal(m.totalI, 2);
	});
});

// ── VC-004: confirmed-state lifecycle ───────────────────────────────────────

describe("form confirmed lifecycle (VC-004)", () => {
	it("chips flip □→■ per question only after Enter", () => {
		const state = createFormState(qs(2));
		let lines = formRender(state, 80, undefined, {
			fg: (c, t) => `⟪${c}⟩${t}⟪/${c}⟫`,
			bg: (c, t) => `⟦${c}⟧${t}⟦/${c}⟧`,
			bold: (t) => `⟪b⟩${t}⟪/b⟫`,
		});
		assert.ok(lines[1]!.includes("□Q1") && lines[1]!.includes("□Q2"));
		formHandleKey(state, "\r"); // confirm Q1 → tab 1
		lines = formRender({ ...state, tab: 0 }, 80, undefined, {
			fg: (c, t) => `⟪${c}⟩${t}⟪/${c}⟫`,
			bg: (c, t) => `⟦${c}⟧${t}⟦/${c}⟧`,
			bold: (t) => `⟪b⟩${t}⟪/b⟫`,
		});
		assert.ok(lines[1]!.includes("■Q1") && lines[1]!.includes("□Q2"));
	});

	it("moving the cursor after a confirm un-confirms the tab", () => {
		const state = createFormState(qs(1));
		formHandleKey(state, "\r");
		assert.equal(allAnswered(state), true);
		state.tab = 0;
		formHandleKey(state, "\x1b[B"); // cursor to option 2
		assert.equal(allAnswered(state), false);
		assert.equal(formAnswers(state).length, 0, "unconfirmed selection is not an answer");
	});

	it("Esc while editing keeps prior confirmed answers intact", () => {
		const state = createFormState(qs(2));
		formHandleKey(state, "\r"); // confirm Q1, now on tab 1
		formHandleKey(state, "\x1b[B"); // cursor 0 -> 1
		formHandleKey(state, "\x1b[B"); // cursor 1 -> custom row
		formHandleKey(state, "\r"); // start editing
		formHandleKey(state, "draft");
		assert.equal(formHandleKey(state, "\x1b"), "abort-editing");
		assert.equal(state.confirmed[0], true);
		assert.equal(state.custom[1], null);
		assert.equal(formAnswers(state).length, 1);
	});
});

// ── VC-006: uniform-gray frame borders ──────────────────────────────────────

describe("uniform-gray frame borders (VC-006)", () => {
	const theme = {
		fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
		bg: (c: string, t: string) => `[[${c}]]${t}[[/${c}]]`,
		bold: (t: string) => `<b>${t}</b>`,
	} satisfies FormTheme;

	it("themePanelLines keeps │ muted on every content line, accents only inside", () => {
		const m = derivePanelModel(
			{
				items: [{ id: "VC-001", text: "`VC-001` covers `I-001`", done: false }],
				implItems: [{ id: "I-001", text: "work" }],
			},
			"gray-frame",
			false,
		);
		const colored = themePanelLines(renderPanelLines(m, 80), m, theme);
		// Lines 1..5 are │…│ content rows.
		for (const line of colored.slice(1, 6)) {
			assert.match(line, /^<muted>│<\/muted>/, `leading │ must be muted: ${line.slice(0, 30)}`);
			assert.match(line, /<muted>│<\/muted>$/, "trailing │ must be muted");
			const inner = line.replace(/^<muted>│<\/muted>/, "").replace(/<muted>│<\/muted>$/, "");
			assert.ok(!inner.includes("│"), "no border glyph inside the colored span");
		}
		// Progress row (index 2) keeps its accent INSIDE the borders.
		assert.match(colored[2]!, /<accent>\s*I items/);
		// Next-action row (index 4) keeps success INSIDE the borders.
		assert.match(colored[4]!, /<success>\s*Next:/);
	});

	it("panel header stays muted except the pi-plans brand", () => {
		const m = derivePanelModel({ items: [], implItems: [] }, "t", false);
		const [header] = themePanelLines(renderPanelLines(m, 80), m, theme);
		assert.match(header, /<accent>pi-plans<\/accent>/);
		assert.ok(!/<accent>[─╭╮]/.test(header), "frame chrome must not be accented");
	});

	it("form frame borders render muted and every themed span closes", () => {
		const state = createFormState(qs(2));
		const lines = formRender(state, 80, undefined, theme);
		assert.match(lines[0]!, /^<muted>─+<\/muted>$/);
		assert.match(lines.at(-1)!, /^<muted>─+<\/muted>$/);
		// SGR hygiene: every opening marker has its closer on the same line, so
		// the host dialog's │ cannot inherit a dangling line color.
		const ansi: FormTheme = {
			fg: (_c, t) => `\u001b[3m${t}\u001b[23m`,
			bg: (_c, t) => `\u001b[7m${t}\u001b[27m`,
			bold: (t) => `\u001b[1m${t}\u001b[22m`,
		};
		for (const line of formRender(createFormState(qs(2)), 80, undefined, ansi)) {
			const opens = (line.match(/\u001b\[(3|7|1)m/g) ?? []).length;
			const closes = (line.match(/\u001b\[(23|27|22)m/g) ?? []).length;
			assert.equal(opens, closes, `unclosed SGR span: ${JSON.stringify(line)}`);
		}
	});
});

// ── VC-005: legacy-plan regression ──────────────────────────────────────────

describe("legacy plan regression (VC-005)", () => {
	it("parses the shipped 0.4.0 and 0.5.0 plan artifacts", () => {
		const root = path.join(process.cwd(), ".git", "pi_plans", "docs");
		const v040 = path.join(root, "2026-09-17-v0-4-0-forms-and-exec-panel", "PLAN_v1.md");
		const v050 = path.join(root, "2026-09-17-v0-5-0-code-graph-adoption", "PLAN_v2.md");
		if (!fs.existsSync(v040) || !fs.existsSync(v050)) return; // artifacts stripped in CI
		assert.equal(parseImplItems(fs.readFileSync(v040, "utf8")).length, 6);
		const items = parseImplItems(fs.readFileSync(v050, "utf8"));
		assert.equal(items.length, 9);
		assert.equal(lintImplItems(fs.readFileSync(v050, "utf8")), null);
	});
});
