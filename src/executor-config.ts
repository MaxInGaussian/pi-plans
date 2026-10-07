/**
 * Where a plan executes: the current session (same model), or one or more
 * delegated worker sessions on a model/effort the user picks at handoff.
 *
 * The choice is stored per run in the execution checkpoint (so a resumed run
 * reuses it without asking again) and remembered globally as a non-binding
 * default for the next handoff's picker.
 */

/** Upper bound for parallel delegated workers. */
export const MAX_EXECUTOR_WORKERS = 4;

export type ExecutorMode = "current-session" | "delegated";

export interface ExecutorChoice {
	mode: ExecutorMode;
	/** Number of delegated worker sessions (1 for current-session). */
	workers: number;
	/** Exact `provider/model` selector; null for current-session. */
	model_selector: string | null;
	/** Thinking level; null = the model's default chain. Null for current-session. */
	thinking_level: string | null;
}

export const CURRENT_SESSION_EXECUTOR: ExecutorChoice = {
	mode: "current-session",
	workers: 1,
	model_selector: null,
	thinking_level: null,
};

export function isDelegated(choice: ExecutorChoice | null | undefined): choice is ExecutorChoice {
	return choice?.mode === "delegated";
}

/**
 * Validate an untrusted value. Returns the normalized choice, or `{ error }`
 * naming the first problem. Strict: unknown keys and out-of-range values are
 * errors, never silently repaired.
 */
export function parseExecutorChoice(raw: unknown, validLevels: ReadonlySet<string>): ExecutorChoice | { error: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "executor must be an object" };
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!["mode", "workers", "model_selector", "thinking_level"].includes(key)) return { error: `unexpected key "${key}"` };
	}
	if (record.mode !== "current-session" && record.mode !== "delegated") return { error: "mode must be current-session or delegated" };
	const workers = record.workers ?? 1;
	if (typeof workers !== "number" || !Number.isInteger(workers) || workers < 1 || workers > MAX_EXECUTOR_WORKERS) {
		return { error: `workers must be an integer from 1 to ${MAX_EXECUTOR_WORKERS}` };
	}
	const selector = record.model_selector ?? null;
	const level = record.thinking_level ?? null;
	if (record.mode === "current-session") {
		if (workers !== 1 || selector !== null || level !== null) return { error: "current-session carries no workers, model or level" };
		return { ...CURRENT_SESSION_EXECUTOR };
	}
	if (typeof selector !== "string" || !/^[^/\s]+\/\S+$/.test(selector)) return { error: "delegated needs a provider/model selector" };
	if (level !== null && (typeof level !== "string" || !validLevels.has(level))) return { error: "invalid thinking_level" };
	return { mode: "delegated", workers, model_selector: selector, thinking_level: level };
}

/** Short human label, e.g. "2 workers · provider/model:high" or "current session". */
export function executorLabel(choice: ExecutorChoice | null | undefined): string {
	if (!isDelegated(choice)) return "current session";
	const model = choice.model_selector ?? "?";
	const withLevel = choice.thinking_level ? `${model}:${choice.thinking_level}` : model;
	return `${choice.workers} ${choice.workers === 1 ? "worker" : "workers"} · ${withLevel}`;
}
