import type { SubagentProgressEvent, SubagentResult } from "./subagent.ts";

export type RefineOverlayRole = "reviewer" | "criticizer";
export type RefineLaneStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export type RefineTranscriptEntryType = "assistant-text" | "thinking" | "tool-call" | "tool-result" | "diagnostic";

export interface RefineTranscriptEntry {
	id: string;
	type: RefineTranscriptEntryType;
	text: string;
	streaming: boolean;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export interface RefineLaneState {
	id: string;
	label: string;
	status: RefineLaneStatus;
	phase: string;
	detail: string;
	transcript: RefineTranscriptEntry[];
	currentTurnIndex: number;
	scrollOffset: number;
	followTranscript: boolean;
	viewportHeight: number;
}

export function statusLabel(status: RefineLaneStatus): string {
	switch (status) {
		case "queued":
			return "queued";
		case "running":
			return "running";
		case "complete":
			return "done";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
	}
}

function transcriptId(lane: RefineLaneState, event: Extract<SubagentProgressEvent, { type: "transcript" }>): string {
	return `${lane.currentTurnIndex}:${event.key}`;
}

function phaseForEntry(event: Extract<SubagentProgressEvent, { type: "transcript" }>): string {
	switch (event.entryType) {
		case "assistant-text":
			return "responding";
		case "thinking":
			return "thinking";
		case "tool-call":
			return event.toolName ? `tool: ${event.toolName}` : "tool call";
		case "tool-result":
			return event.toolName ? `result: ${event.toolName}` : "tool result";
		case "diagnostic":
			return "diagnostic";
	}
}

function applyTranscriptEvent(lane: RefineLaneState, event: Extract<SubagentProgressEvent, { type: "transcript" }>): void {
	const id = transcriptId(lane, event);
	let entry = lane.transcript.find((candidate) => candidate.id === id);
	if (!entry && event.entryType === "tool-call" && event.toolCallId) {
		entry = lane.transcript.find((candidate) => candidate.type === "tool-call" && candidate.toolCallId === event.toolCallId);
	}
	if (!entry) {
		entry = { id, type: event.entryType, text: "", streaming: event.streaming };
		lane.transcript.push(entry);
	}
	if (event.update === "append") entry.text += event.text;
	else entry.text = event.text;
	entry.streaming = event.streaming;
	if (event.toolCallId !== undefined) entry.toolCallId = event.toolCallId;
	if (event.toolName !== undefined) entry.toolName = event.toolName;
	if (event.isError !== undefined) entry.isError = event.isError;
	lane.detail = entry.text;
	lane.status = "running";
	lane.phase = phaseForEntry(event);
}

function applyDiagnostic(lane: RefineLaneState, text: string): void {
	if (!text) return;
	const id = `${lane.currentTurnIndex}:diagnostic`;
	const existing = lane.transcript.find((entry) => entry.id === id);
	if (existing) existing.text += text;
	else lane.transcript.push({ id, type: "diagnostic", text, streaming: true });
	lane.detail = text;
	lane.phase = "diagnostic";
}

export function applyRefineProgress(lane: RefineLaneState, event: SubagentProgressEvent): void {
	if (lane.status === "complete" || lane.status === "failed" || lane.status === "cancelled") return;

	switch (event.type) {
		case "process":
			lane.phase = event.phase === "started" ? "starting" : "exiting";
			return;
		case "turn":
			if (event.phase === "start") {
				lane.status = "running";
				lane.phase = "thinking";
				lane.currentTurnIndex = event.turnIndex ?? lane.currentTurnIndex + 1;
			} else {
				lane.phase = "waiting";
			}
			return;
		case "transcript":
			applyTranscriptEvent(lane, event);
			return;
		case "stderr":
			applyDiagnostic(lane, event.text);
			return;
	}
}

export function applyRefineResult(lane: RefineLaneState, result: SubagentResult): void {
	const finalText = result.output || result.errorMessage || result.stderr || "";
	const finalEntry = [...lane.transcript].reverse().find((entry) => entry.type === "assistant-text");
	if (finalText) {
		if (finalEntry) {
			finalEntry.text = finalText;
			finalEntry.streaming = false;
		} else {
			lane.transcript.push({ id: `${lane.currentTurnIndex}:result`, type: "assistant-text", text: finalText, streaming: false });
		}
	}
	lane.detail = finalText;
	if (result.ok) {
		lane.status = "complete";
		lane.phase = "complete";
		return;
	}
	if (result.cancelled) {
		lane.status = "cancelled";
		lane.phase = "cancelled";
		return;
	}
	lane.status = "failed";
	lane.phase = result.timedOut ? "timed out" : "failed";
}
