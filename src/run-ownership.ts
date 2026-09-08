/**
 * Run activity ownership (I-002).
 *
 * At most one live owner per run. An owner record carries host, pid, the
 * process start time (PID-reuse guard), the Pi session id, a random process
 * token, and a generation counter. Acquisition is atomic (O_EXCL create);
 * takeovers require proof the previous owner is dead — process gone, or the
 * pid alive but with a different start time (reused pid). Unknown hosts,
 * corrupt records, and unverifiable liveness are conservatively refused.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StateError, runDirPath, utcNow } from "./state.ts";

export const OWNER_SCHEMA = 1;

export interface OwnerRecord {
	schema: number;
	host: string;
	pid: number;
	/** `ps -o lstart=` output; null when unresolvable. Mismatch vs a live pid means reuse. */
	pidStart: string | null;
	sessionId: string | null;
	processToken: string;
	generation: number;
	acquiredAt: string;
}

export class OwnershipError extends StateError {}

/** Records this process currently holds: runKey → owner. */
const held = new Map<string, OwnerRecord>();

function runKey(workdir: string, runId: string): string {
	return `${path.resolve(workdir)}::${runId}`;
}

function ownerFilePath(workdir: string, runId: string): string | null {
	const runDir = runDirPath(workdir, runId);
	return runDir === null ? null : path.join(runDir, "owner.json");
}

function validateOwnerRecord(data: unknown, label: string): OwnerRecord {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new OwnershipError(`${label}: expected an object`);
	}
	const record = data as Record<string, unknown>;
	const allowed = new Set(["schema", "host", "pid", "pidStart", "sessionId", "processToken", "generation", "acquiredAt"]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new OwnershipError(`${label}: unexpected key "${key}"`);
	}
	if (record.schema !== OWNER_SCHEMA) {
		throw new OwnershipError(`${label}.schema: unsupported version ${String(record.schema)}`);
	}
	if (typeof record.host !== "string" || record.host === "") throw new OwnershipError(`${label}.host: expected a non-empty string`);
	if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1) {
		throw new OwnershipError(`${label}.pid: expected a positive integer`);
	}
	if (record.pidStart !== null && typeof record.pidStart !== "string") {
		throw new OwnershipError(`${label}.pidStart: expected a string or null`);
	}
	if (typeof record.processToken !== "string" || record.processToken === "") {
		throw new OwnershipError(`${label}.processToken: expected a non-empty string`);
	}
	if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 1) {
		throw new OwnershipError(`${label}.generation: expected a positive integer`);
	}
	if (typeof record.acquiredAt !== "string") throw new OwnershipError(`${label}.acquiredAt: expected a string`);
	return {
		schema: OWNER_SCHEMA,
		host: record.host,
		pid: record.pid,
		pidStart: (record.pidStart as string | null) ?? null,
		sessionId: (record.sessionId as string | null) ?? null,
		processToken: record.processToken,
		generation: record.generation,
		acquiredAt: record.acquiredAt,
	};
}

function readOwnerFile(filePath: string): OwnerRecord {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new OwnershipError(`owner record ${filePath} is corrupt (${(error as Error).message}); repair or remove it explicitly`);
	}
	return validateOwnerRecord(data, "owner record");
}

function writeOwnerFile(filePath: string, record: OwnerRecord): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
	renameSync(tmp, filePath);
}

/** Process start time via `ps -o lstart=`; null when unresolvable. */
export function processStartOf(pid: number): string | null {
	try {
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
		if (result.error || result.status !== 0) return null;
		const start = (result.stdout ?? "").trim();
		return start === "" ? null : start;
	} catch {
		return null;
	}
}

function processAlive(pid: number, pidStart: string | null): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		return true; // EPERM etc.: exists but not ours
	}
	if (pidStart === null) return true; // alive, start unverifiable
	// F-006 (implementation review): a live pid whose CURRENT start time cannot
	// be resolved (ps missing/failing) is conservatively ALIVE — never steal.
	const currentStart = processStartOf(pid);
	if (currentStart === null) return true;
	return currentStart === pidStart; // mismatch = reused pid = dead owner
}

export interface AcquireOptions {
	sessionId?: string | null;
}

/**
 * Acquire (or keep) ownership of a run for this process. Re-acquiring a run
 * this process already holds returns the existing record. A live foreign
 * owner, a foreign host, or a corrupt record is refused.
 */
