/**
 * Lightweight, dependency-free replacements for the pi-tui text utilities used
 * by the refine overlay. Keeping these local lets the overlay render correctly
 * in contexts where the pi-tui module is not on the resolver path (notably the
 * standalone `node:test` runs in this repository, since `@earendil-works/pi-tui`
 * is a peer of `@earendil-works/pi-coding-agent` rather than a direct
 * dependency of pi-plans).
 */

const ELLIPSIS = "…";

/**
 * ECMA-48 CSI sequence: ESC [ parameter bytes (0x30-0x3F), intermediate bytes
 * (0x20-0x2F), final byte (0x40-0x7E). Matched atomically so styling payloads
 * never leak into width math and are never split mid-sequence.
 */
const CSI_PATTERN = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

interface AnsiPart {
	kind: "csi" | "text";
	value: string;
}

function splitAnsi(text: string): AnsiPart[] {
	const parts: AnsiPart[] = [];
	let last = 0;
	for (const match of text.matchAll(CSI_PATTERN)) {
		const start = match.index ?? 0;
		if (start > last) parts.push({ kind: "text", value: text.slice(last, start) });
		parts.push({ kind: "csi", value: match[0] });
		last = start + match[0].length;
	}
	if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
	return parts;
}

function graphemeWidth(text: string): number {
	let width = 0;
	for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const cp = segment.segment.codePointAt(0) ?? 0;
		if (cp < 0x20) continue;
		if (cp === 0x09) { width += 3; continue; }
		if (cp >= 0x1100 && cp <= 0x115f) { width += 2; continue; }
		if (cp >= 0x2e80 && cp <= 0x9fff) { width += 2; continue; }
		if (cp >= 0xac00 && cp <= 0xd7a3) { width += 2; continue; }
		if (cp >= 0xff00 && cp <= 0xff60) { width += 2; continue; }
		if (cp >= 0x1f300 && cp <= 0x1faff) { width += 2; continue; }
		width += 1;
	}
	return width;
}

export function visibleWidth(text: string): number {
	if (!text) return 0;
	let width = 0;
	for (const part of splitAnsi(text)) {
		if (part.kind === "csi") continue; // escape sequences render at zero width
		width += graphemeWidth(part.value);
	}
	return width;
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = ELLIPSIS): string {
	const measured = visibleWidth(text);
	if (measured <= maxWidth) return text;
	const ellipsisWidth = ellipsis ? visibleWidth(ellipsis) : 0;
	const target = Math.max(0, maxWidth - ellipsisWidth);
	let result = "";
	let used = 0;
	let exhausted = false;
	for (const part of splitAnsi(text)) {
		if (part.kind === "csi") {
			if (!exhausted) result += part.value; // keep styling runs intact; never split them
			continue;
		}
		for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part.value)) {
			const w = visibleWidth(segment.segment);
			if (used + w > target) {
				exhausted = true;
				break;
			}
			result += segment.segment;
			used += w;
		}
	}
	// A kept open SGR (its reset lived past the cut) must not bleed into the
	// ellipsis or anything rendered after this string.
	if (exhausted && result.includes("\x1b[")) result += "\x1b[0m";
	return ellipsis ? `${result}${ellipsis}` : result;
}

export function wrapTextWithAnsi(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const normalized = text.replace(/\r\n/g, "\n");
	const words = normalized.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const word of words) {
		if (word === "") continue;
		const wordWidth = visibleWidth(word);
		if (wordWidth > maxWidth) {
			// Hard split a single overlong word (ANSI-aware: CSI runs are zero-width and atomic).
			if (current) { lines.push(current); current = ""; currentWidth = 0; }
			let buffer = "";
			let bufferWidth = 0;
			for (const part of splitAnsi(word)) {
				if (part.kind === "csi") {
					buffer += part.value;
					continue;
				}
				for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part.value)) {
					const w = visibleWidth(segment.segment);
					if (bufferWidth + w > maxWidth) {
						lines.push(buffer);
						buffer = segment.segment;
						bufferWidth = w;
					} else {
						buffer += segment.segment;
						bufferWidth += w;
					}
				}
			}
			if (buffer) { lines.push(buffer); buffer = ""; bufferWidth = 0; }
			continue;
		}
		if (currentWidth + wordWidth > maxWidth) {
			lines.push(current.trimEnd());
			current = word.trimStart();
			currentWidth = visibleWidth(current);
		} else {
			current += word;
			currentWidth += wordWidth;
		}
	}
	if (current.trim().length > 0) lines.push(current.trimEnd());
	return lines;
}

export function matchesEscape(data: string): boolean {
	return data === "\x1b" || data === "\x1b\x1b" || /^(\x1b\[\??\d*[A-Za-z])|(\x1bO[A-Za-z])$/.test(data);
}
