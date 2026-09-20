/**
 * Watch mode (plan I-007, R-006, F-004): recursive fs.watch with a 300ms
 * per-file debounce feeding the shared incremental reindex. Lifecycle is
 * pinned to the pi extension hooks — started by /watch-graph (or session_start
 * when the enabled marker is set), stopped by /unwatch-graph, disable-graph,
 * and an idempotent session_shutdown handler. A PID+heartbeat lock under
 * .git/pi_plans/graph/watch keeps a single writer per worktree across pi
 * sessions; per-file single-flight dedupes apply-trigger vs watch events.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isIndexablePath } from "./discovery.ts";
import { reindexRelativePaths, type FreshnessRuntime } from "./freshness.ts";
import { PathError, resolveCanonicalWorktree, type WorktreePaths } from "./paths.ts";
import { loadGraphRuntime } from "./runtime.ts";
import { buildParsersFromRuntime } from "./freshness.ts";
import type { Store } from "./store.ts";
import { Store as StoreClass } from "./store.ts";

export const WATCH_DEBOUNCE_MS = 300;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const LOCK_STALE_MS = 30_000;

const INDEXABLE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;

interface ActiveWatcher {
	stop(): void;
	root: string;
}

const activeWatchers = new Map<string, ActiveWatcher>();

function graphDir(paths: WorktreePaths): string {
	return path.join(paths.gitCommonDir, "pi_plans", "graph");
}

function lockPath(paths: WorktreePaths): string {
	return path.join(graphDir(paths), "watch.lock");
}

function markerPath(paths: WorktreePaths): string {
	return path.join(graphDir(paths), "watch.enabled");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLock(paths: WorktreePaths): { pid: number; heartbeat: number } | null {
	try {
		const raw = JSON.parse(fs.readFileSync(lockPath(paths), "utf8")) as { pid: number; heartbeat: number };
		if (typeof raw.pid === "number" && typeof raw.heartbeat === "number") return raw;
	} catch {
		/* missing or malformed lock = no active watcher */
	}
	return null;
}

function isPending(store: Store, fileDir: string, fileName: string): boolean {
	// Fail CLOSED (impl-review F-F): a read error must not let a watch event
	// fall through to a reindex that could clobber a staged edit.
	try {
		const row = store.read(() =>
			store.db.prepare(`SELECT pending_kind FROM files WHERE file_dir = ? AND file_name = ?`).get(fileDir, fileName),
		) as { pending_kind: string | null } | undefined;
		return row?.pending_kind !== null && row?.pending_kind !== undefined;
	} catch {
		return true;
	}
}

export function watchStatus(paths: WorktreePaths): { active: boolean; pid: number | null; stale: boolean } {
	const lock = readLock(paths);
	if (!lock) return { active: false, pid: null, stale: false };
	const fresh = Date.now() - lock.heartbeat < LOCK_STALE_MS;
	return { active: pidAlive(lock.pid) && fresh, pid: lock.pid, stale: !fresh };
}

/** Open the dedicated watcher runtime (its own Store handle, kept open). */
async function openRuntime(paths: WorktreePaths): Promise<FreshnessRuntime | null> {
	const { runtime } = await loadGraphRuntime();
	fs.mkdirSync(path.dirname(paths.codeGraphDb), { recursive: true });
	const store = new StoreClass(
		{ dbPath: paths.codeGraphDb, worktreeRoot: paths.worktreeRoot, gitCommonDir: paths.gitCommonDir },
		runtime.sqlite,
	);
	const parsers = await buildParsersFromRuntime(runtime);
	return { store, paths, parsers };
}

export interface StartResult {
	started: boolean;
	reason?: string;
}

