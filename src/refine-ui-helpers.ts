/**
 * Lightweight, dependency-free replacements for the pi-tui text utilities used
 * by the refine overlay. Keeping these local lets the overlay render correctly
 * in contexts where the pi-tui module is not on the resolver path (notably the
 * standalone `node:test` runs in this repository, since `@earendil-works/pi-tui`
 * is a peer of `@earendil-works/pi-coding-agent` rather than a direct
 * dependency of pi-plans).
 */

const ELLIPSIS = "…";

export function visibleWidth(text: string): number {
	if (!text) return 0;
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

export function truncateToWidth(text: string, maxWidth: number, ellipsis = ELLIPSIS): string {
	const measured = visibleWidth(text);
	if (measured <= maxWidth) return text;
	const ellipsisWidth = ellipsis ? visibleWidth(ellipsis) : 0;
	const target = Math.max(0, maxWidth - ellipsisWidth);
	let result = "";
	let used = 0;
	for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const w = visibleWidth(segment.segment);
		if (used + w > target) break;
		result += segment.segment;
		used += w;
	}
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
			// Hard split a single overlong word.
			if (current) { lines.push(current); current = ""; currentWidth = 0; }
			let buffer = "";
			let bufferWidth = 0;
			for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)) {
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