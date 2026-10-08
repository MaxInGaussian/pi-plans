/**
 * Shared types and event normalization for delegated agent sessions
 * (reviewers, reference analysts, execution workers). The in-process runner
 * lives in `src/agent-session.ts`; this module only holds the protocol the
 * UI reducers consume.
 */

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
	| { type: "stderr"; text: string }
	/** Cumulative token usage of the session so far (display only). */
	| { type: "usage"; input: number; output: number; contextPercent?: number };

export interface SubagentOptions {
	systemPrompt: string;
	task: string;
	cwd: string;
	/** Exact "provider/model" selector; omit to inherit the dispatching session's model. */
	model?: string;
	/** Explicit thinking level for the session (e.g. "high", "off"). Omit for
	 * the default chain (per-model settings -> defaultThinkingLevel -> medium);
	 * "default" as a value is NOT valid here — resolve null via
	 * src/thinking-levels.ts before calling. */
	thinkingLevel?: string;
	/** Tool allowlist for the session. Defaults to read-only tools. */
	tools?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Optional normalized progress sink. Exceptions from the sink are ignored. */
	onProgress?: (event: SubagentProgressEvent) => void;
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SubagentResult {
	ok: boolean;
	output: string;
	model?: string;
	errorMessage?: string;
	stderr: string;
	turns: number;
	usage?: SubagentUsage;
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

export interface MessageLike {
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

export function messageText(message: MessageLike | undefined, kind: "text" | "thinking" = "text"): string {
	if (!Array.isArray(message?.content)) return typeof message?.content === "string" && kind === "text" ? message.content : "";
	return message.content
		.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === kind)
		.map((part) => {
			const value = part as { text?: unknown; thinking?: unknown };
			return typeof value.text === "string" ? value.text : typeof value.thinking === "string" ? value.thinking : "";
		})
		.join("\n");
}

export function finalOutput(messages: MessageLike[]): string {
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
