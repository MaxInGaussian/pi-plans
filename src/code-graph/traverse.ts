/**
 * Pure-algorithm graph traversal for the code_graph query actions (plan
 * I-006, R-004). Deterministic: neighbors expand in (file_dir, file_name,
 * function_name) lexicographic order; budgets count emitted characters
 * (tokens ≈ chars/4) and overflow stops expansion with a truncated flag.
 * Only resolved, bound edges participate by default (F-005); the caller can
 * opt into dangling/ambiguous edges with includeUnresolved.
 */

import type { Store } from "./store.ts";

export interface NodeRef {
	fileDir: string;
	fileName: string;
	functionName: string;
}

export interface GraphIndex {
	nodes: Map<string, NodeRef>;
	adj: Map<string, Array<{ to: string; confidence: string; callee: string }>>;
	rev: Map<string, Array<{ from: string; confidence: string }>>;
	byName: Map<string, string[]>;
	community: Map<string, string>;
}

export const DEFAULT_BUDGET_TOKENS = 1500;

export function loadGraphIndex(store: Store, opts?: { includeUnresolved?: boolean }): GraphIndex {
	const includeUnresolved = opts?.includeUnresolved === true;
	const nodes = new Map<string, NodeRef>();
	const byName = new Map<string, string[]>();
	for (const row of store.read(() =>
		store.db.prepare(`SELECT file_dir, file_name, function_name FROM functions`).all(),
	) as Array<{ file_dir: string; file_name: string; function_name: string }>) {
		const key = `${row.file_dir}/${row.file_name}::${row.function_name}`;
		nodes.set(key, { fileDir: row.file_dir, fileName: row.file_name, functionName: row.function_name });
		const lower = row.function_name.toLowerCase();
		const list = byName.get(lower) ?? [];
		list.push(key);
		byName.set(lower, list);
	}
	const adj = new Map<string, Array<{ to: string; confidence: string; callee: string }>>();
	const rev = new Map<string, Array<{ from: string; confidence: string }>>();
	const edgeSource = includeUnresolved
		? store.read(() => store.db.prepare(`SELECT from_file_dir, from_file_name, from_function, to_file_dir, to_file_name, to_function, to_callee_text, confidence FROM call_edges WHERE to_file_dir IS NOT NULL`).all())
		: store.read(() => store.db.prepare(`SELECT from_file_dir, from_file_name, from_function, to_file_dir, to_file_name, to_function, to_callee_text, confidence FROM resolved_call_adjacency`).all());
	for (const row of edgeSource as Array<{
		from_file_dir: string;
		from_file_name: string;
		from_function: string;
		to_file_dir: string;
		to_file_name: string;
		to_function: string;
		to_callee_text: string;
		confidence: string;
	}>) {
		const from = `${row.from_file_dir}/${row.from_file_name}::${row.from_function}`;
		const to = `${row.to_file_dir}/${row.to_file_name}::${row.to_function}`;
		if (!nodes.has(from) || !nodes.has(to)) continue;
		const out = adj.get(from) ?? [];
		out.push({ to, confidence: row.confidence, callee: row.to_callee_text });
		adj.set(from, out);
		const inc = rev.get(to) ?? [];
		inc.push({ from, confidence: row.confidence });
		rev.set(to, inc);
	}
	for (const list of adj.values()) list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
	for (const list of rev.values()) list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
	const community = new Map<string, string>();
	for (const row of store.read(() =>
		store.db.prepare(`SELECT file_dir, file_name, function_name, label FROM communities`).all(),
	) as Array<{ file_dir: string; file_name: string; function_name: string; label: string }>) {
		community.set(`${row.file_dir}/${row.file_name}::${row.function_name}`, row.label);
	}
	return { nodes, adj, rev, byName, community };
}

export function resolveNodeSelector(index: GraphIndex, selector: string): string | null {
	const direct = index.byName.get(selector.toLowerCase());
	if (direct && direct.length > 0) return direct[0]!;
	if (selector.includes("::")) {
		const [file, name] = selector.split("::");
		if (file && name) {
			const hit = [...index.nodes.keys()].find((key) => key.startsWith(`${file}::${name}`));
			if (hit) return hit;
		}
	}
	if (selector.includes("/")) {
		const hit = [...index.nodes.keys()].filter((key) => key.startsWith(`${selector}::`)).sort();
		if (hit.length > 0) return hit[0]!;
	}
	return null;
}

export interface BudgetState {
	used: number;
	truncated: boolean;
}

export function makeBudget(tokens: number): { chars: number; state: BudgetState; spend(line: string): boolean } {
	const chars = Math.max(200, tokens * 4);
	const state: BudgetState = { used: 0, truncated: false };
	return {
		chars,
		state,
		spend(line: string): boolean {
			if (state.used + line.length > chars) {
				state.truncated = true;
				return false;
			}
			state.used += line.length + 1;
			return true;
		},
	};
}

export interface QueryResult {
	lines: string[];
	visited: number;
	edges: number;
	truncated: boolean;
	seeds: string[];
}

