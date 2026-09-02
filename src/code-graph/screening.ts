/**
 * Read-only screening queries that exclude full_code from the response.
 * Used by the agent-facing tool and `/graph-status`.
 */

import { Store } from "./store.ts";
import type { FunctionScreening, Language } from "./types.ts";

export interface ScreeningOptions {
	store: Store;
	language?: Language;
	functionNameLike?: string;
	limit?: number;
}

export function screeningQuery(opts: ScreeningOptions): FunctionScreening[] {
	const conditions: string[] = [];
	const params: Array<string | number> = [];
	if (opts.language) {
		conditions.push("f.language = ?");
		params.push(opts.language);
	}
	if (opts.functionNameLike) {
		conditions.push("f.function_name LIKE ?");
		params.push(`%${opts.functionNameLike}%`);
	}
	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
	const rows = opts.store
		.read(() =>
			opts.store.db
				.prepare(
					`SELECT
						f.file_dir AS file_dir,
						f.file_name AS file_name,
						f.function_name AS function_name,
						f.language AS language,
						f.kind AS kind,
						f.summary_description AS description,
						f.summary_inputs AS inputs_json,
						f.summary_outputs AS outputs_json,
						f.summary_status AS summary_status,
						f.version AS version,
						(SELECT json_group_array(json_object('file_dir', e.from_file_dir, 'file_name', e.from_file_name, 'function_name', e.from_function))
							FROM call_edges e WHERE e.to_file_dir = f.file_dir AND e.to_file_name = f.file_name AND e.to_function = f.function_name AND e.resolution = 'resolved') AS in_json,
						(SELECT json_group_array(json_object('file_dir', e.to_file_dir, 'file_name', e.to_file_name, 'function_name', e.to_function))
							FROM call_edges e WHERE e.from_file_dir = f.file_dir AND e.from_file_name = f.file_name AND e.from_function = f.function_name AND e.resolution = 'resolved') AS out_json
					FROM functions f
					${where}
					ORDER BY f.file_dir, f.file_name, f.function_name
					LIMIT ${limit}`,
				)
				.all(...params),
		) as Array<{
			file_dir: string;
			file_name: string;
			function_name: string;
			language: Language;
			kind: string;
			description: string | null;
			inputs_json: string | null;
			outputs_json: string | null;
			summary_status: string | null;
			version: number;
			in_json: string | null;
			out_json: string | null;
		}>;
	return rows.map((row) => ({
		fileDir: row.file_dir,
		fileName: row.file_name,
		functionName: row.function_name,
		language: row.language,
		kind: row.kind as FunctionScreening["kind"],
		description: row.description,
		inputs: row.inputs_json ? (JSON.parse(row.inputs_json) as string[]) : null,
		outputs: row.outputs_json ? (JSON.parse(row.outputs_json) as string[]) : null,
		version: row.version,
		summaryStatus: row.summary_status as FunctionScreening["summaryStatus"],
		inLinks: row.in_json ? (JSON.parse(row.in_json) as FunctionScreening["inLinks"]) : [],
		outLinks: row.out_json ? (JSON.parse(row.out_json) as FunctionScreening["outLinks"]) : [],
	}));
}
