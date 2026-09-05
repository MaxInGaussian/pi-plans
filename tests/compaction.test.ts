import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildOwnCut,
	buildPiPlansVccCompaction,
	compactionCurrentI,
	DEFAULT_VCC_SETTINGS,
	loadVccSettings,
	parseCompactionInstructions,
	PI_VCC_COMPACT_INSTRUCTION,
	scaffoldVccSettings,
	shouldScheduleAutoContinue,
	vccSettingsPath,
	type CompactionEntryLike,
} from "../src/compaction.ts";

function textEntry(id: string, role: string, text: string): CompactionEntryLike {
	return { id, type: "message", message: { role, content: [{ type: "text", text }] } };
}

function toolCallEntry(id: string, name: string, args: Record<string, unknown>): CompactionEntryLike {
	return { id, type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } };
}

function toolResultEntry(id: string, name: string, text: string): CompactionEntryLike {
	return { id, type: "message", message: { role: "toolResult", toolName: name, content: [{ type: "text", text }] } };
}

describe("pi-vcc compaction", () => {
	let tmpRoot: string;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-vcc-"));
	});

	after(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("builds an own cut that keeps the requested recent user turns", () => {
		const entries = [
			textEntry("u-1", "user", "implement compact support"),
			textEntry("a-1", "assistant", "started the helper"),
			textEntry("u-2", "user", "continue from the current task"),
			textEntry("a-2", "assistant", "working on tests"),
		];
		const cut = buildOwnCut(entries, 1);
		assert.equal(cut.ok, true);
		assert.equal(cut.ok ? cut.firstKeptEntryId : undefined, "u-2");
		assert.deepEqual(cut.ok ? cut.messages.map((message) => message.role) : [], ["user", "assistant"]);

		const compactAll = buildOwnCut(entries, 0);
		assert.equal(compactAll.ok, true);
		assert.equal(compactAll.ok ? compactAll.compactAll : false, true);
		assert.equal(compactAll.ok ? compactAll.firstKeptEntryId : "not-ok", "");
		assert.deepEqual(buildOwnCut([textEntry("u", "user", "only one turn")], 1), { ok: false, reason: "too_few_live_messages" });
	});

	it("reads legacy compaction details without writing the old schema", () => {
		const legacyCompaction: CompactionEntryLike = {
			id: "old-compact",
			type: "compaction",
			details: {
				kind: "pi-plans-execution-compaction",
				readRecords: [
					{ path: "src/legacy.ts", lineStart: 5, lineEnd: 9, range: "5-9", summary: "legacy facts", key: "src/legacy.ts|5-9" },
				],
				metrics: {
					currentI: "I-007",
					firstKeptEntryId: "u-2",
					targetMet: false,
					hardFloorReason: "single oversized tool result",
				},
			},
		};
		assert.equal(compactionCurrentI(legacyCompaction), "I-007");

		const entries = [
			textEntry("u-1", "user", "old prefix"),
			textEntry("a-1", "assistant", "old answer"),
			legacyCompaction,
			textEntry("u-2", "user", "retained user from old boundary"),
			textEntry("a-2", "assistant", "live answer"),
			textEntry("u-3", "user", "latest user"),
			textEntry("a-3", "assistant", "latest answer"),
		];
		const cut = buildOwnCut(entries, 1);
		assert.equal(cut.ok, true);
		assert.deepEqual(cut.ok ? cut.messages.map((message) => message.content) : [], [
			[{ type: "text", text: "retained user from old boundary" }],
			[{ type: "text", text: "live answer" }],
		]);

		const result = buildPiPlansVccCompaction({
			branchEntries: entries,
			preparation: { tokensBefore: 20_000 },
			reason: "threshold",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.equal(result.kind, "compaction");
		if (result.kind !== "compaction") return;
		assert.match(result.compaction.summary, /Read: src\/legacy\.ts line 5-9 Extracted information summary: legacy facts/);
		assert.match(result.compaction.summary, /Previous compaction hard floor: single oversized tool result/);
		assert.equal((result.compaction.details as any).kind, undefined);
		assert.equal((result.compaction.details as any).readRecords, undefined);
		assert.equal((result.compaction.details as any).metrics?.currentI, undefined);
		assert.equal(result.compaction.details.compactor, "pi-vcc");
	});

	it("applies smart keep, explicit keep, budget cuts, and tool-result-safe boundaries", () => {
		const smallTurns = [
			textEntry("u-1", "user", "first task"),
			textEntry("a-1", "assistant", "first answer"),
			textEntry("u-2", "user", "second task"),
			textEntry("a-2", "assistant", "second answer"),
			textEntry("u-3", "user", "third task"),
			textEntry("a-3", "assistant", "third answer"),
		];
		const smart = buildPiPlansVccCompaction({
			branchEntries: smallTurns,
			preparation: { tokensBefore: 10_000 },
			reason: "threshold",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.equal(smart.kind, "compaction");
		if (smart.kind !== "compaction") return;
		assert.equal(smart.stats.smartKeepAdjusted, true);
		assert.equal(smart.stats.smartFromKeep, 1);
		assert.equal(smart.stats.requestedKeepUserTurns, 2);
		assert.equal(smart.compaction.firstKeptEntryId, "u-2");

		const explicit = buildPiPlansVccCompaction({
			branchEntries: smallTurns,
			preparation: { tokensBefore: 10_000 },
			customInstructions: `${PI_VCC_COMPACT_INSTRUCTION} keep:1`,
			reason: "threshold",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.equal(explicit.kind, "compaction");
		if (explicit.kind !== "compaction") return;
		assert.equal(explicit.stats.smartKeepAdjusted, false);
		assert.equal(explicit.stats.requestedKeepUserTurns, 1);
		assert.equal(explicit.compaction.firstKeptEntryId, "u-3");

		const huge = "x".repeat(300_000);
		const noAnchor = buildPiPlansVccCompaction({
			branchEntries: [
				textEntry("u-1", "user", "single user turn"),
				textEntry("a-1", "assistant", huge),
				textEntry("a-2", "assistant", "safe assistant boundary"),
			],
			preparation: { tokensBefore: 200_000 },
			reason: "threshold",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.equal(noAnchor.kind, "compaction");
		if (noAnchor.kind !== "compaction") return;
		assert.equal(noAnchor.stats.budgetCut, "no_anchor");
		assert.equal(noAnchor.compaction.firstKeptEntryId, "a-1");

		const oversizedTail = buildPiPlansVccCompaction({
			branchEntries: [
				textEntry("u-1", "user", "one"),
				textEntry("a-1", "assistant", "done"),
				textEntry("u-2", "user", "two"),
				textEntry("a-2", "assistant", "done"),
				textEntry("u-3", "user", "three"),
				textEntry("a-3", "assistant", huge),
			],
			preparation: { tokensBefore: 250_000 },
			reason: "threshold",
			willRetry: false,
			settings: { ...DEFAULT_VCC_SETTINGS, smartKeepTail: false },
			phaseContext: { phase: "planning" },
		});
		assert.equal(oversizedTail.kind, "compaction");
		if (oversizedTail.kind !== "compaction") return;
		assert.equal(oversizedTail.stats.budgetCut, "oversized_tail");
		assert.equal(oversizedTail.compaction.firstKeptEntryId, "a-3");

		const toolBoundary = buildPiPlansVccCompaction({
			branchEntries: [
				textEntry("u-1", "user", "single user turn"),
				toolCallEntry("tc-1", "read", { path: "src/exec.ts" }),
				toolResultEntry("tr-1", "read", huge),
				textEntry("a-after", "assistant", "safe boundary after the tool result"),
			],
			preparation: { tokensBefore: 250_000 },
			reason: "threshold",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.equal(toolBoundary.kind, "compaction");
		if (toolBoundary.kind !== "compaction") return;
		assert.equal(toolBoundary.stats.budgetCut, "no_anchor");
		assert.equal(toolBoundary.compaction.firstKeptEntryId, "a-after");
	});

	it("compiles a deterministic five-section summary with phase context and file activity", () => {
		const result = buildPiPlansVccCompaction({
			branchEntries: [
				textEntry("u-1", "user", "Please implement repo-private VCC compaction. Always keep ASCII output."),
				toolCallEntry("tc-1", "edit", { path: "src/compaction.ts" }),
				textEntry("a-1", "assistant", "Updated src/compaction.ts and ran npm test."),
				textEntry("u-2", "user", "Continue execution."),
				textEntry("a-2", "assistant", "Current work is in the retained tail."),
			],
			preparation: {
				firstKeptEntryId: "fallback",
				tokensBefore: 40_000,
				previousSummary: "## Legacy Summary\nEarlier compact facts.",
				fileOps: { read: ["src/exec.ts"], written: ["src/compaction.ts"], edited: [] },
			},
			customInstructions: `${PI_VCC_COMPACT_INSTRUCTION} keep:1`,
			reason: "threshold",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: {
				phase: "execution",
				planPath: "/repo/PLAN_v3.md",
				currentI: "I-002",
				remainingVerifierIds: ["VC-002"],
				implementationIds: ["I-001", "I-002"],
			},
		});
		assert.equal(result.kind, "compaction");
		if (result.kind !== "compaction") return;
		assert.equal(result.compaction.firstKeptEntryId, "u-2");
		assert.match(result.compaction.summary, /\[Session Goal\]/);
		assert.match(result.compaction.summary, /Execute accepted plan \/repo\/PLAN_v3\.md/);
		assert.match(result.compaction.summary, /\[Files And Changes\]/);
		assert.match(result.compaction.summary, /Modified: src\/compaction\.ts/);
		assert.match(result.compaction.summary, /Read: src\/exec\.ts/);
		assert.match(result.compaction.summary, /\[Outstanding Context\]/);
		assert.match(result.compaction.summary, /Current implementation item: I-002/);
		assert.match(result.compaction.summary, /Previous compact summary: Legacy Summary Earlier compact facts\./);
		assert.match(result.compaction.summary, /\[User Preferences\]/);
		assert.match(result.compaction.summary, /Always keep ASCII output/);
		assert.equal(result.compaction.details.compactor, "pi-vcc");
		assert.equal(result.compaction.details.phase, "execution");
		assert.equal(result.stats.keptUserTurns, 1);
		assert.equal(result.followUpPrompt, null);
	});

	it("cancels unsafe manual cuts but falls back to Pi core for overflow retry", () => {
		const manual = buildPiPlansVccCompaction({
			branchEntries: [],
			preparation: { firstKeptEntryId: "fallback", tokensBefore: 100 },
			reason: "manual",
			willRetry: false,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.equal(manual.kind, "cancel");

		const overflowRetry = buildPiPlansVccCompaction({
			branchEntries: [],
			preparation: { firstKeptEntryId: "fallback", tokensBefore: 100 },
			reason: "overflow",
			willRetry: true,
			settings: DEFAULT_VCC_SETTINGS,
			phaseContext: { phase: "planning" },
		});
		assert.deepEqual(overflowRetry, { kind: "fallback", reason: "no_live_messages" });

		const overrideDisabled = buildPiPlansVccCompaction({
			branchEntries: [
				textEntry("u-1", "user", "old"),
				textEntry("a-1", "assistant", "old answer"),
				textEntry("u-2", "user", "new"),
			],
			preparation: { firstKeptEntryId: "fallback", tokensBefore: 100 },
			settings: { ...DEFAULT_VCC_SETTINGS, overrideDefaultCompaction: false },
			phaseContext: { phase: "planning" },
		});
		assert.deepEqual(overrideDisabled, { kind: "fallback", reason: "override-disabled" });
	});

	it("parses manual keep/follow-up instructions and gates auto-continue by version", () => {
		assert.deepEqual(parseCompactionInstructions("pi-plans execution auto compact"), {
			isPiVcc: false,
			isInternalPiPlans: true,
			keepUserTurns: 1,
			keepUserTurnsExplicit: false,
			followUpPrompt: null,
		});
		assert.deepEqual(parseCompactionInstructions("keep:2 Continue with tests"), {
			isPiVcc: false,
			isInternalPiPlans: false,
			keepUserTurns: 2,
			keepUserTurnsExplicit: true,
			followUpPrompt: "Continue with tests",
		});
		assert.deepEqual(parseCompactionInstructions(`${PI_VCC_COMPACT_INSTRUCTION} keep:3`), {
			isPiVcc: true,
			isInternalPiPlans: false,
			keepUserTurns: 3,
			keepUserTurnsExplicit: true,
			followUpPrompt: null,
		});
		assert.deepEqual(parseCompactionInstructions("Continue with tests keep:2"), {
			isPiVcc: false,
			isInternalPiPlans: false,
			keepUserTurns: 2,
			keepUserTurnsExplicit: true,
			followUpPrompt: "Continue with tests",
		});
		assert.equal(shouldScheduleAutoContinue(true, "0.84.3"), true);
		assert.equal(shouldScheduleAutoContinue(true, "0.84.4"), false);
		assert.equal(shouldScheduleAutoContinue(false, "0.84.3"), false);
	});

	it("scaffolds and loads repo-private VCC settings", () => {
		const stateRoot = path.join(tmpRoot, "state");
		scaffoldVccSettings(stateRoot);
		assert.equal(fs.existsSync(vccSettingsPath(stateRoot)), true);
		assert.deepEqual(loadVccSettings(stateRoot), DEFAULT_VCC_SETTINGS);

		fs.writeFileSync(vccSettingsPath(stateRoot), JSON.stringify({ overrideDefaultCompaction: false }), "utf8");
		scaffoldVccSettings(stateRoot);
		assert.deepEqual(loadVccSettings(stateRoot), {
			...DEFAULT_VCC_SETTINGS,
			overrideDefaultCompaction: false,
		});

		const invalidRoot = path.join(tmpRoot, "invalid-state");
		fs.mkdirSync(invalidRoot, { recursive: true });
		const invalidPath = vccSettingsPath(invalidRoot);
		fs.writeFileSync(invalidPath, "{ invalid json", "utf8");
		scaffoldVccSettings(invalidRoot);
		assert.equal(fs.readFileSync(invalidPath, "utf8"), "{ invalid json");
		assert.deepEqual(loadVccSettings(invalidRoot), DEFAULT_VCC_SETTINGS);

		const envRoot = path.join(tmpRoot, "env-state");
		const envConfig = path.join(tmpRoot, "external-pi-vcc-config.json");
		const previousEnv = process.env.PI_VCC_CONFIG_PATH;
		try {
			process.env.PI_VCC_CONFIG_PATH = envConfig;
			fs.writeFileSync(envConfig, JSON.stringify({ smartKeepTail: false, continueAfterThresholdCompact: false }), "utf8");
			assert.deepEqual(loadVccSettings(envRoot), DEFAULT_VCC_SETTINGS);
		} finally {
			if (previousEnv === undefined) delete process.env.PI_VCC_CONFIG_PATH;
			else process.env.PI_VCC_CONFIG_PATH = previousEnv;
		}
	});

	it("writes debug snapshots only when enabled", () => {
		const debugPath = "/tmp/pi-vcc-debug.json";
		const previous = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, "utf8") : null;
		try {
			fs.rmSync(debugPath, { force: true });
			const event = {
				branchEntries: [
					textEntry("u-1", "user", "implement debug test"),
					textEntry("a-1", "assistant", "working"),
					textEntry("u-2", "user", "continue"),
					textEntry("a-2", "assistant", "tail"),
				],
				preparation: { tokensBefore: 10_000 },
				reason: "threshold" as const,
				willRetry: false,
				phaseContext: { phase: "planning" as const },
			};
			buildPiPlansVccCompaction({ ...event, settings: DEFAULT_VCC_SETTINGS });
			assert.equal(fs.existsSync(debugPath), false);

			buildPiPlansVccCompaction({ ...event, settings: { ...DEFAULT_VCC_SETTINGS, debug: true } });
			const debug = JSON.parse(fs.readFileSync(debugPath, "utf8"));
			assert.equal(debug.usedOwnCut, true);
			assert.equal(debug.phase, "planning");
		} finally {
			if (previous === null) fs.rmSync(debugPath, { force: true });
			else fs.writeFileSync(debugPath, previous, "utf8");
		}
	});
});
