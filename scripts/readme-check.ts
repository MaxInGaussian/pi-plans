/**
 * README <-> code-surface consistency checks.
 *
 * The README is the front door of the package, so every surface fact it
 * states (commands, tools, `plans` actions, skills, templates, dependencies,
 * links, section anchors, the header stat strip) is asserted here and enforced
 * by `scripts/validate.ts` in CI and at `prepack` time.
 *
 * Deliberate exclusions from the extracted surface (documented so a future
 * reader does not mistake them for gaps):
 * - the seven skill-alias commands `index.ts` registers inside a
 *   `for (const name of [...])` loop — extracted separately as `aliasCommands`
 *   and counted in the stat strip, never name-asserted one by one;
 * - the three wrapped built-in file tools registered by
 *   `tools/graph-aware-file-tools.ts` (its argument is an array, not a
 *   `name:` literal).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ReadmeSurface {
	/** Workspace root the relative links are resolved against. */
	root: string;
	/** README.md contents. */
	readme: string;
	/** Literal `registerCommand("…")` names. */
	commands: string[];
	/** Skill aliases registered in a loop (counted, not name-asserted). */
	aliasCommands: string[];
	/** Literal `registerTool({ name: "…" })` / `defineTool({ name: "…" })` names. */
	tools: string[];
	/** The `plans` tool's `action` enum. */
	actions: string[];
	/** `skills/*` directory names. */
	skills: string[];
	/** `references/*template*.md` file names. */
	templates: string[];
	/** `package.json` devDependencies keys. */
	devDependencies: string[];
	/** `package.json` license. */
	license: string;
}

/**
 * Declared assertion ids. Keep this list in sync with `readmeIssues`; the
 * validator prints its length as the README check count.
 */
export const README_CHECKS = [
	"commands",
	"tools",
	"actions",
	"skills",
	"dependencies",
	"links",
	"anchors",
	"highlights",
	"legacy-ids",
	"cjk",
	"stat-strip",
	"extraction-floors",
] as const;

// Duplicated on purpose: `scripts/validate.ts` runs `main()` at module scope
// (and shells out to `npm pack`), so it must never be imported from here.
const CJK_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const LEGACY_ID_RE = /\bI-[0-9]{3}\b/;

const MANDATED_HEADINGS = [
	"Highlights",
	"Benchmarked: single-seed exploratory result",
	"Contents",
	"How it works",
	"Quick start",
	"What it does",
	"Interface overview",
	"Requirements & compatibility",
	"VCC compact",
	"Visible Refiner overlay",
	"The execution rules",
	"Skills",
	"Installation details",
	"Benchmarks",
	"Layout",
	"Safety model",
	"Verification",
	"FAQ",
	"Contributing",
	"License",
];

const FLOORS = {
	commands: 18,
	aliasCommands: 7,
	tools: 7,
	actions: 14,
	skills: 7,
	templates: 2,
} as const;

function walk(dir: string, out: string[] = []): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			walk(full, out);
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

function matchAll(text: string, re: RegExp): string[] {
	const seen: string[] = [];
	for (const match of text.matchAll(re)) {
		if (match[1]) seen.push(match[1]);
	}
	return [...new Set(seen)].sort();
}

