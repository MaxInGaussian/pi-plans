/**
 * Every skill and agent definition must carry frontmatter that Pi's own
 * parser accepts. An unquoted `description:` holding `: ` is invalid YAML
 * ("Nested mappings are not allowed in compact mappings") and makes Pi refuse
 * the file (issue #7), so the shipped files are parsed with the same parser.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const ROOT = path.resolve(import.meta.dirname, "..");

const skillFiles = fs.readdirSync(path.join(ROOT, "skills")).map((dir) => path.join("skills", dir, "SKILL.md"));
const agentFiles = fs.readdirSync(path.join(ROOT, "agents")).filter((file) => file.endsWith(".md")).map((file) => path.join("agents", file));

function frontmatterOf(file: string): Record<string, unknown> {
	return parseFrontmatter(fs.readFileSync(path.join(ROOT, file), "utf8")).frontmatter;
}

describe("skill and agent frontmatter parses as YAML", () => {
	for (const file of skillFiles) {
		it(`${file} has a string name and description`, () => {
			const data = frontmatterOf(file);
			assert.equal(typeof data.name, "string");
			assert.equal(typeof data.description, "string");
			assert.ok((data.description as string).length > 0);
		});
	}

	for (const file of agentFiles) {
		it(`${file} has a string name, description and tools`, () => {
			const data = frontmatterOf(file);
			assert.equal(typeof data.name, "string");
			assert.equal(typeof data.description, "string");
			assert.equal(typeof data.tools, "string");
		});
	}

	it("the parser really rejects an unquoted ': ' in a description (the guard is live)", () => {
		assert.throws(() => parseFrontmatter("---\nname: x\ndescription: bigger than plan-big: an abstract plan\n---\nbody\n"));
		const quoted = parseFrontmatter('---\nname: x\ndescription: "bigger than plan-big: an abstract plan"\n---\nbody\n').frontmatter;
		assert.equal(quoted.description, "bigger than plan-big: an abstract plan");
	});
});
