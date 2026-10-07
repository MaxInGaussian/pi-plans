/**
 * In-process delegated agent sessions.
 *
 * Reviewers, reference analysts and execution workers all run as SDK agent
 * sessions inside the host process instead of `pi` child processes. That keeps
 * a session addressable after it starts: it can be steered, re-prompted with
 * the next batch of work, and given tools that close over live extension state
 * (the delegated executor reports task progress through such a tool).
 *
 * Two entry points:
 *  - `runAgentSession` — one-shot: start, run one prompt, dispose.
 *  - `startAgentSession` — returns a handle whose `run()` can be called again
 *    on the same live session; the caller disposes it.
 */

import {
	finalOutput,
	messageText,
	normalizeSubagentEvent,
	type MessageLike,
	type SubagentOptions,
	type SubagentProgressEvent,
	type SubagentResult,
	type SubagentUsage,
} from "./subagent.ts";

/** The slice of ExtensionContext a session needs to resolve its model. */
export interface AgentHost {
	modelRegistry?: unknown;
	/** The dispatching session's model — used when no selector is given. */
	model?: unknown;
}

/** Narrow an extension context to the fields a session needs. */
export function agentHostOf(ctx: { modelRegistry?: unknown; model?: unknown }): AgentHost {
	return { modelRegistry: ctx.modelRegistry, model: ctx.model };
}

export interface AgentRunOptions extends SubagentOptions {
	host?: AgentHost;
	/** Extra tools (SDK ToolDefinition shape) registered on the session. */
	customTools?: unknown[];
	/** Called once the session exists, before the first prompt. */
	onSession?: (handle: AgentHandle) => void;
}

export interface AgentHandle {
	/** Run one agent loop to completion on this live session. */
	run(text: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SubagentResult>;
	/** Interrupt the running loop after the current tool call; queued for the
	 * next run when the session is idle. */
	steer(text: string): void;
	abort(): Promise<void>;
	/** Messages of the underlying session (live array). */
	messages(): MessageLike[];
	isRunning(): boolean;
	dispose(): void;
}

/** Minimal session surface the engine depends on (also what test fakes provide). */
export interface SessionLike {
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string, options?: unknown): Promise<void>;
	steer(text: string): Promise<void> | void;
	abort(): Promise<void> | void;
	dispose(): void;
	readonly messages: unknown[];
	readonly isStreaming?: boolean;
}

type SessionFactory = (options: Record<string, unknown>) => Promise<{ session: SessionLike }>;

let testFactory: SessionFactory | null = null;

/** Test seam: replace the SDK `createAgentSession` with a fake. */
export function __setSessionFactoryForTests(factory: SessionFactory | null): void {
	testFactory = factory;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

interface RegistryLike {
	find?: (provider: string, modelId: string) => unknown;
	runtime?: unknown;
}

/** Split an exact "provider/model" selector; model ids may contain slashes. */
export function splitSelector(selector: string): { provider: string; id: string } | null {
	const index = selector.indexOf("/");
	if (index <= 0 || index === selector.length - 1) return null;
	return { provider: selector.slice(0, index), id: selector.slice(index + 1) };
}

function resolveModel(options: AgentRunOptions): { model: unknown } | { error: string } {
	if (!options.model) return { model: options.host?.model };
	const parts = splitSelector(options.model);
	const registry = options.host?.modelRegistry as RegistryLike | undefined;
	if (!parts) return { error: `invalid model selector "${options.model}" (expected provider/model)` };
	if (typeof registry?.find !== "function") return { error: `cannot resolve model "${options.model}": no model registry available` };
	const model = registry.find(parts.provider, parts.id);
	if (!model) return { error: `model "${options.model}" is not available` };
	return { model };
}

function usageOf(message: MessageLike | undefined): SubagentUsage | null {
	const usage = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
	if (!usage || typeof usage !== "object") return null;
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const cost = usage.cost as { total?: unknown } | undefined;
	return {
		input: num(usage.input),
		output: num(usage.output),
		cacheRead: num(usage.cacheRead),
		cacheWrite: num(usage.cacheWrite),
		cost: num(cost?.total),
	};
}

async function defaultFactory(options: Record<string, unknown>): Promise<{ session: SessionLike }> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const cwd = String(options.cwd);
	const agentDir = sdk.getAgentDir();
	const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: [String(options.systemPrompt)],
	});
	await resourceLoader.reload();
	const { systemPrompt: _systemPrompt, ...rest } = options;
	const created = await sdk.createAgentSession({
		...(rest as Record<string, unknown>),
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(cwd),
	} as never);
	return { session: created.session as unknown as SessionLike };
}

function emit(options: Pick<AgentRunOptions, "onProgress">, event: SubagentProgressEvent): void {
	try {
		options.onProgress?.(event);
	} catch {
		// A display sink must not be able to fail the session runner.
	}
}

function failedResult(message: string, extra: Partial<SubagentResult> = {}): SubagentResult {
	return { ok: false, output: "", stderr: "", turns: 0, errorMessage: message, ...extra };
}

