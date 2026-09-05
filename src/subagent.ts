/**
 * Minimal read-only subagent runner: spawns a `pi --mode json -p --no-session`
 * subprocess with a delegated system prompt and restricted tools, mirrors the
 * official subagent example's invocation and JSON event parsing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SubagentTranscriptEntryType = "assistant-text" | "thinking" | "tool-call" | "tool-result";

export type SubagentProgressEvent =
	| { type: "process"; phase: "started" | "exited"; code?: number }
	| { type: "turn"; phase: "start" | "end"; turnIndex?: number }
	| {
			type: "transcript";
			phase: "start" | "update" | "end";
			entryType: SubagentTranscriptEntryType;
			key: string;
			text: string;
			update: "append" | "replace";
			streaming: boolean;
			toolCallId?: string;
			toolName?: string;
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
	content?: unknown;
	model?: string;
}

interface RawSubagentEvent {
	type?: unknown;
	turnIndex?: unknown;
	message?: MessageLike;
	toolCallId?: unknown;
	toolName?: unknown;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: unknown;
	assistantMessageEvent?: unknown;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	if (value && typeof value === "object") {
		const content = (value as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) => {
					if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
						return (part as { text: string }).text;
					}
					return formatValue(part);
				})
				.filter(Boolean)
				.join("\n");
			if (text) return text;
		}
	}
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function messageText(message: MessageLike | undefined, kind: "text" | "thinking" = "text"): string {
	if (!Array.isArray(message?.content)) return typeof message?.content === "string" && kind === "text" ? message.content : "";
	return message.content
		.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === kind)
		.map((part) => {
			const value = part as { text?: unknown; thinking?: unknown };
			return typeof value.text === "string" ? value.text : typeof value.thinking === "string" ? value.thinking : "";
		})
		.join("\n");
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

interface TranscriptEventOptions {
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

function transcriptEvent(
	phase: "start" | "update" | "end",
	entryType: SubagentTranscriptEntryType,
	key: string,
	text: string,
	update: "append" | "replace",
	streaming: boolean,
	options: TranscriptEventOptions = {},
): SubagentProgressEvent {
	return { type: "transcript", phase, entryType, key, text, update, streaming, ...options };
}

function messageContentEvents(message: MessageLike | undefined, phase: "start" | "end"): SubagentProgressEvent[] {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((part, index) => {
		if (!part || typeof part !== "object") return [];
		const value = part as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (value.type === "text" && typeof value.text === "string") {
			return [transcriptEvent(phase, "assistant-text", `content:${index}`, value.text, "replace", phase !== "end")];
		}
		if (value.type === "thinking") {
			const text = typeof value.thinking === "string" ? value.thinking : typeof value.text === "string" ? value.text : "";
			return [transcriptEvent(phase, "thinking", `content:${index}`, text, "replace", phase !== "end")];
		}
		if (value.type === "toolCall") {
			return [transcriptEvent(phase, "tool-call", `content:${index}`, formatValue(value.arguments), "replace", phase !== "end", {
				toolCallId: typeof value.id === "string" ? value.id : undefined,
				toolName: typeof value.name === "string" ? value.name : undefined,
			})];
		}
		return [];
	});
}

function assistantUpdateEvents(event: RawSubagentEvent): SubagentProgressEvent[] {
	const update = event.assistantMessageEvent;
	if (!update || typeof update !== "object") return messageContentEvents(event.message, "end");
	const value = update as {
		type?: unknown;
		contentIndex?: unknown;
		delta?: unknown;
		content?: unknown;
		id?: unknown;
		toolName?: unknown;
		toolCall?: { id?: unknown; name?: unknown; arguments?: unknown };
	};
	const type = typeof value.type === "string" ? value.type : "";
	const index = typeof value.contentIndex === "number" ? value.contentIndex : 0;
	const key = `content:${index}`;
	switch (type) {
		case "text_start":
			return [transcriptEvent("start", "assistant-text", key, "", "replace", true)];
		case "text_delta":
			return [transcriptEvent("update", "assistant-text", key, typeof value.delta === "string" ? value.delta : "", "append", true)];
		case "text_end":
			return [transcriptEvent("end", "assistant-text", key, typeof value.content === "string" ? value.content : "", "replace", false)];
		case "thinking_start":
			return [transcriptEvent("start", "thinking", key, "", "replace", true)];
		case "thinking_delta":
			return [transcriptEvent("update", "thinking", key, typeof value.delta === "string" ? value.delta : "", "append", true)];
		case "thinking_end":
			return [transcriptEvent("end", "thinking", key, typeof value.content === "string" ? value.content : "", "replace", false)];
		case "toolcall_start":
			return [transcriptEvent("start", "tool-call", key, "", "replace", true, {
				toolCallId: typeof value.id === "string" ? value.id : undefined,
				toolName: typeof value.toolName === "string" ? value.toolName : undefined,
			})];
		case "toolcall_delta":
			return [transcriptEvent("update", "tool-call", key, typeof value.delta === "string" ? value.delta : "", "append", true, {
				toolCallId: typeof value.id === "string" ? value.id : undefined,
				toolName: typeof value.toolName === "string" ? value.toolName : undefined,
			})];
		case "toolcall_end":
			return [transcriptEvent("end", "tool-call", key, formatValue(value.toolCall?.arguments), "replace", false, {
				toolCallId: typeof value.toolCall?.id === "string" ? value.toolCall.id : typeof value.id === "string" ? value.id : undefined,
				toolName: typeof value.toolCall?.name === "string" ? value.toolCall.name : typeof value.toolName === "string" ? value.toolName : undefined,
			})];
		default:
			return [];
	}
}

/**
 * Normalize the JSONL events emitted by `pi --mode json` into the small
 * protocol consumed by the refinement overlay. Unknown events are ignored so
 * adding progress support cannot make result parsing version-fragile.
 */
