import type { SubagentProgressEvent, SubagentResult } from "./subagent.ts";

export type RefineOverlayRole = "reviewer" | "criticizer";
export type RefineLaneStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface RefineLaneState {
	id: string;
	label: string;
	status: RefineLaneStatus;
	phase: string;
	detail: string;
}

function shorten(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
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

export function applyRefineProgress(lane: RefineLaneState, event: SubagentProgressEvent): void {
	if (lane.status === "complete" || lane.status === "failed" || lane.status === "cancelled") return;

	switch (event.type) {
		case "process":
			lane.phase = event.phase === "started" ? "starting" : "exiting";
			return;
		case "turn":
			lane.status = "running";
			lane.phase = event.phase === "start" ? "thinking" : "waiting";
			return;
		case "message":
			lane.status = "running";
			lane.phase = event.role === "assistant" ? "responding" : event.role;
			if (event.text) lane.detail = shorten(event.text, 180);
			return;
		case "tool":
			lane.status = "running";
			lane.phase = `tool: ${event.toolName}`;
			if (event.detail) lane.detail = shorten(event.detail, 180);
			return;
		case "stderr":
			lane.phase = "diagnostic";
			if (event.text) lane.detail = shorten(event.text, 180);
			return;
	}
}

export function applyRefineResult(lane: RefineLaneState, result: SubagentResult): void {
	if (result.ok) {
		lane.status = "complete";
		lane.phase = "complete";
		lane.detail = shorten(result.output, 180);
		return;
	}
	if (result.cancelled) {
		lane.status = "cancelled";
		lane.phase = "cancelled";
		lane.detail = shorten(result.errorMessage ?? "Subagent was aborted", 180);
		return;
	}
	lane.status = "failed";
	lane.phase = result.timedOut ? "timed out" : "failed";
	lane.detail = shorten((result.errorMessage ?? result.stderr) || "Subagent failed", 180);
}