/** Whether the session's last assistant turn ended in an error (pi resolves
 * `prompt()` for these instead of rejecting). */
function finalTurnError(messages: MessageLike[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as MessageLike & { stopReason?: unknown; errorMessage?: unknown };
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			return typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "model turn failed";
		}
		if (message.stopReason === "length" && !messageText(message, "text").trim()) return "model output was cut off before any text";
		return null;
	}
	return null;
}

/** Create a live session and return its handle. Never throws: a setup failure
 * is returned as `{ error }` so callers can fold it into a failed lane. */
export async function startAgentSession(options: AgentRunOptions): Promise<{ handle: AgentHandle } | { error: string }> {
	const resolved = resolveModel(options);
	if ("error" in resolved) return { error: resolved.error };

	const tools = options.tools ?? READ_ONLY_TOOLS;
	const sessionOptions: Record<string, unknown> = {
		cwd: options.cwd,
		systemPrompt: options.systemPrompt,
		tools,
		...(options.customTools?.length ? { customTools: options.customTools } : {}),
		...(resolved.model ? { model: resolved.model } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	};
	const registry = options.host?.modelRegistry as RegistryLike | undefined;
	const runtime = registry?.runtime as { getModel?: unknown } | undefined;
	if (runtime && typeof runtime.getModel === "function") sessionOptions.modelRuntime = runtime;

	let session: SessionLike;
	try {
		session = (await (testFactory ?? defaultFactory)(sessionOptions)).session;
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	let running = false;
	let disposed = false;
	let pendingSteers: string[] = [];
	let currentRunStart = 0;
	let turns = 0;
	let usage: SubagentUsage | undefined;

	const addUsage = (message: MessageLike | undefined): void => {
		const next = usageOf(message);
		if (!next) return;
		usage = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		usage.input += next.input;
		usage.output += next.output;
		usage.cacheRead += next.cacheRead;
		usage.cacheWrite += next.cacheWrite;
		usage.cost += next.cost;
	};

	const unsubscribe = session.subscribe((event) => {
		for (const progress of normalizeSubagentEvent(event)) emit(options, progress);
		const typed = event as { type?: string; message?: MessageLike };
		if (typed.type === "message_end" && typed.message?.role === "assistant") {
			turns += 1;
			addUsage(typed.message);
		}
	});

	const messages = (): MessageLike[] => session.messages as MessageLike[];

	const handle: AgentHandle = {
		isRunning: () => running,
		messages,
		steer(text: string) {
			if (disposed) return;
			if (running) void Promise.resolve(session.steer(text)).catch(() => undefined);
			else pendingSteers.push(text);
		},
		async abort() {
			if (disposed) return;
			await Promise.resolve(session.abort()).catch(() => undefined);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			try {
				session.dispose();
			} catch {
				/* already torn down */
			}
		},
		async run(text, runOptions = {}) {
			if (disposed) return failedResult("agent session was disposed");
			if (running) return failedResult("agent session is already running");
			running = true;
			const signal = runOptions.signal ?? options.signal;
			let termination: "abort" | "timeout" | null = null;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				if (termination === null) termination = "abort";
				void handle.abort();
			};
			const queued = pendingSteers;
			pendingSteers = [];
			const prompt = queued.length ? `${queued.join("\n\n")}\n\n${text}` : text;
			currentRunStart = messages().length;
			const turnsBefore = turns;
			emit(options, { type: "process", phase: "started" });
			try {
				timer = setTimeout(() => {
					if (termination === null) termination = "timeout";
					void handle.abort();
				}, runOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				if (termination === null) await session.prompt(prompt);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (termination === null) {
					emit(options, { type: "process", phase: "exited", code: 1 });
					return failedResult(message, { turns: turns - turnsBefore, usage });
				}
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				running = false;
			}
			const runMessages = messages().slice(currentRunStart);
			const output = finalOutput(runMessages);
			const runTurns = turns - turnsBefore;
			emit(options, { type: "process", phase: "exited", code: termination === null ? 0 : 1 });
			if (termination === "abort") {
				return failedResult("Subagent was aborted", { output, turns: runTurns, usage, cancelled: true });
			}
			if (termination === "timeout") {
				return failedResult("Subagent timed out", { output, turns: runTurns, usage, timedOut: true });
			}
			const turnError = finalTurnError(runMessages);
			if (turnError) return failedResult(turnError, { output, turns: runTurns, usage });
			if (!output) return failedResult("subagent produced no final output", { turns: runTurns, usage });
			const model = [...runMessages].reverse().find((message) => message.role === "assistant" && message.model)?.model;
			return { ok: true, output, model, stderr: "", turns: runTurns, usage };
		},
	};

	options.onSession?.(handle);
	return { handle };
}

/** One-shot run: start a session, run `options.task`, dispose. */
export async function runAgentSession(options: AgentRunOptions): Promise<SubagentResult> {
	const started = await startAgentSession(options);
	if ("error" in started) return failedResult(started.error);
	try {
		return await started.handle.run(`Task: ${options.task}`);
	} finally {
		started.handle.dispose();
	}
}
