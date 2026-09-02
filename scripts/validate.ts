#!/usr/bin/env node
/** Validate the pi-plans extension structure. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const SKILL_ROOT = path.join(ROOT, "skills");
const EXPECTED_SKILLS = new Set([
	"planning",
	"plan-small",
	"plan-normal",
	"plan-big",
	"plan-with-refs",
	"debug-and-plan",
]);
const REQUIRED_REFERENCES = ["pi-planning-workflow.md", "plan-artifact-template.md", "state-and-config.md"];
const REQUIRED_AGENTS = ["reviewer.md", "criticizer.md"];
const REQUIRED_TOOL_FILES = [
	"tools/plans.ts",
	"tools/ask-choice.ts",
	"tools/refine.ts",
	"tools/execute-plan.ts",
	"tools/code-graph.ts",
	"src/state.ts",
	"src/guard.ts",
	"src/plan.ts",
	"src/subagent.ts",
	"src/exec.ts",
	"src/code-graph/runtime.ts",
	"src/code-graph/schema.ts",
	"src/code-graph/store.ts",
];

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function parseFrontmatter(text: string, file: string): Map<string, string> {
	if (!text.startsWith("---\n")) fail(`${file}: missing opening frontmatter`);
	const end = text.indexOf("\n---\n", 3);
	if (end < 0) fail(`${file}: missing closing frontmatter`);
	const data = new Map<string, string>();
	for (const line of text.slice(4, end).split("\n")) {
		if (!line.trim()) continue;
		const sep = line.indexOf(":");
		if (sep < 0) fail(`${file}: invalid frontmatter line ${line!}`);
		data.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
	}
	return data;
}

function validateSkill(dir: string): void {
	const file = path.join(dir, "SKILL.md");
	if (!fs.existsSync(file)) fail(`missing ${file}`);
	const text = fs.readFileSync(file, "utf8");
	const frontmatter = parseFrontmatter(text, file);
	const name = frontmatter.get("name") ?? "";
	const description = frontmatter.get("description") ?? "";

	if (name !== path.basename(dir)) fail(`${file}: name ${name!} must match directory ${path.basename(dir)}`);
	if (!NAME_RE.test(name) || name.length > 64) fail(`${file}: invalid skill name`);
	if (!description || description.length > 1024) fail(`${file}: invalid description length`);
	if (!/Use|MUST USE/.test(description)) fail(`${file}: description should include routing language`);

	const requiredPhrases = ["Auto-complete", "ask_choice", "refine", "language", "reviewer", "criticizer", ".git/pi_plans"];
	for (const phrase of requiredPhrases) {
		if (!text.includes(phrase)) fail(`${file}: missing required phrase ${phrase!}`);
	}
}

function validateDefaultConfig(): void {
	const source = fs.readFileSync(path.join(ROOT, "src", "state.ts"), "utf8");
	if (!source.includes('"pi-plans-reviewer"') || !source.includes('"pi-plans-criticizer"')) {
		fail("src/state.ts: name_prefix defaults missing");
	}
	if (source.includes("effort")) fail("src/state.ts: per-role effort must not exist");
	if (!source.includes('"delegated-subagent"')) fail("src/state.ts: delegated-subagent default missing");
	if (!source.includes('artifact_root: DEFAULT_ARTIFACT_ROOT')) fail("src/state.ts: artifact_root default missing");
	if (!source.includes('artifact_root_source: "unset"')) fail("src/state.ts: artifact_root_source default missing");
	if (!source.includes('artifact_root_updated_at: null')) fail("src/state.ts: artifact_root_updated_at default missing");
}

interface PackageJson {
	private?: boolean;
	keywords?: unknown[];
	publishConfig?: { access?: string };
	pi?: { extensions?: unknown[]; skills?: unknown[] };
	files?: unknown[];
	engines?: { node?: string };
	scripts?: { test?: string; prepack?: string };
	license?: string;
}

function normalizePackageEntry(value: unknown): string {
	return String(value).replace(/\/$/, "");
}

function validatePlansTool(): void {
	const source = fs.readFileSync(path.join(ROOT, "tools", "plans.ts"), "utf8");
	if (!source.includes('"set-artifact-root"')) fail("tools/plans.ts: set-artifact-root action missing");
	if (!source.includes("artifactRootSource")) fail("tools/plans.ts: artifactRootSource parameter missing");
}

function validatePackageMetadata(): void {
	const pkgPath = path.join(ROOT, "package.json");
	let pkg: PackageJson;
	try {
		pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
	} catch (error) {
		fail(`package.json: invalid JSON: ${(error as Error).message}`);
	}

	if (pkg.private === true) fail("package.json: private must be removed or false for npm publish");
	if (pkg.license !== "MIT") fail("package.json: license must be MIT");
	if (pkg.publishConfig?.access !== "public") fail("package.json: publishConfig.access must be public");
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.map(String).includes("pi-package")) {
		fail("package.json: missing pi-package keyword");
	}

	const pi = pkg.pi ?? {};
	const extensions = new Set((pi.extensions ?? []).map(normalizePackageEntry));
	const skills = new Set((pi.skills ?? []).map(normalizePackageEntry));
	if (!extensions.has("./index.ts")) fail("package.json: pi.extensions must include ./index.ts");
	if (!skills.has("./skills")) fail("package.json: pi.skills must include ./skills");

	const files = new Set((pkg.files ?? []).map(normalizePackageEntry));
	for (const required of ["README.md", "LICENSE", "index.ts", "agents", "references", "scripts", "skills", "src", "tests", "tools"]) {
		if (!files.has(required)) fail(`package.json: files must include ${required}`);
	}

	if (pkg.engines?.node !== ">=22.6") fail("package.json: engines.node must be >=22.6");
	if (pkg.scripts?.test !== "node --experimental-strip-types scripts/run-tests.ts") {
		fail("package.json: test script must use scripts/run-tests.ts");
	}
	if (pkg.scripts?.prepack !== "npm run validate && npm test") {
		fail("package.json: prepack must run validate and test");
	}
}

function main(): void {
	const found = new Set(
		fs
			.readdirSync(SKILL_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name),
	);
	const missing = [...EXPECTED_SKILLS].filter((skill) => !found.has(skill));
	const extra = [...found].filter((skill) => !EXPECTED_SKILLS.has(skill));
	if (missing.length || extra.length) {
		fail(`skill set mismatch; missing=${missing.join(",")} extra=${extra.join(",")}`);
	}
	for (const skill of [...EXPECTED_SKILLS].sort()) {
		validateSkill(path.join(SKILL_ROOT, skill));
	}

	for (const ref of REQUIRED_REFERENCES) {
		const file = path.join(ROOT, "references", ref);
		if (!fs.existsSync(file)) fail(`missing reference ${ref}`);
		if (!fs.readFileSync(file, "utf8").includes(".git/pi_plans")) {
			fail(`${ref}: missing .git/pi_plans state location`);
		}
	}

	for (const agent of REQUIRED_AGENTS) {
		const file = path.join(ROOT, "agents", agent);
		if (!fs.existsSync(file)) fail(`missing agent ${agent}`);
		const text = fs.readFileSync(file, "utf8");
		if (!/tools:\s*read/.test(text)) fail(`${agent}: must declare read-only tools`);
		if (!text.includes("read-only")) fail(`${agent}: must state read-only contract`);
	}

	for (const tool of REQUIRED_TOOL_FILES) {
		if (!fs.existsSync(path.join(ROOT, tool))) fail(`missing ${tool}`);
	}

	if (!fs.existsSync(path.join(ROOT, "index.ts"))) fail("missing index.ts");

	validateDefaultConfig();
	validatePlansTool();
	validatePackageMetadata();
	console.log(`validated ${EXPECTED_SKILLS.size} skills, ${REQUIRED_REFERENCES.length} references, ${REQUIRED_AGENTS.length} agents, ${REQUIRED_TOOL_FILES.length} tools`);
}

main();