/** Keyword → node match, then BFS/DFS expansion under a budget. */
export function queryGraph(
	index: GraphIndex,
	terms: string[],
	opts: { mode?: "bfs" | "dfs"; budgetTokens?: number },
): QueryResult {
	const budget = makeBudget(opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
	const lowered = terms.map((t) => t.toLowerCase());
	const seeds = new Set<string>();
	for (const [name, keys] of index.byName) {
		if (lowered.some((term) => name.includes(term))) {
			for (const key of keys) seeds.add(key);
		}
	}
	const sortedSeeds = [...seeds].sort();
	const lines: string[] = [];
	const emit = (line: string): boolean => {
		if (budget.spend(line)) {
			lines.push(line);
			return true;
		}
		return false;
	};
	let visited = 0;
	let edgeCount = 0;
	if (sortedSeeds.length === 0) {
		return { lines: ["no matching nodes"], visited: 0, edges: 0, truncated: false, seeds: [] };
	}
	const seen = new Set<string>();
	const queue = [...sortedSeeds];
	const dfs = opts.mode === "dfs";
	while (queue.length > 0) {
		const current = dfs ? queue.pop()! : queue.shift()!;
		if (seen.has(current)) continue;
		seen.add(current);
		visited++;
		const node = index.nodes.get(current)!;
		const community = index.community.get(current);
		if (!emit(`● ${node.functionName} — ${node.fileDir}/${node.fileName}${community ? ` §${community}` : ""}`)) break;
		const neighbors = index.adj.get(current) ?? [];
		let overflow = false;
		for (const nb of neighbors) {
			if (seen.has(nb.to) && !queue.includes(nb.to)) continue;
			edgeCount++;
			const target = index.nodes.get(nb.to)!;
			if (!emit(`  → ${target.functionName} (${target.fileDir}/${target.fileName}) [${nb.confidence}]`)) {
				overflow = true;
				break;
			}
		}
		if (overflow) break;
		for (const nb of neighbors) {
			if (!seen.has(nb.to)) queue.push(nb.to);
		}
	}
	return { lines, visited, edges: edgeCount, truncated: budget.state.truncated, seeds: sortedSeeds };
}

export interface PathResult {
	hops: Array<{ from: string; to: string; confidence: string }>;
	found: boolean;
}

/** Shortest path between two nodes (BFS over resolved edges). */
export function shortestPath(index: GraphIndex, fromKey: string, toKey: string): PathResult {
	const prev = new Map<string, { from: string; confidence: string }>();
	const visited = new Set<string>([fromKey]);
	let queue = [fromKey];
	while (queue.length > 0) {
		const next: string[] = [];
		for (const current of queue) {
			for (const nb of index.adj.get(current) ?? []) {
				if (visited.has(nb.to)) continue;
				visited.add(nb.to);
				prev.set(nb.to, { from: current, confidence: nb.confidence });
				if (nb.to === toKey) {
					queue = [];
					next.length = 0;
					break;
				}
				next.push(nb.to);
			}
		}
		queue = next;
	}
	if (!prev.has(toKey) && fromKey !== toKey) return { hops: [], found: false };
	const hops: Array<{ from: string; to: string; confidence: string }> = [];
	let cursor = toKey;
	while (cursor !== fromKey) {
		const step = prev.get(cursor);
		if (!step) break;
		hops.unshift({ from: step.from, to: cursor, confidence: step.confidence });
		cursor = step.from;
	}
	return { hops, found: true };
}

export interface ExplainResult {
	node: NodeRef;
	community: string | null;
	outDegree: number;
	inDegree: number;
	callees: Array<{ name: string; file: string; confidence: string }>;
	callers: Array<{ name: string; file: string; confidence: string }>;
}

export function explainNode(index: GraphIndex, key: string): ExplainResult | null {
	const node = index.nodes.get(key);
	if (!node) return null;
	const callees = (index.adj.get(key) ?? []).map((nb) => {
		const target = index.nodes.get(nb.to)!;
		return { name: target.functionName, file: `${target.fileDir}/${target.fileName}`, confidence: nb.confidence };
	});
	const callers = (index.rev.get(key) ?? []).map((nb) => {
		const source = index.nodes.get(nb.from)!;
		return { name: source.functionName, file: `${source.fileDir}/${source.fileName}`, confidence: nb.confidence };
	});
	return {
		node,
		community: index.community.get(key) ?? null,
		outDegree: callees.length,
		inDegree: callers.length,
		callees,
		callers,
	};
}

export interface ImpactResult {
	affected: Array<{ name: string; file: string; via: string }>;
	files: string[];
	truncated: boolean;
	root: NodeRef;
}

/** Reverse call closure: everything that (transitively) calls the target. */
export function impactOf(index: GraphIndex, key: string, opts?: { budgetTokens?: number }): ImpactResult | null {
	const root = index.nodes.get(key);
	if (!root) return null;
	const budget = makeBudget(opts?.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
	const affected: Array<{ name: string; file: string; via: string }> = [];
	const files = new Set<string>();
	const visited = new Set<string>([key]);
	const queue = [key];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const nb of index.rev.get(current) ?? []) {
			if (visited.has(nb.from)) continue;
			visited.add(nb.from);
			const source = index.nodes.get(nb.from)!;
			const file = `${source.fileDir}/${source.fileName}`;
			files.add(file);
			if (!budget.spend(`${source.functionName} (${file})`)) {
				queue.length = 0;
				break;
			}
			affected.push({ name: source.functionName, file, via: nb.confidence });
			queue.push(nb.from);
		}
	}
	return { affected, files: [...files].sort(), truncated: budget.state.truncated, root };
}