export async function startGraphWatcher(workdir: string): Promise<StartResult> {
	const paths = resolveCanonicalWorktree(workdir);
	const existing = activeWatchers.get(paths.worktreeRoot);
	if (existing) return { started: true };
	const lock = readLock(paths);
	if (lock && pidAlive(lock.pid) && Date.now() - lock.heartbeat < LOCK_STALE_MS && lock.pid !== process.pid) {
		return { started: false, reason: `another pi session (pid ${lock.pid}) is already watching this worktree` };
	}
	let runtime: FreshnessRuntime | null = null;
	try {
		runtime = await openRuntime(paths);
	} catch {
		return { started: false, reason: "code-graph runtime unavailable" };
	}
	if (!runtime) return { started: false, reason: "code-graph runtime unavailable" };

	fs.mkdirSync(graphDir(paths), { recursive: true });
	// O_EXCL-style claim: a concurrent session that already holds a live lock
	// makes this create fail and loses cleanly (impl-review F-F TOCTOU). A
	// stale lock (dead pid / expired heartbeat) is removed first.
	const preLock = readLock(paths);
	if (preLock && (!pidAlive(preLock.pid) || Date.now() - preLock.heartbeat >= LOCK_STALE_MS)) {
		try {
			fs.unlinkSync(lockPath(paths));
		} catch {
			/* ignore */
		}
	}
	try {
		fs.writeFileSync(lockPath(paths), JSON.stringify({ pid: process.pid, heartbeat: Date.now() }), { flag: "wx" });
	} catch {
		runtime.store.close();
		const lock = readLock(paths);
		return { started: false, reason: `another session claimed the watch lock (pid ${lock?.pid ?? "?"})` };
	}
	fs.writeFileSync(markerPath(paths), new Date().toISOString(), "utf8");

	let closed = false;
	let failureCount = 0;
	const MAX_EVENT_FAILURES = 10;
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let watcher: ReturnType<typeof fs.watch> | null = null;
	let stopFn: () => void = () => {};
	try {
		watcher = fs.watch(paths.worktreeRoot, { recursive: true }, (_event, filename) => {
			if (closed || typeof filename !== "string") return;
			const rel = filename.split(path.sep).join("/");
			if (!INDEXABLE_RE.test(rel) || !isIndexablePath(rel)) return;
			const dir = rel.slice(0, rel.lastIndexOf("/")) || ".";
			const name = rel.slice(rel.lastIndexOf("/") + 1);
			if (isPending(runtime.store, dir, name)) return; // F-001 tie-in
			const existingTimer = timers.get(rel);
			if (existingTimer) clearTimeout(existingTimer);
			timers.set(
				rel,
				setTimeout(() => {
					timers.delete(rel);
					void reindexRelativePaths(runtime, [rel])
						.then(() => {
							failureCount = 0;
							try {
								fs.writeFileSync(lockPath(paths), JSON.stringify({ pid: process.pid, heartbeat: Date.now() }), "utf8");
							} catch {
								/* heartbeat refresh is best-effort */
							}
						})
						.catch(() => {
							// Retry-cap with a user-visible hint (plan R-006):
							// after repeated failures, stop and defer to
							// /update-graph instead of spinning silently.
							failureCount++;
							if (failureCount >= MAX_EVENT_FAILURES) {
								try {
									fs.writeFileSync(
										path.join(graphDir(paths), "watch.failed"),
										`watcher stopped after ${failureCount} reindex failures at ${new Date().toISOString()}; run /update-graph`,
										"utf8",
									);
								} catch {
									/* best-effort */
								}
								stopFn();
							}
						});
				}, WATCH_DEBOUNCE_MS),
			);
		});
	} catch {
		runtime.store.close();
		try {
			fs.unlinkSync(lockPath(paths));
			fs.unlinkSync(markerPath(paths));
		} catch {
			/* ignore */
		}
		return { started: false, reason: "fs.watch recursive unavailable on this platform; use /update-graph instead" };
	}
	// An fs.watch 'error' event (watched tree deleted, EMFILE, permissions)
	// must never crash the host process: stop cleanly and surface a hint.
	watcher?.on?.("error", () => {
		try {
			fs.writeFileSync(
				path.join(graphDir(paths), "watch.failed"),
				`watcher stopped by fs.watch error at ${new Date().toISOString()}; run /update-graph or /watch-graph again`,
				"utf8",
			);
		} catch {
			/* best-effort */
		}
		stopFn();
	});

	const heartbeat = setInterval(() => {
		if (closed) return;
		try {
			fs.writeFileSync(lockPath(paths), JSON.stringify({ pid: process.pid, heartbeat: Date.now() }), "utf8");
		} catch {
			/* best-effort */
		}
	}, HEARTBEAT_INTERVAL_MS);

	const stop = (): void => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		try {
			watcher?.close();
		} catch {
			/* ignore */
		}
		runtime.store.close();
		// Only remove a lock we still own: a successor session that took over
		// after our heartbeat went stale must not lose its lock (impl-review F-F).
		const lock = readLock(paths);
		if (!lock || lock.pid === process.pid) {
			try {
				fs.unlinkSync(lockPath(paths));
			} catch {
				/* already gone */
			}
		}
		activeWatchers.delete(paths.worktreeRoot);
	};
	stopFn = stop;
	activeWatchers.set(paths.worktreeRoot, { stop, root: paths.worktreeRoot });
	return { started: true };
}

export function stopGraphWatcher(workdir: string): void {
	const paths = tryResolveLifecyclePaths(workdir);
	if (!paths) return;
	const watcher = activeWatchers.get(paths.worktreeRoot);
	if (watcher) {
		watcher.stop();
		return;
	}
	// Not ours (or this process restarted): clear an orphan/stale lock only.
	const lock = readLock(paths);
	if (lock && (!pidAlive(lock.pid) || Date.now() - lock.heartbeat >= LOCK_STALE_MS || lock.pid === process.pid)) {
		try {
			fs.unlinkSync(lockPath(paths));
		} catch {
			/* ignore */
		}
	}
}

/**
 * Lifecycle paths for non-session_start callers: the graph can only live
 * inside a git worktree, so a non-git workdir is a normal no-op (silent
 * degradation) rather than an error. Other errors still propagate.
 */
function tryResolveLifecyclePaths(workdir: string): WorktreePaths | null {
	try {
		return resolveCanonicalWorktree(workdir);
	} catch (error) {
		if (error instanceof PathError) return null;
		throw error;
	}
}

/** session_start re-establishment: marker present → best-effort restart. */
export async function restartWatcherIfEnabled(workdir: string): Promise<void> {
	const paths = tryResolveLifecyclePaths(workdir);
	if (!paths) return;
	try {
		if (!fs.existsSync(markerPath(paths))) return;
	} catch {
		return;
	}
	await startGraphWatcher(workdir).catch(() => ({ started: false }));
}

/** disable-graph: stop watching and forget the marker. */
export function disableWatcher(workdir: string): void {
	const paths = tryResolveLifecyclePaths(workdir);
	if (!paths) return;
	stopGraphWatcher(workdir);
	try {
		fs.unlinkSync(markerPath(paths));
	} catch {
		/* ignore */
	}
}

/** Test seam: number of live watchers in this process. */
export function liveWatcherCount(): number {
	return activeWatchers.size;
}
