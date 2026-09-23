/**
 * Shared terminal-key normalization for pi-plans components.
 *
 * pi-tui hands raw stdin data to a focused component's `handleInput` without
 * pre-normalizing it, so every component must normalize keys itself. When the
 * pi-tui module resolves, we delegate to its canonical helpers
 * (`parseKey` / `matchesKey` / `decodeKittyPrintable`); when it does not
 * (standalone `node:test` runs, degraded hosts), a local fallback keeps
 * legacy, SS3 (application-cursor) and kitty CSI-u input working.
 *
 * The fallback deliberately mirrors pi-tui's parsing semantics — modifier
 * naming order, shifted-letter identity, functional-key equivalents and the
 * printable-character filter — so both paths behave identically.
 */

export type PiTuiModule = typeof import("@earendil-works/pi-tui");

let piTui: PiTuiModule | undefined;
let piTuiPromise: Promise<PiTuiModule | undefined> | undefined;
let piTuiOverride: { set: boolean; value: PiTuiModule | undefined } = { set: false, value: undefined };

export function loadPiTui(): Promise<PiTuiModule | undefined> {
	if (!piTuiPromise) {
		piTuiPromise = import("@earendil-works/pi-tui")
			.then((mod) => {
				piTui = mod as PiTuiModule;
				return piTui;
			})
			.catch(() => {
				piTui = undefined;
				return undefined;
			});
	}
	return piTuiPromise;
}

void loadPiTui();

/** Synchronous accessor for the lazily loaded pi-tui module. */
export function getPiTui(): PiTuiModule | undefined {
	return piTuiOverride.set ? piTuiOverride.value : piTui;
}

/** Test-only: force the module state (`undefined` exercises the fallback path). */
export function __setPiTuiForTests(mod: PiTuiModule | undefined): void {
	piTuiOverride = { set: true, value: mod };
}

/** Test-only: drop the forced override and use the real module state again. */
export function __clearPiTuiForTests(): void {
	piTuiOverride = { set: false, value: undefined };
}

const MODIFIER_SHIFT = 1;
const MODIFIER_ALT = 2;
const MODIFIER_CTRL = 4;
const MODIFIER_SUPER = 8;
const SUPPORTED_MODIFIER_MASK = MODIFIER_SHIFT | MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_SUPER;
const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

const CODEPOINT_ESCAPE = 27;
const CODEPOINT_TAB = 9;
const CODEPOINT_ENTER = 13;
const CODEPOINT_SPACE = 32;
const CODEPOINT_BACKSPACE = 127;
const CODEPOINT_KP_ENTER = 57414; // Numpad Enter (Kitty protocol)

const ARROW_KEY_NAMES: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };

/** Kitty functional-key sentinels, mirroring pi-tui's internal constants. */
const FUNCTIONAL_DELETE = -10;
const FUNCTIONAL_INSERT = -11;
const FUNCTIONAL_PAGE_UP = -12;
const FUNCTIONAL_PAGE_DOWN = -13;
const FUNCTIONAL_HOME = -14;
const FUNCTIONAL_END = -15;
const ARROW_UP = -1;
const ARROW_DOWN = -2;
const ARROW_RIGHT = -3;
const ARROW_LEFT = -4;

const KITTY_FUNCTIONAL_EQUIVALENTS = new Map<number, number>([
	[57399, 48],
	[57400, 49],
	[57401, 50],
	[57402, 51],
	[57403, 52],
	[57404, 53],
	[57405, 54],
	[57406, 55],
	[57407, 56],
	[57408, 57],
	[57409, 46],
	[57410, 47],
	[57411, 42],
	[57412, 45],
	[57413, 43],
	[57415, 61],
	[57416, 44],
	[57417, ARROW_LEFT],
	[57418, ARROW_RIGHT],
	[57419, ARROW_UP],
	[57420, ARROW_DOWN],
	[57421, FUNCTIONAL_PAGE_UP],
	[57422, FUNCTIONAL_PAGE_DOWN],
	[57423, FUNCTIONAL_HOME],
	[57424, FUNCTIONAL_END],
	[57425, FUNCTIONAL_INSERT],
	[57426, FUNCTIONAL_DELETE],
]);

const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

