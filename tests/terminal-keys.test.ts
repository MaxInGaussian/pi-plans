/**
 * Shared terminal-key normalization (issue #2): the loaded path and the
 * dependency-free fallback must both agree with pi-tui's canonical parsing for
 * legacy, SS3 (application-cursor), kitty CSI-u and modifier sequences, and the
 * chunk decoder must handle multiple sequences, raw passthrough and
 * non-printable rejections.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	__clearPiTuiForTests,
	__setPiTuiForTests,
	decodePrintableChunk,
	fallbackDecodePrintable,
	fallbackNormalizeKey,
	getPiTui,
	loadPiTui,
	matchesTerminalKey,
	normalizeKey,
} from "../src/terminal-keys.ts";

type PiTuiModule = typeof import("@earendil-works/pi-tui");

/** Sequences a pi-plans overlay can receive, across all three encodings. */
const NORMALIZE_TABLE = [
	// legacy / application-cursor (SS3)
	"\t",
	"\r",
	"\n",
	"\x7f",
	"\x08",
	"\x1b",
	"\x1b[Z",
	"\x1b[A",
	"\x1b[B",
	"\x1b[C",
	"\x1b[D",
	"\x1bOA",
	"\x1bOB",
	"\x1bOC",
	"\x1bOD",
	"\x1b[H",
	"\x1b[F",
	"\x1bOH",
	"\x1bOF",
	"\x1b[2~",
	"\x1b[3~",
	"\x1b[5~",
	"\x1b[6~",
	"\x1b[7~",
	"\x1b[8~",
	"\x1b[5;2~",
	"\x1b[1;2Z",
	// kitty CSI-u: named keys, functional codepoints, modifiers, event types
	"\x1b[13u",
	"\x1b[13;2u",
	"\x1b[13;5u",
	"\x1b[9u",
	"\x1b[9;2u",
	"\x1b[9;5u",
	"\x1b[27u",
	"\x1b[27;2u",
	"\x1b[127u",
	"\x1b[127;2u",
	"\x1b[32u",
	"\x1b[57414u",
	"\x1b[57417u",
	"\x1b[57418u",
	"\x1b[57419u",
	"\x1b[57420u",
	"\x1b[57421u",
	"\x1b[57422u",
	"\x1b[57423u",
	"\x1b[57424u",
	"\x1b[57425u",
	"\x1b[57426u",
	"\x1b[57419;2u",
	"\x1b[57419;5u",
	"\x1b[57419;1:2u",
	"\x1b[57419;1:3u",
	"\x1b[1;1A",
	"\x1b[1;1B",
	"\x1b[1;1C",
	"\x1b[1;1D",
	"\x1b[1;2A",
	"\x1b[1;5A",
	"\x1b[1;6A",
	"\x1b[97u",
	"\x1b[97;2u",
	"\x1b[97;5u",
	"\x1b[97;6u",
	"\x1b[65;2u",
	"\x1b[48u",
	"\x1b[45u",
	"\x1b[61u",
	"\x1b[57399u",
	"\x1b[57409u",
	"\x1b[57415u",
	"\x1b[57352u",
	"\x1b[20320u",
	// plain characters / unknown sequences
	"a",
	" ",
	"自",
	"\x1b[99;5u",
];

const MATCH_KEYS = ["enter", "tab", "shift+tab", "escape", "up", "down", "left", "right", "pageUp", "pageDown", "backspace", "space"];

async function piTuiOrFail(): Promise<PiTuiModule> {
	const tui = await loadPiTui();
	assert.ok(tui, "pi-tui must be resolvable in the test environment");
	return tui;
}

