/**
 * Minimal read-only subagent runner: spawns a `pi --mode json -p --no-session`
 * subprocess with a delegated system prompt and restricted tools, mirrors the
 * official subagent example's invocation and JSON event parsing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SubagentProgressEvent =
	| { type: "process"; phase: "started" | "exited"; code?: number }
	| { type: "turn"; phase: "start" | "end" }
	| { type: "message"; phase: "start" | "update" | "end"; role: string; text: string }
	| {
			type: "tool";
			phase: "start" | "update" | "end";
			toolCallId: string;
			toolName: string;
			detail: string;
			isError?: boolean;
	  }
	| { type: "stderr"; text: string };

export interface SubagentOptions {
	systemPrompt: string;
	task: string;
	cwd: string;
	/** Exact "provider/model" selector; omit to inherit the dispatching session's model. */
	model?: string;
	/** Tool allowlist for the child process. Defaults to read-only tools. */
	tools?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Optional normalized progress sink. Exceptions from the sink are ignored. */
	onProgress?: (event: SubagentProgressEvent) => void;
}

export interface SubagentResult {
	ok: boolean;
	output: string;
	model?: string;
	errorMessage?: string;
	stderr: string;
	turns: number;
	cancelled?: boolean;
	timedOut?: boolean;
}

/** Strip YAML frontmatter from an agent definition file. */
export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---\n", 3);
	if (end < 0) return text;
	return text.slice(end + 5).trimStart();
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface MessageLike {
	role: string;
	content?: Array<{ type: string; text?: string; thinking?: string }> | string;
	model?: string;
}

interface RawSubagentEvent {
	type?: unknown;
	message?: MessageLike;
	toolCallId?: unknown;
	toolName?: unknown;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: unknown;
	assistantMessageEvent?: unknown;
}

function finalOutput(messages: MessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			const text = messageText(message, "text").trim();
			if (text) return text;
		}
	}
	return "";
}

function messageText(message: MessageLike | undefined, kind: "text" | "thinking" = "text"): string {
	if (!message?.content) return "";
	if (typeof message.content === "string") return kind === "text" ? message.content : "";
	return message.content
		.filter((part) => part.type === kind)
		.map((part) => (kind === "thinking" ? part.thinking ?? part.text ?? "" : part.text ?? ""))
		.join("\n");
}

function messageEventText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const event = value as { delta?: unknown; content?: unknown };
	return typeof event.delta === "string" ? event.delta : typeof event.content === "string" ? event.content : "";
}

function preview(value: unknown, maxLength = 240): string {
	if (typeof value === "string") return value.slice(0, maxLength);
	if (value === undefined) return "";
	try {
		const text = JSON.stringify(value);
		return text ? text.slice(0, maxLength) : "";
	} catch {
		return String(value).slice(0, maxLength);
	}
}

/**
 * Normalize the JSONL events emitted by `pi --mode json` into the small
 * protocol consumed by the refinement overlay. Unknown events are ignored so
 * adding progress support cannot make result parsing version-fragile.
 */
export function normalizeSubagentEvent(value: unknown): SubagentProgressEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as RawSubagentEvent;
	if (typeof event.type !== "string") return undefined;

	if (event.type === "turn_start") return { type: "turn", phase: "start" };
	if (event.type === "turn_end") return { type: "turn", phase: "end" };

	if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
		if (!event.message && !event.assistantMessageEvent) return undefined;
		const role = event.message?.role ?? "assistant";
		return {
			type: "message",
			phase: event.type.slice("message_".length) as "start" | "update" | "end",
			role,
			text: messageText(event.message) || messageEventText(event.assistantMessageEvent),
		};
	}

	const toolEvent =
		event.type === "tool_execution_start"
			? "start"
			: event.type === "tool_execution_update"
				? "update"
				: event.type === "tool_execution_end" || event.type === "tool_result_end"
					? "end"
					: null;
	if (toolEvent) {
		return {
			type: "tool",
			phase: toolEvent,
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "unknown",
			toolName: typeof event.toolName === "string" ? event.toolName : "tool",
			detail: preview(event.args ?? event.partialResult ?? event.result),
			...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
		};
	}

	return undefined;
}

function emitProgress(options: SubagentOptions, event: SubagentProgressEvent): void {
	try {
		options.onProgress?.(event);
	} catch {
		// A display sink must not be able to fail the child runner.
	}
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function runPiSubagent(options: SubagentOptions): Promise<SubagentResult> {
	const tools = options.tools ?? ["read", "grep", "find", "ls"];
	let tmpDir = "";
	const messages: MessageLike[] = [];
	let stderr = "";
	let termination: "abort" | "timeout" | null = null;

	try {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-subagent-"));
		const promptFile = path.join(tmpDir, "system-prompt.md");
		fs.writeFileSync(promptFile, options.systemPrompt, { encoding: "utf8", mode: 0o600 });

		const args: string[] = ["--mode", "json", "-p", "--no-session", "--tools", tools.join(",")];
		if (options.model) args.push("--model", options.model);
		args.push("--append-system-prompt", promptFile);
		args.push(`Task: ${options.task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let closed = false;
			let settled = false;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

			const onAbort = () => {
				if (termination === null) termination = "abort";
				killProc();
			};

			const cleanup = () => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				options.signal?.removeEventListener("abort", onAbort);
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				closed = true;
				cleanup();
				emitProgress(options, { type: "process", phase: "exited", code });
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: RawSubagentEvent;
				try {
					event = JSON.parse(line) as RawSubagentEvent;
				} catch {
					return;
				}
				const progress = normalizeSubagentEvent(event);
				if (progress) emitProgress(options, progress);
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					messages.push(event.message);
				}
			};

			const killProc = () => {
				if (settled || termination === null) return;
				if (!proc.killed) proc.kill("SIGTERM");
				if (!forceKillTimer) {
					forceKillTimer = setTimeout(() => {
						try {
							if (!closed) proc.kill("SIGKILL");
						} catch {
							// The process already exited.
						}
					}, 5000);
				}
			};

			emitProgress(options, { type: "process", phase: "started" });
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				const text = data.toString();
				stderr += text;
				emitProgress(options, { type: "stderr", text });
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			});
			proc.on("error", (error) => {
				stderr += error instanceof Error ? error.message : String(error);
				finish(1);
			});

			timeoutTimer = setTimeout(() => {
				if (termination === null) termination = "timeout";
				killProc();
			}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			if (options.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		const turns = messages.filter((message) => message.role === "assistant").length;
		const output = finalOutput(messages);
		if (termination === "abort") {
			return { ok: false, output, stderr, turns, cancelled: true, errorMessage: "Subagent was aborted" };
		}
		if (termination === "timeout") {
			return { ok: false, output, stderr, turns, timedOut: true, errorMessage: "Subagent timed out" };
		}
		if (exitCode !== 0) {
			return { ok: false, output, stderr, turns, errorMessage: `pi exited with code ${exitCode}` };
		}
		if (!output) {
			return { ok: false, output: "", stderr, turns, errorMessage: "subagent produced no final output" };
		}
		return {
			ok: true,
			output,
			model: [...messages].reverse().find((message) => message.role === "assistant" && message.model)?.model,
			stderr,
			turns,
		};
	} finally {
		if (tmpDir) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
}