const LEGACY_SEQUENCES: Record<string, string> = {
	"\t": "tab",
	"\r": "enter",
	"\n": "enter",
	"\x7f": "backspace",
	"\x08": "backspace",
	"\x1b": "escape",
	"\x1b[Z": "shift+tab",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1b[H": "home",
	"\x1b[F": "end",
	"\x1bOH": "home",
	"\x1bOF": "end",
};

const CSI_U_PATTERN = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const CSI_U_CHUNK_PATTERN = /\x1b\[\d+(?::\d*)?(?::\d+)?(?:;\d+)?(?::\d+)?u/g;
const CSI_ARROW_MODIFIER_PATTERN = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/;
const CSI_TILDE_PATTERN = /^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/;

const TILDE_KEY_NAMES: Record<number, string> = {
	2: "insert",
	3: "delete",
	5: "pageUp",
	6: "pageDown",
	7: "home",
	8: "end",
};

function normalizeFunctional(codepoint: number): number {
	return KITTY_FUNCTIONAL_EQUIVALENTS.get(codepoint) ?? codepoint;
}

function normalizeShiftedIdentity(codepoint: number, modifier: number): number {
	const effective = modifier & ~LOCK_MASK;
	if ((effective & MODIFIER_SHIFT) !== 0 && codepoint >= 65 && codepoint <= 90) return codepoint + 32;
	return codepoint;
}

function withModifiers(keyName: string, modifier: number): string | undefined {
	const effective = modifier & ~LOCK_MASK;
	if ((effective & ~SUPPORTED_MODIFIER_MASK) !== 0) return undefined;
	const parts: string[] = [];
	if (effective & MODIFIER_SHIFT) parts.push("shift");
	if (effective & MODIFIER_CTRL) parts.push("ctrl");
	if (effective & MODIFIER_ALT) parts.push("alt");
	if (effective & MODIFIER_SUPER) parts.push("super");
	return parts.length > 0 ? `${parts.join("+")}+${keyName}` : keyName;
}

function keyNameForCodepoint(codepoint: number): string | undefined {
	if (codepoint === CODEPOINT_ESCAPE) return "escape";
	if (codepoint === CODEPOINT_TAB) return "tab";
	if (codepoint === CODEPOINT_ENTER || codepoint === CODEPOINT_KP_ENTER) return "enter";
	if (codepoint === CODEPOINT_SPACE) return "space";
	if (codepoint === CODEPOINT_BACKSPACE) return "backspace";
	if (codepoint === FUNCTIONAL_DELETE) return "delete";
	if (codepoint === FUNCTIONAL_INSERT) return "insert";
	if (codepoint === FUNCTIONAL_PAGE_UP) return "pageUp";
	if (codepoint === FUNCTIONAL_PAGE_DOWN) return "pageDown";
	if (codepoint === FUNCTIONAL_HOME) return "home";
	if (codepoint === FUNCTIONAL_END) return "end";
	if (codepoint === ARROW_UP) return "up";
	if (codepoint === ARROW_DOWN) return "down";
	if (codepoint === ARROW_LEFT) return "left";
	if (codepoint === ARROW_RIGHT) return "right";
	if (codepoint >= 48 && codepoint <= 57) return String.fromCharCode(codepoint);
	if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint);
	if (SYMBOL_KEYS.has(String.fromCharCode(codepoint))) return String.fromCharCode(codepoint);
	return undefined;
}

function isPrivateUse(codepoint: number): boolean {
	return (
		(codepoint >= 0xe000 && codepoint <= 0xf8ff) ||
		(codepoint >= 0xf0000 && codepoint <= 0xffffd) ||
		(codepoint >= 0x100000 && codepoint <= 0x10fffd)
	);
}

function printableFromCodepoint(codepoint: number): string | undefined {
	if (!Number.isFinite(codepoint) || codepoint < 32 || isPrivateUse(codepoint)) return undefined;
	try {
		return String.fromCodePoint(codepoint);
	} catch {
		return undefined;
	}
}

function hasPrivateUse(text: string): boolean {
	for (const char of text) {
		const codepoint = char.codePointAt(0) ?? 0;
		if (isPrivateUse(codepoint)) return true;
	}
	return false;
}

function passthroughText(text: string): string {
	// Unknown escape-led segments (e.g. an unconsumed CSI) are dropped; raw
	// UTF-8 (legacy keys, IME composition) passes through untouched.
	return text.startsWith("\x1b") ? "" : text;
}

/** Dependency-free key normalizer used when pi-tui is unavailable. */
export function fallbackNormalizeKey(data: string): string | undefined {
	const legacy = LEGACY_SEQUENCES[data];
	if (legacy !== undefined) return legacy;

	// Plain single-character input (non-escape): mirror pi-tui's legacy path.
	if (data.length === 1) {
		const codepoint = data.codePointAt(0) ?? 0;
		const name = keyNameForCodepoint(codepoint);
		if (name !== undefined) return name;
	}

	const arrow = CSI_ARROW_MODIFIER_PATTERN.exec(data);
	if (arrow) {
		const modifier = Number.parseInt(arrow[1] ?? "1", 10) - 1;
		const name = ARROW_KEY_NAMES[arrow[3] ?? ""];
		return name ? withModifiers(name, modifier) : undefined;
	}

	const tilde = CSI_TILDE_PATTERN.exec(data);
	if (tilde) {
		const modifier = tilde[2] ? Number.parseInt(tilde[2], 10) - 1 : 0;
		const name = TILDE_KEY_NAMES[Number.parseInt(tilde[1] ?? "", 10)];
		return name ? withModifiers(name, modifier) : undefined;
	}

	const kitty = CSI_U_PATTERN.exec(data);
	if (kitty) {
		const codepoint = Number.parseInt(kitty[1] ?? "", 10);
		if (!Number.isFinite(codepoint)) return undefined;
		const baseLayoutKey = kitty[3] ? Number.parseInt(kitty[3], 10) : undefined;
		const modifier = kitty[4] ? Number.parseInt(kitty[4], 10) - 1 : 0;
		const identity = normalizeShiftedIdentity(normalizeFunctional(codepoint), modifier);
		const isLatinLetter = identity >= 97 && identity <= 122;
		const isDigit = identity >= 48 && identity <= 57;
		const isSymbol = SYMBOL_KEYS.has(String.fromCharCode(identity));
		const effective = isLatinLetter || isDigit || isSymbol ? identity : (baseLayoutKey ?? identity);
		const name = keyNameForCodepoint(effective);
		return name ? withModifiers(name, modifier) : undefined;
	}

	return undefined;
}

/** Dependency-free printable-text decoder used when pi-tui is unavailable. */
export function fallbackDecodePrintable(data: string): string | undefined {
	const match = CSI_U_PATTERN.exec(data);
	if (!match) return undefined;
	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(codepoint)) return undefined;
	const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
	const modifier = match[4] ? Number.parseInt(match[4], 10) - 1 : 0;
	// Only plain or Shift-modified text keys are printable (mirrors pi-tui).
	if ((modifier & ~(MODIFIER_SHIFT | LOCK_MASK)) !== 0) return undefined;
	let effective = codepoint;
	if ((modifier & MODIFIER_SHIFT) !== 0 && typeof shiftedKey === "number") effective = shiftedKey;
	return printableFromCodepoint(normalizeFunctional(effective));
}

