/**
 * Shared glue between the spawn sites (refine, analyze_refs, the execution
 * reviewer, the delegated executor) and the fleet: registers a group of
 * lanes, hands each lane its own abort signal, and attaches the list UI in
 * TUI sessions.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fleet, type FleetGroup, type FleetRole } from "./agent-fleet.ts";
import { fleetUi, fleetUiHost } from "./fleet-ui.ts";
import type { UiLanguage } from "./ui-language.ts";
import type { SubagentResult } from "./subagent.ts";

export interface FleetRun {
	group: FleetGroup;
	/** Aborts when the parent aborts or this lane is stopped from the overlay. */
	signalFor(laneId: string): AbortSignal;
	/** Detach from the parent signal and settle any lane that never reported. */
	close(): void;
}

export interface OpenFleetGroupSpec {
	role: FleetRole;
	groupId: string;
	lanes: Array<{ id: string; label?: string }>;
	modelLabel?: string;
	lang?: UiLanguage;
	signal?: AbortSignal;
	/** Re-dispatches global shortcuts that an open overlay would swallow. */
	onUnhandledKey?: (data: string) => void;
}

export function openFleetGroup(ctx: ExtensionContext | ExtensionCommandContext, spec: OpenFleetGroupSpec): FleetRun {
	const controllers = new Map<string, AbortController>();
	for (const lane of spec.lanes) controllers.set(lane.id, new AbortController());
	const abortAll = () => {
		for (const controller of controllers.values()) controller.abort();
	};
	if (spec.signal?.aborted) abortAll();
	else spec.signal?.addEventListener("abort", abortAll, { once: true });

	const group = fleet.registerGroup({
		groupId: spec.groupId,
		role: spec.role,
		modelLabel: spec.modelLabel,
		lanes: spec.lanes.map((lane) => ({ id: lane.id, label: lane.label, abort: () => controllers.get(lane.id)?.abort() })),
	});
	fleetUi.attach(fleetUiHost(ctx), { lang: spec.lang, onUnhandledKey: spec.onUnhandledKey });

	return {
		group,
		signalFor: (laneId) => controllers.get(laneId)!.signal,
		close() {
			spec.signal?.removeEventListener("abort", abortAll);
			for (const lane of spec.lanes) {
				const entry = fleet.get(`${spec.groupId}:${lane.id}`);
				if (!entry) continue;
				const status = entry.lane.status;
				if (status === "complete" || status === "failed" || status === "cancelled") continue;
				const result: SubagentResult = { ok: false, output: "", stderr: "", turns: 0, cancelled: true, errorMessage: "lane ended without a result" };
				group.complete(lane.id, result);
			}
		},
	};
}