export function normalizeSubagentEvent(value: unknown): SubagentProgressEvent[] {
	if (!value || typeof value !== "object") return [];
	const event = value as RawSubagentEvent;
	if (typeof event.type !== "string") return [];

	if (event.type === "turn_start") {
		return [{ type: "turn", phase: "start", ...(typeof event.turnIndex === "number" ? { turnIndex: event.turnIndex } : {}) }];
	}
	if (event.type === "turn_end") {
		return [{ type: "turn", phase: "end", ...(typeof event.turnIndex === "number" ? { turnIndex: event.turnIndex } : {}) }];
	}

	if (event.type === "message_start") return messageContentEvents(event.message, "start");
	if (event.type === "message_update") return assistantUpdateEvents(event);
	if (event.type === "message_end") return messageContentEvents(event.message, "end");

	if (event.type === "tool_execution_start") {
		return [transcriptEvent("start", "tool-call", `tool:${String(event.toolCallId ?? "unknown")}`, formatValue(event.args), "replace", true, {
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
			toolName: typeof event.toolName === "string" ? event.toolName : undefined,
		})];
	}
	if (event.type === "tool_execution_update") {
		return [transcriptEvent("update", "tool-result", `tool:${String(event.toolCallId ?? "unknown")}`, formatValue(event.partialResult), "replace", true, {
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
			toolName: typeof event.toolName === "string" ? event.toolName : undefined,
		})];
	}
	if (event.type === "tool_execution_end") {
		return [transcriptEvent("end", "tool-result", `tool:${String(event.toolCallId ?? "unknown")}`, formatValue(event.result), "replace", false, {
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
			toolName: typeof event.toolName === "string" ? event.toolName : undefined,
			isError: typeof event.isError === "boolean" ? event.isError : undefined,
		})];
	}

	return [];
}

function emitProgress(options: SubagentOptions, event: SubagentProgressEvent): void {
	try {
		options.onProgress?.(event);
	} catch {
		// A display sink must not be able to fail the child runner.
	}
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

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
				for (const progressEvent of progress) emitProgress(options, progressEvent);
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