/**
 * Normalize one raw input chunk to a key identifier (`"enter"`, `"up"`,
 * `"shift+tab"`, `"ctrl+c"`, single characters, …) or `undefined`.
 */
export function normalizeKey(data: string): string | undefined {
	const tui = getPiTui();
	if (tui) {
		try {
			return tui.parseKey(data);
		} catch {
			// fall through to the local parser
		}
	}
	return fallbackNormalizeKey(data);
}

/** Match raw input against a key identifier such as `"escape"` or `"pageUp"`. */
export function matchesTerminalKey(data: string, key: string): boolean {
	const tui = getPiTui();
	if (tui) {
		try {
			return tui.matchesKey(data, key);
		} catch {
			// fall through to the local parser
		}
	}
	return fallbackNormalizeKey(data) === key;
}

/**
 * Decode every kitty CSI-u printable sequence inside a raw chunk. Unknown
 * escape-led segments are dropped; raw non-ESC text passes through. Returns
 * `undefined` when the chunk carries no printable text at all.
 */
export function decodePrintableChunk(data: string): string | undefined {
	const tui = getPiTui();
	let out = "";
	let last = 0;
	for (const match of data.matchAll(CSI_U_CHUNK_PATTERN)) {
		const start = match.index ?? 0;
		if (start > last) out += passthroughText(data.slice(last, start));
		const decoded = tui ? tui.decodeKittyPrintable(match[0]) : fallbackDecodePrintable(match[0]);
		if (decoded !== undefined && decoded.length > 0 && !hasPrivateUse(decoded)) out += decoded;
		last = start + match[0].length;
	}
	if (last < data.length) out += passthroughText(data.slice(last));
	return out.length > 0 ? out : undefined;
}
