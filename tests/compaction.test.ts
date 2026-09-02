import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractReadRecords,
	formatReadRecord,
	hasCompactableContent,
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

describe("hasCompactableContent", () => {
	it("returns true when messages exist beyond the keep-recent window", () => {
		const entries = [
			textEntry("a-1", "old turn body", 15_000),
			textEntry("a-2", "middle turn", 15_000),
			textEntry("a-3", "recent turn", 15_000),
		];
		assert.equal(hasCompactableContent(entries, 20_000), true);
	});

	it("returns false when everything fits inside the keep-recent window", () => {
		const entries = [
			textEntry("a-1", "old turn body", 15_000),
			textEntry("a-2", "recent turn", 10_000),
		];
		assert.equal(hasCompactableContent(entries, 20_000), false);
	});

	it("returns false when the branch was just compacted", () => {
		const entries = [
			textEntry("a-1", "old", 30_000),
			{ id: "c-1", type: "compaction", firstKeptEntryId: "a-1" },
		];
		assert.equal(hasCompactableContent(entries, 20_000), false);
	});

	it("honors the previous compaction's kept boundary", () => {
		const compacted = [
			{ id: "c-1", type: "compaction", firstKeptEntryId: "k-1" },
			textEntry("k-1", "kept by compaction", 5_000),
		];
		// Kept boundary content stays inside the window: nothing compactable.
		assert.equal(hasCompactableContent([...compacted, textEntry("k-2", "new", 16_000)], 20_000), false);
		// Once post-compaction growth exceeds the window, older kept content becomes compactable.
		assert.equal(hasCompactableContent([...compacted, textEntry("k-2", "new huge", 30_000)], 20_000), true);
	});

	it("returns false for an empty branch and ignores entries without messages", () => {
		assert.equal(hasCompactableContent([], 20_000), false);
		assert.equal(hasCompactableContent([
			{ id: "r-1", type: "raw", tokens: 30_000 },
			{ id: "r-2", type: "raw" },
		], 20_000), false);
	});
});
