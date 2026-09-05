/**
 * Lazy runtime guards for the code-graph module. Imports happen on first use
 * so that a missing parser dependency or unsupported Node version cannot
 * prevent the rest of pi-plans from registering.
 *
 * The module never throws at import time; every consumer calls one of the
 * `ensure*` helpers and inspects the resulting status object.
 */

import { execSync } from "node:child_process";

export type RuntimeIssue =
	| { kind: "node-version"; detail: string }
	| { kind: "sqlite-import"; detail: string }
	| { kind: "parser-import"; detail: string; package: string }
	| { kind: "runtime-unsupported"; detail: string };

export interface RuntimeStatus {
	nodeVersion: string;
	nodeMajor: number;
	hasExperimentalSqliteFlag: boolean;
	graphEffectiveFloorMet: boolean;
	parserAvailable: boolean;
	sqliteAvailable: boolean;
	bunDetected: boolean;
	issues: RuntimeIssue[];
}

const MAJOR = Number(process.versions.node.split(".")[0]);
const MINOR = Number(process.versions.node.split(".")[1] ?? "0");

export const IS_BUN = typeof (process as { versions?: { bun?: string } }).versions?.bun === "string";

function flagHasExperimentalSqlite(): boolean {
	try {
		const out = execSync(process.execPath, ["--experimental-sqlite", "-e", "1"], { encoding: "utf8" });
		return out === "1";
	} catch {
		try {
			const out = execSync(process.execPath, ["-e", "process.features.sqlite ?? \"off\""], { encoding: "utf8" }).trim();
			return out !== "off" && out !== "undefined" && out !== "\"off\"";
		} catch {
			return false;
		}
	}
}

async function importSqlite(): Promise<unknown> {
	return await import("node:sqlite");
}

async function importParser(): Promise<unknown> {
	const mod = await import("tree-sitter");
	const js = await import("tree-sitter-javascript");
	const ts = await import("tree-sitter-typescript");
	const py = await import("tree-sitter-python");
	return { default: mod.default ?? mod, js: js.default ?? js, ts: ts.default ?? ts, py: py.default ?? py };
}

export async function detectRuntimeStatus(): Promise<RuntimeStatus> {
	const issues: RuntimeIssue[] = [];
	if (IS_BUN) {
		issues.push({
			kind: "runtime-unsupported",
			detail: "graph feature is Node-only; detected Bun runtime",
		});
	}
	const nodeVersion = process.versions.node;
	const graphEffectiveFloorMet = IS_BUN
		? false
		: (MAJOR === 22 && MINOR >= 13) || MAJOR > 22;
	const hasFlag = flagHasExperimentalSqlite();
	const sqliteAvailable = await importSqlite()
		.then(() => true)
		.catch((err: Error) => {
			issues.push({ kind: "sqlite-import", detail: err.message });
			return false;
		});
	if (!sqliteAvailable && !hasFlag && !IS_BUN) {
		issues.push({
			kind: "node-version",
			detail: `node:sqlite requires Node >=22.13 or --experimental-sqlite; current ${nodeVersion}`,
		});
	}
	const parserAvailable = await importParser()
		.then(() => true)
		.catch((err: Error) => {
			issues.push({
				kind: "parser-import",
				package: "tree-sitter",
				detail: err.message,
			});
			return false;
		});
	return {
		nodeVersion,
		nodeMajor: MAJOR,
		hasExperimentalSqliteFlag: hasFlag,
		graphEffectiveFloorMet,
		parserAvailable,
		sqliteAvailable,
		bunDetected: IS_BUN,
		issues,
	};
}

export interface GraphRuntime {
	sqlite: typeof import("node:sqlite");
	parser: {
		Parser: typeof import("tree-sitter").default;
		javascript: unknown;
		typescript: unknown;
		tsx: unknown;
		python: unknown;
	};
}

let cached: GraphRuntime | null = null;

export async function loadGraphRuntime(): Promise<{ runtime: GraphRuntime; status: RuntimeStatus }> {
	if (cached) return { runtime: cached, status: await detectRuntimeStatus() };
	const sqlite = await importSqlite();
	const ParserMod = await import("tree-sitter");
	const jsMod = await import("tree-sitter-javascript");
	const tsMod = await import("tree-sitter-typescript");
	const pyMod = await import("tree-sitter-python");
	const Parser = (ParserMod as { default?: unknown }).default ?? ParserMod;
	const runtime: GraphRuntime = {
		sqlite: sqlite as typeof import("node:sqlite"),
		parser: {
			Parser: Parser as typeof import("tree-sitter").default,
			javascript: (jsMod as { default?: unknown }).default ?? jsMod,
			typescript: (tsMod as { default?: { typescript: unknown; tsx: unknown } }).default?.typescript ?? tsMod,
			tsx: (tsMod as { default?: { tsx: unknown } }).default?.tsx ?? tsMod,
			python: (pyMod as { default?: unknown }).default ?? pyMod,
		},
	};
	cached = runtime;
	return { runtime, status: await detectRuntimeStatus() };
}

export function describeRuntimeIssues(status: RuntimeStatus): string[] {
	if (status.issues.length === 0) return [];
	return status.issues.map((issue) => {
		switch (issue.kind) {
			case "node-version":
				return `Node version: ${issue.detail}`;
			case "sqlite-import":
				return `node:sqlite import failed: ${issue.detail}`;
			case "parser-import":
				return `parser import failed (${issue.package}): ${issue.detail}`;
			case "runtime-unsupported":
				return `runtime: ${issue.detail}`;
			default:
				return "unknown runtime issue";
		}
	});
}