describe("terminal-keys normalization", () => {
	it("loaded path matches pi-tui parseKey for the full sequence table", async () => {
		const tui = await piTuiOrFail();
		for (const sequence of NORMALIZE_TABLE) {
			assert.equal(normalizeKey(sequence), tui.parseKey(sequence), `normalizeKey mismatch for ${JSON.stringify(sequence)}`);
		}
	});

	it("fallback path matches pi-tui parseKey for the full sequence table", async () => {
		const tui = await piTuiOrFail();
		for (const sequence of NORMALIZE_TABLE) {
			assert.equal(
				fallbackNormalizeKey(sequence),
				tui.parseKey(sequence),
				`fallbackNormalizeKey mismatch for ${JSON.stringify(sequence)}`,
			);
		}
	});

	it("loaded and fallback matchers agree with pi-tui matchesKey", async () => {
		const tui = await piTuiOrFail();
		for (const sequence of NORMALIZE_TABLE) {
			for (const key of MATCH_KEYS) {
				const expected = tui.matchesKey(sequence, key);
				assert.equal(matchesTerminalKey(sequence, key), expected, `loaded matcher mismatch for ${JSON.stringify(sequence)}/${key}`);
				assert.equal(fallbackNormalizeKey(sequence) === key, expected, `fallback matcher mismatch for ${JSON.stringify(sequence)}/${key}`);
			}
		}
	});

	it("forced fallback keeps normalizeKey/matchesTerminalKey identical to the loaded path", async () => {
		const tui = await piTuiOrFail();
		const loadedKeys = NORMALIZE_TABLE.map((sequence) => normalizeKey(sequence));
		__setPiTuiForTests(undefined);
		try {
			assert.equal(getPiTui(), undefined);
			NORMALIZE_TABLE.forEach((sequence, index) => {
				assert.equal(normalizeKey(sequence), loadedKeys[index], `fallback normalizeKey mismatch for ${JSON.stringify(sequence)}`);
				assert.equal(normalizeKey(sequence), tui.parseKey(sequence), `fallback vs pi-tui mismatch for ${JSON.stringify(sequence)}`);
			});
			for (const sequence of NORMALIZE_TABLE) {
				for (const key of MATCH_KEYS) {
					assert.equal(matchesTerminalKey(sequence, key), tui.matchesKey(sequence, key), `fallback matcher mismatch for ${JSON.stringify(sequence)}/${key}`);
				}
			}
		} finally {
			__clearPiTuiForTests();
		}
		assert.ok(getPiTui(), "module state must be restored after the forced-fallback test");
	});

	it("loadPiTui caches the module reference", async () => {
		const first = await loadPiTui();
		const second = await loadPiTui();
		assert.equal(first, second);
		assert.equal(getPiTui(), first);
	});
});

describe("terminal-keys printable decoding", () => {
	it("decodes kitty text, multiple sequences per chunk, and raw passthrough", () => {
		assert.equal(decodePrintableChunk("\x1b[20320u"), "你");
		assert.equal(decodePrintableChunk("\x1b[20320u\x1b[22909u"), "你好");
		assert.equal(decodePrintableChunk("a\x1b[20320u"), "a你");
		assert.equal(decodePrintableChunk("\x1b[97u\x1b[57419u"), "a");
		assert.equal(decodePrintableChunk("\x1b[97;2u"), "a");
		assert.equal(decodePrintableChunk("\x1b[65;2u"), "A");
		assert.equal(decodePrintableChunk("\x1b[57409u"), ".");
		assert.equal(decodePrintableChunk("自"), "自");
		assert.equal(decodePrintableChunk("abc"), "abc");
	});

	it("rejects non-printable sequences", () => {
		assert.equal(decodePrintableChunk("\x1b[97;5u"), undefined); // ctrl+a
		assert.equal(decodePrintableChunk("\x1b[57419u"), undefined); // kitty up
		assert.equal(decodePrintableChunk("\x1b[57352u"), undefined); // unmapped functional codepoint (private use)
		assert.equal(decodePrintableChunk("\x1b[Z"), undefined);
		assert.equal(decodePrintableChunk(""), undefined);
	});

	it("fallback decoder matches the loaded chunk decoder", () => {
		const table = ["\x1b[20320u", "\x1b[97;2u", "\x1b[65;2u", "\x1b[57409u", "\x1b[97;5u", "\x1b[57419u", "\x1b[57352u", "\x1b[13u"];
		const loaded = table.map((sequence) => decodePrintableChunk(sequence));
		__setPiTuiForTests(undefined);
		try {
			table.forEach((sequence, index) => {
				assert.equal(fallbackDecodePrintable(sequence), loaded[index], `fallback decode mismatch for ${JSON.stringify(sequence)}`);
				assert.equal(decodePrintableChunk(sequence), loaded[index], `forced-fallback chunk mismatch for ${JSON.stringify(sequence)}`);
			});
		} finally {
			__clearPiTuiForTests();
		}
	});
});
