import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Messaging surface for pi-plans: the subset of ExtensionAPI that tools,
 * commands, and event handlers need for session writes (appendEntry /
 * sendMessage / sendUserMessage).
 *
 * SDK facts (agent-session.js / extensions/types.d.ts, pi 0.99.0):
 * - These methods exist ONLY on the ExtensionAPI ("pi") handed to the
 *   extension factory. The per-call ExtensionContext does NOT carry them.
 * - Session replacement (newSession/fork/switchSession) disposes the old
 *   session and constructs a new one whose extension runner RE-RUNS every
 *   extension factory; reload() does the same. Therefore the correct
 *   staleness-safe pattern is to refresh this module-level reference at the
 *   TOP of the factory on every run — never hold a ctx/pi captured anywhere
 *   else across turns.
 *
 * Invariant (verified for pi 0.99.x hosts): ONE live session per process.
 * Teardown strictly precedes rebuild (agent-session-runtime teardownCurrent
 * → createRuntime), and pi-plans subagents run as separate processes, so the
 * last factory to run always belongs to the only live session. A future
 * same-process multi-session host sharing the extension cache would break
 * this assumption (last factory wins); that would need per-session keying.
 */
export type Messaging = Pick<ExtensionAPI, "appendEntry" | "sendMessage" | "sendUserMessage">;

let messagingApi: Messaging | null = null;

/** Called at the top of the extension factory on every (re)load and session construction. */
export function setMessagingApi(api: Messaging | null): void {
	messagingApi = api;
}

/** Current-session messaging surface. Throws if used before the extension factory ran. */
export function messaging(): Messaging {
	if (!messagingApi) throw new Error("pi-plans messaging used before extension initialization");
	return messagingApi;
}

/** Best-effort variant for optional writes (e.g. auto-complete state entries):
 * returns null when the factory has not run; callers swallow transient errors. */
export function tryMessaging(): Messaging | null {
	return messagingApi;
}
