/**
 * Registry of live delegated agents (reviewers, reference analysts, the
 * execution reviewer, execution workers).
 *
 * Every spawn site registers a *group* of lanes here; the fleet list widget
 * and the single-agent overlay (`src/fleet-ui.ts`) render straight from it.
 * The registry owns no sessions — callers keep running their own handles and
 * push progress through the group.
 */

import { applyRefineProgress, applyRefineResult, type RefineLaneState, type RefineOverlayRole } from "./refine-ui-state.ts";
import type { SubagentProgressEvent, SubagentResult } from "./subagent.ts";

export type FleetRole = RefineOverlayRole | "executor";

export interface FleetEntry {
	/** Unique across the fleet: `<groupId>:<laneId>`. */
	id: string;
	laneId: string;
	groupId: string;
	label: string;
	role: FleetRole;
	lane: RefineLaneState;
	modelLabel?: string;
	/** Milliseconds spent working so far; queued and idle time never counts. */
	workedMs: number;
	/** Set while the agent is working: the moment the current stretch began. */
	workingSince?: number;
	finishedAt?: number;
	/** A long-lived worker waiting for its next assignment. */
	idle: boolean;
	/** Short free-form suffix for the list row (for example "2/3 tasks"). */
	note: string;
	toolCalls: number;
	/** Cumulative input and output tokens of the agent's session. */
	inputTokens: number;
	outputTokens: number;
	/** Share of the model's context window in use (0-100); absent until known. */
	contextPercent?: number;
	/** Stops just this agent; absent when the spawner cannot stop one lane. */
	abort?: () => void;
}

export interface FleetGroupSpec {
	groupId: string;
	role: FleetRole;
	modelLabel?: string;
	lanes: Array<{ id: string; label?: string; abort?: () => void }>;
}

type Listener = () => void;

function newLane(id: string, label: string): RefineLaneState {
	return {
		id,
		label,
		status: "queued",
		phase: "queued",
		detail: "",
		transcript: [],
		currentTurnIndex: 0,
		scrollOffset: 0,
		followTranscript: true,
		viewportHeight: 1,
	};
}

function isTerminal(entry: FleetEntry): boolean {
	return entry.lane.status === "complete" || entry.lane.status === "failed" || entry.lane.status === "cancelled";
}

function beginWork(entry: FleetEntry): void {
	if (entry.workingSince === undefined && !entry.idle && !isTerminal(entry)) entry.workingSince = Date.now();
}

function endWork(entry: FleetEntry): void {
	if (entry.workingSince === undefined) return;
	entry.workedMs += Math.max(0, Date.now() - entry.workingSince);
	entry.workingSince = undefined;
}

/** Time the agent has actually been working: excludes the time it sat queued
 * and the stretches a long-lived worker spent idle between assignments. */
export function workedMs(entry: Pick<FleetEntry, "workedMs" | "workingSince">, now: number = Date.now()): number {
	return entry.workedMs + (entry.workingSince === undefined ? 0 : Math.max(0, now - entry.workingSince));
}

/** Handle a spawn site uses to report on its lanes. */
export class FleetGroup {
	readonly groupId: string;
	private readonly fleet: AgentFleet;

	constructor(fleet: AgentFleet, groupId: string) {
		this.fleet = fleet;
		this.groupId = groupId;
	}

	private entry(laneId: string): FleetEntry | undefined {
		return this.fleet.get(`${this.groupId}:${laneId}`);
	}

	update(laneId: string, event: SubagentProgressEvent): void {
		const entry = this.entry(laneId);
		if (!entry || isTerminal(entry)) return;
		// The first event of a queued lane starts its clock; events that arrive
		// while a worker is idle (a late "exited") do not.
		beginWork(entry);
		if (event.type === "transcript" && event.entryType === "tool-call" && event.phase === "start" && event.key.startsWith("tool:")) {
			entry.toolCalls += 1;
		}
		if (event.type === "usage") {
			entry.inputTokens = event.input;
			entry.outputTokens = event.output;
			if (event.contextPercent !== undefined) entry.contextPercent = event.contextPercent;
			this.fleet.notify();
			return;
		}
		applyRefineProgress(entry.lane, event);
		this.fleet.notify();
	}