/** Read the code surface the README must agree with. */
export function collectSurface(root: string): ReadmeSurface {
	const sources = [path.join(root, "index.ts"), ...walk(path.join(root, "src")), ...walk(path.join(root, "tools"))];
	const texts = new Map<string, string>();
	for (const file of sources) {
		try {
			texts.set(file, fs.readFileSync(file, "utf8"));
		} catch {
			// A missing optional source simply contributes nothing.
		}
	}
	const combined = [...texts.values()].join("\n");

	const commands = matchAll(combined, /registerCommand\(\s*"([a-z0-9-]+)"/g);

	// The alias loop is the block that follows the "Direct slash aliases" note.
	const indexSource = texts.get(path.join(root, "index.ts")) ?? "";
	let aliasCommands: string[] = [];
	const aliasMarker = indexSource.indexOf("Direct slash aliases");
	if (aliasMarker >= 0) {
		const window = indexSource.slice(aliasMarker, aliasMarker + 600);
		const array = window.match(/for \(const name of \[([\s\S]*?)\]/);
		if (array) aliasCommands = matchAll(array[1], /"([a-z0-9-]+)"/g);
	}

	const tools = matchAll(combined, /(?:registerTool|defineTool)\(\s*\{[\s\S]{0,120}?name:\s*"([a-z0-9_]+)"/g);

	const plansSource = texts.get(path.join(root, "tools", "plans.ts")) ?? "";
	const actionEnum = plansSource.match(/action:\s*StringEnum\(\s*\[([\s\S]*?)\]/);
	const actions = actionEnum ? matchAll(actionEnum[1], /"([a-z-]+)"/g) : [];

	let skills: string[] = [];
	try {
		skills = fs
			.readdirSync(path.join(root, "skills"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		skills = [];
	}

	let templates: string[] = [];
	try {
		templates = fs
			.readdirSync(path.join(root, "references"))
			.filter((name) => name.endsWith(".md") && name.includes("template"))
			.sort();
	} catch {
		templates = [];
	}

	let pkg: { license?: unknown; devDependencies?: Record<string, unknown> } = {};
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as typeof pkg;
	} catch {
		pkg = {};
	}

	let readme = "";
	try {
		readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
	} catch {
		// A missing README is reported by readmeIssues below, not by a stack trace.
		readme = "";
	}

	return {
		root,
		readme,
		commands,
		aliasCommands,
		tools,
		actions,
		skills,
		templates,
		devDependencies: Object.keys(pkg.devDependencies ?? {}).sort(),
		license: String(pkg.license ?? ""),
	};
}

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
export function slugifyHeading(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9 _-]/g, "")
		.replace(/ /g, "-");
}

function section(readme: string, heading: string): string | null {
	const start = readme.indexOf(`\n## ${heading}\n`);
	if (start < 0) return null;
	const rest = readme.slice(start + heading.length + 5);
	const next = rest.indexOf("\n## ");
	return next < 0 ? rest : rest.slice(0, next);
}

/** Return every README <-> surface inconsistency; empty means consistent. */
export function readmeIssues(surface: ReadmeSurface): string[] {
	const issues: string[] = [];
	const r = surface.readme;
	const mentions = (name: string) => new RegExp(`/${name}(?![a-z0-9-])`).test(r);

	// 1. commands
	const missingCommands = surface.commands.filter((name) => !mentions(name));
	if (missingCommands.length) issues.push(`commands: README does not mention /${missingCommands.join(", /")}`);

	// 2. tools
	const missingTools = surface.tools.filter((name) => !r.includes("`" + name + "`"));
	if (missingTools.length) issues.push(`tools: README does not mention ${missingTools.join(", ")}`);

	// 3. plans actions
	const missingActions = surface.actions.filter((name) => !r.includes("`" + name + "`"));
	if (missingActions.length) issues.push(`actions: README does not mention ${missingActions.join(", ")}`);

	// 4. skills
	const missingSkills = surface.skills.filter((name) => !r.includes(`skills/${name}/SKILL.md`));
	if (missingSkills.length) issues.push(`skills: README does not link ${missingSkills.join(", ")}`);

	// 5. dependencies
	const treeSitter = surface.devDependencies.filter((name) => name.startsWith("tree-sitter"));
	const missingDeps = [...treeSitter.filter((name) => !r.includes(name)), ...(r.includes("devDependencies") ? [] : ["devDependencies"])];
	if (missingDeps.length) issues.push(`dependencies: README does not name ${missingDeps.join(", ")} in the requirements section`);

	// 6. relative link and image targets
	for (const target of linkTargets(r)) {
		const clean = target.split("?")[0].split("#")[0];
		if (!clean || !fs.existsSync(path.join(surface.root, clean))) {
			issues.push(`links: README target does not exist: ${target}`);
		}
	}

	// 7. every in-page anchor resolves (not only the Contents list), and the
	// mandated headings exist
	const headings = [...r.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1].trim());
	const slugs = new Set(headings.map(slugifyHeading));
	for (const requirement of MANDATED_HEADINGS) {
		if (!headings.includes(requirement)) issues.push(`anchors: required heading is missing: ## ${requirement}`);
	}
	for (const anchor of [...r.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1])) {
		if (!slugs.has(anchor)) issues.push(`anchors: in-page link does not resolve: #${anchor}`);
	}
	const contents = section(r, "Contents");
	if (contents === null) {
		issues.push("anchors: README has no ## Contents section");
	} else {
		for (const anchor of [...contents.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1])) {
			if (!slugs.has(anchor)) issues.push(`anchors: Contents entry does not resolve: #${anchor}`);
		}
	}

	// 8. Highlights precedes Contents
	const highlightsAt = r.indexOf("\n## Highlights\n");
	const contentsAt = r.indexOf("\n## Contents\n");
	if (highlightsAt < 0) issues.push("highlights: README has no ## Highlights section");
	else if (contentsAt >= 0 && highlightsAt > contentsAt) issues.push("highlights: ## Highlights must precede ## Contents");

	// 9. no legacy plan-id token is presented
	const legacy = r.match(LEGACY_ID_RE);
	if (legacy) issues.push(`legacy-ids: README still shows the legacy plan id ${legacy[0]}`);

	// 10. English only
	if (CJK_RE.test(r)) issues.push("cjk: README must be entirely English (no CJK ideographs or full-width punctuation)");

	// 11. stat strip matches the surface
	const strip = r.match(
		/<b>(\d+)<\/b> skills · <b>(\d+)<\/b> slash commands · <b>(\d+)<\/b> tools · <b>(\d+)<\/b> templates · <b>([A-Za-z0-9.+-]+)<\/b>/,
	);
	if (!strip) {
		issues.push("stat-strip: README has no parseable header stat strip");
	} else {
		const expected = [
			String(surface.skills.length),
			String(surface.commands.length + surface.aliasCommands.length),
			String(surface.tools.length),
			String(surface.templates.length),
			surface.license,
		];
		const actual = strip.slice(1, 6);
		actual.forEach((value, index) => {
			if (value !== expected[index]) {
				issues.push(`stat-strip: entry ${index + 1} is ${value}, surface says ${expected[index]}`);
			}
		});
	}

	// 12. extraction floors: a broken extractor must fail loudly, never pass quietly
	const counted: Array<[keyof typeof FLOORS, number, string]> = [
		["commands", surface.commands.length, "registerCommand literals"],
		["aliasCommands", surface.aliasCommands.length, "skill aliases"],
		["tools", surface.tools.length, "registerTool literals"],
		["actions", surface.actions.length, "plans action enum"],
		["skills", surface.skills.length, "skills/ directories"],
		["templates", surface.templates.length, "references/*template* files"],
	];
	for (const [key, value, what] of counted) {
		if (value < FLOORS[key]) {
			issues.push(`extraction-floors: surface extraction broke — parsed ${value} ${what} (expected >= ${FLOORS[key]}); update scripts/readme-check.ts`);
		}
	}

	return issues;
}

/** Markdown link targets plus `<img src>` values, ignoring external URLs. */
function linkTargets(readme: string): string[] {
	const targets: string[] = [];
	for (const match of readme.matchAll(/\]\(([^)\s]+)\)/g)) targets.push(match[1]);
	for (const match of readme.matchAll(/src="([^"]+)"/g)) targets.push(match[1]);
	return [...new Set(targets)].filter(
		(target) => !target.startsWith("#") && !target.startsWith("http://") && !target.startsWith("https://") && !target.startsWith("mailto:"),
	);
}