export function acquireOwnership(workdir: string, runId: string, options: AcquireOptions = {}): OwnerRecord {
	const key = runKey(workdir, runId);
	const alreadyHeld = held.get(key);
	if (alreadyHeld) {
		// Keep the token; refresh nothing — liveness is checked on demand.
		return alreadyHeld;
	}
	const filePath = ownerFilePath(workdir, runId);
	if (filePath === null) throw new OwnershipError(`run does not exist: ${runId}`);
	mkdirSync(path.dirname(filePath), { recursive: true });
	const candidate: OwnerRecord = {
		schema: OWNER_SCHEMA,
		host: os.hostname(),
		pid: process.pid,
		pidStart: processStartOf(process.pid),
		sessionId: options.sessionId ?? null,
		processToken: randomUUID().replace(/-/g, ""),
		generation: 1,
		acquiredAt: utcNow(),
	};
	// Fast path: exclusive create when no owner exists yet.
	try {
		const fd = openSync(filePath, "wx");
		writeFileSync(fd, `${JSON.stringify(candidate, null, "\t")}\n`, "utf8");
		closeSync(fd);
		held.set(key, candidate);
		return candidate;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	// Someone owns it. Same live process re-entering (e.g. extension reload
	// dropped the in-memory map): adopt the existing record when pid+start
	// match, keeping generation continuity.
	const existing = readOwnerFile(filePath);
	if (existing.host === candidate.host && existing.pid === candidate.pid && existing.pidStart === candidate.pidStart) {
		held.set(key, existing);
		return existing;
	}
	if (existing.host !== candidate.host) {
		throw new OwnershipError(
			`run ${runId} is owned by host "${existing.host}"; cross-host liveness cannot be verified — refusing`,
		);
	}
	if (processAlive(existing.pid, existing.pidStart)) {
		throw new OwnershipError(
			`run ${runId} is actively owned by pid ${existing.pid} (generation ${existing.generation}); refusing to steal`,
		);
	}
	// Provably dead previous owner: guarded takeover.
	takeoverWithLock(filePath, workdir, runId, existing, candidate, options);
	const next = readOwnerFile(filePath);
	held.set(key, next);
	return next;
}

function takeoverWithLock(
	filePath: string,
	workdir: string,
	runId: string,
	expected: OwnerRecord,
	candidate: OwnerRecord,
	options: AcquireOptions,
): void {
	const lockPath = `${filePath}.lock`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Stale-lock sweep: a lock whose creator is gone cannot deadlock us.
			try {
				const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
				if (typeof lock.pid === "number" && !processAlive(lock.pid, null)) unlinkSync(lockPath);
			} catch {
				/* unreadable lock: wait and retry */
			}
			const snooze = spawnSync("sleep", ["0.05"], { encoding: "utf8" });
			if (snooze.error) break;
			continue;
		}
		try {
			// Re-validate under the lock: the world may have moved.
			const current = readOwnerFile(filePath);
			if (current.processToken !== expected.processToken) {
				throw new OwnershipError(`run ${runId} changed owners during takeover; retry acquire`);
			}
			if (processAlive(current.pid, current.pidStart)) {
				throw new OwnershipError(`run ${runId} owner pid ${current.pid} is alive again; refusing to steal`);
			}
			const next: OwnerRecord = {
				...candidate,
				sessionId: options.sessionId ?? null,
				generation: current.generation + 1,
			};
			writeOwnerFile(filePath, next);
			writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, takenAt: utcNow() })}\n`, "utf8");
		} finally {
			try {
				unlinkSync(lockPath);
			} catch {
				/* best-effort */
			}
		}
		return;
	}
	throw new OwnershipError(`run ${runId}: could not acquire the takeover lock; another takeover is in flight`);
}

/** Current owner record without acquiring; null when unowned. Corrupt records throw. */
export function ownershipRecord(workdir: string, runId: string): OwnerRecord | null {
	const filePath = ownerFilePath(workdir, runId);
	if (filePath === null || !existsSync(filePath)) return null;
	return readOwnerFile(filePath);
}

/** True when a live owner holds the run right now. */
export function ownershipHeld(workdir: string, runId: string): boolean {
	const record = ownershipRecord(workdir, runId);
	if (record === null) return false;
	return processAlive(record.pid, record.pidStart);
}

/** Fail when this session no longer owns the run (takeover or release happened). */
export function assertOwnership(workdir: string, runId: string, expected: { processToken: string; generation: number }): void {
	const filePath = ownerFilePath(workdir, runId);
	if (filePath === null || !existsSync(filePath)) {
		throw new OwnershipError(`run ${runId} has no owner record; ownership was released`);
	}
	const record = readOwnerFile(filePath);
	if (record.processToken !== expected.processToken || record.generation !== expected.generation) {
		throw new OwnershipError(
			`ownership of ${runId} moved (generation ${expected.generation} → ${record.generation}); this session no longer owns the run`,
		);
	}
}

/** Release ownership; only the matching token may remove the record. */
export function releaseOwnership(workdir: string, runId: string, processToken: string): boolean {
	const key = runKey(workdir, runId);
	const filePath = ownerFilePath(workdir, runId);
	if (filePath === null) return false;
	held.delete(key);
	if (!existsSync(filePath)) return false;
	const record = readOwnerFile(filePath);
	if (record.processToken !== processToken) return false;
	try {
		unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Records held by this process (test/inspection helper). */
export function heldOwnershipKeys(): string[] {
	return [...held.keys()];
}

/** The owner record this process currently holds for a run, if any (F-005). */
export function heldOwnershipRecord(workdir: string, runId: string): OwnerRecord | null {
	return held.get(runKey(workdir, runId)) ?? null;
}