	complete(laneId: string, result: SubagentResult): void {
		const entry = this.entry(laneId);
		if (!entry) return;
		endWork(entry);
		applyRefineResult(entry.lane, result);
		entry.idle = false;
		entry.finishedAt = Date.now();
		this.fleet.notify();
	}

	setNote(laneId: string, note: string): void {
		const entry = this.entry(laneId);
		if (!entry || entry.note === note) return;
		entry.note = note;
		this.fleet.notify();
	}

	setIdle(laneId: string, idle: boolean): void {
		const entry = this.entry(laneId);
		if (!entry || entry.idle === idle) return;
		entry.idle = idle;
		// Waiting between assignments stops the clock; a new assignment restarts it.
		if (idle) endWork(entry);
		else beginWork(entry);
		this.fleet.notify();
	}

	/** Replace the lane state with engine-held state (reopen paths). */
	seed(laneId: string, lane: RefineLaneState): void {
		const entry = this.entry(laneId);
		if (!entry) return;
		entry.lane = lane;
		this.fleet.notify();
	}

	/** Drop every lane of this group from the list. */
	remove(): void {
		this.fleet.removeGroup(this.groupId);
	}
}

/** How long a finished agent stays in the list before it is dropped. */
export const FINISHED_RETAIN_MS = 10 * 60 * 1000;

export class AgentFleet {
	private readonly entries = new Map<string, FleetEntry>();
	private readonly listeners = new Set<Listener>();
	private readonly retainMs: number;

	constructor(retainMs: number = FINISHED_RETAIN_MS) {
		this.retainMs = retainMs;
	}

	/** Live agents plus recently finished ones; older finished agents are dropped. */
	list(): FleetEntry[] {
		const now = Date.now();
		for (const [id, entry] of [...this.entries]) {
			if (isTerminal(entry) && !entry.idle && entry.finishedAt !== undefined && now - entry.finishedAt > this.retainMs) {
				this.entries.delete(id);
			}
		}
		return [...this.entries.values()];
	}

	get(id: string): FleetEntry | undefined {
		return this.entries.get(id);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				/* a display listener must not break progress reporting */
			}
		}
	}

	/** Register a group of lanes (all start `queued`). Finished lanes of
	 * earlier groups are pruned so the list always reflects the newest work. */
	registerGroup(spec: FleetGroupSpec): FleetGroup {
		for (const [id, entry] of [...this.entries]) {
			if (entry.groupId !== spec.groupId && isTerminal(entry) && !entry.idle) this.entries.delete(id);
		}
		this.removeGroup(spec.groupId, false);
		for (const lane of spec.lanes) {
			const label = lane.label ?? lane.id;
			this.entries.set(`${spec.groupId}:${lane.id}`, {
				id: `${spec.groupId}:${lane.id}`,
				laneId: lane.id,
				groupId: spec.groupId,
				label,
				role: spec.role,
				lane: newLane(lane.id, label),
				modelLabel: spec.modelLabel,
				workedMs: 0,
				idle: false,
				note: "",
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				abort: lane.abort,
			});
		}
		this.notify();
		return new FleetGroup(this, spec.groupId);
	}

	removeGroup(groupId: string, notify = true): void {
		let changed = false;
		for (const [id, entry] of [...this.entries]) {
			if (entry.groupId === groupId) {
				this.entries.delete(id);
				changed = true;
			}
		}
		if (changed && notify) this.notify();
	}

	clear(): void {
		if (this.entries.size === 0) return;
		this.entries.clear();
		this.notify();
	}
}

/** Process-wide fleet shared by refine, analyze_refs, the auditor and the executor. */
export const fleet = new AgentFleet();

/**
 * Run `jobs` with at most `limit` in flight. Lanes not yet started stay
 * `queued` in the fleet, so a long reference list shows as queued bullets
 * instead of per-batch overlays.
 */
export async function runLimited<T>(limit: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
	const results: T[] = new Array(jobs.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < jobs.length) {
			const index = next++;
			results[index] = await jobs[index]!();
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
	return results;
}
