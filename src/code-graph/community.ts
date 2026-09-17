/**
 * Community detection and the human report (plan I-003, R-005).
 *
 * Label propagation over the resolved call graph (pure algorithm, no LLM,
 * no dependencies — graphify's Leiden replaced per D-005). Deterministic:
 * fixed node order (file_dir, file_name, function_name) and smallest-label
 * tie-breaks, iterated at most MAX_ITERATIONS rounds.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store.ts";

export const MAX_ITERATIONS = 20;
export const GOD_NODE_COUNT = 10;

export interface CommunityRow {
	community_id: number;
	file_dir: string;
	file_name: string;
	function_name: string;
	label: string;
	degree: number;
}

interface NodeKey {
	fileDir: string;
	fileName: string;
	functionName: string;
}

const keyOf = (n: NodeKey) => `${n.fileDir}/${n.fileName}::${n.functionName}`;

/** Run label propagation and persist assignments into `communities`.
 *  Returns summary stats (also used by the report generator). */
export function computeCommunities(store: Store): {
	communities: number;
	nodes: number;
	godNodes: Array<{ name: string; file: string; degree: number; community: string }>;
} {
	const edges: Array<{ from_key: string; to_key: string }> = store.read(() =>
		store.db
			.prepare(
				`SELECT from_file_dir || '/' || from_file_name || '::' || from_function AS from_key,
					to_file_dir || '/' || to_file_name || '::' || to_function AS to_key
				 FROM resolved_call_adjacency`,
			)
			.all(),
	) as Array<{ from_key: string; to_key: string }>;
	const nodesRaw = store.read(() =>
		store.db.prepare(`SELECT file_dir, file_name, function_name FROM functions`).all(),
	) as Array<{ file_dir: string; file_name: string; function_name: string }>;
	const nodes: NodeKey[] = nodesRaw.map((n) => ({ fileDir: n.file_dir, fileName: n.file_name, functionName: n.function_name }));
	const order = nodes.map(keyOf).sort();

	const neighbors = new Map<string, string[]>();
	const degree = new Map<string, number>();
	for (const key of order) {
		neighbors.set(key, []);
		degree.set(key, 0);
	}
	for (const raw of edges) {
		const from = raw.from_key;
		const to = raw.to_key;
		if (!from || !to || !neighbors.has(from) || !neighbors.has(to)) continue;
		neighbors.get(from)!.push(to);
		neighbors.get(to)!.push(from);
		degree.set(from, (degree.get(from) ?? 0) + 1);
		degree.set(to, (degree.get(to) ?? 0) + 1);
	}

	// Label propagation: synchronous updates in deterministic order.
	const labels = new Map<string, string>();
	order.forEach((key, i) => labels.set(key, `#${i}`));
	for (let round = 0; round < MAX_ITERATIONS; round++) {
		let changed = false;
		for (const key of order) {
			const counts = new Map<string, number>();
			for (const nb of neighbors.get(key) ?? []) {
				const label = labels.get(nb);
				if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
			}
			if (counts.size === 0) continue;
			let best: string | null = null;
			let bestCount = -1;
			for (const [label, count] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
				if (count > bestCount) {
					best = label;
					bestCount = count;
				}
			}
			if (best && best !== labels.get(key)) {
				labels.set(key, best);
				changed = true;
			}
		}
		if (!changed) break;
	}

	// Community ids: stable numbering by smallest member key.
	const groupId = new Map<string, number>();
	const membersByGroup = new Map<string, string[]>();
	for (const key of order) {
		const label = labels.get(key) ?? key;
		if (!membersByGroup.has(label)) membersByGroup.set(label, []);
		membersByGroup.get(label)!.push(key);
	}
	const sortedGroups = [...membersByGroup.keys()].sort((a, b) => {
		const am = membersByGroup.get(a)![0]!;
		const bm = membersByGroup.get(b)![0]!;
		return am < bm ? -1 : am > bm ? 1 : 0;
	});
	sortedGroups.forEach((label, i) => groupId.set(label, i + 1));

	// Community label: most frequent top-level directory (or file name for root files).
	const groupLabel = new Map<number, string>();
	for (const [label, keys] of membersByGroup) {
		const id = groupId.get(label)!;
		const counts = new Map<string, number>();
		for (const key of keys) {
			const fileDir = key.slice(0, key.indexOf("/"));
			const seg = fileDir === "." ? path.basename(key.slice(0, key.lastIndexOf("::"))) : fileDir;
			counts.set(seg, (counts.get(seg) ?? 0) + 1);
		}
		let best = "misc";
		let bestCount = -1;
		for (const [seg, count] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (count > bestCount) {
				best = seg;
				bestCount = count;
			}
		}
		groupLabel.set(id, best);
	}

	store.tx(() => {
		store.db.prepare(`DELETE FROM communities`).run();
		const insert = store.db.prepare(
			`INSERT INTO communities (community_id, file_dir, file_name, function_name, label, degree)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const key of order) {
			const label = labels.get(key) ?? key;
			const id = groupId.get(label) ?? 0;
			const slash = key.indexOf("/");
			const colon = key.lastIndexOf("::");
			const fileDir = key.slice(0, slash);
			const fileName = key.slice(slash + 1, colon);
			const functionName = key.slice(colon + 2);
			insert.run(id, fileDir, fileName, functionName, groupLabel.get(id) ?? "misc", degree.get(key) ?? 0);
		}
	});

	const godNodes = order
		.map((key) => ({
			name: key.slice(key.lastIndexOf("::") + 2),
			file: key.slice(0, key.lastIndexOf("::")),
			degree: degree.get(key) ?? 0,
			community: groupLabel.get(groupId.get(labels.get(key) ?? key) ?? 0) ?? "misc",
		}))
		.sort((a, b) => b.degree - a.degree || (a.file < b.file ? -1 : 1))
		.slice(0, GOD_NODE_COUNT);

	return { communities: sortedGroups.length, nodes: order.length, godNodes };
}

/** Render GRAPH_REPORT.md (plan R-005) under `<gitCommonDir>/pi_plans/graph/`. */
export function generateGraphReport(store: Store, graphDir: string, baseline?: { files: number; functions: number; ms: number }): string {
	const stats = computeCommunities(store);
	const edgeStats = store.read(() =>
		store.db
			.prepare(`SELECT kind, resolution, confidence, COUNT(*) AS n FROM call_edges GROUP BY kind, resolution, confidence`)
			.all(),
	) as Array<{ kind: string; resolution: string; confidence: string; n: number }>;
	const communitySizes = store.read(() =>
		store.db.prepare(`SELECT community_id, label, COUNT(*) AS members FROM communities GROUP BY community_id, label ORDER BY members DESC`).all(),
	) as Array<{ community_id: number; label: string; members: number }>;

	const lines: string[] = [];
	lines.push("# Code Graph Report");
	lines.push("");
	lines.push(`Generated: ${new Date().toISOString()}`);
	if (baseline) lines.push(`Index baseline: ${baseline.files} files · ${baseline.functions} functions · ${baseline.ms}ms`);
	lines.push(`Nodes (functions): ${stats.nodes} · Communities: ${stats.communities}`);
	lines.push("");
	lines.push("## Edges");
	lines.push("");
	lines.push("| kind | resolution | confidence | count |");
	lines.push("|---|---|---|---|");
	for (const row of edgeStats) lines.push(`| ${row.kind} | ${row.resolution} | ${row.confidence} | ${row.n} |`);
	lines.push("");
	lines.push("## Communities (label propagation, resolved edges only)");
	lines.push("");
	lines.push("| id | label | functions |");
	lines.push("|---|---|---|");
	for (const row of communitySizes) lines.push(`| ${row.community_id} | ${row.label} | ${row.members} |`);
	lines.push("");
	lines.push("## God nodes (top 10 by resolved degree)");
	lines.push("");
	for (const [i, node] of stats.godNodes.entries()) {
		lines.push(`${i + 1}. **${node.name}** (${node.file}) — degree ${node.degree}, community \`${node.community}\``);
	}
	lines.push("");
	lines.push("## Suggested queries");
	lines.push("");
	lines.push('- `code_graph query "ask form"` — BFS around a topic with a token budget');
	lines.push("- `code_graph path formRender formAnswers` — shortest call path between two functions");
	lines.push("- `code_graph explain formRender` — one node in detail (location, community, neighbors)");
	lines.push("- `code_graph impact stripRecommendedMarker` — reverse call closure before editing");
	lines.push("");
	const text = lines.join("\n");
	fs.mkdirSync(graphDir, { recursive: true });
	fs.writeFileSync(path.join(graphDir, "GRAPH_REPORT.md"), text, "utf8");
	return path.join(graphDir, "GRAPH_REPORT.md");
}
