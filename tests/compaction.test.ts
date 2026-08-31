import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractReadRecords,
	formatReadRecord,
	legalFirstKeptEntryIndex,
	mergeCompactionDetails,
	planIAwareCompaction,
	currentIExceedsTrigger,
} from "../src/compaction.ts";

function textEntry(id: string, text: string, tokens = 100) {
	return { id, type: "message", tokens, message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("I-aware compaction policy", () => {
	it("keeps a legal current-I suffix and never starts at a tool result", () => {
		const entries = [
			textEntry("i1", "[I-001:current] completed"),
			{ id: "call", type: "message", tokens: 100, message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/repo/a.ts", offset: 4, limit: 2 } }] } },
			{ id: "result", type: "message", tokens: 100, message: { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "private source output that must be bounded" }] } },
			textEntry("i2", "[I-002:current] active"),
			{ id: "u", type: "message", tokens: 100, message: { role: "user", content: [{ type: "text", text: "latest question" }] } },
			textEntry("a", "latest answer"),
		];
		const plan = planIAwareCompaction({ entries, currentI: "I-002", knownIIds: ["I-001", "I-002"], contextWindow: 1000, tokensBefore: 600 });
		assert.equal(plan.currentI, "I-002");
		assert.equal(plan.slices.filter((slice) => slice.id !== null).length, 2);
		assert.ok(plan.firstKeptEntryId);
		assert.notEqual(plan.firstKeptEntryId, "result");
		assert.ok(plan.summaryEntries.every((entry) => !plan.keptEntries.includes(entry)));
		assert.equal(legalFirstKeptEntryIndex(entries, 2), 1);
	});

	it("starts a new current-I slice after a prior compaction snapshot", () => {
		const entries = [
			{ id: "old-summary", type: "compaction", details: { currentI: "I-002" } },
			textEntry("u", "new question", 100),
			textEntry("a", "new answer", 100),
		];
		const plan = planIAwareCompaction({ entries, currentI: "I-002", knownIIds: ["I-001", "I-002"], contextWindow: 1000, tokensBefore: 200 });
		assert.equal(plan.currentStartIndex, 1);
		assert.equal(plan.slices.at(-1)?.id, "I-002");
		assert.equal(plan.slices.at(-1)?.current, true);
		assert.equal(plan.slices.at(-1)?.entries[0]?.id, "u");
	});	it("extracts bounded paired Read records and merges by path/range", () => {
		const raw = "x".repeat(500);
		const entries = [
			{ id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/repo/a.ts", offset: 7, limit: 3 } }] } },
			{ id: "result", type: "message", message: { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: raw }] } },
		];
		const records = extractReadRecords(entries);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.range, "7-9");
		assert.equal(records[0]?.formatted, formatReadRecord(records[0]!));
		assert.match(records[0]?.formatted ?? "", /^Read: \/repo\/a\.ts line 7-9 Extracted information summary: /);
		assert.ok((records[0]?.formatted.length ?? 0) < raw.length);
		const merged = mergeCompactionDetails(
			{ readRecords: records },
			{ readRecords: [{ ...records[0]!, summary: "new extraction", formatted: "" }] },
		);
		assert.equal(merged.readRecords?.length, 1);
		assert.equal(merged.readRecords?.[0]?.summary, "new extraction");
	});

	it("uses strict trigger and records a hard floor when the retained suffix cannot fit", () => {
		assert.equal(currentIExceedsTrigger(200, 1000), false);
		assert.equal(currentIExceedsTrigger(201, 1000), true);
		const entries = [textEntry("i1", "[I-001:current] " + "work ".repeat(40), 900), textEntry("u", "latest", 200), textEntry("a", "answer", 200)];
		const plan = planIAwareCompaction({ entries, currentI: "I-001", contextWindow: 1000, tokensBefore: 1300 });
		assert.equal(plan.metrics.targetMet, false);
		assert.ok(plan.metrics.hardFloorReason);
	});
});
